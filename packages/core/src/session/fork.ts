/**
 * Marker written when a session is forked.
 *
 * The copied transcript keeps its original event timestamps; the marker is
 * appended with the fork time so the new session sorts by when it was created
 * without inventing a human message.
 */

import type { SessionEvent, SessionEventInput } from './types';

export const SESSION_FORK_EVENT = 'session/fork';

export interface SessionForkEventData {
  readonly sourceSessionId: string;
}

export function createSessionForkEvent(sourceSessionId: string): SessionEventInput {
  return { type: SESSION_FORK_EVENT, data: { sourceSessionId } satisfies SessionForkEventData };
}

export function foldSessionForkSource(events: readonly SessionEvent[]): string | undefined {
  const event = events.findLast((item) => item.type === SESSION_FORK_EVENT);
  if (event === undefined || typeof event.data !== 'object' || event.data === null) return undefined;
  const source = (event.data as { sourceSessionId?: unknown }).sourceSessionId;
  return typeof source === 'string' && source.length > 0 ? source : undefined;
}
