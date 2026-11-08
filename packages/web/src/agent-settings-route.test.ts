import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentAuthoringService, AgentCatalog, ConfigStore } from '@omniagent/core';
import { startWebHost } from './server';
import type { WebHost } from './server';

const hosts: WebHost[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CONFIG = {
  model: 'deepseek-flash',
  provider: 'deepseek-official',
  roles: { quick: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
  agentProfiles: {
    default: { tools: '*', skills: '*' },
    search: { tools: ['read_file'], skills: [] },
  },
};

function emptyWorkspaces() {
  return {
    async list() { return []; },
    async get() { return undefined; },
    async add() { throw new Error('unexpected'); },
    async remove() { return false; },
    async touch() { return undefined; },
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-agent-settings-'));
  roots.push(root);
  const configDir = join(root, 'config');
  const dir = join(configDir, 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), JSON.stringify(CONFIG));
  await writeFile(join(dir, 'writer.md'), [
    '---',
    'name: Writer',
    'description: Writes code',
    'role: quick',
    'usage: primary',
    'profile: default',
    '---',
    'You write code.',
  ].join('\n'));
  const configStore = await ConfigStore.open(join(configDir, 'config.json'));
  const catalog = new AgentCatalog(dir);
  const agentAuthoring = new AgentAuthoringService({ dir, catalog, configStore });
  const host = await startWebHost({
    workspaces: emptyWorkspaces(),
    store: {} as never,
    agentAuthoring,
  });
  hosts.push(host);
  return { base: host.address()!, dir };
}

function put(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agent settings API', () => {
  it('lists definitions with profile ids and returns instructions for editing', async () => {
    const { base } = await setup();
    const list = await (await fetch(`${base}/api/settings/agents`)).json() as {
      agents: Array<{ id: string; builtIn: boolean }>;
      profiles: string[];
    };
    expect(list.profiles).toEqual(['default', 'search']);
    expect(list.agents).toContainEqual(expect.objectContaining({ id: 'writer', builtIn: false }));
    expect(list.agents).toContainEqual(expect.objectContaining({ id: 'default', builtIn: true }));

    const detail = await (await fetch(`${base}/api/settings/agents/writer`)).json() as {
      agent: { id: string; instructions: string };
      profiles: string[];
    };
    expect(detail.agent).toMatchObject({ id: 'writer', instructions: 'You write code.' });
    expect(detail.profiles).toEqual(['default', 'search']);
    expect((await fetch(`${base}/api/settings/agents/missing`)).status).toBe(404);
  });

  it('creates, updates, and deletes a custom definition', async () => {
    const { base, dir } = await setup();
    const definition = {
      name: 'Reviewer',
      description: 'Reviews changes',
      role: 'quick',
      usage: 'primary',
      profile: 'search',
      instructions: 'Review carefully.',
    };

    const created = await put(`${base}/api/settings/agents/reviewer`, definition);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ created: true, agent: { id: 'reviewer', instructions: 'Review carefully.' } });
    const source = await readFile(join(dir, 'reviewer.md'), 'utf8');
    expect(source).toContain('name: Reviewer');
    expect(source).toContain('role: quick');
    expect(source).toContain('Review carefully.');

    const duplicate = await put(`${base}/api/settings/agents/reviewer`, definition);
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json() as { error: string }).error).toMatch(/already exists/);
    expect(await readFile(join(dir, 'reviewer.md'), 'utf8')).toBe(source);

    const updated = await put(`${base}/api/settings/agents/reviewer`, {
      ...definition,
      name: 'Senior reviewer',
      overwrite: true,
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ created: false, agent: { name: 'Senior reviewer' } });
    expect(await readFile(join(dir, 'reviewer.md'), 'utf8')).toContain('name: Senior reviewer');

    expect(await (await fetch(`${base}/api/settings/agents/reviewer`, { method: 'DELETE' })).json())
      .toEqual({ removed: true });
    expect(await (await fetch(`${base}/api/settings/agents/reviewer`, { method: 'DELETE' })).json())
      .toEqual({ removed: false });
    await expect(readFile(join(dir, 'reviewer.md'))).rejects.toThrow();
  });

  it('rejects reserved ids, unknown roles or profiles, and extra fields', async () => {
    const { base, dir } = await setup();
    const definition = {
      name: 'X',
      description: 'X',
      instructions: 'X',
    };

    expect((await put(`${base}/api/settings/agents/default`, definition)).status).toBe(400);
    expect((await put(`${base}/api/settings/agents/creator`, definition)).status).toBe(400);
    expect((await put(`${base}/api/settings/agents/explorer`, { ...definition, role: 'missing' })).status).toBe(400);
    expect((await put(`${base}/api/settings/agents/explorer`, { ...definition, profile: 'missing' })).status).toBe(400);
    expect((await put(`${base}/api/settings/agents/explorer`, { ...definition, secret: true })).status).toBe(400);
    expect((await put(`${base}/api/settings/agents/explorer`, { ...definition, name: 42 })).status).toBe(400);
    await expect(readFile(join(dir, 'explorer.md'))).rejects.toThrow();
  });
});
