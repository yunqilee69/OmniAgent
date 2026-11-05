import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore, createInitialDshPermissionEvent, projectModelSelection } from '@omniagent/core';
import type { ModelChoice, SessionModelSelection } from '@omniagent/core';
import { startWebHost } from './server';
import type { WebHost, WebHostOptions } from './server';
import { WorkspaceRegistry } from './workspaces';

const hosts: WebHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.close())); });

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const catalog: ModelChoice[] = [
  { provider: 'provider-a', model: 'model-1', name: 'Model One' },
  { provider: 'provider-a', model: 'model-2', name: 'Model Two', reasoning: true },
];
const initial: SessionModelSelection = { version: 1, provider: 'provider-a', model: 'model-1' };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-model-route-'));
  const path = join(root, 'workspace');
  await mkdir(path);
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const workspace = await workspaces.add(path);
  const store = new SessionStore(join(root, 'sessions'));
  const captured: Array<SessionModelSelection | undefined> = [];
  const host = await startWebHost({
    workspaces, store,
    modelCatalog: () => catalog,
    defaultModelSelection: () => initial,
    permissionSettings: {
      async read() { return { defaultPreset: 'workspace-write', requiresSelection: false }; },
      async update(value: { defaultPreset: 'workspace-write' }) { return value; },
      snapshot() { return { defaultPreset: 'workspace-write', requiresSelection: false, revision: 0 }; },
    } as unknown as WebHostOptions['permissionSettings'],
    createSession(_workspace, handle, _permissions, model) {
      captured.push(model);
      return {
        id: handle.id,
        async *send() { yield { type: 'turn.end', reason: 'end_turn' }; },
        interrupt() {},
      };
    },
  });
  hosts.push(host);
  const url = `${host.address()}/api/workspaces/${workspace.id}/sessions`;
  return { host, url, workspace, store, captured };
}

async function create(url: string): Promise<{ sessionUrl: string; id: string }> {
  const response = await fetch(url, post({}));
  expect(response.status).toBe(201);
  const { session } = await response.json() as { session: { id: string } };
  return { sessionUrl: `${url}/${session.id}`, id: session.id };
}

describe('session model API', () => {
  it('exposes the credential-free catalog', async () => {
    const { host } = await setup();
    const response = await fetch(`${host.address()}/api/models`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: catalog });
  });

  it('pins the default selection, reports it, and uses it for a turn', async () => {
    const { url, store, workspace, captured } = await setup();
    const { sessionUrl, id } = await create(url);

    const detail = await (await fetch(sessionUrl)).json() as { model: unknown };
    expect(detail.model).toEqual(initial);
    expect(projectModelSelection((await store.open(workspace.path, id)).events))
      .toEqual({ status: 'selected', selection: initial });

    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(200);
    expect(captured).toEqual([initial]);
  });

  it('persists an explicit switch and rejects unknown or malformed selections', async () => {
    const { url, store, workspace, captured } = await setup();
    const { sessionUrl, id } = await create(url);
    const switchTo = { version: 1, provider: 'provider-a', model: 'model-2' };

    expect((await fetch(`${sessionUrl}/model`, post({ provider: 'provider-a', model: 'missing' }))).status).toBe(409);
    expect((await fetch(`${sessionUrl}/model`, post({ provider: 'provider-a', model: 'model-2', extra: true }))).status).toBe(400);
    const changed = await fetch(`${sessionUrl}/model`, post({ provider: 'provider-a', model: 'model-2' }));
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ model: switchTo });
    expect((await fetch(`${sessionUrl}/model`, post({ provider: 'provider-a', model: 'model-2' }))).status).toBe(200);
    expect(projectModelSelection((await store.open(workspace.path, id)).events))
      .toEqual({ status: 'selected', selection: switchTo });
    expect((await store.open(workspace.path, id)).events.filter((event) => event.type === 'model/selected'))
      .toHaveLength(2);

    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(200);
    expect(captured).toEqual([switchTo]);
  });

  it('uses the configured default for a legacy session without a selection event', async () => {
    const { url, workspace, store, captured } = await setup();
    const legacy = await store.create({ id: 'legacy', workspace: workspace.path, cwd: workspace.path });
    await legacy.append(createInitialDshPermissionEvent('workspace-write'));
    const sessionUrl = `${url}/legacy`;

    expect((await (await fetch(sessionUrl)).json() as { model: unknown }).model).toBeNull();
    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(200);
    expect(captured).toEqual([initial]);
  });
});
