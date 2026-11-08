import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelSettings } from './model-settings';
import { startWebHost } from './server';

const hosts: Array<Awaited<ReturnType<typeof startWebHost>>> = [];
const roots: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

function emptyWorkspaces() {
  return {
    async list() { return []; },
    async get() { return undefined; },
    async add() { throw new Error('unexpected'); },
    async remove() { return false; },
    async touch() { return undefined; },
  };
}

async function mockEndpoint(body: unknown): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  servers.push({
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

async function fixture(baseURL: string) {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-model-route-'));
  roots.push(root);
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify({
    provider: 'gateway',
    model: 'model-a',
    providers: {
      gateway: {
        displayName: 'Gateway',
        api: 'openai-completions',
        baseURL,
        apiKey: 'sk-endpoint',
        models: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B' },
        ],
      },
      alternate: {
        displayName: 'Alternate',
        api: 'openai-responses',
        baseURL: 'https://alternate.example/v1',
        models: [{ id: 'model-c' }],
      },
    },
    roles: {
      default: { name: 'Default', provider: 'gateway', model: 'model-a' },
      alt: { name: 'Alt', provider: 'alternate', model: 'model-c' },
    },
  }));
  const host = await startWebHost({
    workspaces: emptyWorkspaces(),
    store: {} as never,
    createSession: async () => { throw new Error('unexpected session creation'); },
    modelSettings: await ModelSettings.open(path),
  });
  hosts.push(host);
  return { host, path };
}

describe('model source settings API', () => {
  it('lists sources and saves a source without returning its key', async () => {
    const { host, path } = await fixture('https://gateway.example/v1');
    const listed = await fetch(`${host.address()}/api/settings/model-sources`);
    expect(listed.status).toBe(200);
    const list = await listed.json() as { sources: Array<Record<string, unknown>> };
    expect(list.sources[0]).toMatchObject({
      id: 'gateway', name: 'Gateway', apiKeyConfigured: true, active: true,
    });
    expect(list.sources[0]).not.toHaveProperty('apiKey');

    const saved = await fetch(`${host.address()}/api/settings/model-sources/gateway`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Gateway 2',
        apiKey: 'sk-replacement',
        models: [{ id: 'model-b' }, { id: 'model-a' }],
      }),
    });
    expect(saved.status).toBe(200);
    const body = await saved.json() as { source: Record<string, unknown> };
    expect(body.source).toMatchObject({ id: 'gateway', name: 'Gateway 2', apiKeyConfigured: true });
    expect(body.source).not.toHaveProperty('apiKey');
    const config = JSON.parse(await readFile(path, 'utf8')) as {
      providers: Record<string, { apiKey?: string; models: Array<{ id: string }> }>;
    };
    expect(config.providers.gateway?.apiKey).toBe('sk-replacement');
    expect(config.providers.gateway?.models.map((model) => model.id)).toEqual(['model-b', 'model-a']);
  });

  it('rejects invalid writes with 400 and leaves config.json untouched', async () => {
    const { host, path } = await fixture('https://gateway.example/v1');
    const before = await readFile(path, 'utf8');
    const response = await fetch(`${host.address()}/api/settings/model-sources/custom`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api: 'openai-completions', models: [] }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/at least one model/);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('rejects removal of the active or a role-referenced source', async () => {
    const { host } = await fixture('https://gateway.example/v1');
    const active = await fetch(`${host.address()}/api/settings/model-sources/gateway`, { method: 'DELETE' });
    expect(active.status).toBe(400);
    expect(await active.text()).toMatch(/default model source/);

    const referenced = await fetch(`${host.address()}/api/settings/model-sources/alternate`, { method: 'DELETE' });
    expect(referenced.status).toBe(400);
    expect(await referenced.json()).toMatchObject({ error: expect.stringMatching(/Role "alt"/) });
  });

  it('fetches models for the editor through the discovery route', async () => {
    const baseURL = await mockEndpoint({
      data: [{ id: 'remote-a', context_window: 32_000 }, { id: 'remote-b' }],
    });
    const { host } = await fixture(baseURL);
    const response = await fetch(`${host.address()}/api/settings/model-sources/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gateway' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [{ id: 'remote-a', contextWindow: 32_000 }, { id: 'remote-b' }],
    });
  });

  it('reports discovery failures as 400 responses', async () => {
    const { host } = await fixture('https://gateway.example/v1');
    const response = await fetch(`${host.address()}/api/settings/model-sources/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api: 'deepseek-messages', baseURL: 'https://gateway.example/v1' }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/does not expose a model list/);
  });
});
