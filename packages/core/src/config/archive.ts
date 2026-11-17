/**
 * Automatic session archiving.
 *
 * Off by default. When enabled, a host scan appends `session/archived` to root
 * sessions whose last conversation activity is older than the retention window.
 * Pinned sessions and sessions with an open turn are never candidates: pinning
 * is an explicit "keep this" signal, and an active turn is still in use.
 * Archiving stays a listing filter; nothing is deleted by the scan.
 */

export const ARCHIVE_DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
/** Shortest retention a user can choose: one hour. */
export const ARCHIVE_MIN_RETENTION_MS = 60 * 60 * 1000;
/** Longest retention a user can choose: one year. */
export const ARCHIVE_MAX_RETENTION_MS = 366 * 24 * 60 * 60 * 1000;
/** How often a running host re-scans. */
export const ARCHIVE_SCAN_INTERVAL_MS = 60 * 60 * 1000;

export interface ArchiveSettings {
  /** False (the default) leaves every session where the user put it. */
  enabled: boolean;
  /** Idle time after which an unpinned root session becomes a candidate. */
  retentionMs: number;
  /**
   * True when a stored value is present but illegal, so the settings page can
   * show the fallback instead of pretending the stored value is in force.
   */
  requiresSelection: boolean;
}

export interface ArchiveCandidate {
  readonly workspace: string;
  readonly id: string;
  readonly updatedAt: number;
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly parentSessionId?: string;
  readonly depth?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A whole number of milliseconds inside the supported retention window. */
export function isArchiveRetention(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= ARCHIVE_MIN_RETENTION_MS
    && value <= ARCHIVE_MAX_RETENTION_MS;
}

function defaults(requiresSelection: boolean): ArchiveSettings {
  return { enabled: false, retentionMs: ARCHIVE_DEFAULT_RETENTION_MS, requiresSelection };
}

/**
 * Read `archive` from a config object.
 *
 * A missing section is the product default: automatic archiving stays off and
 * the three-day window is only a suggestion until the user turns it on. A
 * present but illegal section falls back the same way and asks the settings
 * page to treat the value as unset.
 */
export function resolveArchiveSettings(config: unknown): ArchiveSettings {
  if (!isRecord(config) || !Object.hasOwn(config, 'archive')) return defaults(false);
  const section = config.archive;
  if (!isRecord(section)
    || !Object.hasOwn(section, 'enabled')
    || typeof section.enabled !== 'boolean'
    || !Object.hasOwn(section, 'retentionMs')
    || !isArchiveRetention(section.retentionMs)) {
    return defaults(true);
  }
  return { enabled: section.enabled, retentionMs: section.retentionMs, requiresSelection: false };
}

/**
 * Root sessions the automatic scan should file away.
 *
 * Children stay with their parent (the sidebar reaches them from the team
 * card), pinned sessions are kept on purpose, and anything already archived
 * is left untouched so a later scan does not append a duplicate event.
 * `active` reports sessions whose turn is still open; those are skipped even
 * when their last persisted activity is old.
 */
export function selectArchiveCandidates(
  sessions: readonly ArchiveCandidate[],
  settings: Pick<ArchiveSettings, 'enabled' | 'retentionMs'>,
  now: number,
  active: (session: ArchiveCandidate) => boolean = () => false,
): ArchiveCandidate[] {
  if (!settings.enabled) return [];
  const cutoff = now - settings.retentionMs;
  return sessions.filter((session) => session.archived !== true
    && session.pinned !== true
    && session.parentSessionId === undefined
    && session.depth === undefined
    && session.updatedAt <= cutoff
    && !active(session));
}
