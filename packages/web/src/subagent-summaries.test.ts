import { describe, expect, it } from 'vitest';
import {
  projectSubagentActivities,
  projectSubagentStatuses,
  projectSubagentTurnOpen,
  projectSubagentUsage,
} from './subagent-summaries';
import type { TrajectoryEvent } from './trajectory';

function event(seq: number, type: string, data: unknown): TrajectoryEvent {
  return { seq, ts: seq * 1_000, type, data };
}

const start = (id: string) => event(0, 'subagent/start', { id, depth: 1, status: 'running' });
const end = (childId: string, status: string) => event(0, 'subagent/end', { childId, status });

describe('subagent summaries', () => {
  it('folds start and end events into the latest status per child', () => {
    const statuses = projectSubagentStatuses([
      event(0, 'subagent/start', { id: 'a' }),
      event(1, 'subagent/start', { id: 'b' }),
      event(2, 'subagent/end', { childId: 'a', status: 'completed' }),
      event(3, 'subagent/end', { childId: 'b', status: 'interrupted' }),
      event(4, 'message/user', { text: 'unrelated' }),
    ]);
    expect([...statuses]).toEqual([['a', 'completed'], ['b', 'interrupted']]);
  });

  it('ignores malformed or unknown-status events', () => {
    const statuses = projectSubagentStatuses([
      event(0, 'subagent/start', { id: 'kept' }),
      event(1, 'subagent/end', { childId: 'kept', status: 'running' }),
      event(2, 'subagent/end', { status: 'completed' }),
      event(3, 'subagent/start', { depth: 1 }),
    ]);
    expect([...statuses]).toEqual([['kept', 'running']]);
  });

  it('reads an open turn from the child transcript, not from the start event alone', () => {
    expect(projectSubagentTurnOpen([start('a'), event(1, 'trace/turn.start', { step: 0 })])).toBe(true);
    expect(projectSubagentTurnOpen([
      event(0, 'trace/turn.start', { step: 0 }),
      event(1, 'trace/turn.end', { reason: 'end_turn' }),
    ])).toBe(false);
    expect(projectSubagentTurnOpen([
      event(0, 'trace/turn.start', { step: 0 }),
      event(1, 'trace/turn.end', { reason: 'end_turn' }),
      event(2, 'trace/turn.start', { step: 0 }),
    ])).toBe(true);
    expect(projectSubagentTurnOpen([])).toBe(false);
  });

  it('totals only the usage the child transcript reported', () => {
    expect(projectSubagentUsage([
      event(0, 'message/assistant', { role: 'assistant', usage: { inputTokens: 1_200, outputTokens: 300 } }),
      event(1, 'message/assistant', { role: 'assistant', usage: { inputTokens: 800, outputTokens: 200 } }),
    ])).toEqual({ inputTokens: 2_000, outputTokens: 500, totalTokens: 2_500 });
    expect(projectSubagentUsage([event(0, 'message/assistant', { role: 'assistant', text: 'no usage' })])).toBeNull();
    expect(projectSubagentUsage([])).toBeNull();
  });

  it('keeps a start event without an open child turn out of the running state', () => {
    const parentEvents = [start('closed'), start('open'), start('vanished')];
    const transcripts: Record<string, TrajectoryEvent[]> = {
      closed: [
        event(0, 'trace/turn.start', { step: 0 }),
        event(1, 'trace/turn.end', { reason: 'end_turn' }),
      ],
      open: [event(0, 'trace/turn.start', { step: 0 })],
    };
    const activities = projectSubagentActivities({
      summaries: [
        { id: 'parent' },
        { id: 'closed', parentSessionId: 'parent' },
        { id: 'open', parentSessionId: 'parent' },
        { id: 'vanished', parentSessionId: 'parent' },
        { id: 'orphan', parentSessionId: 'missing-parent' },
      ],
      events: (id) => (id === 'parent' ? parentEvents : transcripts[id]),
    });
    expect(activities.get('closed')).toEqual({ subagentStatus: 'idle', usage: null });
    expect(activities.get('open')).toEqual({ subagentStatus: 'running', usage: null });
    // No transcript to disprove the start event: report what the parent recorded.
    expect(activities.get('vanished')).toEqual({ subagentStatus: 'running', usage: null });
    // A missing parent proves nothing, but the child is still resumable.
    expect(activities.get('orphan')).toEqual({ subagentStatus: 'idle', usage: null });
    expect(activities.has('parent')).toBe(false);
  });

  it('reports a recorded outcome over the transcript it left behind', () => {
    const activities = projectSubagentActivities({
      summaries: [{ id: 'child', parentSessionId: 'parent' }],
      events: (id) => (id === 'parent'
        ? [start('child'), end('child', 'failed')]
        : [
          event(0, 'trace/turn.start', { step: 0 }),
          event(1, 'message/assistant', { role: 'assistant', usage: { inputTokens: 10, outputTokens: 5 } }),
        ]),
    });
    expect(activities.get('child')).toEqual({
      subagentStatus: 'failed',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });
});
