import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '@omniagent/core';
import { startWebHost } from './server';
import type { WebHost, WebHostOptions } from './server';
import { WorkspaceRegistry } from './workspaces';

type Preset = 'read-only' | 'workspace-write' | 'danger-full-access';
const hosts: WebHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.close())); });

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function setup(initial: Preset | null = 'workspace-write') {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-dsh-permission-route-'));
  const path = join(root, 'workspace');
  await mkdir(path);
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const workspace = await workspaces.add(path);
  const store = new SessionStore(join(root, 'sessions'));
  let defaultPreset = initial;
  let revision = 0;
  const captured: unknown[] = [];
  const permissionSettings = {
    async read() { return { defaultPreset, requiresSelection: defaultPreset === null }; },
    async update(value: { defaultPreset: Preset }) { defaultPreset = value.defaultPreset; revision += 1; return this.read(); },
    snapshot() { return { defaultPreset, requiresSelection: defaultPreset === null, revision }; },
  };
  const host = await startWebHost({
    workspaces, store,
    permissionSettings: permissionSettings as unknown as WebHostOptions['permissionSettings'],
    createSession(_workspace, handle, permissions) {
      captured.push(permissions);
      return {
        id: handle.id,
        async *send() { yield { type: 'turn.end', reason: 'end_turn' }; },
        interrupt() {},
      };
    },
  });
  hosts.push(host);
  const url = `${host.address()}/api/workspaces/${workspace.id}/sessions`;
  return { url, workspace, store, captured, permissionSettings };
}

async function create(url: string): Promise<string> {
  const response = await fetch(url, post({}));
  expect(response.status).toBe(201);
  const { session } = await response.json() as { session: { id: string } };
  return `${url}/${session.id}`;
}

describe('DSH session permission presets', () => {
  it('pins the default on creation and ignores later default changes for this session', async () => {
    const { url, store, workspace, captured, permissionSettings } = await setup();
    const sessionUrl = await create(url);
    await permissionSettings.update({ defaultPreset: 'read-only' });
    const detail = await (await fetch(sessionUrl)).json() as { header: { id: string }; permission: unknown };
    expect(detail.permission).toEqual({ preset: 'workspace-write' });
    expect((await store.open(workspace.path, detail.header.id)).events).toContainEqual(expect.objectContaining({
      type: 'permission/dsh-preset', data: { version: 1, preset: 'workspace-write' },
    }));
    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(200);
    expect(captured).toContainEqual(expect.objectContaining({ preset: 'workspace-write' }));
    const later = await create(url);
    expect((await (await fetch(later)).json() as { permission: unknown }).permission).toEqual({ preset: 'read-only' });
  });

  it('blocks legacy sessions until an explicit selection and persists the selection', async () => {
    const { url, workspace, store, captured } = await setup();
    await store.create({ id: 'legacy', workspace: workspace.path, cwd: workspace.path });
    const sessionUrl = `${url}/legacy`;
    expect((await (await fetch(sessionUrl)).json() as { permission: unknown }).permission).toEqual({ preset: null });
    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(409);
    expect(captured).toHaveLength(0);
    const changed = await fetch(`${sessionUrl}/permission`, post({ preset: 'read-only' }));
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ permission: { preset: 'read-only' } });
    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(200);
    expect(captured).toContainEqual(expect.objectContaining({ preset: 'read-only' }));
    expect((await new SessionStore(join(workspace.path, '..', 'sessions')).open(workspace.path, 'legacy')).events)
      .toContainEqual(expect.objectContaining({ type: 'permission/dsh-preset', data: { version: 1, preset: 'read-only' } }));
  });

  it('requires an explicit preset if an old configuration has not been migrated', async () => {
    const { url, captured } = await setup(null);
    const sessionUrl = await create(url);
    expect((await (await fetch(sessionUrl)).json() as { permission: unknown }).permission).toEqual({ preset: null });
    expect((await fetch(`${sessionUrl}/messages`, post({ text: 'go' }))).status).toBe(409);
    expect(captured).toHaveLength(0);
  });

  it('rejects invalid choices and does not append duplicate selections', async () => {
    const { url, workspace, store } = await setup();
    const sessionUrl = await create(url);
    const id = sessionUrl.slice(sessionUrl.lastIndexOf('/') + 1);
    expect((await fetch(`${sessionUrl}/permission`, post({ preset: 'bypass' }))).status).toBe(400);
    expect((await fetch(`${sessionUrl}/permission`, post({ preset: 'workspace-write', extra: true }))).status).toBe(400);
    expect((await fetch(`${sessionUrl}/permission`, post({ preset: 'workspace-write' }))).status).toBe(200);
    expect((await store.open(workspace.path, id)).events.filter((event) => event.type === 'permission/dsh-preset')).toHaveLength(1);
  });
});
