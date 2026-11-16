import type { AskUserAnswerItem, AskUserQuestion } from '../tools/builtin/ask-user';
import { ASK_USER_MAX_TIMEOUT_SEC, validateAskUserAnswers } from '../tools/builtin/ask-user';

/** Waiting for an answer while the tool call is still open. */
export const ASK_USER_PENDING_EVENT = 'ask-user/pending';
/** The foreground wait expired. The tool result is pending; a later answer is a user message. */
export const ASK_USER_CONTINUED_EVENT = 'ask-user/continued';
/** The user answered, skipped, or cancelled. A later pending event reopens the question. */
export const ASK_USER_DECISION_EVENT = 'ask-user/decision';

const LIMITS = { requestId: 256, callId: 256 };

export type AskUserDecisionKind = 'answer' | 'cancel';

export interface PendingAskUser {
  requestId: string;
  callId: string;
  questions: AskUserQuestion[];
  timeoutSec: number;
  /** `open` while the tool is still waiting; `continued` after it returned pending. */
  state: 'open' | 'continued';
  /** Derived from the persisted pending event timestamp for finite waits. */
  deadlineAt?: number;
}

export interface AskUserDecision {
  requestId: string;
  callId: string;
  kind: AskUserDecisionKind;
  answers?: AskUserAnswerItem[];
}

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

function timeoutOf(value: unknown): number | undefined {
  if (value === -1) return -1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > ASK_USER_MAX_TIMEOUT_SEC) {
    return undefined;
  }
  return value;
}

function questionOf(value: unknown): AskUserQuestion | undefined {
  const data = record(value);
  const id = boundedText(data?.id, 80);
  const question = boundedText(data?.question, 2_000);
  if (id === undefined || question === undefined || typeof data?.multiSelect !== 'boolean') return undefined;
  const header = data.header === undefined ? undefined : boundedText(data.header, 80);
  if (data.header !== undefined && header === undefined) return undefined;
  let options: AskUserQuestion['options'];
  if (data.options !== undefined) {
    if (!Array.isArray(data.options) || data.options.length === 0 || data.options.length > 6) return undefined;
    const parsed = [];
    const labels = new Set<string>();
    for (const option of data.options) {
      const item = record(option);
      const label = boundedText(item?.label, 120);
      if (label === undefined || labels.has(label)) return undefined;
      labels.add(label);
      const description = item?.description === undefined ? undefined : boundedText(item.description, 500);
      if (item?.description !== undefined && description === undefined) return undefined;
      parsed.push({ label, ...(description === undefined ? {} : { description }) });
    }
    options = parsed;
  }
  return {
    id,
    question,
    ...(header === undefined ? {} : { header }),
    ...(options === undefined ? {} : { options }),
    multiSelect: data.multiSelect,
  };
}

function questionsOf(value: unknown): AskUserQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return undefined;
  const questions: AskUserQuestion[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const question = questionOf(item);
    if (question === undefined || ids.has(question.id)) return undefined;
    ids.add(question.id);
    questions.push(question);
  }
  return questions;
}

function pendingOf(data: Record<string, unknown> | undefined, state: PendingAskUser['state'], timestamp?: number): PendingAskUser | undefined {
  const requestId = boundedText(data?.requestId, LIMITS.requestId);
  const callId = boundedText(data?.callId, LIMITS.callId);
  const questions = questionsOf(data?.questions);
  const timeoutSec = timeoutOf(data?.timeoutSec);
  if (requestId === undefined || callId === undefined || questions === undefined || timeoutSec === undefined) {
    return undefined;
  }
  return {
    requestId,
    callId,
    questions,
    timeoutSec,
    state,
    ...(timeoutSec === -1 || timestamp === undefined ? {} : { deadlineAt: timestamp + timeoutSec * 1000 }),
  };
}

export function createAskUserPendingEvent(pending: Omit<PendingAskUser, 'state'>): {
  type: typeof ASK_USER_PENDING_EVENT;
  data: Omit<PendingAskUser, 'state'>;
} {
  const parsed = pendingOf(pending as unknown as Record<string, unknown>, 'open');
  if (parsed === undefined) throw new TypeError('Ask-user state is missing a request, call, questions, or timeout');
  return {
    type: ASK_USER_PENDING_EVENT,
    data: {
      requestId: parsed.requestId,
      callId: parsed.callId,
      questions: parsed.questions,
      timeoutSec: parsed.timeoutSec,
    },
  };
}

export function createAskUserContinuedEvent(pending: Pick<PendingAskUser, 'requestId' | 'callId'>): {
  type: typeof ASK_USER_CONTINUED_EVENT;
  data: { requestId: string; callId: string };
} {
  const requestId = boundedText(pending.requestId, LIMITS.requestId);
  const callId = boundedText(pending.callId, LIMITS.callId);
  if (requestId === undefined || callId === undefined) {
    throw new TypeError('Ask-user continuation is missing a request or call');
  }
  return { type: ASK_USER_CONTINUED_EVENT, data: { requestId, callId } };
}

export function createAskUserDecisionEvent(decision: AskUserDecision): {
  type: typeof ASK_USER_DECISION_EVENT;
  data: AskUserDecision;
} {
  const requestId = boundedText(decision.requestId, LIMITS.requestId);
  const callId = boundedText(decision.callId, LIMITS.callId);
  if (requestId === undefined || callId === undefined || (decision.kind !== 'answer' && decision.kind !== 'cancel')) {
    throw new TypeError('Ask-user decision is missing a request, call, or outcome');
  }
  return {
    type: ASK_USER_DECISION_EVENT,
    data: {
      requestId,
      callId,
      kind: decision.kind,
      ...(decision.answers === undefined ? {} : { answers: decision.answers }),
    },
  };
}

/**
 * The newest ask-user call the session can still accept an answer for.
 *
 * A decision closes its request. A tool result closes an `open` call, because
 * the tool already returned; a `continued` call stays answerable after its
 * pending tool result. A decision for an older request does not close a newer one.
 */
export function projectPendingAskUser(events: readonly { type: string; data: unknown }[]): PendingAskUser | null {
  const settled = new Set<string>();
  const answeredCalls = new Set<string>();
  const continued = new Set<string>();
  for (const event of events) {
    const data = record(event.data);
    if (event.type === ASK_USER_DECISION_EVENT) {
      const requestId = boundedText(data?.requestId, LIMITS.requestId);
      // `pending` is the timeout marker, not a terminal decision. The
      // subsequent continued event keeps this question answerable after reload.
      if (requestId !== undefined && data?.action !== 'pending') settled.add(requestId);
    } else if (event.type === ASK_USER_CONTINUED_EVENT) {
      const requestId = boundedText(data?.requestId, LIMITS.requestId);
      if (requestId !== undefined) continued.add(requestId);
    } else if (event.type === 'message/tool-result') {
      const callId = boundedText(record(data?.result)?.callId, LIMITS.callId);
      if (callId !== undefined) answeredCalls.add(callId);
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== ASK_USER_PENDING_EVENT) continue;
    const timestamp = (event as unknown as { ts?: unknown }).ts;
    const pending = pendingOf(record(event.data), 'open', typeof timestamp === 'number' ? timestamp : undefined);
    if (pending === undefined) continue;
    if (settled.has(pending.requestId)) return null;
    if (continued.has(pending.requestId)) return { ...pending, state: 'continued' };
    if (answeredCalls.has(pending.callId)) return null;
    return pending;
  }
  return null;
}

/** Parse and check a late or in-window answer against the questions still pending. */
export function answersForPendingAskUser(
  pending: PendingAskUser,
  answers: readonly AskUserAnswerItem[],
): AskUserAnswerItem[] {
  return validateAskUserAnswers(pending.questions, answers);
}
