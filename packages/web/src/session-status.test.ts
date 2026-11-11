import { describe, expect, it } from 'vitest';
import { projectLastTurn, sessionPendingKind } from './session-status';

describe('session status projections', () => {
  it('reads the newest turn end and skips records it cannot trust', () => {
    expect(projectLastTurn([])).toBeNull();
    expect(projectLastTurn([{ type: 'message/user', ts: 3 }])).toBeNull();
    expect(projectLastTurn([{ type: 'trace/turn.end', ts: 3, data: { reason: 'invented' } }])).toBeNull();
    expect(projectLastTurn([{ type: 'trace/turn.end', ts: 3 }])).toBeNull();
    expect(projectLastTurn([
      { type: 'trace/turn.end', ts: 10, data: { reason: 'end_turn' } },
      { type: 'message/user', ts: 20 },
      { type: 'trace/turn.end', ts: -1, data: { reason: 'error' } },
    ])).toEqual({ endedAt: 0, reason: 'error' });
  });

  it('reports the interaction a turn blocks on, planning ahead of tools', () => {
    expect(sessionPendingKind([])).toBeNull();
    expect(sessionPendingKind([{ type: 'assistant.delta' }, { type: 'tool.result' }])).toBeNull();
    expect(sessionPendingKind([{ type: 'permission.requested' }])).toBe('approval');
    expect(sessionPendingKind([{ type: 'plan.review.requested' }])).toBe('plan-review');
    expect(sessionPendingKind([{ type: 'permission.requested' }, { type: 'plan.review.requested' }])).toBe('plan-review');
  });
});
