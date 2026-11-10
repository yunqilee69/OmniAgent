import { describe, expect, it } from 'vitest';
import { applyAgentEvent, createLiveState } from '../ui/src/lib/events.ts';
import { emptyMetrics, validateSessionMetrics } from '../ui/src/lib/session-metrics.ts';
import { projectSessionMetrics } from './session-metrics.ts';

describe('live session metrics', () => {
  it('matches durable counts, usage, throughput and cache after multiple runs and failed steps', () => {
    const history = [
      { seq: 1, ts: 100, type: 'trace/turn.start', data: { step: 0 } },
      { seq: 2, ts: 200, type: 'message/assistant', data: { role: 'assistant', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 }, requestDurationMs: 500 } },
      { seq: 3, ts: 300, type: 'trace/turn.end', data: {} },
    ];
    const base = projectSessionMetrics(history);
    const live = createLiveState();
    live.metrics = structuredClone(base);
    const next = [
      { type: 'turn.start', step: 0 },
      { type: 'assistant.message', message: { role: 'assistant', content: [], toolCalls: [], usage: { inputTokens: 200, outputTokens: 30, cachedInputTokens: 100 }, requestDurationMs: 1000 } },
      { type: 'turn.start', step: 1 },
      { type: 'assistant.message', message: { role: 'assistant', content: [], toolCalls: [], usage: { inputTokens: 50, outputTokens: 10 } } },
      { type: 'turn.start', step: 2 },
      { type: 'turn.end', reason: 'error' },
    ];
    next.forEach((event) => applyAgentEvent(live, event));
    const durable = projectSessionMetrics([...history,
      { seq: 4, ts: 400, type: 'trace/turn.start', data: { step: 0 } },
      { seq: 5, ts: 500, type: 'message/assistant', data: next[1]!.message },
      { seq: 6, ts: 600, type: 'trace/turn.start', data: { step: 1 } },
      { seq: 7, ts: 700, type: 'message/assistant', data: next[3]!.message },
      { seq: 8, ts: 800, type: 'trace/turn.start', data: { step: 2 } },
      { seq: 9, ts: 900, type: 'trace/turn.end', data: { reason: 'error' } },
    ]);
    expect(live.metrics).toMatchObject({ runs: { started: 2, completed: 2 }, steps: { started: 4 },
      usage: durable.usage, throughput: durable.throughput, cache: durable.cache });
    expect(live.metrics!.cache).toEqual({ inputTokens: 300, cachedInputTokens: 140, count: 2 });
    expect(live.metrics!.throughput).toEqual({ outputTokens: 50, durationMs: 1500, count: 2 });
  });

  it('preserves unavailable values and excludes invalid cache or timing pairs', () => {
    const live = createLiveState();
    live.metrics = emptyMetrics();
    applyAgentEvent(live, { type: 'turn.start', step: 0 });
    const malformed: Record<string, unknown> = { type: 'assistant.message', message: { content: [], toolCalls: [], usage: { inputTokens: 5, cachedInputTokens: 6 }, requestDurationMs: 0 } };
    applyAgentEvent(live, malformed);
    expect(live.metrics.usage.outputTokens).toBeNull();
    expect(live.metrics.cache.count).toBe(0);
    expect(live.metrics.throughput.count).toBe(0);
    expect(validateSessionMetrics(live.metrics)).toEqual(live.metrics);
    expect(validateSessionMetrics({ version: 1 })).toBeNull();
  });
});
