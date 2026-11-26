import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_DEFAULT_RETENTION_MS,
  resolveArchiveSettings,
  selectArchiveCandidates,
} from './archive';
import type { ArchiveCandidate } from './archive';

const DAY = 24 * 60 * 60 * 1000;

function session(patch: Partial<ArchiveCandidate> & Pick<ArchiveCandidate, 'id'> & { updatedAt?: number }): ArchiveCandidate {
  return { workspace: '/workspace', ...patch };
}

describe('archive settings', () => {
  it('stays off when the section is missing', () => {
    expect(resolveArchiveSettings({})).toEqual({
      enabled: false,
      retentionMs: ARCHIVE_DEFAULT_RETENTION_MS,
      requiresSelection: false,
    });
    expect(resolveArchiveSettings(null).requiresSelection).toBe(false);
  });

  it('reads an explicit on/off choice and its retention window', () => {
    expect(resolveArchiveSettings({ archive: { enabled: true, retentionMs: 7 * DAY } })).toEqual({
      enabled: true,
      retentionMs: 7 * DAY,
      requiresSelection: false,
    });
    expect(resolveArchiveSettings({ archive: { enabled: false, retentionMs: DAY } }).enabled).toBe(false);
  });

  it('falls back when the stored section is illegal', () => {
    for (const archive of [
      { enabled: 'yes', retentionMs: DAY },
      { enabled: true, retentionMs: 0 },
      { enabled: true, retentionMs: 1.5 },
      { enabled: true },
      null,
    ]) {
      expect(resolveArchiveSettings({ archive })).toMatchObject({ enabled: false, requiresSelection: true });
    }
  });
});

describe('archive candidate selection', () => {
  const now = 10 * DAY;
  const settings = { enabled: true, retentionMs: 3 * DAY };

  it('files away only idle, unpinned root sessions', () => {
    const sessions = [
      session({ id: 'stale', updatedAt: now - 4 * DAY }),
      session({ id: 'recent', updatedAt: now - DAY }),
      session({ id: 'exact', updatedAt: now - 3 * DAY }),
      session({ id: 'pinned', updatedAt: now - 9 * DAY, pinned: true }),
      session({ id: 'filed', updatedAt: now - 9 * DAY, archived: true }),
      session({ id: 'child', updatedAt: now - 9 * DAY, parentSessionId: 'stale', depth: 1 }),
    ];
    expect(selectArchiveCandidates(sessions, settings, now).map((item) => item.id)).toEqual(['stale', 'exact']);
  });

  it('leaves a session alone when its activity time was not read', () => {
    const sessions = [session({ id: 'unreadable' })];
    expect(selectArchiveCandidates(sessions, settings, now)).toEqual([]);
  });

  it('leaves a session alone while its turn is open', () => {
    const sessions = [session({ id: 'busy', updatedAt: now - 9 * DAY })];
    expect(selectArchiveCandidates(sessions, settings, now, () => true)).toEqual([]);
  });

  it('selects nothing while automatic archiving is off', () => {
    const sessions = [session({ id: 'stale', updatedAt: 0 })];
    expect(selectArchiveCandidates(sessions, { enabled: false, retentionMs: DAY }, now)).toEqual([]);
  });
});
