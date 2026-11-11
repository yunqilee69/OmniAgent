import { translator, type Locale, type Translate } from './i18n.ts';
import type { SessionSummary, SubagentStatus } from './wire.ts';

/** One row of the header's subagent card, derived from the workspace session list. */
export interface SubagentRow {
  id: string;
  /** Short task name: the child's own title, falling back to its description. */
  name: string;
  /** Task brief shown under the name; empty when the name already is the description. */
  detail: string;
  status: SubagentStatus;
  /** True while the child is still working, from the parent's start event. */
  running: boolean;
  /** True when the transcript can be continued with a follow-up message. */
  resumable: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  createdAt: number;
  durationMs: number | null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The name a session is shown under: title, then the subagent description. */
export function sessionLabel(session: SessionSummary): string {
  return text(session.title) || text(session.description);
}

/**
 * Walk `parentSessionId` from the given session up to its root.
 * @param sessions - one workspace's session summaries.
 * @param sessionId - any session in that workspace.
 * @returns the ancestor chain ending at the session itself; empty when it is not listed.
 */
export function sessionTrail(sessions: readonly SessionSummary[], sessionId: string): SessionSummary[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const trail: SessionSummary[] = [];
  const seen = new Set<string>();
  let current = byId.get(sessionId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current);
    const parentId = text(current.parentSessionId);
    current = parentId === '' ? undefined : byId.get(parentId);
  }
  return trail;
}

/** The root of the chain containing `sessionId`, or null when the session is not listed. */
export function sessionRoot(sessions: readonly SessionSummary[], sessionId: string): SessionSummary | null {
  return sessionTrail(sessions, sessionId)[0] ?? null;
}

/**
 * Every subagent under one root, oldest first.
 *
 * Depth is not trusted for nesting: a grandchild whose parent is missing from
 * the list still belongs to the root, so the walk follows parent ids.
 * @param sessions - one workspace's session summaries.
 * @param rootId - the root session whose team is rendered.
 * @returns child rows sorted by creation time, the root excluded.
 */
export function subagentRows(sessions: readonly SessionSummary[], rootId: string): SubagentRow[] {
  const children = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const parentId = text(session.parentSessionId);
    if (parentId === '') continue;
    const siblings = children.get(parentId);
    if (siblings === undefined) children.set(parentId, [session]);
    else siblings.push(session);
  }
  const rows: SubagentRow[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift() as string;
    for (const child of children.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      rows.push(toRow(child));
    }
  }
  return rows.sort((left, right) => left.createdAt - right.createdAt);
}

function toRow(session: SessionSummary): SubagentRow {
  const description = text(session.description);
  const title = text(session.title);
  const status: SubagentStatus = session.subagentStatus ?? 'idle';
  const createdAt = typeof session.createdAt === 'number' ? session.createdAt : 0;
  const updatedAt = typeof session.updatedAt === 'number' ? session.updatedAt : 0;
  return {
    id: session.id,
    name: title || description,
    detail: title === '' ? '' : description,
    status,
    running: status === 'running',
    resumable: status !== 'running',
    inputTokens: session.usage?.inputTokens ?? null,
    outputTokens: session.usage?.outputTokens ?? null,
    totalTokens: session.usage?.totalTokens ?? null,
    createdAt,
    durationMs: createdAt > 0 && updatedAt >= createdAt ? updatedAt - createdAt : null,
  };
}

/** Compact token counts: 0, 12.4k, 1.6M, 42.1M. */
export function formatTokens(total: number | null): string {
  if (total === null) return '';
  if (total >= 1_000_000_000) return `${(total / 1_000_000_000).toFixed(1)}B`;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return String(total);
}

/** A run's wall-clock length in the user's units: 20 sec, 38 min 53 sec, 2 hr 4 min. */
export function formatSubagentDuration(ms: number | null, locale: Locale): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  const t = translator(locale);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t('{seconds} sec', { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('{minutes} min {seconds} sec', { minutes, seconds: seconds % 60 });
  return t('{hours} hr {minutes} min', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** Status word for one card row. */
export function subagentStatusLabel(status: SubagentStatus, t: Translate): string {
  switch (status) {
    case 'running': return t('Running');
    case 'completed': return t('Completed');
    case 'failed': return t('Failed');
    case 'interrupted': return t('Interrupted');
    default: return t('Idle');
  }
}
