import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentCatalog,
  ConfigStore,
  ModeStore,
  RuntimeResolver,
  SessionStore,
} from '@omniagent/core';
import { startWebHost } from './server';
import type { WebHost, WebHostOptions } from './server';
import { WorkspaceRegistry } from './workspaces';

const hosts: WebHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.close())); });

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** A fresh install: the config directory exists but nothing configures a model. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-unconfigured-'));
  const configDir = join(root, 'config');
  const workspacePath = join(root, 'workspace');
  await mkdir(configDir);
  await mkdir(workspacePath);
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const workspace = await workspaces.add(workspacePath);
  const store = new SessionStore(join(root, 'sessions'));
  const configStore = await ConfigStore.open(join(configDir, 'config.json'));
  const agents = new AgentCatalog(join(configDir, 'agents'));
  const host = await startWebHost({
    workspaces,
    store,
    runtime: new RuntimeResolver({ configStore, agents }),
    modeStore: new ModeStore({ path: join(configDir, 'modes.json'), configStore, agents }),
    permissionSettings: {
      async read() { return { defaultPreset: 'workspace-write' as const, requiresSelection: false }; },
      async update(value: { defaultPreset: 'workspace-write' }) { return value; },
      snapshot() { return { defaultPreset: 'workspace-write' as const, requiresSelection: false, revision: 0 }; },
      async current() { return { defaultPreset: 'workspace-write' as const, requiresSelection: false, revision: 0 }; },
    } as unknown as WebHostOptions['permissionSettings'],
    createRuntimeSession(_workspace, handle) {
      return {
        id: handle.id,
        async *send() { yield { type: 'turn.end', reason: 'end_turn' }; },
        interrupt() {},
      };
    },
  });
  hosts.push(host);
  return { base: host.address()!, workspaceId: workspace.id };
}

describe('unconfigured install', () => {
  it('offers the built-in modes instead of failing on a missing default role', async () => {
    const { base } = await setup();
    const body = await (await fetch(`${base}/api/modes`)).json() as {
      modes: { id: string; valid: boolean; warnings: string[] }[];
      defaultMode: string;
    };
    expect(body.modes.map((mode) => mode.id)).toEqual(['standard', 'creator']);
    expect(body.modes.every((mode) => mode.valid)).toBe(true);
    expect(body.modes.flatMap((mode) => mode.warnings)).toEqual([]);
    expect(body.defaultMode).toBe('standard');
  });

  it('creates a session from a mode without any model configured', async () => {
    const { base, workspaceId } = await setup();
    const response = await fetch(`${base}/api/workspaces/${workspaceId}/sessions`, post({ mode: 'standard' }));
    expect(response.status).toBe(201);
    const body = await response.json() as { session: { id: string } };
    const detail = await (await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${body.session.id}`)).json() as {
      resolvedModel: unknown;
      agent: { id: string };
    };
    expect(detail.agent.id).toBe('default');
    // No model seat is filled yet: the page asks the user to pick one instead of
    // reporting an error.
    expect(detail.resolvedModel).toBeNull();
  });
});
