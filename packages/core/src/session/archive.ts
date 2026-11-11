/**
 * Log-backed session archiving.
 *
 * Archiving is a `session/archived` event so it replays with the rest of the
 * session log. The transcript, its title and its subagents stay on disk and
 * remain openable by id; archiving only hides the session from the sidebar list
 * and from session search. The latest event wins; a missing or malformed event
 * means the session is not archived. Archive changes are UI state and must not
 * move a session in the recency ordering, so `lastActivityTime` ignores them.
 */

import type { SessionEvent, SessionEventInput } from './types';

export const SESSION_ARCHIVE_EVENT = 'session/archived';

export interface SessionArchiveEventData {
  readonly archived: boolean;
}

export function createSessionArchiveEvent(archived: boolean): SessionEventInput {
  return { type: SESSION_ARCHIVE_EVENT, data: { archived } satisfies SessionArchiveEventData };
}

export function foldSessionArchived(events: readonly SessionEvent[]): boolean {
  const event = events.findLast((item) => item.type === SESSION_ARCHIVE_EVENT);
  if (event === undefined || typeof event.data !== 'object' || event.data === null) return false;
  return (event.data as { archived?: unknown }).archived === true;
}
