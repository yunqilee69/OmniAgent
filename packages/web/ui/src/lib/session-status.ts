/**
 * Sidebar row state, derived from host facts rather than this tab's live turn.
 *
 * A row answers one question: what does this conversation need from the user
 * right now? Pending interactions outrank live activity, and a run that ended
 * while the user was looking elsewhere keeps a completion (or failure) mark
 * until it is acknowledged. The vocabulary mirrors the host stream so the row,
 * the hover card and search results cannot disagree.
 */

import type { Translate } from './i18n';
import type { SessionPendingKind, SessionSummary } from './wire';

/** Dot semantics shared with the primitive state dot. */
export type SessionRowState = 'ongoing' | 'warning' | 'done' | 'error' | 'idle';

/** One line of session state: the dot plus what it means. */
export interface SessionRowStatus {
  state: SessionRowState;
  label: string;
  /** Compact label that replaces the row's relative time while the row waits. */
  trailingLabel?: string;
}

/** Host facts a listed session carries, merged from the list baseline and the status stream. */
export interface SessionLiveState {
  running: boolean;
  pending: SessionPendingKind | null;
  /** The latest persisted turn ended with an error and the user has not re-run it. */
  lastTurnFailed: boolean;
  /** A run finished while the user was elsewhere; cleared by opening the session. */
  completionUnread: boolean;
}

export const IDLE_SESSION_STATE: SessionLiveState = {
  running: false,
  pending: null,
  lastTurnFailed: false,
  completionUnread: false,
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Count running child sessions per ancestor.
 *
 * A subagent's turn never reaches the web server's turn registry, so its own
 * row cannot prove it is live; the parent's row carries that work instead. A
 * running grandchild counts for every ancestor, because the whole chain is
 * still waiting on it.
 * @param sessions - one workspace's session summaries.
 * @param isRunning - whether a child session is still working.
 * @returns running descendant counts keyed by ancestor session id.
 */
export function runningSubagentCounts(
  sessions: readonly Pick<SessionSummary, 'id' | 'parentSessionId' | 'subagentStatus'>[],
  isRunning: (session: Pick<SessionSummary, 'id' | 'parentSessionId' | 'subagentStatus'>) => boolean,
): Map<string, number> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const parentId = text(session.parentSessionId);
    if (parentId === '' || !isRunning(session)) continue;
    const seen = new Set<string>([session.id]);
    let current = byId.get(parentId);
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      counts.set(current.id, (counts.get(current.id) ?? 0) + 1);
      const next = text(current.parentSessionId);
      current = next === '' ? undefined : byId.get(next);
    }
  }
  return counts;
}

/**
 * Derive a row's statuses, primary first.
 *
 * Precedence: waiting for the user, then the session's own live turn, then its
 * running subagents, then a failed last turn, then an unread completion. Idle
 * is reported so hover cards can name it; rows draw no dot for it.
 * @param input - host facts for one listed session.
 * @param input.runningSubagents - running descendant count from {@link runningSubagentCounts}.
 * @param t - translator for the workspace browser copy.
 * @returns one status per fact worth showing, most important first.
 */
export function sessionRowStatuses(
  input: Pick<SessionLiveState, 'running' | 'pending' | 'lastTurnFailed' | 'completionUnread'> & {
    runningSubagents?: number;
  },
  t: Translate,
): SessionRowStatus[] {
  const subagents = (input.runningSubagents ?? 0) === 0
    ? undefined
    : {
      state: 'ongoing' as const,
      label: t('{count} subagents running', { count: input.runningSubagents ?? 0 }),
    };
  const pending = input.pending === 'approval'
    ? { state: 'warning' as const, label: t('Waiting for approval'), trailingLabel: t('Approval') }
    : input.pending === 'plan-review'
      ? { state: 'warning' as const, label: t('Waiting for plan review'), trailingLabel: t('Plan review') }
      : undefined;
  if (pending !== undefined) return subagents === undefined ? [pending] : [pending, subagents];
  if (input.running) {
    const primary: SessionRowStatus = { state: 'ongoing', label: t('Running') };
    return subagents === undefined ? [primary] : [primary, subagents];
  }
  if (subagents !== undefined) return [subagents];
  if (input.lastTurnFailed) return [{ state: 'error', label: t('Failed') }];
  if (input.completionUnread) return [{ state: 'done', label: t('Completed') }];
  return [{ state: 'idle', label: t('Idle') }];
}

/**
 * Whether a row draws its leading status dot, or leaves the cell to a seat such
 * as the pinned or scheduled-task mark.
 * @param statuses - result of {@link sessionRowStatuses}.
 */
export function showsRowDot(statuses: readonly SessionRowStatus[]): boolean {
  return statuses[0]?.state !== undefined && statuses[0].state !== 'idle';
}
