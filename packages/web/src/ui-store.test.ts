import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../ui/src/lib/store.ts';
import { groupTurns } from '../ui/src/lib/events.ts';
import type { AgentSummary } from '../ui/src/lib/wire.ts';

const defaultAgent: AgentSummary = {
  id: 'default', name: 'Default', description: '', role: 'default',
  usage: 'both', profile: 'default', valid: true, warnings: [],
};
const writerAgent: AgentSummary = {
  id: 'writer', name: 'Writer', description: 'Writes code', role: 'default',
  usage: 'primary', profile: 'default', valid: true, warnings: [],
};
const explorerAgent: AgentSummary = {
  id: 'explorer', name: 'Explorer', description: '', role: 'default',
  usage: 'subagent', profile: 'default', valid: true, warnings: [],
};

const standardMode = {
  id: 'standard',
  name: 'Standard',
  description: '',
  agent: 'default',
  model: { version: 2, kind: 'agent' },
  tools: '*',
  skills: '*',
  builtIn: true,
  customized: false,
  valid: true,
  warnings: [],
};

interface DetailOptions {
  text?: string;
  agent?: AgentSummary;
  binding?: unknown;
  permission?: string | null;
  plan?: boolean;
  todos?: unknown;
  running?: boolean;
  agentSkills?: unknown;
}

function detail(options: DetailOptions = {}) {
  return {
    header: { cwd: '/workspace' },
    permission: { preset: options.permission === undefined ? 'workspace-write' : options.permission },
    agent: options.agent ?? defaultAgent,
    model: options.binding ?? { version: 2, kind: 'agent' },
    resolvedModel: null,
    agentError: null,
    agentWarnings: [],
    agentSkills: options.agentSkills,
    plan: { active: options.plan ?? false },
    todos: options.todos ?? null,
    running: options.running === true,
    messages: [{ role: 'user', content: [{ type: 'text', text: options.text ?? 'Alpha history' }] }],
    events: [],
    audit: [],
    trajectory: null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function baseFetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if (url === '/api/workspaces' && method === 'GET') {
    return Promise.resolve(json({ workspaces: [{ id: 'a', name: 'Alpha', path: '/a' }] }));
  }
  if (url === '/api/settings/permissions' && method === 'GET') {
    return Promise.resolve(json({ settings: { defaultPreset: 'workspace-write', requiresSelection: false } }));
  }
  if (url === '/api/models' && method === 'GET') {
    return Promise.resolve(json({ models: [
      { provider: 'provider-a', model: 'model-1', name: 'Model One', capabilities: { imageInput: false }, reasoningEfforts: [] },
      { provider: 'provider-a', model: 'model-2', name: 'Model Two', capabilities: { imageInput: false }, reasoningEfforts: ['low', 'high'] },
    ] }));
  }
  if (url === '/api/agents' && method === 'GET') {
    return Promise.resolve(json({ agents: [defaultAgent, writerAgent, explorerAgent] }));
  }
  if (url === '/api/roles' && method === 'GET') {
    return Promise.resolve(json({ roles: [{ id: 'default', name: 'Default', provider: 'provider-a', model: 'model-1' }] }));
  }
  if (url === '/api/workspaces/a/sessions' && method === 'GET') {
    return Promise.resolve(json({ sessions: [{ id: 'shared', updatedAt: 1 }] }));
  }
  throw new Error(`Unexpected request: ${method} ${url}`);
}

async function waitFor(predicate: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function boot(fetcher: typeof fetch): Promise<AppStore> {
  vi.stubGlobal('fetch', fetcher);
  const store = new AppStore();
  await store.bootstrap();
  await waitFor(() => store.currentEntry()?.loaded === true);
  await waitFor(() => !store.getSnapshot().modelsLoading);
  return store;
}

function sessionFetcher(
  overrides: (url: string, init?: RequestInit) => Promise<Response | undefined> | Response | undefined,
): typeof fetch {
  return async (input, init) => {
    const handled = await overrides(String(input), init);
    return handled ?? baseFetcher(input, init);
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace session isolation', () => {
  it('loads concurrent workspace lists independently and never drafts for a background empty list', async () => {
    let resolveA!: (response: Response) => void;
    let resolveB!: (response: Response) => void;
    const a = new Promise<Response>((resolve) => { resolveA = resolve; });
    const b = new Promise<Response>((resolve) => { resolveB = resolve; });
    vi.stubGlobal('fetch', sessionFetcher((url) => {
      if (url === '/api/workspaces') return json({ workspaces: [{ id: 'a', name: 'Alpha', path: '/a' }, { id: 'b', name: 'Beta', path: '/b' }] });
      if (url === '/api/workspaces/a/sessions') return a;
      if (url === '/api/workspaces/b/sessions') return b;
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));
    const store = new AppStore();
    const booting = store.bootstrap();
    await waitFor(() => store.getSnapshot().sessionsLoading);
    const background = store.loadSessions('b', false);
    resolveB(json({ sessions: [] }));
    await background;
    expect(store.getSnapshot().workspaceId).toBe('a');
    expect(store.getSnapshot().sessionId).toBeNull();
    expect(store.getSnapshot().sessionsByWorkspace.b).toMatchObject({ loaded: true, sessions: [] });
    expect(Object.values(store.getSnapshot().entries).some((entry) => entry.draft)).toBe(false);
    resolveA(json({ sessions: [{ id: 'shared' }] }));
    await booting;
    expect(store.getSnapshot().sessionId).toBe('shared');
    expect(store.getSnapshot().sessionsByWorkspace.a?.sessions.map((session) => session.id)).toEqual(['shared']);
  });

  it('reloads the full list when a mutation finishes during its first load', async () => {
    let resolveOld!: (response: Response) => void;
    const oldList = new Promise<Response>((resolve) => { resolveOld = resolve; });
    let listCalls = 0;
    const store = await boot(sessionFetcher((url, init) => {
      if (url === '/api/workspaces') return json({ workspaces: [{ id: 'a', name: 'Alpha', path: '/a' }, { id: 'b', name: 'Beta', path: '/b' }] });
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      if (url === '/api/workspaces/b/sessions/shared' && init?.method === 'PATCH') return json({ title: 'Renamed' });
      if (url === '/api/workspaces/b/sessions') {
        listCalls += 1;
        return listCalls === 1 ? oldList : json({ sessions: [{ id: 'shared', title: 'Renamed' }, { id: 'other' }] });
      }
      return undefined;
    }));
    const pending = store.loadSessions('b', false);
    await store.renameSession('shared', 'Renamed', 'b');
    await waitFor(() => store.getSnapshot().sessionsByWorkspace.b?.loaded === true);
    resolveOld(json({ sessions: [{ id: 'shared', title: 'Old' }] }));
    await pending;
    expect(store.getSnapshot().sessionsByWorkspace.b?.sessions).toEqual([{ id: 'shared', title: 'Renamed' }, { id: 'other' }]);
    expect(listCalls).toBe(2);
  });

  it('keeps newer list results and workspace-scoped mutations despite delayed responses', async () => {
    let resolveOld!: (response: Response) => void;
    let resolveRename!: (response: Response) => void;
    let deferList = false;
    let deferredOnce = false;
    const calls: string[] = [];
    const oldList = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const rename = new Promise<Response>((resolve) => { resolveRename = resolve; });
    const store = await boot(sessionFetcher((url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url === '/api/workspaces') return json({ workspaces: [{ id: 'a', name: 'Alpha', path: '/a' }, { id: 'b', name: 'Beta', path: '/b' }] });
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      if (url === '/api/workspaces/b/sessions/shared' && method === 'PATCH') return rename;
      if (url === '/api/workspaces/b/sessions/shared' && method === 'DELETE') return json({ deleted: true });
      if (url === '/api/workspaces/b/sessions/shared/pin') return json({ pinned: true });
      if (url === '/api/workspaces/b/sessions/shared') return json(detail({ text: 'Beta' }));
      if (url === '/api/workspaces/b/sessions') {
        if (deferList && !deferredOnce) { deferredOnce = true; return oldList; }
        return json({ sessions: [{ id: 'shared', title: deferList ? 'Renamed' : 'Beta' }, { id: 'next' }] });
      }
      return undefined;
    }));
    await store.loadSessions('b', false);
    deferList = true;
    const stale = store.loadSessions('b', false);
    const pendingRename = store.renameSession('shared', 'Renamed', 'b');
    store.selectSession('shared', 'b');
    store.selectSession('shared', 'a');
    resolveRename(json({ title: 'Renamed' }));
    await pendingRename;
    await waitFor(() => !store.getSnapshot().sessionsByWorkspace.b?.loading);
    resolveOld(json({ sessions: [{ id: 'shared', title: 'Stale' }] }));
    await stale;
    expect(store.getSnapshot().sessionsByWorkspace.b?.sessions[0]?.title).toBe('Renamed');
    expect(store.getSnapshot().sessions[0]?.title).not.toBe('Renamed');
    await store.setSessionPinned('shared', true, 'b');
    expect(store.getSnapshot().sessionsByWorkspace.b?.sessions[0]?.pinned).toBe(true);
    expect(store.getSnapshot().sessions[0]?.pinned).not.toBe(true);
    await store.deleteSession('shared', 'b');
    expect(store.getSnapshot().workspaceId).toBe('a');
    expect(store.getSnapshot().sessionId).toBe('shared');
    expect(store.getSnapshot().sessionsByWorkspace.b?.sessions.map((session) => session.id)).toEqual(['next']);
    expect(calls).toContain('PATCH /api/workspaces/b/sessions/shared');
    expect(calls).toContain('DELETE /api/workspaces/b/sessions/shared');
  });
});

describe('workbench store', () => {
  it('keeps the automatic draft when its first session creation fails', async () => {
    let attempts = 0;
    const store = await boot(sessionFetcher((url, init) => {
      if (url === '/api/modes') return json({ modes: [standardMode], defaultMode: 'standard' });
      if (url === '/api/workspaces/a/sessions' && init?.method === 'POST') {
        attempts += 1;
        return json({ error: 'creation failed' }, 500);
      }
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [] });
      return undefined;
    }));
    const draft = store.getSnapshot().sessionId;
    await expect(store.sendMessage('Hello')).resolves.toBe(false);
    expect(attempts).toBe(1);
    expect(store.getSnapshot().sessionId).toBe(draft);
    expect(store.currentEntry()).toMatchObject({ draft: true, loaded: true });
    expect(store.getSnapshot().alert).not.toBe('');
  });

  it('does not replace a session selected while automatic creation awaits modes', async () => {
    let resolveModes!: (response: Response) => void;
    const modes = new Promise<Response>((resolve) => { resolveModes = resolve; });
    vi.stubGlobal('fetch', sessionFetcher((url) => {
      if (url === '/api/modes') return modes.then((response) => response.clone());
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [] });
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));
    const store = new AppStore();
    const bootstrap = store.bootstrap();
    await waitFor(() => store.getSnapshot().workspaceId === 'a' && !store.getSnapshot().sessionsLoading);
    store.selectSession('shared');
    resolveModes(json({ modes: [standardMode], defaultMode: 'standard' }));
    await bootstrap;
    expect(store.getSnapshot().sessionId).toBe('shared');
    expect(Object.values(store.getSnapshot().entries).some((entry) => entry.draft)).toBe(false);
  });

  it('opens an empty workspace as a local draft and persists only on first send', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const store = await boot(sessionFetcher((url, init) => {
      if (url === '/api/modes') return json({ modes: [standardMode], defaultMode: 'standard' });
      if (url === '/api/workspaces/a/sessions' && (init?.method ?? 'GET') === 'GET') return json({ sessions: [] });
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (url === '/api/workspaces/a/sessions') return json({ session: { id: 'fresh', updatedAt: 2 } }, 201);
        if (url === '/api/workspaces/a/sessions/fresh/permission') return json({ permission: { preset: 'workspace-write' } });
        if (url === '/api/workspaces/a/sessions/fresh/messages') return new Response(stream);
      }
      if (url === '/api/workspaces/a/sessions/fresh') return json(detail({ text: 'Hello' }));
      return undefined;
    }));

    expect(store.getSnapshot().sessionId).toMatch(/^draft-/);
    expect(store.getSnapshot().sessions).toEqual([]);
    expect(store.currentEntry()).toMatchObject({ draft: true, loaded: true, permission: 'workspace-write', mode: { mode: 'standard' } });
    expect(posts).toEqual([]);
    await expect(store.sendMessage('Hello')).resolves.toBe(true);
    expect(posts).toEqual([
      { url: '/api/workspaces/a/sessions', body: { mode: 'standard' } },
      { url: '/api/workspaces/a/sessions/fresh/permission', body: { preset: 'workspace-write' } },
      { url: '/api/workspaces/a/sessions/fresh/messages', body: { text: 'Hello' } },
    ]);
    controller.enqueue(new TextEncoder().encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await waitFor(() => store.currentEntry()?.run === undefined);
  });

  it('restores the saved session when the workspace has existing sessions', async () => {
    const values = new Map([['omniagent.activeSessions', JSON.stringify({ a: 'older' })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const store = await boot(sessionFetcher((url) => {
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 2 }, { id: 'older', updatedAt: 1 }] });
      if (url === '/api/workspaces/a/sessions/older') return json(detail());
      return undefined;
    }));
    expect(store.getSnapshot().sessionId).toBe('older');
    expect(store.currentEntry()?.draft).toBe(false);
  });

  it.each([
    ['request failure', json({ error: 'sessions unavailable' }, 500)],
    ['invalid response', json({})],
  ])('does not create a draft on session list %s and permits retry', async (_name, failedResponse) => {
    let fail = true;
    const store = new AppStore();
    vi.stubGlobal('fetch', sessionFetcher((url, init) => {
      if (url === '/api/modes') return json({ modes: [standardMode], defaultMode: 'standard' });
      if (url === '/api/workspaces/a/sessions' && (init?.method ?? 'GET') === 'GET') return fail ? failedResponse : json({ sessions: [] });
      return undefined;
    }));
    await store.bootstrap();
    expect(store.getSnapshot().sessionId).toBeNull();
    expect(store.getSnapshot().sessionError).not.toBe('');
    fail = false;
    await store.loadSessions('a', true);
    expect(store.currentEntry()?.draft).toBe(true);
  });

  it('does not replace a session selected while the list is loading', async () => {
    let resolveList!: (response: Response) => void;
    const list = new Promise<Response>((resolve) => { resolveList = resolve; });
    vi.stubGlobal('fetch', sessionFetcher((url) => {
      if (url === '/api/workspaces/a/sessions') return list;
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));
    const store = new AppStore();
    const bootstrap = store.bootstrap();
    await waitFor(() => store.getSnapshot().sessionsLoading);
    store.selectSession('shared');
    resolveList(json({ sessions: [] }));
    await bootstrap;
    expect(store.getSnapshot().sessionId).toBe('shared');
    expect(store.currentEntry()?.draft).toBe(false);
  });

  it('does not replace a manual draft while automatic creation awaits modes', async () => {
    let resolveModes!: (response: Response) => void;
    const modes = new Promise<Response>((resolve) => { resolveModes = resolve; });
    vi.stubGlobal('fetch', sessionFetcher((url) => {
      if (url === '/api/modes') return modes.then((response) => response.clone());
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [] });
      return undefined;
    }));
    const store = new AppStore();
    const bootstrap = store.bootstrap();
    await waitFor(() => store.getSnapshot().workspaceId === 'a' && !store.getSnapshot().sessionsLoading);
    const manual = store.startDraftSession();
    resolveModes(json({ modes: [standardMode], defaultMode: 'standard' }));
    await Promise.all([bootstrap, manual]);
    expect(store.currentEntry()?.draft).toBe(true);
    expect(Object.values(store.getSnapshot().entries).filter((entry) => entry.draft)).toHaveLength(1);
  });

  it('does not create a draft in a workspace left while modes are loading', async () => {
    let resolveModes!: (response: Response) => void;
    const modes = new Promise<Response>((resolve) => { resolveModes = resolve; });
    vi.stubGlobal('fetch', sessionFetcher((url) => {
      if (url === '/api/modes') return modes.then((response) => response.clone());
      if (url === '/api/workspaces') return json({ workspaces: [{ id: 'a', name: 'Alpha', path: '/a' }, { id: 'b', name: 'Beta', path: '/b' }] });
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [] });
      if (url === '/api/workspaces/b/sessions') return json({ sessions: [{ id: 'other', updatedAt: 1 }] });
      if (url === '/api/workspaces/b/sessions/other') return json(detail());
      return undefined;
    }));
    const store = new AppStore();
    const bootstrap = store.bootstrap();
    await waitFor(() => store.getSnapshot().workspaceId === 'a' && !store.getSnapshot().sessionsLoading);
    await store.selectWorkspace('b');
    resolveModes(json({ modes: [standardMode], defaultMode: 'standard' }));
    await bootstrap;
    expect(store.getSnapshot().workspaceId).toBe('b');
    expect(store.getSnapshot().sessionId).toBe('other');
    expect(Object.values(store.getSnapshot().entries).some((entry) => entry.draft)).toBe(false);
  });

  it('reports mode failure without creating a session and retries on a later list load', async () => {
    let fail = true;
    vi.stubGlobal('fetch', sessionFetcher((url) => {
      if (url === '/api/modes') return fail ? json({ error: 'modes unavailable' }, 500) : json({ modes: [standardMode], defaultMode: 'standard' });
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [] });
      return undefined;
    }));
    const store = new AppStore();
    await store.bootstrap();
    expect(store.getSnapshot().sessionId).toBeNull();
    expect(store.getSnapshot().modesError).not.toBe('');
    expect(store.getSnapshot().alert).not.toBe('');
    fail = false;
    await store.loadSessions('a', true);
    expect(store.currentEntry()?.draft).toBe(true);
  });

  it('reports permission settings failure and retries without persisting a session', async () => {
    let fail = true;
    const posts: string[] = [];
    vi.stubGlobal('fetch', sessionFetcher((url, init) => {
      if (init?.method === 'POST') posts.push(url);
      if (url === '/api/modes') return json({ modes: [standardMode], defaultMode: 'standard' });
      if (url === '/api/settings/permissions') return fail
        ? json({ error: 'permissions unavailable' }, 500)
        : json({ settings: { defaultPreset: 'workspace-write', requiresSelection: false } });
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [] });
      return undefined;
    }));
    const store = new AppStore();
    await store.bootstrap();
    expect(store.getSnapshot().sessionId).toBeNull();
    expect(store.getSnapshot().permissionsError).not.toBe('');
    expect(store.getSnapshot().alert).not.toBe('');
    expect(posts).toEqual([]);
    fail = false;
    await store.loadSessions('a', true);
    expect(store.currentEntry()).toMatchObject({ draft: true, permission: 'workspace-write' });
    expect(posts).toEqual([]);
  });

  it('retains a draft when the user must explicitly select a permission', async () => {
    const store = await boot(sessionFetcher((url) => {
      if (url === '/api/modes') return json({ modes: [standardMode], defaultMode: 'standard' });
      if (url === '/api/settings/permissions') return json({ settings: { defaultPreset: null, requiresSelection: true } });
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [] });
      return undefined;
    }));
    expect(store.currentEntry()).toMatchObject({ draft: true, permission: null });
    await expect(store.sendMessage('Blocked')).resolves.toBe(false);
  });

  it('loads the configured model catalog and persists a session model switch', async () => {
    const binding = { version: 2, kind: 'model', provider: 'provider-a', model: 'model-2' };
    const switches: unknown[] = [];
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/model' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        switches.push(body);
        return json({ model: body, resolvedModel: { provider: 'provider-a', model: 'model-2', name: 'Model Two', capabilities: { imageInput: false } } });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));
    expect(store.getSnapshot().models.map((model) => model.name)).toEqual(['Model One', 'Model Two']);

    await store.saveSessionModel({ version: 2, kind: 'model', provider: 'provider-a', model: 'model-1' });
    expect(switches).toHaveLength(1);
    expect(store.currentEntry()?.binding).toEqual({ version: 2, kind: 'model', provider: 'provider-a', model: 'model-1' });

    await store.saveSessionModel({ version: 2, kind: 'model', provider: 'provider-a', model: 'model-1' });
    expect(switches).toHaveLength(1);

    await store.saveSessionModel({ version: 2, kind: 'model', provider: 'provider-a', model: 'model-2' });
    expect(switches).toEqual([
      { version: 2, kind: 'model', provider: 'provider-a', model: 'model-1' },
      { version: 2, kind: 'model', provider: 'provider-a', model: 'model-2' },
    ]);
    expect(store.currentEntry()?.binding).toEqual(binding);
    expect(store.currentEntry()?.modelSaving).toBe(false);
    expect(store.currentEntry()?.modelError).toBe('');
  });

  it('filters subagent-only agents and persists a session agent switch', async () => {
    const switches: string[] = [];
    let currentAgent = defaultAgent;
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/agent' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { agent: string };
        switches.push(body.agent);
        currentAgent = body.agent === 'writer' ? writerAgent : defaultAgent;
        return json({ agent: currentAgent });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail({ agent: currentAgent }));
      return undefined;
    }));

    await store.saveSessionAgent('explorer');
    expect(switches).toEqual([]);
    expect(store.currentEntry()?.agent?.id).toBe('default');

    await store.saveSessionAgent('writer');
    expect(switches).toEqual(['writer']);
    expect(store.currentEntry()?.agent?.id).toBe('writer');
    expect(store.currentEntry()?.agentSaving).toBe(false);
    expect(store.currentEntry()?.agentError).toBe('');
  });

  it('persists a session permission switch and exposes a rejected change', async () => {
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/permission' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { preset: string };
        if (body.preset === 'danger-full-access') return json({ error: 'The sandbox rejected this preset' }, 409);
        return json({ permission: { preset: body.preset } });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await store.saveSessionPermission('read-only');
    expect(store.currentEntry()?.permission).toBe('read-only');
    expect(store.currentEntry()?.permissionSaving).toBe(false);

    await store.saveSessionPermission('danger-full-access');
    expect(store.currentEntry()?.permission).toBe('read-only');
    expect(store.currentEntry()?.permissionError).toContain('The sandbox rejected this preset');
  });

  it('tracks an approval demand, submits the decision, and reconciles the finished turn', async () => {
    const decisions: unknown[] = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/messages' && init?.method === 'POST') {
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === '/api/workspaces/a/sessions/shared/approvals' && init?.method === 'POST') {
        decisions.push(JSON.parse(String(init.body)));
        return json({ ok: true });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail({ text: 'Read it' }));
      return undefined;
    }));

    await expect(store.sendMessage('Read it')).resolves.toBe(true);
    expect(store.currentEntry()?.run?.transcript.at(-1)).toMatchObject({ kind: 'user', text: 'Read it' });

    controller.enqueue(encoder.encode('data: {"type":"permission.requested","requestId":"r1","call":{"id":"c1","name":"bash","arguments":{"command":"ls"}},"reason":"approval"}\n\n'));
    await waitFor(() => store.currentEntry()?.run?.approval !== undefined);
    expect(store.currentEntry()?.run?.approval).toMatchObject({ requestId: 'r1', call: { id: 'c1' } });

    await store.resolveApproval('allow');
    expect(decisions).toEqual([{ requestId: 'r1', decision: 'allow' }]);
    expect(store.currentEntry()?.run?.approval).toBeUndefined();

    controller.enqueue(encoder.encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await waitFor(() => store.currentEntry()?.run === undefined);
    expect(store.currentEntry()?.outcome).toBe('');
    expect(store.getSnapshot().alert).toBe('');
  });

  it('keeps live events scoped to their workspace and session', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces' && (init?.method ?? 'GET') === 'GET') {
        return json({ workspaces: [
          { id: 'a', name: 'Alpha', path: '/a' },
          { id: 'b', name: 'Beta', path: '/b' },
        ] });
      }
      if (url === '/api/workspaces/b/sessions' && (init?.method ?? 'GET') === 'GET') {
        return json({ sessions: [{ id: 'shared', updatedAt: 2 }] });
      }
      if (url === '/api/workspaces/b/sessions/shared') return json(detail({ text: 'Beta history' }));
      if (url === '/api/workspaces/a/sessions/shared/messages' && init?.method === 'POST') {
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail({ text: 'Alpha history' }));
      return undefined;
    }));

    await store.sendMessage('Alpha turn');
    controller.enqueue(encoder.encode('data: {"type":"assistant.delta","text":"Alpha answer"}\n\n'));
    await waitFor(() => (store.currentEntry()?.run?.transcript.length ?? 0) > 1);

    await store.selectWorkspace('b');
    await waitFor(() => store.currentEntry()?.loaded === true);
    expect(store.getSnapshot().workspaceId).toBe('b');
    expect(store.currentEntry()?.transcript.map((item) => item.kind === 'user' ? item.text : '')).toEqual(['Beta history']);

    controller.enqueue(encoder.encode('data: {"type":"assistant.delta","text":" still alpha"}\n\n'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.currentEntry()?.transcript.map((item) => item.kind === 'user' ? item.text : '')).toEqual(['Beta history']);
    expect(store.getSnapshot().entries[JSON.stringify(['a', 'shared'])]?.run?.streamText).toContain('Alpha answer');

    controller.enqueue(encoder.encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await waitFor(() => store.getSnapshot().entries[JSON.stringify(['a', 'shared'])]?.run === undefined);
  });

  it('marks a turn as stopping and posts the interrupt', async () => {
    const interrupts: unknown[] = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/messages' && init?.method === 'POST') {
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === '/api/workspaces/a/sessions/shared/interrupt' && init?.method === 'POST') {
        interrupts.push(JSON.parse(String(init.body)));
        return json({ ok: true });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await store.sendMessage('Long turn');
    await store.stopTurn();
    expect(interrupts).toEqual([{}]);
    expect(store.currentEntry()?.run?.stopping).toBe(true);

    controller.enqueue(encoder.encode('data: {"type":"turn.end","reason":"interrupted"}\n\n'));
    controller.close();
    await waitFor(() => store.currentEntry()?.run === undefined);
  });

  it('steers into the running turn and keeps the optimistic user message', async () => {
    const steers: unknown[] = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/messages' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { mode?: string };
        if (body.mode === 'steer') {
          steers.push(body);
          return json({ accepted: true, delivery: 'queued' }, 202);
        }
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await store.sendMessage('First turn');
    await expect(store.steerMessage('Second turn')).resolves.toBe(true);
    expect(steers).toEqual([{ text: 'Second turn', mode: 'steer' }]);
    expect(store.currentEntry()?.run?.transcript.at(-1)).toMatchObject({ kind: 'user', text: 'Second turn' });

    controller.enqueue(encoder.encode('data: {"type":"assistant.delta","text":"reply"}\n\n'));
    await waitFor(() => store.currentEntry()?.run?.transcript.some((item) => item.kind === 'assistant' && item.text === 'reply') === true);
    expect(store.currentEntry()?.run?.transcript.some((item) => item.kind === 'user' && item.text === 'Second turn')).toBe(true);

    controller.enqueue(encoder.encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await waitFor(() => store.currentEntry()?.run === undefined);
  });

  it('queues a message and starts it after the running turn ends', async () => {
    const posted: string[] = [];
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const encoder = new TextEncoder();
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/messages' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { text: string };
        posted.push(body.text);
        return new Response(new ReadableStream<Uint8Array>({ start(value) { controllers.push(value); } }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await store.sendMessage('First turn');
    await waitFor(() => controllers.length === 1);
    const first = store.currentEntry()?.run;
    expect(first?.transcript.at(-1)).toMatchObject({ kind: 'user', text: 'First turn', turn: 1 });
    expect(groupTurns(first!.transcript, first!.turns, true).at(-1)?.user?.text).toBe('First turn');
    expect(store.queueMessage('Second turn')).toBe(true);
    expect(store.currentEntry()?.queued.map((item) => item.text)).toEqual(['Second turn']);

    controllers[0]!.enqueue(encoder.encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controllers[0]!.close();
    await waitFor(() => posted.length === 2);
    expect(posted).toEqual(['First turn', 'Second turn']);
    expect(store.currentEntry()?.queued).toHaveLength(0);

    await waitFor(() => controllers.length === 2);
    const second = store.currentEntry()?.run;
    expect(second?.transcript.at(-1)).toMatchObject({ kind: 'user', text: 'Second turn', turn: 1 });
    expect(groupTurns(second!.transcript, second!.turns, true).at(-1)?.user?.text).toBe('Second turn');
    controllers[1]!.enqueue(encoder.encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controllers[1]!.close();
    await waitFor(() => store.currentEntry()?.run === undefined);
  });

  it('stops a turn that another tab is running', async () => {
    const interrupts: unknown[] = [];
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/interrupt' && init?.method === 'POST') {
        interrupts.push(JSON.parse(String(init.body)));
        return json({ ok: true });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail({ running: true }));
      return undefined;
    }));

    expect(store.currentEntry()?.running).toBe(true);
    await store.stopTurn();
    expect(interrupts).toEqual([{}]);
  });

  it('restores the draft transcript when the server rejects a concurrent turn', async () => {
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/messages' && init?.method === 'POST') {
        return json({ error: 'A turn is already active' }, 409);
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await expect(store.sendMessage('Second turn')).resolves.toBe(false);
    expect(store.currentEntry()?.run).toBeUndefined();
    expect(store.currentEntry()?.transcript).toHaveLength(1);
    expect(store.getSnapshot().alert).toContain('已有回合正在运行');
  });

  it('blocks sending until a permission preset is explicitly selected', async () => {
    let posted = false;
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/messages' && init?.method === 'POST') {
        posted = true;
        return json({ error: 'unreachable' }, 500);
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail({ permission: null }));
      return undefined;
    }));
    expect(store.currentEntry()?.permission).toBeNull();

    await expect(store.sendMessage('Blocked')).resolves.toBe(false);
    expect(posted).toBe(false);
  });

  it('toggles plan mode through the session endpoint', async () => {
    const toggles: unknown[] = [];
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/plan' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        toggles.push(body);
        return json({ plan: body });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await store.togglePlan();
    expect(toggles).toEqual([{ active: true }]);
    expect(store.currentEntry()?.plan.active).toBe(true);
    await store.togglePlan();
    expect(toggles).toEqual([{ active: true }, { active: false }]);
    expect(store.currentEntry()?.plan.active).toBe(false);
  });

  it('submits plan review decisions with trimmed feedback', async () => {
    const reviews: unknown[] = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/messages' && init?.method === 'POST') {
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === '/api/workspaces/a/sessions/shared/plan-review' && init?.method === 'POST') {
        reviews.push(JSON.parse(String(init.body)));
        return json({ ok: true });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await store.sendMessage('Plan it');
    controller.enqueue(encoder.encode('data: {"type":"plan.review.requested","requestId":"plan-1","plan":"# Plan\\n\\nDo it."}\n\n'));
    await waitFor(() => store.currentEntry()?.run?.planReview !== undefined);
    expect(store.currentEntry()?.run?.planReview?.plan).toContain('# Plan');
    expect(store.currentEntry()?.run?.approval).toBeUndefined();

    await store.resolvePlanReview(false, '  Add tests  ');
    expect(reviews).toEqual([{ requestId: 'plan-1', approved: false, feedback: 'Add tests' }]);
    expect(store.currentEntry()?.run?.planReview).toBeUndefined();

    controller.enqueue(encoder.encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await waitFor(() => store.currentEntry()?.run === undefined);
  });

  it('keeps a new session local until the first message persists its mode', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/modes') return json({ modes: [standardMode], defaultMode: 'standard' });
      if (url === '/api/workspaces/a/sessions' && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ session: { id: 'fresh', workspace: '/a', createdAt: 2, updatedAt: 2, blank: true, mode: 'standard' } }, 201);
      }
      if (url === '/api/workspaces/a/sessions/fresh/permission' && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ permission: JSON.parse(String(init.body)) });
      }
      if (url === '/api/workspaces/a/sessions/fresh/messages' && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      if (url === '/api/workspaces/a/sessions/fresh') return json(detail({ text: 'Hello' }));
      return undefined;
    }));

    await expect(store.startDraftSession('standard')).resolves.toBeNull();
    expect(posts).toEqual([]);
    expect(store.getSnapshot().sessionId).toMatch(/^draft-/);
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(['shared']);
    expect(store.currentEntry()).toMatchObject({
      draft: true,
      loaded: true,
      permission: 'workspace-write',
      mode: { mode: 'standard' },
      resolvedModel: { provider: 'provider-a', model: 'model-1', name: 'Model One' },
    });

    await expect(store.sendMessage('Hello')).resolves.toBe(true);
    expect(posts.map((post) => post.url)).toEqual([
      '/api/workspaces/a/sessions',
      '/api/workspaces/a/sessions/fresh/permission',
      '/api/workspaces/a/sessions/fresh/messages',
    ]);
    expect(posts[0]!.body).toEqual({ mode: 'standard' });
    expect(posts[1]!.body).toEqual({ preset: 'workspace-write' });
    expect(posts[2]!.body).toEqual({ text: 'Hello' });
    expect(store.getSnapshot().sessionId).toBe('fresh');
    expect(store.currentEntry()).toMatchObject({ draft: false, title: null });
    expect(store.currentEntry()?.run?.transcript.at(-1)).toMatchObject({ kind: 'user', text: 'Hello' });

    controller.enqueue(encoder.encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await waitFor(() => store.currentEntry()?.run === undefined);
  });

  it('lets a draft override the mode model and sends the override when persisting', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/modes') return json({ modes: [standardMode], defaultMode: 'standard' });
      if (url === '/api/workspaces/a/sessions' && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ session: { id: 'fresh', workspace: '/a', createdAt: 2, updatedAt: 2, blank: true, mode: 'standard' } }, 201);
      }
      if (url === '/api/workspaces/a/sessions/fresh/permission' && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ permission: JSON.parse(String(init.body)) });
      }
      if (url === '/api/workspaces/a/sessions/fresh/messages' && init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      if (url === '/api/workspaces/a/sessions/fresh') return json(detail({ text: 'Hello' }));
      return undefined;
    }));

    await expect(store.startDraftSession('standard')).resolves.toBeNull();
    expect(store.currentEntry()?.draft).toBe(true);
    const override = { version: 2 as const, kind: 'model' as const, provider: 'provider-a', model: 'model-2', reasoningEffort: 'high' as const };
    await store.saveSessionModel(override);
    expect(store.currentEntry()?.binding).toEqual(override);
    expect(store.currentEntry()?.resolvedModel).toMatchObject({
      provider: 'provider-a', model: 'model-2', name: 'Model Two', reasoningEffort: 'high',
    });
    expect(posts).toEqual([]);

    await expect(store.sendMessage('Hello')).resolves.toBe(true);
    expect(posts.map((post) => post.url)).toEqual([
      '/api/workspaces/a/sessions',
      '/api/workspaces/a/sessions/fresh/permission',
      '/api/workspaces/a/sessions/fresh/messages',
    ]);
    expect(posts[0]!.body).toEqual({ mode: 'standard', model: override });
    expect(store.getSnapshot().sessionId).toBe('fresh');
    expect(store.currentEntry()).toMatchObject({ draft: false, binding: override });

    controller.enqueue(encoder.encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await waitFor(() => store.currentEntry()?.run === undefined);
  });

  it('drops the draft without persisting it when another session is selected', async () => {
    const store = await boot(sessionFetcher(async (url) => {
      if (url === '/api/modes') return json({ modes: [standardMode], defaultMode: 'standard' });
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await expect(store.startDraftSession('standard')).resolves.toBeNull();
    expect(store.getSnapshot().sessionId).toMatch(/^draft-/);
    store.selectSession('shared');
    expect(store.getSnapshot().sessionId).toBe('shared');
    expect(Object.values(store.getSnapshot().entries).some((entry) => entry.draft)).toBe(false);
  });

  it('starts the draft in the requested workspace and follows the mode role model', async () => {
    const roleMode = {
      ...standardMode,
      id: 'deep',
      name: 'Deep',
      model: { version: 2, kind: 'role', role: 'writer' },
    };
    const store = await boot(sessionFetcher(async (url) => {
      if (url === '/api/modes') return json({ modes: [standardMode, roleMode], defaultMode: 'standard' });
      if (url === '/api/roles') {
        return json({ roles: [
          { id: 'default', name: 'Default', provider: 'provider-a', model: 'model-1' },
          { id: 'writer', name: 'Writer', provider: 'provider-a', model: 'model-2', reasoningEffort: 'high' },
        ] });
      }
      if (url === '/api/workspaces') {
        return json({ workspaces: [
          { id: 'a', name: 'Alpha', path: '/a' },
          { id: 'b', name: 'Beta', path: '/b' },
        ] });
      }
      if (url === '/api/workspaces/b/sessions') return json({ sessions: [] });
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await expect(store.startDraftSession({ workspaceId: 'b' })).resolves.toBeNull();
    expect(store.getSnapshot().workspaceId).toBe('b');
    expect(store.getSnapshot().sessionId).toMatch(/^draft-/);
    expect(store.getSnapshot().entries[JSON.stringify(['b', store.getSnapshot().sessionId])]?.draft).toBe(true);
    expect(store.currentEntry()?.resolvedModel).toMatchObject({ name: 'Model One', provider: 'provider-a' });

    store.selectDraftMode('deep');
    expect(store.currentEntry()?.mode?.mode).toBe('deep');
    expect(store.currentEntry()?.resolvedModel).toMatchObject({
      provider: 'provider-a',
      model: 'model-2',
      name: 'Model Two',
      reasoningEffort: 'high',
    });
  });

  it('pins a session ahead of newer activity and unpins it', async () => {
    let pinned = false;
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions' && (init?.method ?? 'GET') === 'GET') {
        return json({ sessions: [
          { id: 'shared', updatedAt: 10 },
          { id: 'older', updatedAt: 5, ...(pinned ? { pinned: true } : {}) },
        ] });
      }
      if (url === '/api/workspaces/a/sessions/older/pin' && init?.method === 'POST') {
        pinned = (JSON.parse(String(init.body)) as { pinned: boolean }).pinned;
        return json({ pinned });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(['shared', 'older']);
    await expect(store.setSessionPinned('older', true)).resolves.toBe(true);
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(['older', 'shared']);
    expect(store.getSnapshot().sessions[0]?.pinned).toBe(true);
    await expect(store.setSessionPinned('older', false)).resolves.toBe(true);
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(['shared', 'older']);
  });

  it('renames the selected session in both the list and the open entry', async () => {
    const patches: unknown[] = [];
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { title: string };
        patches.push(body);
        return json({ title: body.title });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await expect(store.renameSession('shared', '  Renamed  ')).resolves.toBe(true);
    expect(patches).toEqual([{ title: 'Renamed' }]);
    expect(store.getSnapshot().sessions[0]).toMatchObject({
      id: 'shared',
      title: 'Renamed',
      titleSource: { kind: 'user' },
    });
    expect(store.currentEntry()?.title).toBe('Renamed');
    await expect(store.renameSession('shared', '   ')).resolves.toBe(false);
    expect(patches).toHaveLength(1);
  });

  it('forks a session and opens the new root session', async () => {
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/fork' && init?.method === 'POST') {
        return json({ session: { id: 'forked', title: 'Alpha (fork)', updatedAt: 20, blank: false } }, 201);
      }
      if (url === '/api/workspaces/a/sessions/forked') return json(detail({ text: 'Alpha history' }));
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await expect(store.forkSession('shared')).resolves.toBe('forked');
    expect(store.getSnapshot().sessionId).toBe('forked');
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(['forked', 'shared']);
    expect(store.getSnapshot().sessions[0]?.title).toBe('Alpha (fork)');
    await waitFor(() => store.currentEntry()?.loaded === true);
    expect(store.currentEntry()?.transcript.some((item) => item.kind === 'user' && item.text === 'Alpha history')).toBe(true);
  });

  it('deletes the selected session and selects the next one', async () => {
    const deletions: string[] = [];
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions' && (init?.method ?? 'GET') === 'GET') {
        return json({ sessions: [
          { id: 'shared', updatedAt: 10 },
          { id: 'next', updatedAt: 5 },
        ] });
      }
      if (url === '/api/workspaces/a/sessions/shared' && init?.method === 'DELETE') {
        deletions.push('shared');
        return json({ deleted: true });
      }
      if (url === '/api/workspaces/a/sessions/next' && init?.method === 'DELETE') {
        deletions.push('next');
        return json({ deleted: true });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      if (url === '/api/workspaces/a/sessions/next') return json(detail({ text: 'Next history' }));
      return undefined;
    }));

    await expect(store.deleteSession('shared')).resolves.toBe(true);
    expect(deletions).toEqual(['shared']);
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(['next']);
    expect(store.getSnapshot().sessionId).toBe('next');
    await waitFor(() => store.currentEntry()?.loaded === true);
    expect(store.currentEntry()?.transcript.some((item) => item.kind === 'user' && item.text === 'Next history')).toBe(true);

    await expect(store.deleteSession('next')).resolves.toBe(true);
    expect(deletions).toEqual(['shared', 'next']);
    expect(store.getSnapshot().sessions).toEqual([]);
    expect(store.getSnapshot().sessionId).toBeNull();
  });

  it('loads the skill catalog reported for the session agent', async () => {
    const store = await boot(sessionFetcher(async (url) => {
      if (url === '/api/workspaces/a/sessions/shared') {
        return json(detail({
          agentSkills: [
            { name: 'reviewer', description: 'Reviews code changes' },
            { name: 'deploy', description: 'Ships releases' },
          ],
        }));
      }
      return undefined;
    }));

    expect(store.currentEntry()?.agentSkills).toEqual([
      { name: 'reviewer', description: 'Reviews code changes' },
      { name: 'deploy', description: 'Ships releases' },
    ]);
  });

  it('opens a recent session from another workspace', async () => {
    const store = await boot(sessionFetcher(async (url) => {
      if (url === '/api/workspaces') {
        return json({ workspaces: [
          { id: 'a', name: 'Alpha', path: '/a' },
          { id: 'b', name: 'Beta', path: '/b' },
        ] });
      }
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      if (url === '/api/workspaces/b/sessions') {
        return json({ sessions: [{ id: 'other', updatedAt: 3 }, { id: 'remote', updatedAt: 2 }] });
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      if (url === '/api/workspaces/b/sessions/other') return json(detail({ text: 'Other history' }));
      if (url === '/api/workspaces/b/sessions/remote') return json(detail({ text: 'Remote history' }));
      return undefined;
    }));

    expect(store.getSnapshot().sessionId).toBe('shared');
    await store.openRecentSession('b', 'remote');
    expect(store.getSnapshot().workspaceId).toBe('b');
    expect(store.getSnapshot().sessionId).toBe('remote');
    await waitFor(() => store.currentEntry()?.loaded === true);
    expect(store.currentEntry()?.transcript.some((item) => item.kind === 'user' && item.text === 'Remote history')).toBe(true);

    await store.openRecentSession('missing', 'unknown');
    expect(store.getSnapshot().workspaceId).toBe('b');
    expect(store.getSnapshot().sessionId).toBe('remote');
  });

  it('requests context compaction for the selected session', async () => {
    const calls: string[] = [];
    const store = await boot(sessionFetcher(async (url, init) => {
      if (url === '/api/workspaces/a/sessions/shared/compact' && init?.method === 'POST') {
        calls.push('compact');
        return json({ ok: true, scheduled: true }, 202);
      }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail());
      return undefined;
    }));

    await store.compactSession();
    expect(calls).toEqual(['compact']);
    expect(store.getSnapshot().alert).not.toBe('');
  });
});
