import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@omniagent/core';
import { McpSettings } from './mcp-settings';
import { startWebHost } from './server';
import type { WebHost } from './server';
import { WorkspaceRegistry } from './workspaces';

const hosts: WebHost[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

function jsonRequest(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function putRequest(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-mcp-route-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify({
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    mcpServers: {
      filesystem: { type: 'stdio', command: 'npx', env: { TOKEN: 'route-secret' } },
    },
  }));
  let probed: McpServerConfig | undefined;
  const settings = await McpSettings.open(path, {
    probe: async (server) => {
      probed = server;
      return {
        ok: true,
        transport: server.transport,
        durationMs: 1,
        tools: [{ name: 'read_file', readOnly: true }],
        resources: [],
        prompts: [],
      };
    },
  });
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  await workspaces.add(workspace);
  const host = await startWebHost({
    workspaces,
    store: {} as never,
    mcpSettings: settings,
    mcpToolNames: () => ['mcp__filesystem__read_file'],
  });
  hosts.push(host);
  return { base: host.address()!, path, probed: () => probed };
}

describe('MCP settings routes', () => {
  it('lists configured servers without returning secret values', async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/api/settings/mcp-servers`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"id":"filesystem"');
    expect(text).toContain('"envKeys":["TOKEN"]');
    expect(text).not.toContain('route-secret');
    expect(text).toContain('"stdio"');
  });

  it('saves, probes and deletes a server', async () => {
    const { base, path, probed } = await setup();
    const saved = await fetch(`${base}/api/settings/mcp-servers/remote`, putRequest({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer value' },
    }));
    expect(saved.status).toBe(200);
    const body = await saved.json() as { server: { id: string; headerKeys: string[] } };
    expect(body.server).toMatchObject({ id: 'remote', headerKeys: ['Authorization'] });
    expect(await readFile(path, 'utf8')).toContain('https://example.com/mcp');

    const tested = await fetch(`${base}/api/settings/mcp-servers/test`, jsonRequest({
      id: 'remote',
      server: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: '' } },
    }));
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true, transport: 'http' });
    expect(probed()?.headers).toEqual({ Authorization: 'Bearer value' });

    const removed = await fetch(`${base}/api/settings/mcp-servers/remote`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
  });

  it('rejects invalid server writes and ids', async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/api/settings/mcp-servers/broken`, putRequest({
      type: 'stdio',
    }))).status).toBe(400);
    expect((await fetch(`${base}/api/settings/mcp-servers/Bad`, putRequest({
      command: 'npx',
    }))).status).toBe(400);
    expect((await fetch(`${base}/api/settings/mcp-servers/test`, jsonRequest({
      id: 'filesystem',
      server: 'nope',
    }))).status).toBe(400);
  });

  it('offers connected MCP tool names to mode selectors', async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/api/modes/options`);
    expect(response.status).toBe(200);
    const body = await response.json() as { tools: string[] };
    expect(body.tools).toContain('mcp__filesystem__read_file');
    expect(body.tools).toContain('read_file');
  });
});
