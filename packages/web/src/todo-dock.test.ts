import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Composer, TodoDock } from '../ui/src/components/Composer.tsx';
import { createLiveState } from '../ui/src/lib/events.ts';
import { translator } from '../ui/src/lib/i18n.ts';
import { AppStore, sessionKey, store } from '../ui/src/lib/store.ts';
import type { SessionEntry } from '../ui/src/lib/store.ts';

const t = translator('en');
const todos: NonNullable<SessionEntry['todos']> = [
  { content: 'First task', status: 'completed' },
  { content: 'Second task', status: 'in_progress' },
];

function render(entry: Pick<SessionEntry, 'todos' | 'run' | 'running'> | null): string {
  return renderToStaticMarkup(createElement(TodoDock, { entry, t }));
}

describe('task dock', () => {
  it('shows task progress during a local run and hides it after the run ends', () => {
    const entry = { todos, running: false, run: createLiveState() };
    expect(render(entry)).toContain('aria-label="Task list"');
    expect(render(entry)).toContain('1 done');
    expect(render(entry)).toContain('1 active');
    expect(render({ todos, running: false })).toBe('');
  });

  it('shows tasks for a run in another tab and hides them once it ends', () => {
    expect(render({ todos, running: true })).toContain('aria-label="Task list"');
    expect(render({ todos, running: false })).toBe('');
  });

  it('does not show an empty task list or a missing session', () => {
    expect(render(null)).toBe('');
    expect(render({ todos: null, running: true })).toBe('');
    expect(render({ todos: [], running: true })).toBe('');
  });

  it('stacks the task list above the composer input', () => {
    const workspaceId = 'workspace';
    const sessionId = 'session';
    const entry = {
      draft: false,
      plan: { active: false },
      queued: [],
      todos,
      running: true,
      loaded: false,
      loading: false,
      permission: null,
      permissionSaving: false,
      permissionError: '',
      agent: null,
      agentSaving: false,
      agentError: '',
      agentWarnings: [],
      agentSkills: null,
      binding: null,
      resolvedModel: null,
      modelSaving: false,
      modelError: '',
      planSaving: false,
      planError: '',
    } as unknown as SessionEntry;
    const state = {
      ...new AppStore().getSnapshot(),
      locale: 'en' as const,
      workspaceId,
      sessionId,
      entries: { [sessionKey(workspaceId, sessionId)]: entry },
    };
    const spy = vi.spyOn(store, 'getSnapshot').mockReturnValue(state);
    const originalConsoleError = console.error;
    const consoleError = vi.spyOn(console, 'error').mockImplementation((message, ...args) => {
      if (typeof message !== 'string' || !message.includes('useLayoutEffect does nothing on the server')) {
        originalConsoleError(message, ...args);
      }
    });
    try {
      const html = renderToStaticMarkup(createElement(Composer, {}));
      expect(html).toContain('aria-label="Task list"');
      expect(html.indexOf('aria-label="Task list"')).toBeLessThan(html.indexOf('<textarea'));
    } finally {
      consoleError.mockRestore();
      spy.mockRestore();
    }
  });
});
