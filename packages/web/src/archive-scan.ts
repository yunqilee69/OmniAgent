import { createSessionArchiveEvent, foldSessionArchived, foldSessionPinned, lastActivityTime, selectArchiveCandidates } from '@omniagent/core';
import type { ArchiveSettings, SessionStore } from '@omniagent/core';

/** Sessions the scanner must leave alone because a turn is still open. */
export type ActiveSessionKeys = ReadonlySet<string>;

export function sessionActivityKey(workspace: string, id: string): string {
  return `${workspace}\0${id}`;
}

export interface ArchiveScanResult {
  readonly archived: number;
}

/**
 * File away idle root sessions and return how many were newly archived.
 *
 * Each candidate is opened again before the event is appended, so a pin or a
 * manual archive that landed between the listing and this write still wins.
 * One failing session does not stop the rest of the scan.
 */
export async function scanAutomaticArchives(
  store: Pick<SessionStore, 'list' | 'open'>,
  settings: Pick<ArchiveSettings, 'enabled' | 'retentionMs'>,
  active: ActiveSessionKeys,
  now = Date.now(),
): Promise<ArchiveScanResult> {
  if (!settings.enabled) return { archived: 0 };
  const listed = await store.list();
  const candidates = selectArchiveCandidates(listed, settings, now, (session) =>
    active.has(sessionActivityKey(session.workspace, session.id)));
  let archived = 0;
  for (const candidate of candidates) {
    try {
      const handle = await store.open(candidate.workspace, candidate.id);
      // Re-read the log: a pin, a restore, or a newer message can land between
      // the listing and this write, and that newer state has to win.
      const summary = selectArchiveCandidates([{
        workspace: handle.header.workspace,
        id: handle.id,
        updatedAt: lastActivityTime(handle.events, handle.header.createdAt),
        parentSessionId: handle.header.parentSessionId,
        depth: handle.header.depth,
        ...(foldSessionPinned(handle.events) ? { pinned: true } : {}),
        ...(foldSessionArchived(handle.events) ? { archived: true } : {}),
      }], settings, now, (session) => active.has(sessionActivityKey(session.workspace, session.id)));
      if (summary.length === 0) continue;
      await handle.append(createSessionArchiveEvent(true));
      archived += 1;
    } catch {
      // A session that disappeared or cannot be parsed is skipped; the next
      // scan retries anything that is still a candidate.
    }
  }
  return { archived };
}
