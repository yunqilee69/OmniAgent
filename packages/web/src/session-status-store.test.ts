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

/** One settings payload, matching the single bootstrap request the page now makes. */
function bootstrapBody(): Record<string, unknown> {
  return {
    permissions: { defaultPreset: 'workspace-write', requiresSelection: false },
    askUser: { timeoutSec: 300, requiresSelection: false },
    webSearch: { apiKeyConfigured: false, maxResults: 5, requiresRepair: false },
    archive: { enabled: false, retentionMs: 7 * 24 * 60 * 60 * 1000, requiresSelection: false },
    models: [],
    agents: [],
    roles: [],
    roleEntries: { roles: [] },
    modelSources: { sources: [], providers: [], protocols: [] },
    mcpServers: { servers: [], transports: [] },
    modes: { modes: [], defaultMode: 'standard' },
  };
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
  /** Body returned for one session's detail request. */
  setDetail: (sessionId: string, body: unknown) => void;
}

/**
 * Boot a store whose workspace lists two sessions, one of them open, and whose
 * status stream is driven by the test instead of a host.
 */
async function boot(options: { sessions?: unknown[] } = {}): Promise<Harness> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const disconnected = vi.fn();
  let sessions = options.sessions ?? [{ id: 'open', updatedAt: 5 }, { id: 'background', updatedAt: 4 }];
  const details = new Map<string, unknown>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input);
    const url = raw.split('?')[0] ?? raw;
    const method = init?.method ?? 'GET';
    if (url === '/api/workspaces' && method === 'GET') {
      return json({ workspaces: [{ id: 'a', name: 'Alpha', path: '/a' }] });
    }
    if (url === '/api/bootstrap' && method === 'GET') return json(bootstrapBody());
    if (url === '/api/workspaces/a/events' && method === 'GET') {
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) { controller = stream; },
        cancel() { disconnected(); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url === '/api/workspaces/a/sessions' && method === 'GET') return json({ sessions });
    if (url.startsWith('/api/workspaces/a/sessions/') && method === 'GET') {
      return json(details.get(url.slice(url.lastIndexOf('/') + 1)) ?? detail);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  const store = new AppStore();
  await store.bootstrap();
  await waitFor(() => controller !== undefined);
  return {
    store,
    push: (frame) => controller.enqueue(encode(frame)),
    setSessions: (next) => { sessions = next; },
    setDetail: (sessionId, body) => { details.set(sessionId, body); },
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
        { id: 'failed', updatedAt: 3, running: false },
      ],
    });
    expect(live(store, 'open')).toEqual(IDLE_SESSION_STATE);
    expect(live(store, 'background')).toMatchObject({ running: true, pending: 'plan-review' });
    // The list no longer carries the transcript, so a session that was never
    // opened does not arrive already marked failed.
    expect(live(store, 'failed')).toMatchObject({ running: false, lastTurnFailed: false, completionUnread: false });
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
    const { store, push, setDetail } = await boot({
      sessions: [{ id: 'open', updatedAt: 5 }, { id: 'background', updatedAt: 4, running: false }],
    });
    // The failure is learned by opening the session, not from the list.
    setDetail('background', {
      ...detail,
      events: [{ type: 'trace/turn.end', seq: 1, ts: 2, data: { reason: 'error' } }],
    });
    store.selectSession('background');
    await waitFor(() => live(store, 'background').lastTurnFailed);
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
      { id: 'background', updatedAt: 9, running: false },
    ]);
    push({ type: 'session.status', sessionId: 'background', running: false, pending: null });
    await waitFor(() => live(store, 'background').completionUnread);
    // The reload is deferred so a burst of endings becomes one list request.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(live(store, 'background').lastTurnFailed).toBe(false);
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

interface BackoffHarness {
  store: AppStore;
  /** Delays the stream reconnect asked setTimeout for, in order. */
  delays: number[];
  /** How many status-stream attachments were attempted. */
  attempts: () => number;
}

/**
 * Boot a store whose workspace status stream is served by `serve`, and record the
 * reconnect delays the store asks for instead of waiting them out.
 * @param serve - builds the response for the Nth attachment attempt.
 */
async function bootStream(serve: (attempt: number) => Response): Promise<BackoffHarness> {
  const delays: number[] = [];
  let attempts = 0;
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    // Only the reconnect backoff reaches into this range; test polling uses 1ms.
    if (typeof ms === 'number' && ms >= 1_000 && ms <= 30_000) delays.push(ms);
    return realSetTimeout(handler as () => void, 0, ...args);
  }) as typeof setTimeout);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input);
    const url = raw.split('?')[0] ?? raw;
    const method = init?.method ?? 'GET';
    if (url === '/api/workspaces' && method === 'GET') {
      return json({ workspaces: [{ id: 'a', name: 'Alpha', path: '/a' }] });
    }
    if (url === '/api/bootstrap' && method === 'GET') return json(bootstrapBody());
    if (url === '/api/workspaces/a/events' && method === 'GET') {
      attempts += 1;
      return serve(attempts);
    }
    if (url === '/api/workspaces/a/sessions' && method === 'GET') return json({ sessions: [{ id: 'open', updatedAt: 5 }] });
    if (url.startsWith('/api/workspaces/a/sessions/') && method === 'GET') return json(detail);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  const store = new AppStore();
  await store.bootstrap();
  await waitFor(() => attempts >= 1);
  return { store, delays, attempts: () => attempts };
}

/** A status stream that closes itself straight away. */
function closingStream(frame?: string): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (frame !== undefined) controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

describe('workspace status stream backoff', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('backs off from one second to the thirty second cap after repeated drops', async () => {
    const harness = await bootStream(() => closingStream());
    await waitFor(() => harness.delays.length >= 7, 4_000);
    expect(harness.delays.slice(0, 7)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    harness.store.dispose();
  });

  it('starts over once the stream delivers data again', async () => {
    // Every attachment replays one frame, so the attempt counter never grows.
    const harness = await bootStream(() =>
      closingStream('data: {"type":"session.status","sessionId":"open","running":false,"pending":null}\n\n'));
    await waitFor(() => harness.delays.length >= 3, 4_000);
    expect(harness.delays.every((delay) => delay === 1_000)).toBe(true);
    harness.store.dispose();
  });

  it('does not reconnect when the stream never worked', async () => {
    const harness = await bootStream(() => json({ error: 'not found' }, 404));
    const seen = harness.attempts();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.attempts()).toBe(seen);
    expect(harness.delays).toEqual([]);
    harness.store.dispose();
  });

  it('stops reconnecting once the store is disposed', async () => {
    const harness = await bootStream(() => closingStream());
    await waitFor(() => harness.delays.length >= 2, 4_000);
    harness.store.dispose();
    const seen = harness.attempts();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.attempts()).toBe(seen);
  });
});
