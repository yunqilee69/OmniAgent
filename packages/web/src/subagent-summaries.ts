import type { TrajectoryEvent } from './trajectory';
import { projectSessionMetrics } from './session-metrics';

/** Five states a child session can be in, as far as its transcripts can prove. */
export type WebSubagentStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'idle';

/** Token totals a child session's own assistant messages reported. */
export interface WebSubagentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/** What the session list adds to a subagent summary beyond the store's own fields. */
export interface WebSubagentActivity {
  subagentStatus: WebSubagentStatus;
  usage: WebSubagentUsage | null;
}

interface SubagentSummaryLike {
  id: string;
  parentSessionId?: string;
}

const START_EVENT = 'subagent/start';
const END_EVENT = 'subagent/end';
const TURN_START_EVENT = 'trace/turn.start';
const TURN_END_EVENT = 'trace/turn.end';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finishedStatus(value: unknown): WebSubagentStatus | undefined {
  return value === 'completed' || value === 'failed' || value === 'interrupted' ? value : undefined;
}

/**
 * Fold a parent session's `subagent/start` and `subagent/end` events into the
 * latest status per child id. A start without a matching end means the child
 * has not reported an outcome yet, which the parent cannot distinguish from a
 * run still in flight on its own.
 */
export function projectSubagentStatuses(events: readonly TrajectoryEvent[]): Map<string, WebSubagentStatus> {
  const statuses = new Map<string, WebSubagentStatus>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const data = record(event.data);
    if (event.type === START_EVENT) {
      const id = typeof data?.id === 'string' ? data.id : '';
      if (id !== '') statuses.set(id, 'running');
    } else if (event.type === END_EVENT) {
      const id = typeof data?.childId === 'string' ? data.childId : '';
      const status = finishedStatus(data?.status);
      if (id !== '' && status !== undefined) statuses.set(id, status);
    }
  }
  return statuses;
}

/**
 * Whether the child's own log says a turn is currently open. A restart leaves
 * a `running` start event with no end event behind, so the child transcript is
 * the tie-breaker: only an unclosed turn means the child is still working.
 */
export function projectSubagentTurnOpen(events: readonly TrajectoryEvent[]): boolean {
  let open = false;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === TURN_START_EVENT) open = true;
    else if (event.type === TURN_END_EVENT) open = false;
  }
  return open;
}

/** Total tokens a session reported, or null when no assistant message carried usage. */
export function projectSubagentUsage(events: readonly TrajectoryEvent[]): WebSubagentUsage | null {
  const { usage } = projectSessionMetrics(events);
  if (usage.inputTokens === null && usage.outputTokens === null) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  };
}

/**
 * Activity of every child session in one workspace.
 *
 * The parent's start/end fold answers "what did the parent record"; the child's
 * own last turn answers "is it still working" when no end event was ever
 * written. Children whose parent events are gone stay `idle`: their transcript
 * is still resumable, but nothing proves a run is live.
 * @param input.summaries - workspace session summaries; only children are projected.
 * @param input.events - reads one session's events, or undefined when it cannot be opened.
 * @returns one activity per child session id.
 */
export function projectSubagentActivities(input: {
  summaries: readonly SubagentSummaryLike[];
  events: (sessionId: string) => readonly TrajectoryEvent[] | undefined;
}): Map<string, WebSubagentActivity> {
  const parentStatuses = new Map<string, Map<string, WebSubagentStatus>>();
  const activities = new Map<string, WebSubagentActivity>();
  for (const summary of input.summaries) {
    const parentId = summary.parentSessionId;
    if (parentId === undefined || parentId === '') continue;
    let statuses = parentStatuses.get(parentId);
    if (statuses === undefined) {
      statuses = projectSubagentStatuses(input.events(parentId) ?? []);
      parentStatuses.set(parentId, statuses);
    }
    const childEvents = input.events(summary.id);
    let subagentStatus = statuses.get(summary.id) ?? 'idle';
    if (subagentStatus === 'running' && childEvents !== undefined && !projectSubagentTurnOpen(childEvents)) {
      subagentStatus = 'idle';
    }
    const usage = childEvents === undefined ? null : projectSubagentUsage(childEvents);
    activities.set(summary.id, { subagentStatus, usage });
  }
  return activities;
}
