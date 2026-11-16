export const PLAN_MODE_EVENT = 'plan/mode';
/** Durable "waiting for the user" record. The plan body stays on the tool call. */
export const PLAN_REVIEW_PENDING_EVENT = 'plan/review.pending';
/** Durable decision. A later pending event reopens the review. */
export const PLAN_REVIEW_DECISION_EVENT = 'plan/review.decision';
/** Durable record that a tool escalation was waiting and did not finish. */
export const PERMISSION_PENDING_EVENT = 'permission/pending';

export interface PlanProjection {
  active: boolean;
}

/** A plan the session is still waiting for the user to accept or send back. */
export interface PendingPlanReview {
  requestId: string;
  callId: string;
  plan: string;
}

/** A tool escalation that was waiting when its turn stopped. It is not executable. */
export interface PendingPermission {
  requestId: string;
  callId: string;
  name: string;
  reason: string;
}

/** The last well-formed mode event wins; malformed or absent state is inactive. */
export function projectPlanMode(events: readonly { type: string; data: unknown }[]): PlanProjection {
  let active = false;
  for (const event of events) {
    if (event.type !== PLAN_MODE_EVENT) continue;
    if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue;
    const value = (event.data as Record<string, unknown>).active;
    if (typeof value === 'boolean') active = value;
  }
  return { active };
}

export function createPlanModeEvent(active: boolean): { type: typeof PLAN_MODE_EVENT; data: { active: boolean } } {
  if (typeof active !== 'boolean') throw new TypeError('Plan mode state must be a boolean');
  return { type: PLAN_MODE_EVENT, data: { active } };
}

const REVIEW_LIMITS = { requestId: 256, callId: 256, plan: 200_000, feedback: 4_000, reason: 500, name: 128 };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > max) return undefined;
  return text;
}

export function createPlanReviewPendingEvent(review: PendingPlanReview): {
  type: typeof PLAN_REVIEW_PENDING_EVENT;
  data: PendingPlanReview;
} {
  const requestId = boundedText(review.requestId, REVIEW_LIMITS.requestId);
  const callId = boundedText(review.callId, REVIEW_LIMITS.callId);
  const plan = boundedText(review.plan, REVIEW_LIMITS.plan);
  if (requestId === undefined || callId === undefined || plan === undefined) {
    throw new TypeError('Plan review state is missing a request, call, or plan');
  }
  return { type: PLAN_REVIEW_PENDING_EVENT, data: { requestId, callId, plan } };
}

export function createPlanReviewDecisionEvent(decision: {
  requestId: string;
  callId: string;
  approved: boolean;
  feedback?: string;
}): { type: typeof PLAN_REVIEW_DECISION_EVENT; data: { requestId: string; callId: string; approved: boolean; feedback?: string } } {
  const requestId = boundedText(decision.requestId, REVIEW_LIMITS.requestId);
  const callId = boundedText(decision.callId, REVIEW_LIMITS.callId);
  if (requestId === undefined || callId === undefined || typeof decision.approved !== 'boolean') {
    throw new TypeError('Plan review decision is missing a request, call, or decision');
  }
  const feedback = decision.feedback === undefined ? undefined : boundedText(decision.feedback, REVIEW_LIMITS.feedback);
  return {
    type: PLAN_REVIEW_DECISION_EVENT,
    data: { requestId, callId, approved: decision.approved, ...(feedback === undefined ? {} : { feedback }) },
  };
}

export function createPermissionPendingEvent(request: PendingPermission): {
  type: typeof PERMISSION_PENDING_EVENT;
  data: PendingPermission;
} {
  const requestId = boundedText(request.requestId, REVIEW_LIMITS.requestId);
  const callId = boundedText(request.callId, REVIEW_LIMITS.callId);
  const name = boundedText(request.name, REVIEW_LIMITS.name);
  const reason = boundedText(request.reason, REVIEW_LIMITS.reason);
  if (requestId === undefined || callId === undefined || name === undefined || reason === undefined) {
    throw new TypeError('Permission pending state is missing a request, call, tool, or reason');
  }
  return { type: PERMISSION_PENDING_EVENT, data: { requestId, callId, name, reason } };
}

/**
 * The review a persisted session is still waiting on.
 *
 * The newest well-formed pending record wins. A decision for the same request,
 * or a tool result for the same call, means the user already answered, so the
 * session is not waiting. A decision for an older request does not close a
 * newer one.
 */
export function projectPendingPlanReview(events: readonly { type: string; data: unknown }[]): PendingPlanReview | null {
  const settled = new Set<string>();
  const answeredCalls = new Set<string>();
  for (const event of events) {
    const data = record(event.data);
    if (event.type === PLAN_REVIEW_DECISION_EVENT) {
      const requestId = boundedText(data?.requestId, REVIEW_LIMITS.requestId);
      if (requestId !== undefined) settled.add(requestId);
    } else if (event.type === 'message/tool-result') {
      const callId = boundedText(record(data?.result)?.callId, REVIEW_LIMITS.callId);
      if (callId !== undefined) answeredCalls.add(callId);
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== PLAN_REVIEW_PENDING_EVENT) continue;
    const data = record(event.data);
    const requestId = boundedText(data?.requestId, REVIEW_LIMITS.requestId);
    const callId = boundedText(data?.callId, REVIEW_LIMITS.callId);
    const plan = boundedText(data?.plan, REVIEW_LIMITS.plan);
    if (requestId === undefined || callId === undefined || plan === undefined) continue;
    if (settled.has(requestId) || answeredCalls.has(callId)) return null;
    return { requestId, callId, plan };
  }
  return null;
}

/**
 * The tool escalation that was waiting when the turn stopped.
 *
 * A permission decision or a tool result for the same call retires it. The
 * record is informational: reopening the session must not execute the call.
 */
export function projectPendingPermission(events: readonly { type: string; data: unknown }[]): PendingPermission | null {
  const settled = new Set<string>();
  for (const event of events) {
    const data = record(event.data);
    if (event.type === 'trace/permission.decided' || event.type === 'message/tool-result') {
      const callId = boundedText(event.type === 'trace/permission.decided' ? data?.callId : record(data?.result)?.callId, REVIEW_LIMITS.callId);
      if (callId !== undefined) settled.add(callId);
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== PERMISSION_PENDING_EVENT) continue;
    const data = record(event.data);
    const requestId = boundedText(data?.requestId, REVIEW_LIMITS.requestId);
    const callId = boundedText(data?.callId, REVIEW_LIMITS.callId);
    const name = boundedText(data?.name, REVIEW_LIMITS.name);
    const reason = boundedText(data?.reason, REVIEW_LIMITS.reason);
    if (requestId === undefined || callId === undefined || name === undefined || reason === undefined) continue;
    if (settled.has(callId)) return null;
    return { requestId, callId, name, reason };
  }
  return null;
}

export const PLAN_MODE_GUIDANCE = `You are in plan mode.

- Investigate the workspace and gather the facts needed for a concrete plan.
- Do not edit or write files while in plan mode.
- Decide the implementation yourself; do not ask the user to approve individual investigation steps.
- When the plan is ready, call exit_plan_mode with the complete Markdown plan, starting with a # heading.
- If the user keeps planning, revise the plan using their feedback and present it again.`;
