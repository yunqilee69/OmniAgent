import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Header } from '../ui/src/components/Header.tsx';
import { AppStore, sessionKey, store } from '../ui/src/lib/store.ts';
import {
  formatSubagentDuration,
  formatTokens,
  sessionRoot,
  sessionTrail,
  subagentRows,
  subagentStatusLabel,
} from '../ui/src/lib/subagents.ts';
import { translator } from '../ui/src/lib/i18n.ts';
import type { SessionSummary } from '../ui/src/lib/wire.ts';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useLayoutEffect: react.useEffect,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

afterEach(() => { vi.restoreAllMocks(); });

const sessions: SessionSummary[] = [
  { id: 'root', title: 'Refactor the parser', createdAt: 100, updatedAt: 900 },
  { id: 'child-a', parentSessionId: 'root', description: 'Parse the payload', createdAt: 200, updatedAt: 400 },
  { id: 'child-b', parentSessionId: 'root', title: 'Mock the API', description: '负责第二项：接口 mock', createdAt: 300, updatedAt: 700 },
  { id: 'grandchild', parentSessionId: 'child-a', description: 'Diff the fixtures', createdAt: 350, updatedAt: 500 },
];

function renderHeader(sessionId: string, list: readonly SessionSummary[] = sessions, entryTitle?: string | null): string {
  const initial = new AppStore(false).getSnapshot();
  vi.spyOn(store, 'getSnapshot').mockReturnValue({
    ...initial,
    locale: 'en',
    workspaceId: 'workspace',
    sessionId,
    sessions: [...list],
    entries: {
      [sessionKey('workspace', sessionId)]: {
        ...initial.entries[sessionKey('workspace', sessionId)],
        title: entryTitle === undefined ? list.find((item) => item.id === sessionId)?.title ?? null : entryTitle,
        plan: { active: false },
      } as (typeof initial.entries)[string],
    },
  });
  return renderToStaticMarkup(createElement(Header, {
    sidebarOpen: true,
    rightOpen: true,
    onToggleSidebar: () => {},
    onToggleRight: () => {},
  }));
}

describe('subagent team helpers', () => {
  it('walks the parent chain and stops on a cycle', () => {
    expect(sessionTrail(sessions, 'grandchild').map((item) => item.id)).toEqual(['root', 'child-a', 'grandchild']);
    expect(sessionTrail(sessions, 'root').map((item) => item.id)).toEqual(['root']);
    expect(sessionTrail(sessions, 'absent')).toEqual([]);
    const cyclic = [
      { id: 'a', parentSessionId: 'b' },
      { id: 'b', parentSessionId: 'a' },
    ];
    expect(sessionTrail(cyclic, 'a').map((item) => item.id)).toEqual(['b', 'a']);
    expect(sessionRoot(cyclic, 'a')?.id).toBe('b');
  });

  it('lists every descendant of one root, oldest first, following parent ids', () => {
    expect(subagentRows(sessions, 'root').map((row) => row.id)).toEqual(['child-a', 'child-b', 'grandchild']);
    expect(subagentRows(sessions, 'absent')).toEqual([]);
    // A child of a child still belongs to the root even when its own parent is missing.
    const orphaned = [...sessions, { id: 'stray', parentSessionId: 'child-a', createdAt: 50 }];
    expect(subagentRows(orphaned, 'root').map((row) => row.id)).toEqual(['stray', 'child-a', 'child-b', 'grandchild']);
  });

  it('names a row by its title and keeps the description as the brief', () => {
    const rows = subagentRows(sessions, 'root');
    expect(rows[0]).toMatchObject({ name: 'Parse the payload', detail: '', resumable: true, status: 'idle' });
    expect(rows[1]).toMatchObject({ name: 'Mock the API', detail: '负责第二项：接口 mock' });
  });

  it('carries the reported activity into the row', () => {
    const [row] = subagentRows([{
      id: 'child',
      parentSessionId: 'root',
      description: 'Work',
      createdAt: 1_000,
      updatedAt: 62_000,
      subagentStatus: 'running',
      usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 },
    }], 'root');
    expect(row).toMatchObject({ status: 'running', running: true, resumable: false, totalTokens: 1_000, durationMs: 61_000 });
  });

  it('formats token totals and run lengths', () => {
    expect([0, 999, 12_400, 1_600_000, 42_100_000].map(formatTokens)).toEqual(['0', '999', '12.4k', '1.6M', '42.1M']);
    expect(formatTokens(null)).toBe('');
    expect(formatSubagentDuration(20_000, 'en')).toBe('20 sec');
    expect(formatSubagentDuration(2_333_000, 'en')).toBe('38 min 53 sec');
    expect(formatSubagentDuration(7_440_000, 'zh')).toBe('2 小时 4 分钟');
    expect(formatSubagentDuration(null, 'en')).toBe('');
  });

  it('labels every status', () => {
    const t = translator('en');
    expect(['running', 'completed', 'failed', 'interrupted', 'idle'].map((status) => subagentStatusLabel(status as never, t)))
      .toEqual(['Running', 'Completed', 'Failed', 'Interrupted', 'Idle']);
  });
});

describe('subagent headers', () => {
  it('titles a child session with its path and moves the team onto the task name', () => {
    const html = renderHeader('child-b');
    expect(html).toContain('title="Back to Refactor the parser"');
    // The current task name is the team trigger, so the count button is gone.
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('>Mock the API<');
    expect(html).not.toContain('3 subagents');
    expect(html).not.toContain('aria-label="Subagent team"');
  });

  it('keeps a root session title as-is and shows the team size next to it', () => {
    const html = renderHeader('root');
    expect(html).toContain('>Refactor the parser<');
    expect(html).not.toContain('title="Back to');
    expect(html).toContain('3 subagents');
    expect(html).toContain('aria-label="Subagent team"');
  });

  it('takes the title from the session list, which is where a late title lands', () => {
    // The entry only learns a title from a live event; the list is the source
    // the sidebar reads, and a title minted after the turn ends is only there.
    const html = renderHeader('root', sessions, null);
    expect(html).toContain('>Refactor the parser<');
    expect(html).not.toContain('>Untitled<');
    expect(html).not.toContain('>New Session<');
  });

  it('renders no team entry for a session without children', () => {
    const html = renderHeader('root', [{ id: 'root', title: 'Solo session' }]);
    expect(html).toContain('>Solo session<');
    expect(html).not.toContain('subagents');
  });
});
