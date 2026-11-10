import { describe, expect, it } from 'vitest';
import { projectSessionMetrics } from './session-metrics';
import type { TrajectoryEvent } from './trajectory';

const event = (seq: number, type: string, data: unknown, ts?: number | null): TrajectoryEvent => ({ seq, type, data, ts });

describe('projectSessionMetrics', () => {
  it('uses run boundaries rather than user messages and sums only paired throughput samples', () => {
    const events = [
      event(0, 'message/user', { secret: 'private' }, 10),
      event(1, 'trace/turn.start', { step: 0 }, 100),
      event(2, 'message/assistant', { requestDurationMs: 20, usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 }, secret: 'private' }, 120),
      event(3, 'message/user', { secret: 'steering' }, 130),
      event(4, 'trace/turn.start', { step: 1 }, 200),
      event(5, 'message/assistant', { requestDurationMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }, 210),
      event(6, 'trace/turn.end', {}, 300),
      event(7, 'trace/turn.start', { step: 0 }, 400),
      event(8, 'assistant/message', { requestDurationMs: 5, usage: { inputTokens: 2, cachedInputTokens: 0 } }, 410),
      event(9, 'trace/turn.end', {}, 450),
    ];
    const metrics = projectSessionMetrics(events.reverse());
    expect(metrics).toEqual({
      version: 1,
      runs: { started: 2, completed: 2, durationMs: 250, knownDurationCount: 2 },
      steps: { started: 3 },
      requests: { count: 3, durationMs: 25, knownDurationCount: 3 },
      usage: { inputTokens: 12, outputTokens: 4, inputKnownCount: 3, outputKnownCount: 2 },
      throughput: { outputTokens: 4, durationMs: 20, count: 1 },
      cache: { inputTokens: 12, cachedInputTokens: 3, count: 2 },
    });
    expect(JSON.stringify(metrics)).not.toContain('private');
  });

  it('distinguishes absent, malformed, zero, partial and backwards values', () => {
    expect(projectSessionMetrics([])).toEqual({
      version: 1,
      runs: { started: 0, completed: 0, durationMs: null, knownDurationCount: 0 },
      steps: { started: 0 },
      requests: { count: 0, durationMs: null, knownDurationCount: 0 },
      usage: { inputTokens: null, outputTokens: null, inputKnownCount: 0, outputKnownCount: 0 },
      throughput: { outputTokens: 0, durationMs: 0, count: 0 },
      cache: { inputTokens: 0, cachedInputTokens: 0, count: 0 },
    });
    const metrics = projectSessionMetrics([
      event(0, 'trace/turn.end', {}, 10),
      event(1, 'trace/turn.start', { step: 2 }, 20),
      event(2, 'trace/turn.end', {}, 30),
      event(3, 'trace/turn.start', { step: 0 }, 50),
      event(4, 'trace/turn.end', {}, 40),
      event(5, 'trace/turn.start', { step: 0 }, 60),
      event(6, 'trace/turn.start', { step: 0 }, 70),
      event(7, 'trace/turn.end', {}, 70),
      event(8, 'message/assistant', { requestDurationMs: -1, usage: { inputTokens: -1, outputTokens: NaN } }),
      event(9, 'message/assistant', { requestDurationMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }),
      event(10, 'message/assistant', { requestDurationMs: Infinity, usage: { outputTokens: 2 } }),
      event(11, 'message/assistant', { role: 'user', requestDurationMs: 9, usage: { outputTokens: 9 } }),
      event(12, 'trace/turn.start', { step: 0 }),
      event(13, 'trace/turn.end', {}, 80),
    ]);
    expect(metrics.runs).toEqual({ started: 5, completed: 4, durationMs: 0, knownDurationCount: 1 });
    expect(metrics.requests).toEqual({ count: 3, durationMs: 0, knownDurationCount: 1 });
    expect(metrics.usage).toEqual({ inputTokens: 0, outputTokens: 2, inputKnownCount: 1, outputKnownCount: 2 });
    expect(metrics.throughput).toEqual({ outputTokens: 0, durationMs: 0, count: 0 });
  });

  it('excludes missing, invalid, and unpaired cache data without hiding known zero', () => {
    const metrics = projectSessionMetrics([
      event(0, 'message/assistant', { usage: { inputTokens: 10, cachedInputTokens: 4 } }),
      event(1, 'message/assistant', { usage: { inputTokens: 5, cachedInputTokens: 0 } }),
      event(2, 'message/assistant', { usage: { inputTokens: 100 } }),
      event(3, 'message/assistant', { usage: { cachedInputTokens: 2 } }),
      event(4, 'message/assistant', { usage: { inputTokens: 2, cachedInputTokens: 3 } }),
      event(5, 'message/assistant', { usage: { inputTokens: 0, cachedInputTokens: 0 } }),
      event(6, 'message/assistant', { usage: { inputTokens: 4, cachedInputTokens: -1 } }),
      event(7, 'message/assistant', { usage: { inputTokens: 4, cachedInputTokens: 0.5 } }),
    ]);
    expect(metrics.cache).toEqual({ inputTokens: 15, cachedInputTokens: 4, count: 2 });
  });
});
