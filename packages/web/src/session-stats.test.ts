import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionStats } from '../ui/src/components/SessionStats.tsx';
import type { SessionMetrics } from '../ui/src/lib/session-metrics.ts';
import type { SessionEntry } from '../ui/src/lib/store.ts';
import { AppStore, store } from '../ui/src/lib/store.ts';

const metrics: SessionMetrics = {
  version: 1,
  runs: { started: 20, completed: 20, durationMs: 438_000, knownDurationCount: 20 },
  steps: { started: 438 },
  requests: { count: 438, durationMs: 8_429_000, knownDurationCount: 438 },
  tools: { count: 1200, durationMs: 944_000, knownDurationCount: 1200 },
  ttft: { durationMs: 6_438, count: 438 },
  usage: { inputTokens: 178_097_419, outputTokens: 120_038, inputKnownCount: 438, outputKnownCount: 438 },
  throughput: { outputTokens: 120_038, durationMs: 2_069_000, count: 438 },
  cache: { inputTokens: 178_097_419, cachedInputTokens: 130_506_496, count: 438 },
};

function render(entry: Partial<SessionEntry> | null, locale: 'zh' | 'en' = 'zh'): string {
  const spy = vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...new AppStore().getSnapshot(), locale });
  const originalConsoleError = console.error;
  const consoleError = vi.spyOn(console, 'error').mockImplementation((message, ...args) => {
    if (typeof message !== 'string' || !message.includes('useLayoutEffect does nothing on the server')) {
      originalConsoleError(message, ...args);
    }
  });
  try {
    return renderToStaticMarkup(createElement(SessionStats, { entry: entry as SessionEntry | null }));
  } finally {
    consoleError.mockRestore();
    spy.mockRestore();
  }
}

describe('session readings', () => {
  it('shows turn, step, speed, token and cache-hit readings in one line', () => {
    const html = render({ metrics, run: undefined });
    expect(html).toContain('data-composer-stat="activity"');
    expect(html).toContain('data-composer-stat="usage"');
    expect(html).toContain('20 轮 438 步');
    expect(html).toContain('58 tok/s');
    expect(html).toContain('178M tok');
    expect(html).toContain('缓存命中 73%');
  });

  it('keeps the reading a plain pill without a dialog while closed', () => {
    const html = render({ metrics, run: undefined });
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('会话统计');
  });

  it('falls back to the compact reading when the session has no timing', () => {
    const html = render({
      run: undefined,
      metrics: {
        ...metrics,
        requests: { count: 0, durationMs: null, knownDurationCount: 0 },
        tools: { count: 0, durationMs: 0, knownDurationCount: 0 },
        ttft: { durationMs: 0, count: 0 },
        throughput: { outputTokens: 0, durationMs: 0, count: 0 },
      },
    });
    expect(html).toContain('20 轮 438 步');
    expect(html).not.toContain('tok/s');
  });

  it('renders nothing until the session reports a reading', () => {
    expect(render(null)).toBe('');
    expect(render({ metrics: null, run: undefined })).toBe('');
    expect(render({ run: undefined, metrics: { ...metrics, steps: { started: 0 } } }).includes('data-composer-stat="activity"'))
      .toBe(false);
  });

  it('translates the readings for the English locale', () => {
    const html = render({ metrics, run: undefined }, 'en');
    expect(html).toContain('20 turns 438 steps');
    expect(html).toContain('Cache hit 73%');
    expect(html).toContain('178M tok');
  });
});
