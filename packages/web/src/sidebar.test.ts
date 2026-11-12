import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../ui/src/components/Sidebar.tsx';
import { AppStore, store } from '../ui/src/lib/store.ts';

const workspaces = [
  { id: 'a', name: 'Alpha', path: '/a', isDefault: true },
  { id: 'b', name: 'Beta', path: '/b' },
];

function renderSidebar(overrides: Partial<ReturnType<AppStore['getSnapshot']>> = {}): string {
  const state = {
    ...new AppStore().getSnapshot(),
    locale: 'en' as const,
    workspaces,
    workspaceId: 'a',
    workspacesLoading: false,
    sessionsLoading: false,
    sessions: [{ id: 'alpha-session', description: 'Alpha session' }],
    ...overrides,
  };
  vi.spyOn(store, 'getSnapshot').mockReturnValue(state);
  return renderToStaticMarkup(createElement(Sidebar, { drawer: false, onClose: () => {} }));
}

afterEach(() => { vi.restoreAllMocks(); });

describe('workspace sidebar', () => {
  it('renders non-default workspaces and default sessions in the Tasks section', () => {
    const html = renderSidebar();
    expect(html).toContain('Alpha session');
    expect(html).not.toContain('title="/a">Alpha');
    expect(html).toContain('title="/b">Beta');
    expect(html).not.toContain('New session in Alpha');
    expect(html).toContain('New session in Beta');
    expect(html.indexOf('>Tasks<')).toBeGreaterThan(html.indexOf('title="/b">Beta'));
  });

  it('lists the conversations the user started, not their subagents', () => {
    const html = renderSidebar({
      sessions: [
        { id: 'root-session', title: 'Ship the parser' },
        { id: 'child-session', parentSessionId: 'root-session', description: 'Parse the payload' },
      ],
    });
    expect(html).toContain('Ship the parser');
    expect(html).not.toContain('Parse the payload');
  });

  it.each([
    { sessionsLoading: true },
    { sessionError: 'Session list failed' },
    { workspacesLoading: true },
    { workspaceError: 'Workspace list failed' },
  ])('keeps all workspace rows visible during loading and errors: %o', (state) => {
    const html = renderSidebar(state);
    expect(html).not.toContain('title="/a">Alpha');
    expect(html).toContain('title="/b">Beta');
    if (state.sessionsLoading || state.sessionError) expect(html).not.toContain('Alpha session');
    if (state.sessionError) expect(html).toContain(state.sessionError);
    if (state.workspaceError) expect(html).toContain(state.workspaceError);
  });

  it('keeps groups expanded across session selection and reuses the list after collapsing', async () => {
    vi.resetModules();
    const hooks: unknown[] = [];
    let cursor = 0;
    vi.doMock('react', async (importOriginal) => {
      const react = await importOriginal<typeof import('react')>();
      return {
        ...react,
        useState: (initial: unknown) => {
          const index = cursor++;
          if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
          return [hooks[index], (next: unknown) => { hooks[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(hooks[index]) : next; }];
        },
        useMemo: (factory: () => unknown) => factory(),
        useEffect: (effect: () => void) => effect(),
        useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      };
    });
    try {
      const { Sidebar: TestSidebar } = await import('../ui/src/components/Sidebar.tsx');
      const { store: testStore, AppStore: TestStore } = await import('../ui/src/lib/store.ts');
      let state = {
        ...new TestStore().getSnapshot(), locale: 'en' as const, workspaces, workspaceId: 'a',
        workspacesLoading: false, sessionsLoading: false, sessionId: 'shared',
        sessions: [{ id: 'shared', title: 'Alpha session' }],
        sessionsByWorkspace: {
          a: { sessions: [{ id: 'shared', title: 'Alpha session' }], loading: false, error: '', loaded: true },
          b: { sessions: [{ id: 'shared', title: 'Beta session' }], loading: false, error: '', loaded: false },
        },
      };
      vi.spyOn(testStore, 'getSnapshot').mockImplementation(() => state);
      const load = vi.spyOn(testStore, 'loadSessions').mockResolvedValue();
      const select = vi.spyOn(testStore, 'selectSession').mockImplementation((id, workspaceId) => {
        state = { ...state, workspaceId: workspaceId!, sessionId: id, sessions: state.sessionsByWorkspace[workspaceId as 'a' | 'b'].sessions };
      });
      type Node = { type?: unknown; props?: { children?: unknown; role?: string; title?: string; className?: string; items?: { id: string; label?: string }[]; onClick?: () => void; onSelect?: (id: string) => void; 'aria-expanded'?: boolean; 'aria-selected'?: boolean } };
      const nodes = (value: unknown): Node[] => {
        if (Array.isArray(value)) return value.flatMap(nodes);
        if (typeof value !== 'object' || value === null) return [];
        const node = value as Node;
        return [node, ...nodes(node.props?.children)];
      };
      const browse = vi.fn();
      const render = () => { cursor = 0; return nodes(TestSidebar({ drawer: false, onClose: () => {}, onBrowseWorkspace: browse })); };
      const row = (tree: Node[], title: string) => tree.find((node) => node.props?.role === 'treeitem' && node.props.title === title)!;
      let tree = render();
      const workspaceRow = (items: Node[], path: string) => items.find((node) => node.props?.role === 'treeitem' && nodes(node.props.children).some((child) => child.props?.title === path))!;
      expect(workspaceRow(tree, '/b').props?.['aria-expanded']).toBe(false);
      const menu = nodes(workspaceRow(tree, '/b')).find((node) => node.props?.items?.some((item) => item.id === 'browse-workspace'))!;
      expect(menu.props?.items?.map((item) => item.id)).toEqual(['browse-workspace', 'remove-workspace']);
      menu.props?.onSelect?.('browse-workspace');
      expect(browse).toHaveBeenCalledWith('b');
      expect(nodes(workspaceRow(tree, '/b')).find((node) => node.type === 'svg')?.props?.className).toBeUndefined();
      workspaceRow(tree, '/b').props?.onClick?.();
      expect(load).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledWith('b', false);
      state = { ...state, sessionsByWorkspace: { ...state.sessionsByWorkspace, b: { ...state.sessionsByWorkspace.b, loaded: true } } };
      tree = render();
      expect(workspaceRow(tree, '/b').props?.['aria-expanded']).toBe(true);
      expect(nodes(workspaceRow(tree, '/b')).find((node) => node.type === 'svg')?.props?.className).toBeTruthy();
      const beta = tree.filter((node) => node.props?.role === 'treeitem' && node.props.title === 'shared')[0]!;
      beta.props?.onClick?.();
      expect(select).toHaveBeenCalledWith('shared', 'b');
      tree = render();
      expect(workspaceRow(tree, '/b').props?.['aria-expanded']).toBe(true);
      expect(row(tree, 'shared').props?.['aria-selected']).toBe(true);
      workspaceRow(tree, '/b').props?.onClick?.();
      tree = render();
      expect(workspaceRow(tree, '/b').props?.['aria-expanded']).toBe(false);
      workspaceRow(tree, '/b').props?.onClick?.();
      tree = render();
      expect(workspaceRow(tree, '/b').props?.['aria-expanded']).toBe(true);
      expect(load).toHaveBeenCalledTimes(1);
      state = { ...state, sessionsByWorkspace: { ...state.sessionsByWorkspace, a: { ...state.sessionsByWorkspace.a, loaded: false } } };
      render();
      expect(load).toHaveBeenCalledWith('a', false);
    } finally {
      vi.doUnmock('react');
      vi.resetModules();
    }
  });

  it('renders cached default sessions below an active workspace with localized labels', () => {
    const html = renderSidebar({
      locale: 'zh',
      workspaceId: 'b',
      sessions: [{ id: 'beta-session', title: 'Beta session' }],
      sessionsByWorkspace: {
        a: { sessions: [{ id: 'alpha-session', title: 'Alpha session' }], loading: false, error: '', loaded: true },
      },
    });
    expect(html.indexOf('>任务<')).toBeGreaterThan(html.indexOf('Beta session'));
    expect(html.indexOf('Alpha session')).toBeGreaterThan(html.indexOf('>任务<'));
    expect(html).not.toContain('title="/a">Alpha');
  });

  it('does not render the local draft as a workspace session', () => {
    const entries = { [JSON.stringify(['a', 'draft-local'])]: { draft: true } } as ReturnType<AppStore['getSnapshot']>['entries'];
    const html = renderSidebar({ sessionId: 'draft-local', sessions: [], entries });
    expect(html).toContain('No sessions yet.');
    expect(html).not.toContain('aria-selected="true"');
  });

  it('names the run state of a session this tab never opened', () => {
    const html = renderSidebar({
      sessions: [{ id: 'ship', description: 'Ship the parser', updatedAt: 1 }],
      statusBySession: {
        [JSON.stringify(['a', 'ship'])]: {
          running: true, pending: 'approval', lastTurnFailed: false, completionUnread: false,
        },
      },
    });
    // The wait outranks the run: the row asks for the user, not the model.
    expect(html).toContain('data-state="warning"');
    expect(html).not.toContain('data-state="ongoing"');
    expect(html).toContain('Waiting for approval');
    expect(html).toContain('>Approval</span>');
    expect(html).not.toContain('New Session');
  });

  it('shows a finished or failed run without opening it, and idles silently', () => {
    const finished = renderSidebar({
      sessions: [{ id: 'done-one', description: 'Done one', updatedAt: 1 }],
      statusBySession: {
        [JSON.stringify(['a', 'done-one'])]: {
          running: false, pending: null, lastTurnFailed: false, completionUnread: true,
        },
      },
    });
    expect(finished).toContain('data-state="done"');
    expect(finished).toContain('Completed');

    const failed = renderSidebar({
      sessions: [{ id: 'bad-one', description: 'Bad one', updatedAt: 1, lastTurn: { endedAt: 1, reason: 'error' } }],
      statusBySession: {
        [JSON.stringify(['a', 'bad-one'])]: {
          running: false, pending: null, lastTurnFailed: true, completionUnread: false,
        },
      },
    });
    expect(failed).toContain('data-state="error"');
    expect(failed).toContain('Failed');

    const idle = renderSidebar({ sessions: [{ id: 'quiet', description: 'Quiet', updatedAt: 1, pinned: true }] });
    expect(idle).not.toContain('data-state=');
    expect(idle).not.toContain('Idle');
  });

  it('reports running subagents on the parent row that is waiting on them', () => {
    const html = renderSidebar({
      sessions: [
        { id: 'root', description: 'Parent work', updatedAt: 2 },
        { id: 'child', parentSessionId: 'root', description: 'Child work', subagentStatus: 'running' },
      ],
    });
    expect(html).not.toContain('Child work');
    expect(html).toContain('data-state="ongoing"');
    expect(html).toContain('1 subagents running');
  });

  it('renders five sessions per group and offers the next five on demand', () => {
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      id: `session-${index}`,
      title: `Session ${index}`,
      updatedAt: 100 - index,
    }));
    const html = renderSidebar({ sessions });
    expect(html).toContain('Session 4');
    expect(html).not.toContain('Session 5');
    expect(html).toContain('Show more (5)');
  });

  it('keeps archived sessions out of the list and offers the archive view', () => {
    const html = renderSidebar({
      sessions: [
        { id: 'visible', title: 'Visible session' },
        { id: 'hidden', title: 'Filed away', archived: true },
      ],
    });
    expect(html).toContain('Visible session');
    expect(html).not.toContain('Filed away');
    expect(html).toContain('aria-label="Archived sessions"');
  });

  it('archives a session from its row menu', async () => {
    vi.resetModules();
    const hooks: unknown[] = [];
    let cursor = 0;
    vi.doMock('react', async (importOriginal) => {
      const react = await importOriginal<typeof import('react')>();
      return {
        ...react,
        useState: (initial: unknown) => {
          const index = cursor++;
          if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
          return [hooks[index], (next: unknown) => { hooks[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(hooks[index]) : next; }];
        },
        useMemo: (factory: () => unknown) => factory(),
        useEffect: (effect: () => void) => effect(),
        useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      };
    });
    try {
      const { Sidebar: TestSidebar } = await import('../ui/src/components/Sidebar.tsx');
      const { store: testStore, AppStore: TestStore } = await import('../ui/src/lib/store.ts');
      const state = {
        ...new TestStore().getSnapshot(), locale: 'en' as const, workspaces, workspaceId: 'a',
        workspacesLoading: false, sessionsLoading: false,
        sessions: [{ id: 'shared', title: 'Alpha session' }],
      };
      vi.spyOn(testStore, 'getSnapshot').mockReturnValue(state);
      const archive = vi.spyOn(testStore, 'setSessionArchived').mockResolvedValue(true);
      type Tree = { props?: { children?: unknown; role?: string; title?: string; items?: Array<{ id: string }>; onSelect?: (id: string) => void } };
      const nodes = (value: unknown): Tree[] => {
        if (Array.isArray(value)) return value.flatMap(nodes);
        if (typeof value !== 'object' || value === null) return [];
        const node = value as Tree;
        return [node, ...nodes(node.props?.children)];
      };
      cursor = 0;
      const tree = nodes(TestSidebar({ drawer: false, onClose: () => {} }));
      const row = tree.find((node) => node.props?.role === 'treeitem' && node.props.title === 'shared')!;
      const menu = nodes(row).find((node) => node.props?.items?.some((item) => item.id === 'archive'))!;
      expect(menu.props?.items?.map((item) => item.id)).toEqual([
        'pin', 'rename', 'fork', 'archive', 'session-actions', 'copy-id', 'session-danger', 'delete',
      ]);
      menu.props?.onSelect?.('archive');
      expect(archive).toHaveBeenCalledWith('shared', true, 'a');
    } finally {
      vi.doUnmock('react');
      vi.resetModules();
    }
  });

  it('opens one archive view for every workspace instead of the active one', async () => {
    vi.resetModules();
    const hooks: unknown[] = [];
    let cursor = 0;
    vi.doMock('react', async (importOriginal) => {
      const react = await importOriginal<typeof import('react')>();
      return {
        ...react,
        useState: (initial: unknown) => {
          const index = cursor++;
          if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
          return [hooks[index], (next: unknown) => { hooks[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(hooks[index]) : next; }];
        },
        useMemo: (factory: () => unknown) => factory(),
        useEffect: (effect: () => void) => effect(),
        useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      };
    });
    try {
      const { Sidebar: TestSidebar } = await import('../ui/src/components/Sidebar.tsx');
      const { store: testStore, AppStore: TestStore } = await import('../ui/src/lib/store.ts');
      type Tree = {
        type?: unknown;
        props?: { children?: unknown; 'aria-label'?: string; disabled?: boolean; onClick?: () => void };
      };
      const nodes = (value: unknown): Tree[] => {
        if (Array.isArray(value)) return value.flatMap(nodes);
        if (typeof value !== 'object' || value === null) return [];
        const node = value as Tree;
        return [node, ...nodes(node.props?.children)];
      };
      const render = (state: Record<string, unknown>): Tree[] => {
        vi.spyOn(testStore, 'getSnapshot').mockReturnValue(state as never);
        cursor = 0;
        return nodes(TestSidebar({ drawer: false, onClose: () => {} }));
      };
      const dialogProps = (tree: Tree[]): string[] | undefined => {
        const dialog = tree.find((node) => typeof node.type === 'function'
          && (node.type as { name?: string }).name === 'ArchivedSessionsDialog');
        return dialog === undefined ? undefined : Object.keys(dialog.props ?? {});
      };
      const state = {
        ...new TestStore().getSnapshot(), locale: 'en' as const, workspaces, workspaceId: 'a',
        workspacesLoading: false, sessionsLoading: false,
        sessions: [{ id: 'shared', title: 'Alpha session' }],
      };
      // Closed until the user asks for it, then rendered without a workspace
      // argument: the dialog reads every workspace's archived rows itself.
      expect(dialogProps(render(state))).toBeUndefined();
      const open = render(state).find((node) => node.props?.['aria-label'] === 'Archived sessions')!;
      expect(open.props?.disabled).not.toBe(true);
      open.props?.onClick?.();
      expect(dialogProps(render(state))).toEqual(['onClose']);
      // The trigger is not tied to a selected workspace any more, so the archive
      // list stays reachable before one is chosen.
      const noWorkspace = render({ ...state, workspaceId: null, sessions: [] });
      expect(noWorkspace.find((node) => node.props?.['aria-label'] === 'Archived sessions')?.props?.disabled)
        .not.toBe(true);
    } finally {
      vi.doUnmock('react');
      vi.resetModules();
    }
  });

  it('shows the newly active workspace sessions after a switch', () => {
    const html = renderSidebar({
      workspaceId: 'b',
      sessions: [{ id: 'beta-session', description: 'Beta session' }],
    });
    expect(html).toContain('Beta session');
    expect(html).not.toContain('Alpha session');
    expect(html).not.toContain('title="/a">Alpha');
    expect(html).toContain('title="/b">Beta');
  });
});
