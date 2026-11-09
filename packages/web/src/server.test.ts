import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentSelectionEvent,
  createModelSelectionEvent,
  FakeModel,
  projectAgentSelection,
  projectMessages,
  Session,
  SessionStore,
  textResponse,
  toolCallResponse,
} from '@omniagent/core';
import type { SessionHandle } from '@omniagent/core';
import { createInitialDshPermissionEvent, projectDshPermissions } from '../../core/src/permissions/dsh-permissions';
import type { DshPermissionSnapshot } from '../../core/src/permissions/dsh-permissions';
import { ApprovalBroker } from './approval';
import { readWorkspaceAudit, recordWorkspaceAudit } from './audit';
import { PermissionSettings } from './permissions';
import { WorkspaceRegistry } from './workspaces';
import { startWebHost } from './server';
import type { WebHost, WebHostOptions, WebSession } from './server';
import { replayEndpointHash } from '../../core/src/providers/replay-identity';

const hosts: WebHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

async function setup(
  makeSession?: (id: string, permissions: DshPermissionSnapshot, workspace: { path: string }, handle: SessionHandle) => WebSession | Promise<WebSession>,
  readAudit: WebHostOptions['readAudit'] = async () => [],
  permissionSettings?: WebHostOptions['permissionSettings'],
  approvalBroker?: WebHostOptions['approvalBroker'],
) {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-web-'));
  const firstPath = join(root, 'project-one');
  const secondPath = join(root, 'project-two');
  await mkdir(firstPath);
  await mkdir(secondPath);
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const first = await workspaces.add(firstPath);
  const second = await workspaces.add(secondPath);
  const store = new SessionStore(join(root, 'sessions'));
  const host = await startWebHost({
    workspaces,
    store,
    createSession: (workspace, handle, permissions) => makeSession?.(handle.id, permissions, workspace, handle) ?? new Session({
      cwd: workspace.path,
      model: new FakeModel([textResponse('hello from model')], { onExhausted: textResponse('again') }),
      approve: async () => 'deny',
      session: handle,
      dshPermissions: permissions,
    }),
    readAudit,
    permissionSettings,
    ...(approvalBroker === undefined ? {} : { approvalBroker }),
  });
  hosts.push(host);
  return { base: host.address()!, first, second, store, workspaces, host };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function nextResponse(host: WebHost): Promise<ServerResponse> {
  return new Promise((resolve) => host.server.once('request', (_request, response) => resolve(response)));
}

function jsonRequest(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function jsonRequestWith(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function flushed(request: ReturnType<typeof httpRequest>): Promise<void> {
  if (request.writableFinished) return Promise.resolve();
  return new Promise((resolve, reject) => {
    request.once('finish', resolve);
    request.once('error', reject);
  });
}

async function jsonResponse<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function sessionsUrl(base: string, workspaceId: string): string {
  return `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`;
}

describe('workspace web host', () => {
  it('reports replay and live message estimates without claiming a window', async () => {
    const { base, first, store } = await setup();
    const handle = await store.create({ id: 'context', workspace: first.path, cwd: first.path });
    await handle.append(createInitialDshPermissionEvent('workspace-write'));
    await handle.append({ type: 'message/user', data: { text: 'hello' } });
    const url = `${sessionsUrl(base, first.id)}/context`;
    const replay = await jsonResponse<{ estimatedMessageTokens?: number; window?: unknown }>(await fetch(`${url}/context`));
    expect(replay.estimatedMessageTokens).toBeGreaterThan(0);
    expect(replay.window).toBeUndefined();
    const response = await fetch(`${url}/messages`, jsonRequest({ text: 'next' }));
    await response.text();
    const live = await jsonResponse<{ estimatedMessageTokens?: number }>(await fetch(`${url}/context`));
    expect(live.estimatedMessageTokens).toBeGreaterThan(replay.estimatedMessageTokens!);
  });

  it('uses the live compacted history instead of replay', async () => {
    const { base, first, store } = await setup((_id, permissions, workspace, handle) => new Session({
      cwd: workspace.path, session: handle, dshPermissions: permissions,
      approve: async () => 'deny', contextWindowTokens: 40,
      model: new FakeModel([textResponse('done')], { onExhausted: textResponse('done') }),
    }));
    const handle = await store.create({ id: 'compact-context', workspace: first.path, cwd: first.path });
    await handle.append(createInitialDshPermissionEvent('workspace-write'));
    await handle.append({ type: 'message/user', data: { text: 'old '.repeat(300) } });
    const url = `${sessionsUrl(base, first.id)}/compact-context`;
    const replay = await jsonResponse<{ estimatedMessageTokens: number }>(await fetch(`${url}/context`));
    const response = await fetch(`${url}/messages`, jsonRequest({ text: 'new' }));
    await response.text();
    const live = await jsonResponse<{ estimatedMessageTokens: number }>(await fetch(`${url}/context`));
    expect(live.estimatedMessageTokens).toBeLessThan(replay.estimatedMessageTokens);
  });

  it('does not expose a stale estimate during an active turn', async () => {
    const started = signal();
    const finish = signal();
    const { base, first, store } = await setup((id) => ({
      id,
      async *send() { started.resolve(); await finish.promise; yield { type: 'turn.end', reason: 'end_turn' }; },
      interrupt() { finish.resolve(); },
      contextMessageEstimate() { return 123; },
    }));
    const handle = await store.create({ id: 'busy-context', workspace: first.path, cwd: first.path });
    await handle.append(createInitialDshPermissionEvent('workspace-write'));
    const url = `${sessionsUrl(base, first.id)}/busy-context`;
    const pending = fetch(`${url}/messages`, jsonRequest({ text: 'hello' }));
    await started.promise;
    expect(await (await fetch(`${url}/context`)).json()).toEqual({});
    finish.resolve();
    await (await pending).text();
  });

  it('initializes only newly created sessions and exposes their preset', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const legacy = await store.create({ id: 'legacy', workspace: first.path, cwd: first.path });
    await legacy.append({ type: 'message/user', data: { text: 'old conversation' } });

    const created = await fetch(url, jsonRequest({}));
    expect(created.status).toBe(201);
    const { session } = await created.json() as { session: { id: string; eventCount: number } };
    expect(session.eventCount).toBe(1);
    expect(projectDshPermissions((await store.open(first.path, session.id)).events))
      .toEqual({ status: 'ready', preset: 'workspace-write' });
    expect((await jsonResponse<{ permission: unknown }>(await fetch(`${url}/${session.id}`))).permission).toEqual({ preset: 'workspace-write' });
    expect((await jsonResponse<{ permission: unknown }>(await fetch(`${url}/legacy`))).permission).toEqual({ preset: null });
    expect((await store.open(first.path, 'legacy')).events).toHaveLength(1);
  });

  it('requires explicit selection for legacy and invalid sessions and changes only the selected session', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    await store.create({ id: 'legacy', workspace: first.path, cwd: first.path });
    const invalid = await store.create({ id: 'invalid', workspace: first.path, cwd: first.path });
    await invalid.append({ type: 'permission/dsh-preset', data: { version: 99, preset: 'read-only' } });
    const other = await store.create({ id: 'other', workspace: first.path, cwd: first.path });
    await other.append(createInitialDshPermissionEvent('workspace-write'));

    for (const id of ['legacy', 'invalid']) {
      expect((await fetch(`${url}/${id}/messages`, jsonRequest({ text: 'blocked' }))).status).toBe(409);
      expect((await jsonResponse<{ permission: unknown }>(await fetch(`${url}/${id}`))).permission).toEqual({ preset: null });
      for (const body of [{}, { preset: 'default' }, { preset: 'read-only', extra: true }, { preset: null }]) {
        expect((await fetch(`${url}/${id}/permission`, jsonRequest(body))).status).toBe(400);
      }
      const selected = await fetch(`${url}/${id}/permission`, jsonRequest({ preset: 'read-only' }));
      expect(selected.status).toBe(200);
      expect(await selected.json()).toEqual({ permission: { preset: 'read-only' } });
      const completed = await fetch(`${url}/${id}/messages`, jsonRequest({ text: 'allowed' }));
      expect(completed.status).toBe(200);
      await completed.text();
      const before = (await store.open(first.path, id)).events.filter((event) => event.type === 'permission/dsh-preset').length;
      expect((await fetch(`${url}/${id}/permission`, jsonRequest({ preset: 'read-only' }))).status).toBe(200);
      expect((await store.open(first.path, id)).events.filter((event) => event.type === 'permission/dsh-preset')).toHaveLength(before);
    }
    expect(projectDshPermissions((await store.open(first.path, 'other')).events))
      .toEqual({ status: 'ready', preset: 'workspace-write' });
  });

  it('requires selection for an invalid preset and applies a changed default only to new sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-legacy-settings-'));
    const path = join(root, 'config.json');
    await writeFile(path, JSON.stringify({ dsh: { permission: { defaultPreset: 'invalid' } } }));
    const settings = await PermissionSettings.open(path);
    const { base, first, store } = await setup(undefined, undefined, settings);
    const url = sessionsUrl(base, first.id);
    expect((await jsonResponse<{ settings: unknown }>(await fetch(`${base}/api/settings/permissions`))).settings)
      .toMatchObject({ defaultPreset: null, requiresSelection: true });

    const firstSession = (await jsonResponse<{ session: { id: string } }>(await fetch(url, jsonRequest({})))).session;
    expect((await store.open(first.path, firstSession.id)).events).toHaveLength(0);
    expect((await fetch(`${url}/${firstSession.id}/messages`, jsonRequest({ text: 'blocked' }))).status).toBe(409);
    for (const body of [{ defaultPreset: 'default' }, { defaultPreset: 'read-only', mode: 'plan' }]) {
      expect((await fetch(`${base}/api/settings/permissions`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })).status).toBe(400);
    }
    const updated = await fetch(`${base}/api/settings/permissions`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultPreset: 'read-only' }),
    });
    expect(updated.status).toBe(200);
    expect((await store.open(first.path, firstSession.id)).events).toHaveLength(0);
    const secondSession = (await jsonResponse<{ session: { id: string } }>(await fetch(url, jsonRequest({})))).session;
    expect(projectDshPermissions((await store.open(first.path, secondSession.id)).events))
      .toEqual({ status: 'ready', preset: 'read-only' });
  });

  it('serializes simultaneous preset selections and appends only one effective change', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      fetch(`${url}/${session.id}/permission`, jsonRequest({ preset: 'read-only' }))));
    expect(results.map((result) => result.status)).toEqual(Array(8).fill(200));
    const events = (await store.open(first.path, session.id)).events.filter((event) => event.type === 'permission/dsh-preset');
    expect(events.map((event) => event.data)).toEqual([
      { version: 1, preset: 'workspace-write' }, { version: 1, preset: 'read-only' },
    ]);
  });

  it('renames a session without treating the rename as conversation activity', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const handle = await store.create({ id: 'rename-me', workspace: first.path, cwd: first.path });
    await handle.append({ type: 'message/user', data: { text: 'hello' }, ts: 5 });
    const before = (await jsonResponse<{ sessions: Array<{ id: string; updatedAt: number }> }>(await fetch(url)))
      .sessions.find((session) => session.id === 'rename-me');
    expect(before?.updatedAt).toBe(5);

    const renamed = await fetch(`${url}/rename-me`, jsonRequestWith('PATCH', { title: '  My chat  ' }));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ title: 'My chat' });
    const detail = await jsonResponse<{ title: string; titleSource: { kind: string } }>(await fetch(`${url}/rename-me`));
    expect(detail.title).toBe('My chat');
    expect(detail.titleSource).toEqual({ kind: 'user' });
    const summary = (await jsonResponse<{ sessions: Array<{ id: string; title?: string; updatedAt: number }> }>(await fetch(url)))
      .sessions.find((session) => session.id === 'rename-me');
    expect(summary).toMatchObject({ title: 'My chat', updatedAt: 5 });

    for (const body of [{ title: '' }, { title: '   ' }, { title: 5 }, { title: 'x', extra: true }, {}]) {
      expect((await fetch(`${url}/rename-me`, jsonRequestWith('PATCH', body))).status).toBe(400);
    }
    expect((await fetch(`${url}/missing`, jsonRequestWith('PATCH', { title: 'x' }))).status).toBe(404);
  });

  it('pins sessions ahead of newer activity and unpins them again', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const older = await store.create({ id: 'older', workspace: first.path, cwd: first.path });
    await older.append({ type: 'message/user', data: { text: 'old' }, ts: 10 });
    const newer = await store.create({ id: 'newer', workspace: first.path, cwd: first.path });
    await newer.append({ type: 'message/user', data: { text: 'new' }, ts: 20 });

    type Listed = { sessions: Array<{ id: string; pinned?: boolean; updatedAt: number }> };
    expect((await jsonResponse<Listed>(await fetch(url))).sessions.map((session) => session.id))
      .toEqual(['newer', 'older']);

    const pinned = await fetch(`${url}/older/pin`, jsonRequest({ pinned: true }));
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toEqual({ pinned: true });
    const ordered = (await jsonResponse<Listed>(await fetch(url))).sessions;
    expect(ordered.map((session) => session.id)).toEqual(['older', 'newer']);
    expect(ordered[0]).toMatchObject({ pinned: true, updatedAt: 10 });

    const unpinned = await fetch(`${url}/older/pin`, jsonRequest({ pinned: false }));
    expect(unpinned.status).toBe(200);
    const restored = (await jsonResponse<Listed>(await fetch(url))).sessions;
    expect(restored.map((session) => session.id)).toEqual(['newer', 'older']);
    expect(restored[1]?.pinned).toBeUndefined();

    for (const body of [{ pinned: 'yes' }, { pinned: true, extra: true }, {}]) {
      expect((await fetch(`${url}/older/pin`, jsonRequest(body))).status).toBe(400);
    }
    expect((await fetch(`${url}/missing/pin`, jsonRequest({ pinned: true }))).status).toBe(404);
  });

  it('deletes one session without touching its siblings', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const keep = await store.create({ id: 'keep', workspace: first.path, cwd: first.path });
    await keep.append({ type: 'message/user', data: { text: 'keep' }, ts: 10 });
    const gone = await store.create({ id: 'gone', workspace: first.path, cwd: first.path });
    await gone.append({ type: 'message/user', data: { text: 'gone' }, ts: 20 });

    const removed = await fetch(`${url}/gone`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
    const list = await jsonResponse<{ sessions: Array<{ id: string }> }>(await fetch(url));
    expect(list.sessions.map((session) => session.id)).toEqual(['keep']);
    expect((await fetch(`${url}/gone`)).status).toBe(404);
    expect((await fetch(`${url}/gone`, { method: 'DELETE' })).status).toBe(404);
    expect((await store.open(first.path, 'keep')).id).toBe('keep');
  });

  it('forks a transcript and its configuration into an unlinked root session', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const source = await store.create({ id: 'source', workspace: first.path, cwd: first.path });
    await source.append(createInitialDshPermissionEvent('workspace-write'));
    await source.append(createAgentSelectionEvent('default'));
    await source.append(createModelSelectionEvent({ version: 2, kind: 'agent' }));
    await source.append({ type: 'message/user', data: { text: 'Fork me' }, ts: 10 });
    await source.append({ type: 'session/pinned', data: { pinned: true }, ts: 11 });
    await source.append({
      type: 'session/title',
      ts: 12,
      data: { title: 'Source chat', messageSeqs: [3], source: { kind: 'user' } },
    });
    const sourceEvents = source.events.length;

    const response = await fetch(`${url}/source/fork`, jsonRequest({}));
    expect(response.status).toBe(201);
    const { session } = await response.json() as {
      session: { id: string; title?: string; pinned?: boolean; blank: boolean; updatedAt: number };
    };
    expect(session.id).not.toBe('source');
    expect(session).toMatchObject({ title: 'Source chat (fork)', blank: false });
    expect(session.pinned).toBeUndefined();
    expect(session.updatedAt).toBeGreaterThan(12);

    const forked = await store.open(first.path, session.id);
    expect(projectDshPermissions(forked.events)).toEqual({ status: 'ready', preset: 'workspace-write' });
    expect(projectAgentSelection(forked.events)).toEqual({ status: 'selected', agent: 'default' });
    expect(projectMessages(forked.events).some((message) => message.role === 'user')).toBe(true);
    expect(forked.events.some((event) => event.type === 'session/pinned')).toBe(false);
    expect(forked.events.at(-1)).toMatchObject({
      type: 'session/fork',
      data: { sourceSessionId: 'source' },
    });
    expect((await store.open(first.path, 'source')).events).toHaveLength(sourceEvents);
  });

  it('does not unregister a workspace while a permission change is being persisted', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const started = signal();
    const release = signal();
    const append = store.append.bind(store);
    store.append = async (path, event) => {
      started.resolve();
      await release.promise;
      return append(path, event);
    };
    const changing = fetch(`${url}/${session.id}/permission`, jsonRequest({ preset: 'read-only' }));
    await started.promise;
    try {
      expect((await fetch(`${base}/api/workspaces/${first.id}`, { method: 'DELETE' })).status).toBe(409);
    } finally {
      release.resolve();
      await changing;
    }
  });

  it('fails closed after an initial permission append fails until an explicit selection succeeds', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const append = store.append.bind(store);
    store.append = async () => { throw new Error('disk unavailable'); };
    const failed = await fetch(url, jsonRequest({}));
    expect(failed.status).toBe(500);
    const [created] = await store.list();
    expect(created).toBeDefined();
    store.append = append;
    expect((await fetch(`${url}/${created!.id}/messages`, jsonRequest({ text: 'blocked' }))).status).toBe(409);
    expect((await jsonResponse<{ permission: unknown }>(await fetch(`${url}/${created!.id}`))).permission).toEqual({ preset: null });
    expect((await fetch(`${url}/${created!.id}/permission`, jsonRequest({ preset: 'read-only' }))).status).toBe(200);
    expect((await fetch(`${url}/${created!.id}/messages`, jsonRequest({ text: 'allowed' }))).status).toBe(200);
  });

  it('fails closed after a preset switch append fails until an explicit retry succeeds', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const append = store.append.bind(store);
    store.append = async () => { throw new Error('disk unavailable'); };
    expect((await fetch(`${url}/${session.id}/permission`, jsonRequest({ preset: 'danger-full-access' }))).status).toBe(500);
    store.append = append;
    expect((await jsonResponse<{ permission: unknown }>(await fetch(`${url}/${session.id}`))).permission).toEqual({ preset: null });
    expect((await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'blocked' }))).status).toBe(409);
    expect((await fetch(`${url}/${session.id}/permission`, jsonRequest({ preset: 'danger-full-access' }))).status).toBe(200);
    expect((await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'allowed' }))).status).toBe(200);
  });

  it('captures the durable session preset before asynchronous startup and uses later changes on the next turn', async () => {
    const starting = signal();
    const continueStartup = signal();
    const snapshots: DshPermissionSnapshot[] = [];
    const { base, first } = await setup(async (id, permissions) => {
      snapshots.push(permissions as DshPermissionSnapshot);
      if (snapshots.length === 1) {
        starting.resolve();
        await continueStartup.promise;
      }
      return {
        id,
        async *send() { yield { type: 'turn.end', reason: 'end_turn' }; },
        interrupt() {},
      };
    });
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const pending = fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'first' }));
    await starting.promise;
    try {
      const changed = await fetch(`${url}/${session.id}/permission`, jsonRequest({ preset: 'read-only' }));
      expect(changed.status).toBe(409);
    } finally {
      continueStartup.resolve();
    }
    const firstResponse = await pending;
    expect(firstResponse.status).toBe(200);
    await firstResponse.text();
    const secondResponse = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'second' }));
    expect(secondResponse.status).toBe(200);
    await secondResponse.text();
    const switched = await fetch(`${url}/${session.id}/permission`, jsonRequest({ preset: 'read-only' }));
    expect(switched.status).toBe(200);
    const thirdResponse = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'third' }));
    expect(thirdResponse.status).toBe(200);
    await thirdResponse.text();
    expect(snapshots).toEqual([
      { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
      { preset: 'read-only', sandbox: 'read-only', approval: 'ask' },
    ]);
    expect(Object.isFrozen(snapshots[0])).toBe(true);
  });

  it('initializes only after create succeeds and never overwrites existing event history', async () => {
    const { base, first, store } = await setup();
    const existing = await store.create({ id: 'existing', workspace: first.path, cwd: first.path });
    await existing.append(createInitialDshPermissionEvent('danger-full-access'));
    const create = store.create.bind(store);
    store.create = async () => existing;
    const created = await fetch(sessionsUrl(base, first.id), jsonRequest({}));
    expect(created.status).toBe(201);
    expect((await store.open(first.path, 'existing')).events).toHaveLength(1);
    expect(projectDshPermissions((await store.open(first.path, 'existing')).events))
      .toEqual({ status: 'ready', preset: 'danger-full-access' });
    store.create = async () => { throw new Error('create failed'); };
    expect((await fetch(sessionsUrl(base, first.id), jsonRequest({}))).status).toBe(500);
    expect((await store.open(first.path, 'existing')).events).toHaveLength(1);
    store.create = create;
  });

  it('redacts provider replay data from session details and streamed assistant messages', async () => {
    const replay = {
      kind: 'deepseek-messages' as const, version: 1 as const, provider: 'deepseek-official' as const,
      endpoint: replayEndpointHash('https://api.deepseek.com/anthropic/v1/messages'),
      model: 'model', blocks: [{ type: 'thinking' as const, thinking: 'PRIVATE_REASONING', signature: 'PRIVATE_SIGNATURE' }],
    };
    const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'public' }], toolCalls: [], dshReplay: replay };
    const { base, first, store } = await setup((id) => ({
      id,
      async *send() {
        yield { type: 'assistant.message', message } as const;
        yield { type: 'turn.end', reason: 'end_turn', history: [message] } as const;
      },
      interrupt() {},
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    await (await store.open(first.path, session.id)).append({ type: 'message/assistant', data: message });
    const detail = await (await fetch(`${url}/${session.id}`)).text();
    const messages = await (await fetch(`${url}/${session.id}/messages`)).text();
    const stream = await (await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'hello' }))).text();
    for (const result of [detail, messages, stream]) {
      expect(result).toContain('public');
      expect(result).not.toContain('PRIVATE_REASONING');
      expect(result).not.toContain('PRIVATE_SIGNATURE');
      expect(result).not.toContain('dshReplay');
    }
  });
  it('lists registered workspaces and manages sessions within their workspace', async () => {
    const { base, first, second, store } = await setup();
    await store.create({ id: 'shared', workspace: first.path, cwd: first.path });
    await store.create({ id: 'shared', workspace: second.path, cwd: second.path });
    const left = await store.open(first.path, 'shared');
    const right = await store.open(second.path, 'shared');
    await left.append({ type: 'message/user', data: { text: 'first workspace' } });
    await right.append({ type: 'message/user', data: { text: 'second workspace' } });

    const list = await (await fetch(`${base}/api/workspaces`)).json() as { workspaces: Array<{ id: string }> };
    expect(list.workspaces.map((workspace) => workspace.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    const firstList = await (await fetch(sessionsUrl(base, first.id))).json() as { sessions: Array<{ workspace: string }> };
    expect(firstList.sessions).toHaveLength(1);
    expect(firstList.sessions[0]?.workspace).toBe(first.path);
    const firstDetail = await (await fetch(`${sessionsUrl(base, first.id)}/shared`)).json() as { messages: unknown[] };
    const secondDetail = await (await fetch(`${sessionsUrl(base, second.id)}/shared`)).json() as { messages: unknown[] };
    expect(firstDetail.messages).toMatchObject([{ role: 'user', content: [{ text: 'first workspace' }] }]);
    expect(secondDetail.messages).toMatchObject([{ role: 'user', content: [{ text: 'second workspace' }] }]);
    expect((await fetch(`${sessionsUrl(base, 'unknown')}/shared`)).status).toBe(404);
    expect((await fetch(`${sessionsUrl(base, first.id)}/unknown`)).status).toBe(404);
  });

  it('streams events in order and rehydrates the finished conversation', async () => {
    const { base, first } = await setup();
    const url = sessionsUrl(base, first.id);
    const created = await fetch(url, jsonRequest({}));
    expect(created.status).toBe(201);
    const { session } = await created.json() as { session: { id: string } };
    const response = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'hello' }));
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await response.text()).split('\n\n').filter((frame) => frame.startsWith('data: '));
    const events = frames.map((frame) => JSON.parse(frame.slice(6)) as { type: string });
    expect(events[0]?.type).toBe('turn.start');
    expect(events.some((event) => event.type === 'assistant.delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('turn.end');
    const detail = await (await fetch(`${url}/${session.id}`)).json() as { messages: Array<{ role: string; content: Array<{ text: string }> }> };
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(detail.messages[1]?.content[0]?.text).toBe('hello from model');
  });

  it('rejects an overlapping turn and permits interrupting the active one', async () => {
    let release: (() => void) | undefined;
    let interrupted = false;
    const { base, first } = await setup((id) => ({
      id,
      async *send() {
        yield { type: 'turn.start', step: 0 };
        await new Promise<void>((resolve) => { release = resolve; });
        yield { type: 'turn.end', reason: interrupted ? 'interrupted' : 'end_turn' };
      },
      interrupt() { interrupted = true; release?.(); },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const messagesUrl = `${url}/${session.id}/messages`;
    const active = await fetch(messagesUrl, jsonRequest({ text: 'first' }));
    const reader = active.body!.getReader();
    const firstChunk = await reader.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain('turn.start');
    const overlapping = await fetch(messagesUrl, jsonRequest({ text: 'second' }));
    expect(overlapping.status).toBe(409);
    const stop = await fetch(`${url}/${session.id}/interrupt`, jsonRequest({}));
    expect(stop.status).toBe(200);
    const rest = await reader.read();
    expect(new TextDecoder().decode(rest.value)).toContain('interrupted');
    await reader.cancel();
  });

  it('steers a direct message into the active turn and exposes the running state', async () => {
    const steered: string[] = [];
    let release: (() => void) | undefined;
    let calls = 0;
    const { base, first } = await setup((id) => ({
      id,
      async *send() {
        const call = calls;
        calls += 1;
        yield { type: 'turn.start', step: 0 };
        if (call === 0) await new Promise<void>((resolve) => { release = resolve; });
        yield { type: 'turn.end', reason: 'end_turn' };
      },
      interrupt() { release?.(); },
      async deliverUserMessage(input) {
        steered.push(typeof input === 'string' ? input : 'content');
        return 'queued' as const;
      },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const messagesUrl = `${url}/${session.id}/messages`;
    const active = await fetch(messagesUrl, jsonRequest({ text: 'first' }));
    const reader = active.body!.getReader();
    await reader.read();
    const detail = await (await fetch(`${url}/${session.id}`)).json() as { running: boolean };
    expect(detail.running).toBe(true);

    const steer = await fetch(messagesUrl, jsonRequest({ text: 'second', mode: 'steer' }));
    expect(steer.status).toBe(202);
    expect(await steer.json()).toEqual({ accepted: true, delivery: 'queued' });
    expect(steered).toEqual(['second']);
    expect((await fetch(messagesUrl, jsonRequest({ text: 'third', mode: 'queue' }))).status).toBe(400);

    await fetch(`${url}/${session.id}/interrupt`, jsonRequest({}));
    await reader.read();
    await reader.cancel();
    const settled = await (await fetch(`${url}/${session.id}`)).json() as { running: boolean };
    expect(settled.running).toBe(false);

    const idleSteer = await fetch(messagesUrl, jsonRequest({ text: 'after', mode: 'steer' }));
    expect(idleSteer.status).toBe(200);
    await idleSteer.text();
  });

  it('uses the permission snapshot captured when a turn is accepted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-permissions-snapshot-'));
    const settings = await PermissionSettings.open(join(root, 'config.json'));
    const expected = { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' };
    const lookupBlocked = signal();
    const continueLookup = signal();
    const snapshots: DshPermissionSnapshot[] = [];
    const { base, first, workspaces } = await setup((id, permissions) => {
      snapshots.push(permissions!);
      return {
        id,
        async *send() { yield { type: 'turn.end', reason: 'end_turn' }; },
        interrupt() {},
      };
    }, undefined, settings);
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const get = workspaces.get.bind(workspaces);
    let lookups = 0;
    workspaces.get = async (id) => {
      const workspace = await get(id);
      if (++lookups === 2) {
        lookupBlocked.resolve();
        await continueLookup.promise;
      }
      return workspace;
    };

    const pending = fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'first' }));
    await lookupBlocked.promise;
    try {
      const updated = await fetch(`${base}/api/settings/permissions`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultPreset: 'read-only' }),
      });
      expect(updated.status).toBe(409);
    } finally {
      continueLookup.resolve();
    }
    const response = await pending;
    await response.text();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual(expected);
  });

  it('preserves not-found responses when an unknown startup is interrupted', async () => {
    const lookupBlocked = signal();
    const continueLookup = signal();
    const { base, first, workspaces } = await setup();
    const get = workspaces.get.bind(workspaces);
    let lookups = 0;
    workspaces.get = async (id) => {
      const workspace = await get(id);
      if (++lookups === 2) {
        lookupBlocked.resolve();
        await continueLookup.promise;
      }
      return workspace;
    };
    const url = `${sessionsUrl(base, first.id)}/missing`;
    const pending = fetch(`${url}/messages`, jsonRequest({ text: 'first' }));
    await lookupBlocked.promise;
    let interrupt: Response;
    try {
      interrupt = await fetch(`${url}/interrupt`, jsonRequest({}));
    } finally {
      continueLookup.resolve();
    }
    const message = await pending;

    expect(interrupt.status).toBe(404);
    expect(message.status).toBe(404);
    expect(message.headers.get('content-type')).toContain('application/json');
  });

  it('acknowledges an interrupt during startup and ends the accepted stream as interrupted', async () => {
    const starting = signal();
    const continueStartup = signal();
    let sent = false;
    const { base, first } = await setup(async (id) => {
      starting.resolve();
      await continueStartup.promise;
      return {
        id,
        async *send() { sent = true; yield { type: 'turn.end', reason: 'end_turn' }; },
        interrupt() {},
      };
    });
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const pending = fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'first' }));
    await starting.promise;

    let interrupt: Response;
    try {
      interrupt = await fetch(`${url}/${session.id}/interrupt`, jsonRequest({}));
      expect(interrupt.status).toBe(200);
      expect(await interrupt.json()).toEqual({ ok: true });
    } finally {
      continueStartup.resolve();
    }
    const response = await pending;
    const events = (await response.text()).split('\n\n').filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as { type: string; reason?: string });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(sent).toBe(false);
    expect(events).toEqual([{ type: 'turn.end', reason: 'interrupted' }]);
  });

  it('interrupts an active turn before its session validation finishes', async () => {
    const active = signal();
    const interruptedSignal = signal();
    let interrupted = false;
    const { base, first, store } = await setup((id) => ({
      id,
      async *send() {
        yield { type: 'turn.start', step: 0 };
        await active.promise;
        yield { type: 'turn.end', reason: interrupted ? 'interrupted' : 'end_turn' };
      },
      interrupt() {
        interrupted = true;
        interruptedSignal.resolve();
        active.resolve();
      },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const response = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'first' }));
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('turn.start');
      const validationStarted = signal();
      const releaseValidation = signal();
      const open = store.open.bind(store);
      store.open = async (workspace, id) => {
        validationStarted.resolve();
        await releaseValidation.promise;
        return open(workspace, id);
      };
      const stopping = fetch(`${url}/${session.id}/interrupt`, jsonRequest({}));
      await validationStarted.promise;
      await interruptedSignal.promise;
      const terminal = await reader.read();
      expect(new TextDecoder().decode(terminal.value)).toContain('"reason":"interrupted"');
      releaseValidation.resolve();
      const stopped = await stopping;
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toEqual({ ok: true });
    } finally {
      active.resolve();
      await reader.cancel().catch(() => undefined);
    }
  });

  it('interrupts an active turn when its stream disconnects', async () => {
    let release: (() => void) | undefined;
    let interrupted = false;
    const { base, first } = await setup((id) => ({
      id,
      async *send() {
        yield { type: 'turn.start', step: 0 };
        await new Promise<void>((resolve) => { release = resolve; });
        yield { type: 'turn.end', reason: 'interrupted' };
      },
      interrupt() { interrupted = true; release?.(); },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const response = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'first' }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 2000;
      const check = () => interrupted || Date.now() >= deadline ? resolve() : setTimeout(check, 10);
      check();
    });
    expect(interrupted).toBe(true);
  });

  it('releases a disconnected turn while its session is still being created', async () => {
    const starting = signal();
    const gate = signal();
    const initialized = signal();
    let sent = false;
    const { base, first, store, host } = await setup(async (id) => {
      starting.resolve();
      await gate.promise;
      initialized.resolve();
      return {
        id,
        async *send() { sent = true; yield { type: 'turn.end', reason: 'end_turn' }; },
        interrupt() {},
      };
    });
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const serverResponse = nextResponse(host);
    const controller = new AbortController();
    const pending = fetch(`${url}/${session.id}/messages`, {
      ...jsonRequest({ text: 'first' }), signal: controller.signal,
    }).catch(() => undefined);
    await starting.promise;
    const response = await serverResponse;
    const closed = new Promise<void>((resolve) => response.once('close', resolve));
    controller.abort();
    await closed;

    try {
      const removal = await fetch(`${base}/api/workspaces/${first.id}`, { method: 'DELETE' });
      expect(removal.status).toBe(200);
    } finally {
      gate.resolve();
      await initialized.promise;
      await pending;
    }
    expect(sent).toBe(false);
    expect((await store.open(first.path, session.id)).id).toBe(session.id);
  });

  it('allows a new turn to reuse a pending session after the first client disconnects', async () => {
    const starting = signal();
    const gate = signal();
    const active = signal();
    let creations = 0;
    const { base, first, workspaces, host } = await setup(async (id) => {
      creations += 1;
      starting.resolve();
      await gate.promise;
      return {
        id,
        async *send() {
          yield { type: 'turn.start', step: 0 };
          await active.promise;
          yield { type: 'turn.end', reason: 'end_turn' };
        },
        interrupt() { active.resolve(); },
      };
    });
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const messagesUrl = `${url}/${session.id}/messages`;
    const serverResponse = nextResponse(host);
    const controller = new AbortController();
    const firstRequest = fetch(messagesUrl, { ...jsonRequest({ text: 'first' }), signal: controller.signal })
      .catch(() => undefined);
    await starting.promise;
    const response = await serverResponse;
    const closed = new Promise<void>((resolve) => response.once('close', resolve));
    controller.abort();
    await closed;

    const rechecked = signal();
    const get = workspaces.get.bind(workspaces);
    let lookups = 0;
    workspaces.get = async (id) => {
      const workspace = await get(id);
      if (++lookups === 2) rechecked.resolve();
      return workspace;
    };
    const retry = fetch(messagesUrl, jsonRequest({ text: 'second' }));
    let retryResponse: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await Promise.race([rechecked.promise, retry.then(() => undefined)]);
      gate.resolve();
      retryResponse = await retry;
      expect(retryResponse.status).toBe(200);
      reader = retryResponse.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('turn.start');
      expect((await fetch(`${base}/api/workspaces/${first.id}`, { method: 'DELETE' })).status).toBe(409);
      expect(creations).toBe(1);
    } finally {
      gate.resolve();
      active.resolve();
      await firstRequest;
      if (reader) await reader.cancel();
      else if (retryResponse) await retryResponse.body?.cancel();
    }
  });

  it('rejects session creation while a global permission update is being persisted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-default-update-'));
    const settings = await PermissionSettings.open(join(root, 'config.json'));
    const { base, first } = await setup(undefined, undefined, settings);
    const started = signal();
    const gate = signal();
    const update = settings.update.bind(settings);
    settings.update = async (value) => {
      started.resolve();
      await gate.promise;
      return update(value);
    };
    const changing = fetch(`${base}/api/settings/permissions`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultPreset: 'read-only' }),
    });
    await started.promise;
    try {
      expect((await fetch(sessionsUrl(base, first.id), jsonRequest({}))).status).toBe(409);
    } finally {
      gate.resolve();
      await changing;
    }
  });

  it('blocks session creation and every permission mutation while any turn is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-control-plane-'));
    const settings = await PermissionSettings.open(join(root, 'config.json'));
    const active = signal();
    const { base, first, store } = await setup((id) => ({
      id,
      async *send() {
        yield { type: 'turn.start', step: 0 };
        await active.promise;
        yield { type: 'turn.end', reason: 'interrupted' };
      },
      interrupt() { active.resolve(); },
    }), undefined, settings);
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const other = await store.create({ id: 'other', workspace: first.path, cwd: first.path });
    await other.append(createInitialDshPermissionEvent('workspace-write'));
    const response = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'start' }));
    const reader = response.body!.getReader();
    try {
      await reader.read();
      expect((await fetch(url, jsonRequest({}))).status).toBe(409);
      expect((await fetch(`${url}/${other.id}/permission`, jsonRequest({ preset: 'danger-full-access' }))).status).toBe(409);
      expect((await fetch(`${base}/api/settings/permissions`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultPreset: 'danger-full-access' }),
      })).status).toBe(409);
    } finally {
      active.resolve();
      await reader.cancel();
    }
  });

  it('does not unregister a workspace while a turn is starting', async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const starting = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { base, first } = await setup(async (id) => {
      started?.();
      await gate;
      return {
        id,
        async *send() { yield { type: 'turn.end', reason: 'end_turn' }; },
        interrupt() {},
      };
    });
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const request = fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'first' }));
    await starting;
    const removal = await fetch(`${base}/api/workspaces/${first.id}`, { method: 'DELETE' });
    release?.();
    const response = await request;
    await response.text();
    expect(removal.status).toBe(409);
  });

  it('does not unregister a workspace while a turn is active', async () => {
    const active = signal();
    const { base, first } = await setup((id) => ({
      id,
      async *send() {
        yield { type: 'turn.start', step: 0 };
        await active.promise;
        yield { type: 'turn.end', reason: 'end_turn' };
      },
      interrupt() { active.resolve(); },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const response = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'first' }));
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('turn.start');
      expect((await fetch(`${base}/api/workspaces/${first.id}`, { method: 'DELETE' })).status).toBe(409);
    } finally {
      active.resolve();
      await reader.cancel();
    }
  });

  it('does not unregister a workspace while a persistent session is being created', async () => {
    const { base, first, store } = await setup();
    const starting = signal();
    const gate = signal();
    const create = store.create.bind(store);
    store.create = async (input) => {
      starting.resolve();
      await gate.promise;
      return create(input);
    };
    const creating = fetch(sessionsUrl(base, first.id), jsonRequest({}));
    await starting.promise;
    let removal: Response;
    try {
      removal = await fetch(`${base}/api/workspaces/${first.id}`, { method: 'DELETE' });
    } finally {
      gate.resolve();
    }
    const created = await creating;
    const body = await created.json() as { session: { id: string } };
    expect(removal.status).toBe(409);
    expect(created.status).toBe(201);
    expect((await fetch(`${base}/api/workspaces/${first.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await store.open(first.path, body.session.id)).id).toBe(body.session.id);
  });

  it('rejects persistent session creation while unregister is in progress', async () => {
    const { base, first, store, workspaces } = await setup();
    const starting = signal();
    const gate = signal();
    const remove = workspaces.remove.bind(workspaces);
    workspaces.remove = async (id) => {
      starting.resolve();
      await gate.promise;
      return remove(id);
    };
    const removing = fetch(`${base}/api/workspaces/${first.id}`, { method: 'DELETE' });
    await starting.promise;
    try {
      const created = await fetch(sessionsUrl(base, first.id), jsonRequest({}));
      expect(created.status).toBe(409);
      expect(await store.list()).toHaveLength(0);
    } finally {
      gate.resolve();
      await removing;
    }
  });

  it('rejects session creation if unregister finishes while the request body is arriving', async () => {
    const { base, first, store, workspaces } = await setup();
    const lookedUp = signal();
    const get = workspaces.get.bind(workspaces);
    workspaces.get = async (id) => {
      const workspace = await get(id);
      lookedUp.resolve();
      return workspace;
    };
    let request!: ReturnType<typeof httpRequest>;
    const result = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      request = httpRequest(sessionsUrl(base, first.id), {
        method: 'POST', headers: { 'content-type': 'application/json' },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.write('{');
    });
    try {
      await lookedUp.promise;
      expect((await fetch(`${base}/api/workspaces/${first.id}`, { method: 'DELETE' })).status).toBe(200);
      request.end('}');
      expect((await result).status).toBe(404);
      expect(await store.list()).toHaveLength(0);
    } finally {
      request.destroy();
    }
  });

  it('cleans up losing listeners after repeated SSE backpressure drains', async () => {
    const { base, first, host } = await setup((id) => ({
      id,
      async *send() {
        for (let index = 0; index < 16; index += 1) {
          yield { type: 'assistant.delta', text: 'x'.repeat(64 * 1024) };
        }
        yield { type: 'turn.end', reason: 'end_turn' };
      },
      interrupt() {},
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const listeners: Array<{ close: number; error: number }> = [];
    host.server.once('request', (_request, response) => {
      response.setMaxListeners(0);
      response.on('drain', () => {
        listeners.push({ close: response.listenerCount('close'), error: response.listenerCount('error') });
      });
    });
    const response = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'first' }));
    await response.arrayBuffer();
    expect(listeners.length).toBeGreaterThan(10);
    expect(listeners.at(-1)!.close).toBeLessThanOrEqual(listeners[0]!.close + 1);
    expect(listeners.at(-1)!.error).toBeLessThanOrEqual(listeners[0]!.error + 1);
  });

  it('cleans up a pending SSE drain wait when the client disconnects', async () => {
    const gate = signal();
    const finished = signal();
    let completed = false;
    const { base, first, host } = await setup((id) => ({
      id,
      async *send() {
        try {
          yield { type: 'assistant.delta', text: 'x'.repeat(16 * 1024 * 1024) };
          await gate.promise;
        } finally {
          completed = true;
          finished.resolve();
        }
      },
      interrupt() {},
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const serverResponse = nextResponse(host);
    const clientResponse = new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = httpRequest(`${url}/${session.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
      }, resolve);
      request.on('error', reject);
      request.end(JSON.stringify({ text: 'first' }));
    });
    const response = await clientResponse;
    response.on('error', () => {});
    response.pause();
    const outgoing = await serverResponse;
    const closed = new Promise<void>((resolve) => outgoing.once('close', resolve));
    try {
      await expect.poll(() => outgoing.writableNeedDrain, { timeout: 2000 }).toBe(true);
      response.destroy();
      await closed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outgoing.listenerCount('drain')).toBe(0);
      // The response keeps one no-op error handler for late EPIPE callbacks.
      expect(outgoing.listenerCount('error')).toBe(1);
      await expect.poll(() => completed, { timeout: 1000 }).toBe(true);
    } finally {
      response.destroy();
      gate.resolve();
      await finished.promise;
    }
  });

  it('rejects hostile origins, malformed bodies and unregistered paths', async () => {
    const { base, first } = await setup();
    const invalidOrigin = await fetch(`${base}/api/workspaces`, {
      ...jsonRequest({ path: first.path }),
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    });
    expect(invalidOrigin.status).toBe(403);
    const crossLoopbackOrigin = await fetch(`${base}/api/workspaces`, {
      headers: { origin: base.replace('127.0.0.1', 'localhost') },
    });
    expect(crossLoopbackOrigin.status).toBe(403);
    const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/api/workspaces`, { headers: { host: 'attacker.example' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    expect(invalidHost).toBe(403);
    const malformed = await fetch(`${base}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    expect(malformed.status).toBe(400);
    const tooLarge = await fetch(`${base}/api/workspaces`, jsonRequest({ path: 'x'.repeat(70_000) }));
    expect(tooLarge.status).toBe(413);
  });

  it('returns a JSON 413 for an oversized chunked request before the upload ends', async () => {
    const { base } = await setup();
    let request!: ReturnType<typeof httpRequest>;
    const result = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      request = httpRequest(`${base}/api/workspaces`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(2000, () => request.destroy(new Error('Timed out waiting for 413')));
      request.write('{"path":"');
      request.write('x'.repeat(64 * 1024));
    });
    try {
      const response = await result;
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body)).toEqual({ error: 'Request body is too large' });
    } finally {
      request.end();
      await flushed(request);
      request.destroy();
    }
  });

  it('returns a JSON 413 for a completed oversized chunked upload', async () => {
    const { base } = await setup();
    for (const size of [64 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
      let request!: ReturnType<typeof httpRequest>;
      const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        request = httpRequest(`${base}/api/workspaces`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
          response.on('error', reject);
        });
        request.on('error', reject);
        request.setTimeout(2000, () => request.destroy(new Error('Timed out waiting for 413')));
        request.write('{"path":"');
        request.end(`${'x'.repeat(size)}"}`);
      });
      await flushed(request);
      expect(result.status).toBe(413);
      expect(JSON.parse(result.body)).toEqual({ error: 'Request body is too large' });
    }
  });

  it('rejects registering paths that are missing, relative, or files', async () => {
    const { base, first } = await setup();
    for (const path of ['relative/path', join(first.path, 'missing'), join(first.path, '..', 'workspaces.json')]) {
      const response = await fetch(`${base}/api/workspaces`, jsonRequest({ path }));
      expect(response.status).toBe(400);
    }
  });

  it('returns 404 for an interrupt on an unknown session', async () => {
    const { base, first } = await setup();
    const response = await fetch(`${sessionsUrl(base, first.id)}/missing/interrupt`, jsonRequest({}));
    expect(response.status).toBe(404);
  });

  it('returns 404 when a legacy session has a conflicting modern identity', async () => {
    const { base, first, store } = await setup();
    await store.create({ id: 'conflict', workspace: first.path, cwd: first.path });
    const originalOpen = store.open.bind(store);
    store.open = async (workspace, id) => {
      if (workspace === first.path && id === 'conflict') throw new Error('session identity mismatch');
      return originalOpen(workspace, id);
    };
    const response = await fetch(`${sessionsUrl(base, first.id)}/conflict`);
    expect(response.status).toBe(404);
  });

  it('streams an error terminal event when session startup fails after the SSE boundary', async () => {
    const { base, first } = await setup(async (id) => ({
      id,
      async *send() {
        yield { type: 'turn.start', step: 0 };
        throw new Error('provider failure');
      },
      interrupt() {},
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const response = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'fail' }));
    const events = (await response.text()).split('\n\n').filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as { type: string; reason?: string });
    expect(response.status).toBe(200);
    expect(events.at(-2)?.type).toBe('error');
    expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'error' });
  });

  it('reads audit entries through the session audit route without leaking sensitive fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-audit-'));
    const firstPath = join(root, 'project-one');
    const secondPath = join(root, 'project-two');
    await mkdir(firstPath);
    await mkdir(secondPath);
    const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
    const first = await workspaces.add(firstPath);
    const second = await workspaces.add(secondPath);
    const store = new SessionStore(join(root, 'sessions'));
    await store.create({ id: 'shared', workspace: first.path, cwd: first.path });
    await store.create({ id: 'shared', workspace: second.path, cwd: second.path });
    await recordWorkspaceAudit(root, first.path, {
      ts: new Date().toISOString(), sessionId: 'shared', step: 0, tool: 'read_file', callId: 'one',
      argsDigest: 'SECRET_ARGS', decision: 'allow', source: 'SECRET_RULE', ok: true,
    });
    await recordWorkspaceAudit(root, second.path, {
      ts: new Date().toISOString(), sessionId: 'shared', step: 0, tool: 'write_file', callId: 'two',
      argsDigest: 'OTHER_SECRET', decision: 'deny', source: 'OTHER_RULE', ok: false,
    });
    const host = await startWebHost({
      workspaces,
      store,
      createSession: (_workspace, handle) => new Session({
        cwd: handle.header.cwd, model: new FakeModel([textResponse('ok')]), approve: async () => 'deny', session: handle,
      }),
      readAudit: (workspace, sessionId) => readWorkspaceAudit(root, workspace.path, sessionId),
    });
    hosts.push(host);
    const firstAudit = await (await fetch(`${sessionsUrl(host.address()!, first.id)}/shared/audit`)).json() as { audit: unknown[] };
    const secondAudit = await (await fetch(`${sessionsUrl(host.address()!, second.id)}/shared/audit`)).json() as { audit: unknown[] };
    expect(firstAudit.audit).toMatchObject([{ callId: 'one', tool: 'read_file' }]);
    expect(secondAudit.audit).toMatchObject([{ callId: 'two', tool: 'write_file' }]);
    const text = JSON.stringify(firstAudit);
    expect(text).not.toContain('SECRET_ARGS');
    expect(text).not.toContain('SECRET_RULE');
  });

  it('persists plan mode and todo state and exposes both in session details', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const { session } = await jsonResponse<{ session: { id: string } }>(await fetch(url, jsonRequest({})));
    const handle = await store.open(first.path, session.id);
    const todos = [
      { content: 'Inspect the code', status: 'completed' },
      { content: 'Implement the change', status: 'in_progress' },
    ];
    await handle.append({ type: 'todo/write', data: { todos } });

    let detail = await jsonResponse<{ plan: { active: boolean }; todos: unknown }>(await fetch(`${url}/${session.id}`));
    expect(detail).toMatchObject({ plan: { active: false }, todos });
    expect((await fetch(`${url}/${session.id}/plan`, jsonRequest({ active: true }))).status).toBe(200);
    detail = await jsonResponse<{ plan: { active: boolean }; todos: unknown }>(await fetch(`${url}/${session.id}`));
    expect(detail).toMatchObject({ plan: { active: true }, todos });
    expect((await fetch(`${url}/${session.id}/plan`, jsonRequest({ active: true, extra: true }))).status).toBe(400);
    expect((await fetch(`${url}/${session.id}/plan`, jsonRequest({ active: 'yes' }))).status).toBe(400);
    expect(await (await fetch(`${url}/${session.id}/plan`, jsonRequest({ active: false }))).json()).toEqual({ plan: { active: false } });
    expect((await jsonResponse<{ plan: { active: boolean } }>(await fetch(`${url}/${session.id}`))).plan).toEqual({ active: false });
    expect((await store.open(first.path, session.id)).events.filter((event) => event.type === 'plan/mode')).toHaveLength(2);
  });

  it('streams plan review prompts and resumes the turn after an approved decision', async () => {
    const approvals = new ApprovalBroker();
    const plan = '# Plan\n\n1. Inspect.\n2. Implement.';
    const { base, first, store } = await setup(
      (id, permissions, workspace, handle) => new Session({
        cwd: workspace.path,
        dshPermissions: permissions,
        session: handle,
        model: new FakeModel([
          toolCallResponse([{ id: 'exit', name: 'exit_plan_mode', args: { plan } }]),
          textResponse('implemented'),
        ], { onExhausted: textResponse('done') }),
        approve: async () => 'deny',
        reviewPlan: approvals.planHandler(workspace.path, id),
      }),
      undefined,
      undefined,
      approvals,
    );
    const url = sessionsUrl(base, first.id);
    const { session } = await jsonResponse<{ session: { id: string } }>(await fetch(url, jsonRequest({})));
    expect((await fetch(`${url}/${session.id}/plan`, jsonRequest({ active: true }))).status).toBe(200);
    expect((await fetch(`${url}/${session.id}/plan-review`, jsonRequest({}))).status).toBe(400);

    const response = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'plan it' }));
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: Array<Record<string, unknown>> = [];
    let buffer = '';
    const readEvents = (final: boolean): void => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as Record<string, unknown>);
      }
      if (final && buffer.startsWith('data: ')) events.push(JSON.parse(buffer.slice(6)) as Record<string, unknown>);
    };
    while (true) {
      const part = await reader.read();
      if (part.done) { readEvents(true); break; }
      buffer += decoder.decode(part.value, { stream: true });
      readEvents(false);
      if (events.some((event) => event.type === 'plan.review.requested')) break;
    }
    const prompt = events.find((event) => event.type === 'plan.review.requested');
    expect(prompt).toMatchObject({ type: 'plan.review.requested', plan });
    expect(typeof prompt?.requestId).toBe('string');

    const decided = await fetch(`${url}/${session.id}/plan-review`, jsonRequest({
      requestId: prompt!.requestId, approved: true, feedback: 'Go ahead',
    }));
    expect(decided.status).toBe(200);
    while (true) {
      const part = await reader.read();
      if (part.done) { readEvents(true); break; }
      buffer += decoder.decode(part.value, { stream: true });
      readEvents(false);
    }
    reader.releaseLock();
    expect(events.at(-1)).toEqual({ type: 'turn.end', reason: 'end_turn' });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'plan.review.decided', requestId: prompt!.requestId, approved: true, feedback: 'Go ahead',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.result', result: expect.objectContaining({ name: 'exit_plan_mode', ok: true }),
    }));
    expect((await jsonResponse<{ plan: { active: boolean } }>(await fetch(`${url}/${session.id}`))).plan).toEqual({ active: false });
    expect((await store.open(first.path, session.id)).events).toContainEqual(expect.objectContaining({
      type: 'plan/mode', data: { active: false },
    }));
    expect((await fetch(`${url}/${session.id}/plan-review`, jsonRequest({
      requestId: prompt!.requestId, approved: true,
    }))).status).toBe(409);
  });

  it('unregisters a workspace without deleting its stored sessions', async () => {
    const { base, first, store } = await setup();
    await store.create({ id: 'keep', workspace: first.path, cwd: first.path });
    expect((await fetch(`${base}/api/workspaces/${first.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(sessionsUrl(base, first.id))).status).toBe(404);
    expect((await new SessionStore(join(first.path, '..', 'sessions')).open(first.path, 'keep')).id).toBe('keep');
  });

  it('searches workspace files for composer references without leaking excluded trees', async () => {
    const { base, first } = await setup();
    await mkdir(join(first.path, 'src', 'lib'), { recursive: true });
    await mkdir(join(first.path, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(first.path, 'src', 'main.ts'), 'export {};\n');
    await writeFile(join(first.path, 'src', 'lib', 'util.ts'), 'export const x = 1;\n');
    await writeFile(join(first.path, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
    const root = await jsonResponse<{ entries: Array<{ path: string; kind: string }> }>(
      await fetch(`${base}/api/workspaces/${first.id}/files?query=`),
    );
    expect(root.entries.map((entry) => [entry.path, entry.kind])).toEqual([['src', 'directory']]);
    const nested = await jsonResponse<{ entries: Array<{ path: string; name: string; kind: string }> }>(
      await fetch(`${base}/api/workspaces/${first.id}/files?query=util&limit=5`),
    );
    expect(nested.entries).toContainEqual({ path: 'src/lib/util.ts', name: 'util.ts', kind: 'file' });
    expect(nested.entries.some((entry) => entry.path.includes('node_modules'))).toBe(false);
    expect((await fetch(`${base}/api/workspaces/${first.id}/files?query=${'a'.repeat(1025)}`)).status).toBe(400);
  });

  it('accepts image and text attachments and persists the composed user content', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const { session } = await jsonResponse<{ session: { id: string } }>(await fetch(url, jsonRequest({})));
    const image = Buffer.from('image-bytes').toString('base64');
    const accepted = await fetch(`${url}/${session.id}/messages`, jsonRequest({
      text: 'Inspect these files',
      attachments: [
        { kind: 'text', name: 'notes.txt', mediaType: 'text/plain', text: 'release checklist' },
        { kind: 'image', name: 'screen.png', mediaType: 'image/png', data: image },
      ],
    }));
    expect(accepted.status).toBe(200);
    await accepted.text();

    const stored = (await store.open(first.path, session.id)).events.find((event) => event.type === 'message/user');
    expect(stored?.data).toMatchObject({
      content: [
        { type: 'text', text: 'Inspect these files' },
        expect.objectContaining({ type: 'text', text: expect.stringContaining('release checklist') }),
        { type: 'image', mediaType: 'image/png', data: image },
      ],
    });
    const detail = await jsonResponse<{ messages: Array<{ role: string; content?: Array<Record<string, unknown>> }> }>(
      await fetch(`${url}/${session.id}`),
    );
    const user = detail.messages.find((message) => message.role === 'user');
    expect(user?.content).toContainEqual({ type: 'image', mediaType: 'image/png', data: image });

    const invalid = await fetch(`${url}/${session.id}/messages`, jsonRequest({
      attachments: [{ kind: 'image', name: 'bad.svg', mediaType: 'image/svg+xml', data: image }],
    }));
    expect(invalid.status).toBe(400);
    expect((await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: '   ' }))).status).toBe(400);
  });

  it('lists recent root sessions with the current workspace first and LIKE filtering', async () => {
    const { base, first, second, store } = await setup();
    const alpha = await store.create({ id: 'alpha-session', workspace: first.path, cwd: first.path });
    await alpha.append({ type: 'message/user', data: { text: 'alpha' } });
    const beta = await store.create({ id: 'beta-session', workspace: second.path, cwd: second.path });
    await beta.append({ type: 'message/user', data: { text: 'beta' } });
    const child = await store.create({
      id: 'child-session', workspace: first.path, cwd: first.path,
      parentSessionId: alpha.id, depth: 1,
    });
    await child.append({ type: 'message/user', data: { text: 'child' } });

    type Recent = {
      sessions: Array<{ id: string; workspaceId: string; title: string | null; blank: boolean }>;
    };
    const recent = await jsonResponse<Recent>(
      await fetch(`${base}/api/sessions/recent?workspaceId=${first.id}&limit=10`),
    );
    expect(recent.sessions.map((item) => item.id)).toEqual(['alpha-session', 'beta-session']);
    expect(recent.sessions[0]).toMatchObject({ workspaceId: first.id, title: null, blank: false });

    const limited = await jsonResponse<Recent>(
      await fetch(`${base}/api/sessions/recent?workspaceId=${first.id}&limit=1`),
    );
    expect(limited.sessions.map((item) => item.id)).toEqual(['alpha-session']);

    const filtered = await jsonResponse<Recent>(
      await fetch(`${base}/api/sessions/recent?workspaceId=${first.id}&query=BETA`),
    );
    expect(filtered.sessions.map((item) => item.id)).toEqual(['beta-session']);
    expect((await fetch(`${base}/api/sessions/recent?workspaceId=missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/sessions/recent?query=${'a'.repeat(1025)}`)).status).toBe(400);
  });

  it('schedules context compaction for the next message', async () => {
    let compactions = 0;
    const { base, first } = await setup((id) => ({
      id,
      async *send() { yield { type: 'turn.end', reason: 'end_turn' }; },
      interrupt() {},
      requestCompaction() { compactions += 1; },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await jsonResponse<{ session: { id: string } }>(await fetch(url, jsonRequest({})));

    const pending = await fetch(`${url}/${session.id}/compact`, jsonRequest({}));
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ ok: true, scheduled: true });
    expect(compactions).toBe(0);

    const sent = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'continue' }));
    expect(sent.status).toBe(200);
    await sent.text();
    expect(compactions).toBe(1);

    expect((await fetch(`${url}/missing/compact`, jsonRequest({}))).status).toBe(404);
  });
});
