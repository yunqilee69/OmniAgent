import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFileTree } from '../ui/src/components/WorkspaceFileTree.tsx';
import { WorkspaceFilePreview } from '../ui/src/components/WorkspaceFilePreview.tsx';
import { FileTreeMenu } from '../ui/src/components/FileTreeMenu.tsx';
import { AppStore, store } from '../ui/src/lib/store.ts';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});

afterEach(() => { vi.restoreAllMocks(); });

describe('workspace file browser UI', () => {
  it('identifies the browsed workspace and provides a back control', () => {
    vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...new AppStore(false).getSnapshot(), locale: 'en' });
    const html = renderToStaticMarkup(createElement(WorkspaceFileTree, {
      workspaceId: 'other',
      workspacePath: '/tmp/other',
      name: 'Other workspace',
      selected: null,
      refreshToken: 0,
      onBack: () => {},
      onSelect: () => {},
      onChanged: () => {},
    }));
    expect(html).toContain('Other workspace');
    expect(html).toContain('aria-label="Back to workspaces"');
    expect(html).toContain('Loading files');
  });

  it('loads a preview without repeating the workspace the session already fixes', () => {
    vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...new AppStore(false).getSnapshot(), locale: 'en' });
    const html = renderToStaticMarkup(createElement(WorkspaceFilePreview, {
      file: { workspaceId: 'other', workspaceName: 'Other workspace', path: 'src/<file>.ts' },
    }));
    expect(html).toContain('Loading file');
    expect(html).not.toContain('Other workspace');
  });

  it('keeps the file menu closed until an entry is targeted', () => {
    vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...new AppStore(false).getSnapshot(), locale: 'en' });
    const html = renderToStaticMarkup(createElement(FileTreeMenu, {
      workspaceId: 'other',
      workspacePath: '/tmp/other',
      target: null,
      onClose: () => {},
      onChanged: () => {},
    }));
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('Rename');
  });
});
