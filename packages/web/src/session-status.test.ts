import { describe, expect, it } from 'vitest';
import { MAX_STATUS_RECONNECT_DELAY, statusReconnectDelay } from '../ui/src/lib/session-status.ts';
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

  it('reads a review that outlived its turn and ignores one the user already answered', () => {
    const pending = { type: 'plan/review.pending', data: { requestId: 'review-1', callId: 'exit', plan: '# Plan' } };
    expect(sessionPendingKind([], [pending])).toBe('plan-review');
    expect(sessionPendingKind([], [
      pending,
      { type: 'plan/review.decision', data: { requestId: 'review-1', callId: 'exit', approved: true } },
    ])).toBeNull();
    expect(sessionPendingKind([], [
      { type: 'permission/pending', data: { requestId: 'ask-1', callId: 'bash-1', name: 'bash', reason: 'Allow one call to use workspace-write: needed' } },
    ])).toBe('approval');
    expect(sessionPendingKind([{ type: 'permission.requested' }], [pending])).toBe('approval');
  });
});

describe('status stream reconnect delay', () => {
  it('starts at one second and doubles per attempt', () => {
    expect(statusReconnectDelay(0)).toBe(1_000);
    expect(statusReconnectDelay(1)).toBe(2_000);
    expect(statusReconnectDelay(2)).toBe(4_000);
    expect(statusReconnectDelay(3)).toBe(8_000);
    expect(statusReconnectDelay(4)).toBe(16_000);
  });

  it('caps the wait at thirty seconds and ignores junk attempts', () => {
    expect(statusReconnectDelay(5)).toBe(MAX_STATUS_RECONNECT_DELAY);
    expect(statusReconnectDelay(30)).toBe(30_000);
    expect(statusReconnectDelay(Number.POSITIVE_INFINITY)).toBe(1_000);
    expect(statusReconnectDelay(-3)).toBe(1_000);
    expect(statusReconnectDelay(1.7)).toBe(2_000);
  });
});
