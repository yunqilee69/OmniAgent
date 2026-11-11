import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
import { hydrateTranscript, userMessageCopyText } from '../ui/src/lib/events';
import type { PublicMessage } from '../ui/src/lib/wire';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UserContent } from '../ui/src/components/ConversationView';

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

function asyncRequest(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', prefer: 'respond-async' }, body: JSON.stringify(body) };
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
  it('follows before the initial message is persisted and replays steering in order', async () => {
    const beforeFirst = signal();
    const releaseFirst = signal();
    const releaseEnd = signal();
    const { base, first } = await setup((id) => ({
      id,
      async *send() {
        beforeFirst.resolve();
        await releaseFirst.promise;
        yield { type: 'turn.start', step: 0 };
        yield { type: 'assistant.delta', text: 'answer' } as never;
        await releaseEnd.promise;
        yield { type: 'turn.end', reason: 'end_turn' };
      },
      async deliverUserMessage() { return 'queued' as const; },
      interrupt() { releaseFirst.resolve(); releaseEnd.resolve(); },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const path = `${url}/${session.id}`;
    const posting = fetch(`${path}/messages`, asyncRequest({ text: 'question' }));
    await beforeFirst.promise;
    const detail = await (await fetch(path)).json() as { running: boolean; messages: unknown[] };
    expect(detail.running).toBe(true);
    expect(detail.messages).toEqual([]);
    const follower = await fetch(`${path}/follow`);
    const reader = follower.body!.getReader();
    const decoder = new TextDecoder();
    const snapshot = JSON.parse(decoder.decode((await reader.read()).value).slice(6));
    expect(snapshot).toMatchObject({ baseline: { messages: [] }, events: [] });
    releaseFirst.resolve();
    expect((await posting).status).toBe(202);
    expect((await fetch(`${path}/messages`, jsonRequest({ text: 'follow up', mode: 'steer' }))).status).toBe(202);
    const replay = await fetch(`${path}/follow`);
    const replayReader = replay.body!.getReader();
    const replaySnapshot = JSON.parse(decoder.decode((await replayReader.read()).value).slice(6));
    expect(replaySnapshot.events.map((event: { type: string }) => event.type)).toEqual([
      'run.user.message', 'turn.start', 'assistant.delta', 'run.user.message',
    ]);
    expect(replaySnapshot.events.filter((event: { type: string }) => event.type === 'run.user.message')
      .map((event: { message: { content: unknown } }) => event.message.content)).toEqual([
      [{ type: 'text', text: 'question' }], [{ type: 'text', text: 'follow up' }],
    ]);
    releaseEnd.resolve();
    await reader.cancel();
    await replayReader.cancel();
  });

  it('publishes an in-flight steer before the terminal event', async () => {
    const deliveryStarted = signal();
    const deliveryGate = signal();
    const endGate = signal();
    const { base, first } = await setup((id) => ({
      id,
      async *send() {
        yield { type: 'turn.start', step: 0 };
        await endGate.promise;
        yield { type: 'turn.end', reason: 'end_turn' };
      },
      async deliverUserMessage() { deliveryStarted.resolve(); await deliveryGate.promise; return 'queued' as const; },
      interrupt() { endGate.resolve(); deliveryGate.resolve(); },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const path = `${url}/${session.id}`;
    expect((await fetch(`${path}/messages`, asyncRequest({ text: 'first' }))).status).toBe(202);
    const follow = await fetch(`${path}/follow`);
    const pending = fetch(`${path}/messages`, jsonRequest({ text: 'next', mode: 'steer' }));
    await deliveryStarted.promise;
    endGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    deliveryGate.resolve();
    expect((await pending).status).toBe(202);
    const frames = (await follow.text()).split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.slice(6)));
    expect(frames.slice(1).map((event) => event.type)).toEqual(['run.user.message', 'turn.end']);
  });

  it('replays an atomic snapshot and continues after followers disconnect', async () => {
    const gate = signal();
    const emitted = signal();
    const { base, first } = await setup((id) => ({
      id,
      async *send() {
        yield { type: 'turn.start', step: 0 };
        emitted.resolve();
        await gate.promise;
        yield { type: 'assistant.delta', text: 'later' } as never;
        yield { type: 'turn.end', reason: 'end_turn' };
      },
      interrupt() { gate.resolve(); },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const path = `${url}/${session.id}`;
    const accepted = await fetch(`${path}/messages`, asyncRequest({ text: 'hello' }));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true });
    await emitted.promise;
    const firstFollow = await fetch(`${path}/follow`);
    const reader = firstFollow.body!.getReader();
    const snapshot = new TextDecoder().decode((await reader.read()).value);
    expect(snapshot).toContain('run.snapshot');
    expect(snapshot).toContain('turn.start');
    await reader.cancel();
    const second = await fetch(`${path}/follow`);
    gate.resolve();
    const text = await second.text();
    const events = text.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.slice(6)));
    expect(events[0]).toMatchObject({ type: 'run.snapshot', baseline: { messages: [] }, events: [{ type: 'run.user.message' }, { type: 'turn.start' }] });
    expect(events.slice(1).map((event) => event.type)).toEqual(['assistant.delta', 'turn.end']);
    expect((await fetch(`${path}/follow`)).status).toBe(204);
  });

  it('retains a bounded replay and remains followable after overflow', async () => {
    const gate = signal();
    const emitted = signal();
    let interrupted = false;
    const { base, first } = await setup((id) => ({
      id,
      async *send() {
        yield { type: 'assistant.delta', text: 'x'.repeat(8 * 1024 * 1024) } as never;
        emitted.resolve();
        await gate.promise;
        yield { type: 'turn.end', reason: 'end_turn' };
      },
      interrupt() { interrupted = true; gate.resolve(); },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const path = `${url}/${session.id}`;
    expect((await fetch(`${path}/messages`, asyncRequest({ text: 'hello' }))).status).toBe(202);
    await emitted.promise;
    const follow = await fetch(`${path}/follow`);
    expect(follow.status).toBe(200);
    const reader = follow.body!.getReader();
    const firstFrame = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(firstFrame.slice(6))).toMatchObject({ type: 'run.snapshot', truncated: true });
    expect(interrupted).toBe(false);
    gate.resolve();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('turn.end');
    await reader.cancel();
    await expect.poll(async () => (await fetch(path).then((response) => response.json()) as { running: boolean }).running).toBe(false);
    expect(interrupted).toBe(false);
  });

  it('recovers a pending approval after the replay limit and accepts its decision', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 10_000 });
    const requesting = signal();
    let decision: string | undefined;
    const { base, first } = await setup((id, _permissions, workspace) => ({
      id,
      async *send() {
        yield { type: 'assistant.delta', text: 'x'.repeat(8 * 1024 * 1024) } as never;
        requesting.resolve();
        decision = await broker.handler(workspace.path, id)!({
          id: 'call', call: { id: 'call', name: 'write_file', arguments: {}, raw: '{}' }, reason: 'write',
        }, new AbortController().signal);
        yield { type: 'turn.end', reason: 'end_turn' };
      },
      interrupt() {},
    }), undefined, undefined, broker);
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const path = `${url}/${session.id}`;
    expect((await fetch(`${path}/messages`, asyncRequest({ text: 'hello' }))).status).toBe(202);
    await requesting.promise;
    let prompt: { requestId: string } | undefined;
    let follow: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    for (let attempt = 0; attempt < 50 && !prompt; attempt++) {
      follow = await fetch(`${path}/follow`);
      reader = follow.body!.getReader();
      const snapshot = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6)) as {
        truncated: boolean; events: Array<{ type: string; requestId: string }>;
      };
      expect(snapshot.truncated).toBe(true);
      prompt = snapshot.events.find((event) => event.type === 'permission.requested');
      if (!prompt) { await reader.cancel(); await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    expect(prompt).toBeDefined();
    expect((await fetch(`${path}/approvals`, jsonRequest({ requestId: prompt!.requestId, decision: 'allow' }))).status).toBe(200);
    await expect.poll(() => decision).toBe('allow');
    await reader!.cancel();
  });

  it('reports an async failure before the first event instead of acknowledging a lost run', async () => {
    const { base, first } = await setup((id) => ({
      id,
      async *send() { throw new Error('startup failed'); yield { type: 'turn.start', step: 0 }; },
      interrupt() {},
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const response = await fetch(`${url}/${session.id}/messages`, asyncRequest({ text: 'hello' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'turn_start_failed_message_may_be_saved' });
  });

  it('reports an uncertain startup failure after persisting the user message', async () => {
    const { base, first, store } = await setup((id, _permissions, _workspace, handle) => ({
      id,
      async *send(input) {
        await handle.append({ type: 'message/user', data: { text: input } });
        throw new Error('failure after persistence');
        yield { type: 'turn.start', step: 0 };
      },
      interrupt() {},
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const response = await fetch(`${url}/${session.id}/messages`, asyncRequest({ text: 'already saved' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'turn_start_failed_message_may_be_saved' });
    const messages = projectMessages((await store.open(first.path, session.id)).events);
    expect(messages).toMatchObject([{ role: 'user', content: [{ type: 'text', text: 'already saved' }] }]);
  });

  it('persists the submitted user message before acknowledging it', async () => {
    const { base, first, store } = await setup();
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const response = await fetch(`${url}/${session.id}/messages`, asyncRequest({ text: 'persist before acceptance' }));
    expect(response.status).toBe(202);
    const handle = await store.open(first.path, session.id);
    expect(projectMessages(handle.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: [expect.objectContaining({ text: 'persist before acceptance' })] }),
    ]));
  });

  it('reconciles a quickly completed turn through persisted session detail', async () => {
    const { base, first } = await setup();
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const path = `${url}/${session.id}`;
    expect((await fetch(`${path}/messages`, asyncRequest({ text: 'hello' }))).status).toBe(202);
    await expect.poll(async () => (await fetch(`${path}/follow`)).status).toBe(204);
    const detail = await (await fetch(path)).json() as { messages: Array<{ role: string }> };
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('exposes persisted history metadata in both read endpoints', async () => {
    const { base, first, store } = await setup();
    const handle = await store.create({ id: 'history-metadata', workspace: first.path, cwd: first.path });
    await handle.append({ type: 'message/user', ts: 1234, data: { text: 'original' } });
    const url = `${sessionsUrl(base, first.id)}/history-metadata`;
    const detail = await jsonResponse<{ messages: Array<{ messageId: string; timestamp: number }> }>(await fetch(url));
    const list = await jsonResponse<typeof detail>(await fetch(`${url}/messages`));
    expect(list).toEqual({ messages: detail.messages });
    expect(detail.messages[0]).toMatchObject({ timestamp: 1234, messageId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
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

  it('interrupts the real session while its user message is being persisted', async () => {
    const writing = signal();
    const release = signal();
    const model = new FakeModel([textResponse('unexpected')]);
    const { base, first } = await setup((_id, permissions, workspace, handle) => {
      const append = handle.append.bind(handle);
      handle.append = async (event) => {
        if (event.type === 'message/user') {
          writing.resolve();
          await release.promise;
        }
        return append(event);
      };
      return new Session({ cwd: workspace.path, model, session: handle, dshPermissions: permissions });
    });
    const url = sessionsUrl(base, first.id);
    const { session } = await (await fetch(url, jsonRequest({}))).json() as { session: { id: string } };
    const path = `${url}/${session.id}`;
    const sending = fetch(`${path}/messages`, jsonRequest({ text: 'hello' }));
    await writing.promise;
    try {
      expect((await fetch(`${path}/interrupt`, jsonRequest({}))).status).toBe(200);
    } finally {
      release.resolve();
    }
    const response = await sending;
    expect(await response.text()).toContain('"reason":"interrupted"');
    expect(model.requests).toHaveLength(0);
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
    const steered: Array<string | readonly import('../../core/src/domain/message').ContentPart[]> = [];
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
        steered.push(input);
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
    expect(await steer.json()).toEqual({ accepted: true, delivery: 'queued', broadcast: true });
    expect(steered).toEqual(['second']);
    const steeredFile = await fetch(messagesUrl, jsonRequest({ mode: 'steer', attachments: [
      { kind: 'file', name: '../report.dsh', mimeType: 'application/octet-stream', data: 'AAEC' },
    ] }));
    expect(steeredFile.status).toBe(202);
    const parts = steered[1] as readonly { type: string; text?: string }[];
    const path = JSON.parse(parts[0]!.text!.match(/: ("[^"]+")\./)![1]!);
    expect(await readFile(path)).toEqual(Buffer.from([0, 1, 2]));
    expect(parts[0]!.text).toContain('../report.dsh');
    expect((await fetch(messagesUrl, jsonRequest({ text: 'third', mode: 'queue' }))).status).toBe(400);

    await fetch(`${url}/${session.id}/interrupt`, jsonRequest({}));
    await reader.read();
    await reader.cancel();
    const settled = await (await fetch(`${url}/${session.id}`)).json() as { running: boolean };
    expect(settled.running).toBe(false);

    const idleSteer = await fetch(messagesUrl, jsonRequest({ text: 'after', mode: 'steer' }));
    expect(idleSteer.status).toBe(409);
    expect(calls).toBe(1);
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

  it('continues an active turn when its POST stream disconnects', async () => {
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
    const follow = await fetch(`${url}/${session.id}/follow`);
    expect(follow.status).toBe(200);
    const follower = follow.body!.getReader();
    expect(new TextDecoder().decode((await follower.read()).value)).toContain('turn.start');
    expect(interrupted).toBe(false);
    release!();
    expect(new TextDecoder().decode((await follower.read()).value)).toContain('turn.end');
    await follower.cancel();
    expect(interrupted).toBe(false);
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

  it('allows a concurrent session and turn while another turn is active', async () => {
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
    let secondReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await reader.read();
      const created = await fetch(url, jsonRequest({}));
      expect(created.status).toBe(201);
      const body = await created.json() as {
        session: { id: string };
        permission: { preset: string | null };
      };
      expect(body.permission.preset).toBe('workspace-write');

      const second = await fetch(`${url}/${body.session.id}/messages`, jsonRequest({ text: 'parallel' }));
      secondReader = second.body!.getReader();
      expect(new TextDecoder().decode((await secondReader.read()).value)).toContain('turn.start');

      // Authorization mutations on other sessions remain blocked.
      expect((await fetch(`${url}/${other.id}/permission`, jsonRequest({ preset: 'danger-full-access' }))).status).toBe(409);
      expect((await fetch(`${base}/api/settings/permissions`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultPreset: 'danger-full-access' }),
      })).status).toBe(409);
    } finally {
      active.resolve();
      await reader.cancel();
      await secondReader?.cancel();
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

  it('bounds slow SSE followers without stopping the producer', async () => {
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
    const response = await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: 'first' }));
    await response.arrayBuffer().catch(() => undefined);
    await expect.poll(async () => (await fetch(`${url}/${session.id}`).then((result) => result.json()) as { running: boolean }).running).toBe(false);
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
      expect(completed).toBe(false);
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

  it('browses and previews files in the requested workspace with safe errors', async () => {
    const { base, first, second } = await setup();
    await writeFile(join(first.path, 'only-first.txt'), 'first');
    await writeFile(join(second.path, 'only-second.txt'), 'second');
    await writeFile(join(first.path, 'binary'), Buffer.from([0, 1]));
    const prefix = `${base}/api/workspaces/${first.id}/files`;
    const tree = await jsonResponse<{ entries: Array<{ path: string }> }>(await fetch(`${prefix}/tree?path=`));
    expect(tree.entries.map((entry) => entry.path)).toContain('only-first.txt');
    expect(tree.entries.map((entry) => entry.path)).not.toContain('only-second.txt');
    expect(await jsonResponse(await fetch(`${prefix}/content?path=only-first.txt`))).toEqual({ path: 'only-first.txt', content: 'first' });
    expect((await fetch(`${prefix}/content?path=only-second.txt`)).status).toBe(404);
    expect((await fetch(`${prefix}/content?path=${encodeURIComponent('../only-second.txt')}`)).status).toBe(400);
    expect((await fetch(`${prefix}/content?path=binary`)).status).toBe(415);
    expect((await fetch(`${base}/api/workspaces/not-found/files/tree`)).status).toBe(404);
  });

  it('serves raw bytes with displayable types, ranges, and download dispositions', async () => {
    const { base, first, second } = await setup();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    await writeFile(join(first.path, 'cover.png'), png);
    await writeFile(join(second.path, 'secret.png'), png);
    await writeFile(join(first.path, 'page.html'), '<h1>hi</h1>');
    await writeFile(join(first.path, 'readme.txt'), 'hello');
    const url = `${base}/api/workspaces/${first.id}/files/raw`;

    const full = await fetch(`${url}?path=cover.png`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('image/png');
    expect(full.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''cover.png");
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-length')).toBe(String(png.length));
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(full.headers.get('x-frame-options')).toBeNull();
    expect(Buffer.from(await full.arrayBuffer())).toEqual(png);

    const head = await fetch(`${url}?path=cover.png`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(png.length));

    const ranged = await fetch(`${url}?path=cover.png`, { headers: { range: 'bytes=1-3' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 1-3/${png.length}`);
    expect(ranged.headers.get('content-length')).toBe('3');
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(png.subarray(1, 4));

    const suffix = await fetch(`${url}?path=cover.png`, { headers: { range: 'bytes=-2' } });
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(png.subarray(png.length - 2));

    const unsatisfiable = await fetch(`${url}?path=cover.png`, { headers: { range: 'bytes=999-1200' } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${png.length}`);

    const download = await fetch(`${url}?path=cover.png&download=1`);
    expect(download.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''cover.png");

    // Non-whitelisted types are download-only, so the route never becomes an XSS origin.
    const html = await fetch(`${url}?path=page.html`);
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
    expect(html.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''page.html");
    const text = await fetch(`${url}?path=readme.txt`);
    expect(text.headers.get('content-type')).toBe('application/octet-stream');

    expect((await fetch(`${url}?path=secret.png`)).status).toBe(404);
    expect((await fetch(`${url}?path=${encodeURIComponent('../project-two/secret.png')}`)).status).toBe(400);
    expect((await fetch(`${url}?path=`)).status).toBe(400);
  });

  it('renames, moves, and deletes workspace entries behind the path fence', async () => {
    const { base, first } = await setup();
    await mkdir(join(first.path, 'docs'), { recursive: true });
    await writeFile(join(first.path, 'docs', 'guide.md'), '# Guide\n');
    await writeFile(join(first.path, 'taken.md'), 'x');
    const prefix = `${base}/api/workspaces/${first.id}/files`;
    const post = (suffix: string, body: unknown): Promise<Response> => fetch(`${prefix}/${suffix}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const renamed = await post('rename', { path: 'docs/guide.md', name: 'manual.md' });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ entry: { path: 'docs/manual.md', name: 'manual.md', kind: 'file' } });
    expect(await readFile(join(first.path, 'docs', 'manual.md'), 'utf8')).toBe('# Guide\n');

    const moved = await post('move', { path: 'docs/manual.md', directory: '' });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ entry: { path: 'manual.md', name: 'manual.md', kind: 'file' } });

    expect((await post('rename', { path: 'manual.md', name: 'taken.md' })).status).toBe(409);
    expect((await post('rename', { path: 'manual.md', name: '../escape.md' })).status).toBe(400);
    expect((await post('rename', { path: 'missing.md', name: 'next.md' })).status).toBe(404);
    expect((await post('rename', { path: '.git/config', name: 'config' })).status).toBe(403);
    await mkdir(join(first.path, 'docs', 'sub'), { recursive: true });
    expect((await post('move', { path: 'docs', directory: 'docs/sub' })).status).toBe(400);
    expect((await post('move', { path: 'manual.md', directory: 'nowhere' })).status).toBe(404);
    expect((await post('move', { path: 'manual.md' })).status).toBe(400);
    expect((await post('rename', { path: '../project-two/x.md', name: 'x.md' })).status).toBe(400);

    const removed = await fetch(`${prefix}?path=${encodeURIComponent('manual.md')}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    await expect(readFile(join(first.path, 'manual.md'))).rejects.toBeInstanceOf(Error);
    expect((await fetch(`${prefix}?path=missing.md`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${prefix}?path=`, { method: 'DELETE' })).status).toBe(400);
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
        { kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', data: Buffer.from('pdf-bytes').toString('base64') },
        { kind: 'image', name: 'screen.png', mediaType: 'image/png', data: image },
      ],
    }));
    expect(accepted.status).toBe(200);
    await accepted.text();

    const stored = (await store.open(first.path, session.id)).events.find((event) => event.type === 'message/user');
    const content = (stored?.data as { content: Array<{ type: string; text?: string; fileName?: string; filePath?: string; data?: string; attachment?: { kind: string; name: string; mediaType: string; filePath: string } }> }).content;
    expect(content[0]).toEqual({ type: 'text', text: 'Inspect these files' });
    expect(JSON.stringify(content)).not.toContain('release checklist');
    expect(content[1]?.text).toContain('notes.txt');
    const notesPath = JSON.parse(content[1]!.text!.match(/: ("[^"]+")\./)![1]!) as string;
    const pdfPath = content[2]!.attachment!.filePath;
    const imagePath = content[3]!.attachment!.filePath;
    expect(content[1]!.attachment).toEqual({ kind: 'file', name: 'notes.txt', mediaType: 'text/plain', filePath: notesPath });
    expect(content[2]!.attachment).toEqual({ kind: 'file', name: 'report.pdf', mediaType: 'application/pdf', filePath: pdfPath });
    expect(content[3]!.attachment).toEqual({ kind: 'image', name: 'screen.png', mediaType: 'image/png', filePath: imagePath });
    expect(isAbsolute(notesPath)).toBe(true);
    expect(await readFile(notesPath, 'utf8')).toBe('release checklist');
    expect(await readFile(pdfPath, 'utf8')).toBe('pdf-bytes');
    expect(content[4]).toEqual({ type: 'image', mediaType: 'image/png', data: image, fileName: 'screen.png', filePath: imagePath });
    expect(await readFile(imagePath, 'utf8')).toBe('image-bytes');
    const detail = await jsonResponse<{ messages: PublicMessage[] }>(await fetch(`${url}/${session.id}`));
    const list = await jsonResponse<{ messages: PublicMessage[] }>(await fetch(`${url}/${session.id}/messages`));
    expect(list.messages).toEqual(detail.messages);
    const user = detail.messages.find((message) => message.role === 'user');
    expect(user?.content).toEqual(content);
    const replayed = hydrateTranscript(detail.messages).transcript.find((item) => item.kind === 'user');
    expect(replayed).toMatchObject({ kind: 'user', text: 'Inspect these files', attachments: [
      { kind: 'file', name: 'notes.txt', mediaType: 'text/plain' },
      { kind: 'file', name: 'report.pdf', mediaType: 'application/pdf' },
      { kind: 'image', name: 'screen.png', mediaType: 'image/png', data: image },
    ] });
    if (replayed?.kind !== 'user') throw new Error('Expected replayed user message');
    expect(userMessageCopyText(replayed.text, replayed.attachments)).toBe('Inspect these files');
    const markup = renderToStaticMarkup(createElement(UserContent, { user: replayed }));
    expect(markup).toContain('notes.txt');
    expect(markup).toContain('report.pdf');
    expect(markup).toContain(`data:image/png;base64,${image}`);
    expect(markup).not.toContain('Untrusted attachment metadata');
    for (const path of [notesPath, pdfPath, imagePath]) expect(markup).not.toContain(path);
    const forked = await jsonResponse<{ session: { id: string } }>(await fetch(`${url}/${session.id}/fork`, jsonRequest({})));
    expect((await fetch(`${url}/${session.id}`, { method: 'DELETE' })).status).toBe(200);
    const fork = await jsonResponse<{ messages: Array<{ content?: Array<Record<string, unknown>> }> }>(await fetch(`${url}/${forked.session.id}`));
    expect(JSON.stringify(fork.messages)).toContain(notesPath);
    expect(isAbsolute(notesPath)).toBe(true);
    expect(await readFile(notesPath, 'utf8')).toBe('release checklist');

    const invalid = await fetch(`${url}/${session.id}/messages`, jsonRequest({
      attachments: [{ kind: 'image', name: 'bad.svg', mediaType: 'image/svg+xml', data: image }],
    }));
    expect(invalid.status).toBe(400);
    expect((await fetch(`${url}/${session.id}/messages`, jsonRequest({ text: '   ' }))).status).toBe(400);
  });

  it('rejects invalid or unavailable attachment requests before creating files', async () => {
    const { base, first } = await setup();
    const url = sessionsUrl(base, first.id);
    const { session } = await jsonResponse<{ session: { id: string } }>(await fetch(url, jsonRequest({})));
    const file = { kind: 'file', name: '../secret.dsh', mimeType: 'application/octet-stream', data: 'YQ==' };
    expect((await fetch(`${url}/missing/messages`, jsonRequest({ attachments: [file] }))).status).toBe(404);
    expect((await fetch(`${url}/${session.id}/messages`, jsonRequest({ mode: 'steer', attachments: [file] }))).status).toBe(409);
    for (const data of ['YQ', 'YR==', 'Y===', 'YQ==\n']) {
      expect((await fetch(`${url}/${session.id}/messages`, jsonRequest({ attachments: [{ ...file, data }] }))).status).toBe(400);
    }
    await expect(readdir(join(first.path, '.omniagent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes files when a turn fails before accepting its user message', async () => {
    const { base, first } = await setup((id) => ({
      id, interrupt() {}, async *send() { throw new Error('failed'); },
    }));
    const url = sessionsUrl(base, first.id);
    const { session } = await jsonResponse<{ session: { id: string } }>(await fetch(url, jsonRequest({})));
    const response = await fetch(`${url}/${session.id}/messages`, jsonRequest({
      attachments: [{ kind: 'file', name: 'input.dsh', mimeType: 'application/octet-stream', data: 'YQ==' }],
    }));
    expect(await response.text()).toContain('turn.end');
    await expect(readdir(join(first.path, '.omniagent'))).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('reports subagent status and token totals on child session summaries only', async () => {
    const { base, first, store } = await setup();
    const parent = await store.create({ id: 'parent-session', workspace: first.path, cwd: first.path });
    await parent.append({ type: 'message/user', data: { text: 'split the work' } });
    const finished = await store.create({
      id: 'child-finished', workspace: first.path, cwd: first.path,
      parentSessionId: 'parent-session', depth: 1, description: 'Parse the payload',
    });
    await finished.append({ type: 'trace/turn.start', data: { step: 0 } });
    await finished.append({
      type: 'message/assistant',
      data: { role: 'assistant', text: 'done', usage: { inputTokens: 1_200, outputTokens: 300 } },
    });
    await finished.append({ type: 'trace/turn.end', data: { reason: 'end_turn' } });
    const working = await store.create({
      id: 'child-working', workspace: first.path, cwd: first.path,
      parentSessionId: 'parent-session', depth: 1, description: 'Check the API mock',
    });
    await working.append({ type: 'trace/turn.start', data: { step: 0 } });
    await parent.append({ type: 'subagent/start', data: { id: 'child-finished', depth: 1, status: 'running' } });
    await parent.append({ type: 'subagent/start', data: { id: 'child-working', depth: 1, status: 'running' } });
    await parent.append({ type: 'subagent/end', data: { childId: 'child-finished', status: 'completed', depth: 1 } });

    type Summary = {
      id: string;
      description?: string;
      parentSessionId?: string;
      subagentStatus?: string;
      usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null;
    };
    const body = await jsonResponse<{ sessions: Summary[] }>(await fetch(sessionsUrl(base, first.id)));
    const byId = (id: string) => body.sessions.find((session) => session.id === id)!;
    expect(byId('child-finished')).toMatchObject({
      parentSessionId: 'parent-session',
      description: 'Parse the payload',
      subagentStatus: 'completed',
      usage: { inputTokens: 1_200, outputTokens: 300, totalTokens: 1_500 },
    });
    expect(byId('child-working')).toMatchObject({ subagentStatus: 'running', usage: null });
    expect(byId('parent-session').subagentStatus).toBeUndefined();
    expect(byId('parent-session').usage).toBeUndefined();
  });
});
