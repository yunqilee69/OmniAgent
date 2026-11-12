import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../ui/src/components/Composer.tsx';
import { store, AppStore, sessionKey } from '../ui/src/lib/store.ts';
import type { SessionEntry } from '../ui/src/lib/store.ts';

const workspaceId = 'workspace';
const sessionId = 'session';

function renderComposer(entry: Partial<SessionEntry>): string {
  const state = {
    ...new AppStore().getSnapshot(),
    locale: 'en' as const,
    workspaceId,
    sessionId,
    entries: { [sessionKey(workspaceId, sessionId)]: entry as SessionEntry },
  };
  const spy = vi.spyOn(store, 'getSnapshot').mockReturnValue(state);
  const originalConsoleError = console.error;
  const consoleError = vi.spyOn(console, 'error').mockImplementation((message, ...args) => {
    if (typeof message !== 'string' || !message.includes('useLayoutEffect does nothing on the server')) {
      originalConsoleError(message, ...args);
    }
  });
  try {
    return renderToStaticMarkup(createElement(Composer, {}));
  } finally {
    consoleError.mockRestore();
    spy.mockRestore();
  }
}

describe('queued message dock', () => {
  it('stacks queued messages above the composer input', () => {
    const html = renderComposer({
      draft: false,
      loaded: true,
      plan: { active: false },
      queued: [{ id: 'q1', text: 'follow up later', attachments: [], createdAt: 1 }],
      running: true,
    });
    expect(html).toContain('aria-label="Queued messages"');
    expect(html).toContain('follow up later');
    expect(html.indexOf('aria-label="Queued messages"')).toBeLessThan(html.indexOf('<textarea'));
  });

  it('hides the dock when nothing is queued', () => {
    const html = renderComposer({ draft: false, loaded: true, plan: { active: false }, queued: [], running: true });
    expect(html).not.toContain('aria-label="Queued messages"');
  });
});
