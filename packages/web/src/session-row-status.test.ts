import { describe, expect, it } from 'vitest';
import { translator } from '../ui/src/lib/i18n.ts';
import {
  IDLE_SESSION_STATE,
  runningSubagentCounts,
  sessionRowStatuses,
  showsRowDot,
} from '../ui/src/lib/session-status.ts';

const zh = translator('zh');
const en = translator('en');

describe('session row statuses', () => {
  it('names the wait before the run, because the user is what the row needs', () => {
    expect(sessionRowStatuses({ ...IDLE_SESSION_STATE, running: true, pending: 'approval' }, zh)).toEqual([
      { state: 'warning', label: '等待审批', trailingLabel: '待审批' },
    ]);
    expect(sessionRowStatuses({ ...IDLE_SESSION_STATE, running: true, pending: 'plan-review' }, zh)).toEqual([
      { state: 'warning', label: '等待计划审阅', trailingLabel: '计划审阅' },
    ]);
  });

  it('reports a live run and then the work its subagents still owe', () => {
    expect(sessionRowStatuses({ ...IDLE_SESSION_STATE, running: true }, en)).toEqual([
      { state: 'ongoing', label: 'Running' },
    ]);
    expect(sessionRowStatuses({ ...IDLE_SESSION_STATE, running: true, runningSubagents: 2 }, zh)).toEqual([
      { state: 'ongoing', label: '运行中' },
      { state: 'ongoing', label: '2 个子智能体运行中' },
    ]);
    // A parent that is only driving subagents still reads as ongoing.
    expect(sessionRowStatuses({ ...IDLE_SESSION_STATE, runningSubagents: 1 }, zh)).toEqual([
      { state: 'ongoing', label: '1 个子智能体运行中' },
    ]);
  });

  it('keeps a finished outcome visible until it is acknowledged or re-run', () => {
    expect(sessionRowStatuses({ ...IDLE_SESSION_STATE, completionUnread: true }, zh)).toEqual([
      { state: 'done', label: '已完成' },
    ]);
    expect(sessionRowStatuses({ ...IDLE_SESSION_STATE, lastTurnFailed: true }, zh)).toEqual([
      { state: 'error', label: '失败' },
    ]);
    // A failure outranks an earlier completion reminder: it is the newer fact.
    expect(sessionRowStatuses({ ...IDLE_SESSION_STATE, lastTurnFailed: true, completionUnread: true }, en)).toEqual([
      { state: 'error', label: 'Failed' },
    ]);
  });

  it('reserves idle for a row with nothing to say', () => {
    const idle = sessionRowStatuses(IDLE_SESSION_STATE, en);
    expect(idle).toEqual([{ state: 'idle', label: 'Idle' }]);
    expect(showsRowDot(idle)).toBe(false);
    expect(showsRowDot(sessionRowStatuses({ ...IDLE_SESSION_STATE, running: true }, en))).toBe(true);
    expect(showsRowDot(sessionRowStatuses({ ...IDLE_SESSION_STATE, completionUnread: true }, en))).toBe(true);
  });
});

describe('running subagent counts', () => {
  const sessions = [
    { id: 'root' },
    { id: 'child', parentSessionId: 'root' },
    { id: 'grandchild', parentSessionId: 'child' },
    { id: 'sibling', parentSessionId: 'root' },
    { id: 'other-root' },
  ];

  it('counts a running descendant for every ancestor that is waiting on it', () => {
    const counts = runningSubagentCounts(sessions, (session) => session.id === 'grandchild');
    expect(counts.get('root')).toBe(1);
    expect(counts.get('child')).toBe(1);
    expect(counts.get('other-root')).toBeUndefined();
  });

  it('counts each running child once and ignores finished ones', () => {
    const counts = runningSubagentCounts(sessions, (session) =>
      session.id === 'child' || session.id === 'sibling');
    expect(counts.get('root')).toBe(2);
    expect(counts.get('child')).toBeUndefined();
  });

  it('survives a malformed parent chain without looping', () => {
    const looped = [
      { id: 'a', parentSessionId: 'b' },
      { id: 'b', parentSessionId: 'a' },
    ];
    const counts = runningSubagentCounts(looped, () => true);
    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(1);
  });
});
