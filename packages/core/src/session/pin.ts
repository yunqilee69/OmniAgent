/**
 * Log-backed session pinning.
 *
 * Pinning is a `session/pinned` event so it replays with the rest of the
 * session log. The latest event wins; a missing or malformed event means the
 * session is not pinned. Pin changes are UI state and must not move a session
 * in the recency ordering, so `lastActivityTime` ignores them.
 */

import type { SessionEvent, SessionEventInput } from './types';

export const SESSION_PIN_EVENT = 'session/pinned';

export interface SessionPinEventData {
  readonly pinned: boolean;
}

export function createSessionPinEvent(pinned: boolean): SessionEventInput {
  return { type: SESSION_PIN_EVENT, data: { pinned } satisfies SessionPinEventData };
}

export function foldSessionPinned(events: readonly SessionEvent[]): boolean {
  const event = events.findLast((item) => item.type === SESSION_PIN_EVENT);
  if (event === undefined || typeof event.data !== 'object' || event.data === null) return false;
  return (event.data as { pinned?: unknown }).pinned === true;
}
