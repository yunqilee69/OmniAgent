/** One-shot permission for the next direct human message to create a goal. */

export const GOAL_GRANT_EVENT = 'goal/grant';

export interface GoalGrant {
  messageSeq: number;
  consumed: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** The newest unused grant wins. A later user message consumes it. */
export function projectGoalGrant(events: readonly { type: string; data: unknown }[]): GoalGrant | null {
  let grant: GoalGrant | null = null;
  let userMessages = 0;
  for (const event of events) {
    if (event.type === 'message/user') {
      userMessages += 1;
      if (grant !== null && userMessages > grant.messageSeq) grant = { messageSeq: grant.messageSeq, consumed: true };
      continue;
    }
    if (event.type !== GOAL_GRANT_EVENT) continue;
    const data = record(event.data);
    const messageSeq = data?.messageSeq;
    if (typeof messageSeq !== 'number' || !Number.isSafeInteger(messageSeq) || messageSeq < 0) continue;
    grant = { messageSeq, consumed: userMessages > messageSeq };
  }
  return grant;
}

export function createGoalGrantEvent(messageSeq: number): { type: typeof GOAL_GRANT_EVENT; data: { messageSeq: number } } {
  if (!Number.isSafeInteger(messageSeq) || messageSeq < 0) {
    throw new TypeError('Goal grant message sequence must be a non-negative integer');
  }
  return { type: GOAL_GRANT_EVENT, data: { messageSeq } };
}

/** Count persisted user messages so a grant can bind to the next one. */
export function countUserMessages(events: readonly { type: string }[]): number {
  return events.reduce((count, event) => count + (event.type === 'message/user' ? 1 : 0), 0);
}
