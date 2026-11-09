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
  it('renders every workspace and only the active workspace sessions', () => {
    const html = renderSidebar();
    expect(html).toContain('Alpha session');
    expect(html).toContain('title="/a">Alpha');
    expect(html).toContain('title="/b">Beta');
    expect(html).toContain('New session in Alpha');
    expect(html).toContain('New session in Beta');
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
  });

  it.each([
    { sessionsLoading: true },
    { sessionError: 'Session list failed' },
    { workspacesLoading: true },
    { workspaceError: 'Workspace list failed' },
  ])('keeps all workspace rows visible during loading and errors: %o', (state) => {
    const html = renderSidebar(state);
    expect(html).toContain('title="/a">Alpha');
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
      type Node = { props?: { children?: unknown; role?: string; title?: string; onClick?: () => void; 'aria-expanded'?: boolean; 'aria-selected'?: boolean } };
      const nodes = (value: unknown): Node[] => {
        if (Array.isArray(value)) return value.flatMap(nodes);
        if (typeof value !== 'object' || value === null) return [];
        const node = value as Node;
        return [node, ...nodes(node.props?.children)];
      };
      const render = () => { cursor = 0; return nodes(TestSidebar({ drawer: false, onClose: () => {} })); };
      const row = (tree: Node[], title: string) => tree.find((node) => node.props?.role === 'treeitem' && node.props.title === title)!;
      let tree = render();
      const workspaceRow = (items: Node[], path: string) => items.find((node) => node.props?.role === 'treeitem' && nodes(node.props.children).some((child) => child.props?.title === path))!;
      expect(workspaceRow(tree, '/a').props?.['aria-expanded']).toBe(true);
      workspaceRow(tree, '/b').props?.onClick?.();
      expect(load).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledWith('b', false);
      state = { ...state, sessionsByWorkspace: { ...state.sessionsByWorkspace, b: { ...state.sessionsByWorkspace.b, loaded: true } } };
      tree = render();
      expect(workspaceRow(tree, '/a').props?.['aria-expanded']).toBe(true);
      expect(workspaceRow(tree, '/b').props?.['aria-expanded']).toBe(true);
      const beta = tree.filter((node) => node.props?.role === 'treeitem' && node.props.title === 'shared')[1]!;
      beta.props?.onClick?.();
      expect(select).toHaveBeenCalledWith('shared', 'b');
      tree = render();
      expect(workspaceRow(tree, '/a').props?.['aria-expanded']).toBe(true);
      expect(workspaceRow(tree, '/b').props?.['aria-expanded']).toBe(true);
      expect(row(tree, 'shared').props?.['aria-selected']).toBe(false);
      workspaceRow(tree, '/b').props?.onClick?.();
      tree = render();
      expect(workspaceRow(tree, '/b').props?.['aria-expanded']).toBe(false);
      workspaceRow(tree, '/b').props?.onClick?.();
      tree = render();
      expect(workspaceRow(tree, '/b').props?.['aria-expanded']).toBe(true);
      expect(load).toHaveBeenCalledTimes(1);
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
    expect(html).toContain('title="/a">Alpha');
    expect(html).toContain('title="/b">Beta');
  });
});
