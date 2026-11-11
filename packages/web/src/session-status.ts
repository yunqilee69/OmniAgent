/**
 * Host-side session state that the sidebar needs but a followed turn does not
 * own: whether the session currently runs, which interaction it waits for, and
 * how its latest turn ended. The list endpoint and the status stream both read
 * these projections so a row never has to depend on this tab's live turn.
 */

import type { TrajectoryEndReason } from './trajectory';

/** The user-facing interaction a running turn is blocked on. */
export type SessionPendingKind = 'approval' | 'plan-review';

/** How the session's latest persisted turn ended. */
export interface SessionLastTurn {
  /** Epoch milliseconds the turn ended, 0 when the log carried no timestamp. */
  endedAt: number;
  reason: TrajectoryEndReason;
}

const STOP_REASONS: ReadonlySet<string> = new Set<TrajectoryEndReason>([
  'end_turn',
  'tool_use',
  'max_tokens',
  'max_steps',
  'interrupted',
  'error',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Read the newest persisted `trace/turn.end` from a session log.
 * @param events - persisted session events, newest last.
 * @returns the last turn's end time and reason, or null when no turn ever ended.
 */
export function projectLastTurn(events: readonly unknown[]): SessionLastTurn | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = record(events[index]);
    if (event?.type !== 'trace/turn.end') continue;
    const reason = record(event.data)?.reason;
    if (typeof reason !== 'string' || !STOP_REASONS.has(reason)) continue;
    const ts = event.ts;
    return {
      endedAt: typeof ts === 'number' && Number.isSafeInteger(ts) && ts > 0 ? ts : 0,
      reason: reason as TrajectoryEndReason,
    };
  }
  return null;
}

/**
 * Classify the interaction a turn currently blocks on. A plan review outranks a
 * tool approval because the turn cannot continue past the plan either way.
 * @param prompts - prompts still awaiting an answer, in emit order.
 */
export function sessionPendingKind(prompts: readonly { type?: unknown }[]): SessionPendingKind | null {
  const types = new Set(prompts.map((prompt) => prompt.type));
  if (types.has('plan.review.requested')) return 'plan-review';
  if (types.has('permission.requested')) return 'approval';
  return null;
}
