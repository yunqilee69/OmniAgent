import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { readWidthPreference, resolveContentWidth, WIDTH_PREF_KEY } from '../ui/src/lib/conversation-width.ts';

describe('conversation width', () => {
  it('takes 64% of the column, clamped between 680 and 920', () => {
    expect(resolveContentWidth(800, null)).toBe(680);
    expect(resolveContentWidth(1200, null)).toBe(768);
    expect(resolveContentWidth(1600, null)).toBe(920);
  });

  it('clamps a dragged preference to the room the handles leave', () => {
    expect(resolveContentWidth(1600, 970)).toBe(970);
    expect(resolveContentWidth(900, 970)).toBe(724);
    expect(resolveContentWidth(1600, 100)).toBe(640);
  });

  it('reads only a positive finite preference', () => {
    const values = new Map<string, string>([[WIDTH_PREF_KEY, '970']]);
    const storage = { getItem: (key: string) => values.get(key) ?? null };
    expect(readWidthPreference(storage)).toBe(970);
    values.set(WIDTH_PREF_KEY, 'huge');
    expect(readWidthPreference(storage)).toBeNull();
    values.set(WIDTH_PREF_KEY, '0');
    expect(readWidthPreference(storage)).toBeNull();
    expect(readWidthPreference(null)).toBeNull();
  });

  it('sizes the column from the measured width and keeps the composer 32px wider', () => {
    const css = readFileSync(new URL('../ui/src/styles/app.module.css', import.meta.url), 'utf8');
    expect(css).toMatch(/clamp\(680px, calc\(var\(--dsh-conversation-column-width, 0px\) \* 0\.64\), 920px\)/);
    expect(css).toMatch(/--dsh-composer-card-max-width:\s*calc\(var\(--dsh-chat-content-width\) \+ 32px\)/);
    expect(css).toContain('.widthHandle');
    const table = readFileSync(new URL('../ui/vendor/primitives/markdown/MarkdownText.module.css', import.meta.url), 'utf8');
    expect(table).toMatch(/max-width:\s*var\(--dsh-chat-table-cell-max, 320px\)/);
  });

  it('mounts a handle on each side of the transcript', () => {
    const originalConsoleError = console.error;
    const consoleError = vi.spyOn(console, 'error').mockImplementation((message, ...args) => {
      if (typeof message !== 'string' || !message.includes('useLayoutEffect does nothing on the server')) {
        originalConsoleError(message, ...args);
      }
    });
    return import('../ui/src/components/ConversationWidth.tsx').then(({ ConversationWidth }) => {
      try {
        const markup = renderToStaticMarkup(createElement(ConversationWidth));
        expect(markup).toContain('data-width-handle="left"');
        expect(markup).toContain('data-width-handle="right"');
      } finally {
        consoleError.mockRestore();
      }
    });
  });
});
