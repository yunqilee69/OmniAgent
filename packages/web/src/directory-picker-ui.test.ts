import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectoryPicker } from '../ui/src/components/DirectoryPicker.tsx';
import { AppStore, store } from '../ui/src/lib/store.ts';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});

function englishStore(): void {
  vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...new AppStore(false).getSnapshot(), locale: 'en' });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('workspace directory picker', () => {
  it('shows navigation chrome instead of a dependent free-text path field', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(DirectoryPicker, { initialPath: '/Users/you' }));
    expect(html).toContain('aria-label="Quick locations"');
    expect(html).toContain('aria-label="Refresh"');
    expect(html).toContain('aria-label="Folders"');
    expect(html).toContain('Loading folders');
  });

  it('keeps going up inside the list as its first row', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(DirectoryPicker, { initialPath: '/Users/you' }));
    const list = html.slice(html.indexOf('aria-label="Folders"'));
    const parent = list.indexOf('aria-label="Up one level"');
    expect(parent).toBeGreaterThan(-1);
    expect(list).toContain('>..<');
    // Nothing else may be listed before the parent row.
    expect(list.indexOf('Loading folders')).toBeGreaterThan(parent);
  });

  it('keeps the path bar editable so a known path can be typed or pasted', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(DirectoryPicker, { initialPath: '/Users/you/project' }));
    expect(html).toContain('value="/Users/you/project"');
    expect(html).toContain('aria-label="Folder path"');
    expect(html).toContain('data-modal-autofocus="true"');
  });
});
