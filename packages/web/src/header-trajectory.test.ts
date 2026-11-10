import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Header } from '../ui/src/components/Header.tsx';
import { RightPanel } from '../ui/src/components/RightPanel.tsx';
import { AppStore, store } from '../ui/src/lib/store.ts';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useLayoutEffect: react.useEffect,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

afterEach(() => { vi.restoreAllMocks(); });

function setSession(entry: Record<string, unknown>): void {
  const initial = new AppStore(false).getSnapshot();
  vi.spyOn(store, 'getSnapshot').mockReturnValue({
    ...initial,
    locale: 'en',
    workspaceId: 'workspace',
    sessionId: 'session',
    entries: { [JSON.stringify(['workspace', 'session'])]: entry as unknown as (typeof initial.entries)[string] },
  });
}

const headerProps = {
  sidebarOpen: false,
  rightOpen: false,
  onToggleSidebar: () => {},
  onToggleRight: () => {},
};

describe('conversation header and trajectory entry', () => {
  it.each([
    { name: 'ready', entry: { plan: { active: false } } },
    { name: 'running', entry: { run: {}, plan: { active: false } } },
    { name: 'approval', entry: { run: { approval: {} }, plan: { active: false } } },
    { name: 'error', entry: { error: 'failed', plan: { active: false } } },
    { name: 'plan mode', entry: { plan: { active: true } } },
  ])('hides header status and trajectory while $name', ({ entry }) => {
    setSession({ ...entry, title: 'Example session' });
    const html = renderToStaticMarkup(createElement(Header, headerProps));
    expect(html).toContain('Example session');
    expect(html).toContain('aria-label="Show sidebar"');
    expect(html).toContain('aria-label="Expand panel"');
    expect(html).toContain('aria-label="Export session"');
    expect(html).not.toContain('data-tone=');
    expect(html).not.toContain('aria-label="Open trajectory"');
  });

  it('retains the trajectory entry on the right panel guide', () => {
    setSession({ title: 'Example session', plan: { active: false } });
    const html = renderToStaticMarkup(createElement(RightPanel, {
      fullscreen: false,
      view: 'guide',
      onViewChange: () => {},
      onClose: () => {},
      onToggleFullscreen: () => {},
    }));
    expect(html).toContain('>Observe</span>');
    expect(html).toContain('>Workspace files</span>');
    expect(html).toContain('>New terminal</span>');
    expect(html).toContain('aria-label="Collapse panel"');
  });
});
