import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore, sessionKey } from '../ui/src/lib/store.ts';
import { IDLE_SESSION_STATE } from '../ui/src/lib/session-status.ts';
import type { SessionStatusEvent } from '../ui/src/lib/wire.ts';

const detail = {
  header: { cwd: '/workspace' },
  permission: { preset: 'workspace-write' },
  agent: undefined,
  model: { version: 2, kind: 'agent' },
  resolvedModel: null,
  agentError: null,
  agentWarnings: [],
  plan: { active: false },
  todos: null,
  running: false,
  messages: [],
  events: [],
  audit: [],
  trajectory: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function encode(frame: SessionStatusEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

interface Harness {
  store: AppStore;
  push: (frame: SessionStatusEvent) => void;
  setSessions: (sessions: unknown[]) => void;
}

/**
 * Boot a store whose workspace lists two sessions, one of them open, and whose
 * status stream is driven by the test instead of a host.
 */
async function boot(options: { sessions?: unknown[] } = {}): Promise<Harness> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const disconnected = vi.fn();
  let sessions = options.sessions ?? [{ id: 'open', updatedAt: 5 }, { id: 'background', updatedAt: 4 }];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/workspaces' && method === 'GET') {
      return json({ workspaces: [{ id: 'a', name: 'Alpha', path: '/a' }] });
    }
    if (url === '/api/settings/permissions' && method === 'GET') {
      return json({ settings: { defaultPreset: 'workspace-write', requiresSelection: false } });
    }
    if (url === '/api/models' && method === 'GET') return json({ models: [] });
    if (url === '/api/agents' && method === 'GET') return json({ agents: [] });
    if (url === '/api/roles' && method === 'GET') return json({ roles: [] });
    if (url === '/api/workspaces/a/events' && method === 'GET') {
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) { controller = stream; },
        cancel() { disconnected(); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url === '/api/workspaces/a/sessions' && method === 'GET') return json({ sessions });
    if (url.startsWith('/api/workspaces/a/sessions/') && method === 'GET') return json(detail);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  const store = new AppStore();
  await store.bootstrap();
  await waitFor(() => controller !== undefined);
  return {
    store,
    push: (frame) => controller.enqueue(encode(frame)),
    setSessions: (next) => { sessions = next; },
  };
}

function live(store: AppStore, sessionId: string) {
  return store.getSnapshot().statusBySession[sessionKey('a', sessionId)] ?? IDLE_SESSION_STATE;
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal('navigator', { locks: { request: <T>(_name: string, callback: () => Promise<T> | T): Promise<T> => Promise.resolve(callback()) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace session status in the store', () => {
  it('seeds every listed session from the host baseline, including ones never opened', async () => {
    const { store } = await boot({
      sessions: [
        { id: 'open', updatedAt: 5 },
        { id: 'background', updatedAt: 4, running: true, pending: 'plan-review' },
        { id: 'failed', updatedAt: 3, running: false, lastTurn: { endedAt: 2, reason: 'error' } },
      ],
    });
    expect(live(store, 'open')).toEqual(IDLE_SESSION_STATE);
    expect(live(store, 'background')).toMatchObject({ running: true, pending: 'plan-review' });
    expect(live(store, 'failed')).toMatchObject({ running: false, lastTurnFailed: true, completionUnread: false });
    store.dispose();
  });

  it('keeps an unread completion for a background run and clears it when opened', async () => {
    const { store, push } = await boot();
    push({ type: 'session.status', sessionId: 'background', running: true, pending: null });
    await waitFor(() => live(store, 'background').running);
    expect(live(store, 'background')).toMatchObject({ running: true, pending: null, completionUnread: false });

    push({ type: 'session.status', sessionId: 'background', running: true, pending: 'approval' });
    await waitFor(() => live(store, 'background').pending === 'approval');

    push({ type: 'session.status', sessionId: 'background', running: false, pending: null });
    await waitFor(() => live(store, 'background').completionUnread);
    expect(live(store, 'background')).toMatchObject({ running: false, pending: null, completionUnread: true });

    store.selectSession('background');
    expect(live(store, 'background').completionUnread).toBe(false);
    store.dispose();
  });

  it('does not mark the session the user is watching as unread', async () => {
    const { store, push } = await boot();
    push({ type: 'session.status', sessionId: 'open', running: true, pending: null });
    await waitFor(() => live(store, 'open').running);
    push({ type: 'session.status', sessionId: 'open', running: false, pending: null });
    await waitFor(() => !live(store, 'open').running);
    expect(live(store, 'open').completionUnread).toBe(false);
    store.dispose();
  });

  it('drops a stale reminder and the failure mark when the session runs again', async () => {
    const { store, push } = await boot({
      sessions: [{ id: 'open', updatedAt: 5 }, { id: 'background', updatedAt: 4, running: false, lastTurn: { endedAt: 2, reason: 'error' } }],
    });
    expect(live(store, 'background').lastTurnFailed).toBe(true);
    push({ type: 'session.status', sessionId: 'background', running: true, pending: null });
    await waitFor(() => live(store, 'background').running);
    expect(live(store, 'background')).toMatchObject({ lastTurnFailed: false, completionUnread: false });
    store.dispose();
  });

  it('re-reads the list after a run ends, without blanking the sidebar', async () => {
    const harness = await boot();
    const { store, push } = harness;
    push({ type: 'session.status', sessionId: 'background', running: true, pending: null });
    await waitFor(() => live(store, 'background').running);
    // The host settles the row's outcome and ordering only after the run ends.
    harness.setSessions([
      { id: 'open', updatedAt: 5 },
      { id: 'background', updatedAt: 9, running: false, lastTurn: { endedAt: 8, reason: 'error' } },
    ]);
    push({ type: 'session.status', sessionId: 'background', running: false, pending: null });
    await waitFor(() => live(store, 'background').lastTurnFailed);
    expect(live(store, 'background').completionUnread).toBe(true);
    const list = store.getSnapshot().sessionsByWorkspace.a!;
    expect(list.loading).toBe(false);
    expect(list.sessions.find((session) => session.id === 'background')?.updatedAt).toBe(9);
    store.dispose();
  });

  it('ignores frames for unknown shapes and keeps the baseline when the stream drops', async () => {
    const { store, push } = await boot();
    push({ type: 'session.status', sessionId: 42, running: true, pending: null } as never);
    push({ type: 'run.snapshot' } as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(live(store, 'background')).toEqual(IDLE_SESSION_STATE);
    store.dispose();
  });
});
