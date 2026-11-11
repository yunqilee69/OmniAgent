import { randomUUID } from 'node:crypto';
import type { AgentEvent, ApprovalResponse, PermissionRequest, PlanReviewResponse, SessionOptions } from '@omniagent/core';

type Prompt = Extract<AgentEvent, { type: 'permission.requested' }>;
type PlanPrompt = Extract<AgentEvent, { type: 'plan.review.requested' }>;
type EventResult = IteratorResult<AgentEvent>;

const GENERIC_APPROVAL_REASON = 'Tool execution requires approval';
const DSH_ESCALATION_REASON = /^Allow one call to use (read-only|workspace-write|danger-full-access): ([\s\S]+)$/;

/**
 * Show the escalation target and the caller's justification, but never forward
 * an arbitrary rule string or terminal control sequence to the browser.
 */
function approvalReason(reason: string): string {
  const match = DSH_ESCALATION_REASON.exec(reason);
  if (!match) return GENERIC_APPROVAL_REASON;
  const detail = match[2]!
    .replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!detail) return GENERIC_APPROVAL_REASON;
  const clipped = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail;
  return `Allow one call to use ${match[1]}: ${clipped}`;
}

interface PendingApproval {
  id: string;
  prompt: Prompt;
  settle(decision: ApprovalResponse): void;
}


export class ApprovalBroker {
  private readonly turns = new Map<string, ApprovalTurn>();
  private readonly timeoutMs: number;

  /**
   * A prompt waits for the user or for the turn to be aborted; it never expires
   * on its own, because a row that silently drops "waiting for approval" hides
   * work the user still has to unblock. Deployments that need a bound can pass
   * `timeoutMs`, which settles the prompt with a deny.
   * @param options.timeoutMs - positive lifetime in milliseconds, or 0/omitted to wait indefinitely.
   */
  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 0;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 0 || this.timeoutMs > 2_147_483_647) {
      throw new RangeError('Invalid approval timeout');
    }
  }

  handler(workspace: string, sessionId: string): SessionOptions['approve'] {
    const key = this.key(workspace, sessionId);
    return (request, signal) => this.turns.get(key)?.request(request, signal) ?? Promise.resolve('deny');
  }

  start(workspace: string, sessionId: string): ApprovalTurn {
    const key = this.key(workspace, sessionId);
    if (this.turns.has(key)) throw new Error('An approval turn is already active');
    const turn = new ApprovalTurn(this.timeoutMs, () => {
      if (this.turns.get(key) === turn) this.turns.delete(key);
    });
    this.turns.set(key, turn);
    return turn;
  }

  respond(workspace: string, sessionId: string, requestId: string, decision: unknown): boolean {
    if (decision !== 'allow' && decision !== 'deny') return false;
    return this.turns.get(this.key(workspace, sessionId))?.respond(requestId, decision) ?? false;
  }

  planHandler(workspace: string, sessionId: string): NonNullable<SessionOptions['reviewPlan']> {
    const key = this.key(workspace, sessionId);
    return (plan, signal) => this.turns.get(key)?.requestPlanReview(plan, signal)
      ?? Promise.resolve({ approved: false, feedback: 'Plan review is unavailable.' });
  }

  respondPlan(workspace: string, sessionId: string, requestId: string, approved: unknown, feedback: unknown): boolean {
    if (typeof approved !== 'boolean') return false;
    if (feedback !== undefined && typeof feedback !== 'string') return false;
    return this.turns.get(this.key(workspace, sessionId))
      ?.respondPlan(requestId, approved, feedback) ?? false;
  }

  private key(workspace: string, sessionId: string): string {
    return JSON.stringify([workspace, sessionId]);
  }
}

export class ApprovalTurn {
  private pending?: PendingApproval;
  private prompt?: Prompt;
  private planPending?: { id: string; prompt: PlanPrompt; settle(response: PlanReviewResponse): void };
  private planPrompt?: PlanPrompt;
  private planDecision?: Extract<AgentEvent, { type: 'plan.review.decided' }>;
  private wake?: () => void;
  private closed = false;
  private streaming = false;

  constructor(private readonly timeoutMs: number, private readonly onClose: () => void) {}

  /** Currently actionable prompts, including those already emitted to a follower. */
  pendingPrompts(): Array<Prompt | PlanPrompt> {
    return [this.pending?.prompt, this.planPending?.prompt].filter((prompt): prompt is Prompt | PlanPrompt => prompt !== undefined);
  }

  request(request: PermissionRequest, signal: AbortSignal): Promise<ApprovalResponse> {
    if (this.closed || this.pending || signal.aborted) return Promise.resolve('deny');
    let prompt: Prompt;
    try {
      // Clone through JSON to ensure this is serializable and detach it from tool state.
      const args: unknown = JSON.parse(JSON.stringify(request.call.arguments));
      prompt = {
        type: 'permission.requested', requestId: randomUUID(),
        call: { id: request.call.id, name: request.call.name, arguments: args },
        // Restrict displayed reasons to recognized DSH escalation messages.
        reason: approvalReason(request.reason),
      };
    } catch {
      return Promise.resolve('deny');
    }
    return new Promise((resolve) => {
      const onAbort = () => settle('deny');
      const timer = this.timeoutMs > 0 ? setTimeout(() => settle('deny'), this.timeoutMs) : undefined;
      const settle = (decision: ApprovalResponse) => {
        if (this.pending !== pending) return;
        this.pending = undefined;
        if (this.prompt === prompt) this.prompt = undefined;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(decision);
      };
      const pending: PendingApproval = { id: prompt.requestId, prompt, settle };
      this.pending = pending;
      this.prompt = prompt;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) settle('deny');
      else this.notify();
    });
  }

  requestPlanReview(plan: string, signal: AbortSignal): Promise<PlanReviewResponse> {
    if (this.closed || this.planPending || signal.aborted) {
      return Promise.resolve({ approved: false, feedback: 'Plan review is unavailable.' });
    }
    if (typeof plan !== 'string' || plan.trim().length === 0 || plan.length > 200_000) {
      return Promise.resolve({ approved: false, feedback: 'The plan is empty or too large to review.' });
    }
    const prompt: PlanPrompt = { type: 'plan.review.requested', requestId: randomUUID(), plan };
    return new Promise((resolve) => {
      const onAbort = () => settle({ approved: false, feedback: 'Plan review was cancelled.' });
      const timer = this.timeoutMs > 0
        ? setTimeout(() => settle({ approved: false, feedback: 'Plan review timed out.' }), this.timeoutMs)
        : undefined;
      const settle = (response: PlanReviewResponse) => {
        if (this.planPending !== pending) return;
        this.planPending = undefined;
        if (this.planPrompt === prompt) this.planPrompt = undefined;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(response);
      };
      const pending = { id: prompt.requestId, prompt, settle };
      this.planPending = pending;
      this.planPrompt = prompt;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) settle({ approved: false, feedback: 'Plan review was cancelled.' });
      else this.notify();
    });
  }

  respond(requestId: string, decision: ApprovalResponse): boolean {
    const pending = this.pending;
    if (this.closed || !pending || pending.id !== requestId) return false;
    pending.settle(decision);
    return true;
  }

  respondPlan(requestId: string, approved: boolean, feedback?: string): boolean {
    const pending = this.planPending;
    if (this.closed || !pending || pending.id !== requestId) return false;
    const clipped = feedback?.trim().slice(0, 4_000);
    this.planDecision = {
      type: 'plan.review.decided', requestId, approved, ...(clipped ? { feedback: clipped } : {}),
    };
    pending.settle({ approved, ...(clipped ? { feedback: clipped } : {}) });
    this.notify();
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending?.settle('deny');
    this.planPending?.settle({ approved: false, feedback: 'Plan review was cancelled.' });
    this.prompt = undefined;
    this.planPrompt = undefined;
    this.planDecision = undefined;
    this.onClose();
    this.notify();
  }

  async *stream(source: AsyncGenerator<AgentEvent>): AsyncGenerator<AgentEvent> {
    if (this.streaming || this.closed) throw new Error('Approval turn is not available');
    this.streaming = true;
    let next: Promise<EventResult> | undefined;
    let sourceError: unknown;
    let sourceFailed = false;
    try {
      while (!this.closed) {
        if (this.prompt) {
          const prompt = this.prompt;
          this.prompt = undefined;
          yield prompt;
          continue;
        }
        if (this.planPrompt) {
          const prompt = this.planPrompt;
          this.planPrompt = undefined;
          yield prompt;
          continue;
        }
        if (this.planDecision) {
          const decision = this.planDecision;
          this.planDecision = undefined;
          yield decision;
          continue;
        }
        next ??= source.next().then(
          (result) => { if (result.done) this.close(); return result; },
          (error: unknown) => { sourceFailed = true; sourceError = error; this.close(); throw error; },
        );
        const ready = await Promise.race([
          next.then((result) => ({ kind: 'source' as const, result })),
          new Promise<{ kind: 'prompt' }>((resolve) => {
            this.wake = () => resolve({ kind: 'prompt' });
            if (this.prompt || this.planPrompt || this.closed) this.notify();
          }),
        ]);
        this.wake = undefined;
        if (this.closed) break;
        if (ready.kind === 'prompt') continue;
        next = undefined;
        if (ready.result.done) return;
        yield ready.result.value;
      }
      if (sourceFailed) throw sourceError;
    } finally {
      this.close();
      if (next) await next.catch(() => undefined);
      await source.return(undefined);
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
