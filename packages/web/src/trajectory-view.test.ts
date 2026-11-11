import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TrajectoryPanel } from '../ui/src/components/TrajectoryView.tsx';
import { translator } from '../ui/src/lib/i18n.ts';
import type { SessionEntry } from '../ui/src/lib/store.ts';
import { recordPreview, recordSections, recordSearchText } from '../ui/src/lib/trajectory.ts';
import type { TrajectoryRecord } from '../ui/src/lib/wire.ts';

// The vendored menu primitives use layout effects that SSR cannot run.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useLayoutEffect: react.useEffect };
});

const t = translator('en');

const records: TrajectoryRecord[] = [
  {
    id: 'input:0', kind: 'input', seq: 0, timestamp: 1_700_000_000_000,
    text: 'Why does the build fail?', clipped: false,
  },
  {
    id: 'model:1', kind: 'model', seq: 1, timestamp: 1_700_000_001_000,
    text: 'Running the suite to find out.', inputTokens: 10, outputTokens: 5, clipped: false,
  },
  {
    id: 'tool:2:0', kind: 'tool', seq: 2, name: 'bash', ok: false, durationMs: 900,
    arguments: '{\n  "command": "pnpm test"\n}', output: 'FAIL src/app.test.ts\nTypeError: boom', clipped: false,
  },
];

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    loaded: true,
    error: '',
    trajectory: { version: 1, records, timeline: { sequence: [], time: [] } },
    events: [{ seq: 3, ts: 1_700_000_002_000, type: 'trace/error', data: { message: 'An error occurred during the turn.' } }],
    audit: [],
    ...overrides,
  } as unknown as SessionEntry;
}

function render(value: SessionEntry | null, hasSession = true): string {
  return renderToStaticMarkup(createElement(TrajectoryPanel, { entry: value, t, hasSession }));
}

describe('trajectory panel', () => {
  it('shows the recorded message text, not just metadata', () => {
    const html = render(entry());
    // The first record is selected, so the inspector already carries its text.
    expect(html).toContain('Why does the build fail?');
    expect(html).toContain('User message');
    expect(html).toContain('aria-label="Copy"');
    // List rows preview content so a reader can scan without clicking.
    expect(html).toContain('User input');
    expect(html).toContain('Running the suite to find out.');
  });

  it('marks a failed tool row with its reason instead of only a status dot', () => {
    const html = render(entry());
    expect(html).toContain('FAIL src/app.test.ts TypeError: boom');
    expect(html).toContain('data-state="error"');
    expect(html).toContain('900 ms');
  });

  it('keeps the empty and loading states', () => {
    expect(render(null)).toContain('Loading session');
    expect(render(entry(), false)).toContain('No session selected');
  });
});

describe('trajectory record content', () => {
  it('returns tool arguments and the failure reason as inspector sections', () => {
    const tool = records[2]!;
    expect(recordSections(tool)).toEqual([
      { label: 'Arguments', value: '{\n  "command": "pnpm test"\n}', tone: 'default', mono: true },
      { label: 'Failure output', value: 'FAIL src/app.test.ts\nTypeError: boom', tone: 'error', mono: true },
    ]);
    expect(recordSections(records[0]!)).toEqual([
      { label: 'User message', value: 'Why does the build fail?', tone: 'default', mono: false },
    ]);
    expect(recordSections(records[1]!)).toEqual([
      { label: 'Assistant message', value: 'Running the suite to find out.', tone: 'default', mono: false },
    ]);
  });

  it('previews the failure reason first and searches inside content', () => {
    expect(recordPreview(records[2]!)).toBe('FAIL src/app.test.ts TypeError: boom');
    expect(recordPreview(records[0]!)).toBe('Why does the build fail?');
    expect(recordSearchText(records[2]!)).toContain('pnpm test');
    expect(recordSearchText(records[2]!)).toContain('typeerror: boom');
  });
});
