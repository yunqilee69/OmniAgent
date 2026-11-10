import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewSurface } from '../ui/src/components/preview/PreviewSurface.tsx';
import { CodeViewer } from '../ui/src/components/preview/viewers/CodeViewer.tsx';
import { DocxViewer } from '../ui/src/components/preview/viewers/DocxViewer.tsx';
import { ImageViewer } from '../ui/src/components/preview/viewers/ImageViewer.tsx';
import { MarkdownViewer } from '../ui/src/components/preview/viewers/MarkdownViewer.tsx';
import { MediaViewer } from '../ui/src/components/preview/viewers/MediaViewer.tsx';
import { PdfViewer } from '../ui/src/components/preview/viewers/PdfViewer.tsx';
import { SheetViewer } from '../ui/src/components/preview/viewers/SheetViewer.tsx';
import { TextViewer } from '../ui/src/components/preview/viewers/TextViewer.tsx';
import { UnsupportedViewer } from '../ui/src/components/preview/viewers/UnsupportedViewer.tsx';
import { RightPanel } from '../ui/src/components/RightPanel.tsx';
import { AppStore, store } from '../ui/src/lib/store.ts';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});

afterEach(() => { vi.restoreAllMocks(); });

function englishStore(): void {
  vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...new AppStore(false).getSnapshot(), locale: 'en' });
}

const file = { workspaceId: 'ws', workspaceName: 'Demo workspace', path: 'docs/guide.md' };

describe('preview surface', () => {
  it('loads the body without repeating the file identity the dock tab already shows', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(PreviewSurface, { file }));
    expect(html).toContain('aria-label="Loading file…"');
    // The tab names the file and the session fixes the workspace, so the body has no header of its own.
    expect(html).not.toContain('Demo workspace');
    expect(html).not.toContain('guide.md');
    expect(html).not.toContain('aria-label="Download"');
    expect(html).not.toContain('aria-label="Copy file path"');
    expect(html).not.toContain('aria-label="Open in new tab"');
  });

  it('keeps the same headerless frame for every kind', () => {
    englishStore();
    for (const path of ['cover.png', 'manual.pdf', 'report.docx', 'data.csv', 'src/app.ts']) {
      const html = renderToStaticMarkup(createElement(PreviewSurface, { file: { ...file, path } }));
      expect(html).toContain('Loading file…');
      expect(html).not.toContain('aria-label="Download"');
    }
  });
});

describe('preview tab', () => {
  it('names the dock tab after the previewed file', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(RightPanel, {
      fullscreen: false,
      view: 'preview',
      preview: { workspaceId: 'ws', workspaceName: 'Demo workspace', path: 'docs/guide.md' },
      onViewChange: () => {},
      onClose: () => {},
      onToggleFullscreen: () => {},
    }));
    expect(html).toContain('File preview｜guide.md');
    expect(html).toContain('aria-label="File preview｜guide.md"');
    // The workspace already scopes the session, so the tab does not repeat it.
    expect(html).not.toContain('Demo workspace');
  });

  it('keeps the plain label when no file is selected', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(RightPanel, {
      fullscreen: false,
      view: 'guide',
      preview: null,
      onViewChange: () => {},
      onClose: () => {},
      onToggleFullscreen: () => {},
    }));
    expect(html).toContain('Start');
  });
});

describe('preview viewers', () => {
  it('renders plain text with a line count', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(TextViewer, {
      workspaceId: 'ws', path: 'notes.txt', text: 'alpha\nbeta\n',
    }));
    expect(html).toContain('3 lines');
    expect(html).toContain('alpha');
  });

  it('numbers code lines and shows the grammar', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(CodeViewer, {
      workspaceId: 'ws', path: 'src/app.ts', text: 'const x = 1;\n',
    }));
    expect(html).toContain('2 lines');
    expect(html).toContain('typescript');
    // Tokens are split per shiki span, so assert the pieces the highlighter emits.
    expect(html).toContain('shiki-token-keyword');
    expect(html).toContain('>const</span>');
  });

  it('renders markdown through the shared markdown pipeline', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(MarkdownViewer, {
      workspaceId: 'ws', path: 'README.md', text: '# Title\n\nBody text.\n',
    }));
    expect(html).toContain('<h1');
    expect(html).toContain('Title');
    expect(html).toContain('Body text.');
  });

  it('frames a PDF through the raw route', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(PdfViewer, {
      workspaceId: 'ws', path: 'docs/manual.pdf', url: '/api/workspaces/ws/files/raw?path=docs%2Fmanual.pdf',
    }));
    expect(html).toContain('<iframe');
    expect(html).toContain('manual.pdf');
    expect(html).toContain('Rendered by your browser');
  });

  it('shows a document toolbar before the Word body is parsed', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(DocxViewer, { workspaceId: 'ws', path: 'spec.docx' }));
    expect(html).toContain('Word document');
    expect(html).not.toContain('aria-label="Download"');
  });

  it('labels a CSV source and an empty sheet honestly', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(SheetViewer, {
      workspaceId: 'ws', path: 'data.csv', text: 'a,b\n1,2\n',
    }));
    expect(html).toContain('CSV');
    // The grid is built in an effect, so the server pass shows the empty state.
    expect(html).toContain('This sheet is empty.');
  });

  it('renders media through the raw route', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(MediaViewer, {
      workspaceId: 'ws', path: 'clip.mp4', url: '/api/workspaces/ws/files/raw?path=clip.mp4',
    }));
    expect(html).toContain('<video');
    expect(html).toContain('controls');
  });

  it('shows an image with its toolbar', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(ImageViewer, {
      workspaceId: 'ws', path: 'cover.png', url: '/api/workspaces/ws/files/raw?path=cover.png',
    }));
    expect(html).toContain('<img');
    expect(html).toContain('cover.png');
    expect(html).toContain('Actual size');
  });

  it('offers download and a new tab for a type without a viewer', () => {
    englishStore();
    const html = renderToStaticMarkup(createElement(UnsupportedViewer, { workspaceId: 'ws', path: 'bundle.zip' }));
    expect(html).toContain('Cannot preview this file type');
    expect(html).toContain('Download');
    expect(html).toContain('Open in new tab');
  });
});
