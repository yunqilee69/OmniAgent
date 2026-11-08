import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpProbeResult, McpServerConfig } from '@omniagent/core';
import { InvalidMcpSettings, McpSettings } from './mcp-settings';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

const baseConfig = {
  model: 'deepseek-flash',
  provider: 'deepseek-official',
};

async function fixture(config: Record<string, unknown> = baseConfig) {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-mcp-settings-'));
  roots.push(root);
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(config));
  return { root, path };
}

async function readJSON(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function probeResult(server: McpServerConfig): McpProbeResult {
  return {
    ok: true,
    transport: server.transport,
    durationMs: 1,
    tools: [{ name: 'echo', readOnly: true }],
    resources: [],
    prompts: [],
  };
}

describe('McpSettings', () => {
  it('saves stdio and remote servers without exposing secrets on read', async () => {
    const { path } = await fixture();
    const settings = await McpSettings.open(path);
    await settings.save('filesystem', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      env: { TOKEN: 'super-secret' },
      timeoutMs: 30_000,
    });
    await settings.save('remote', {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
    });

    const stored = await readJSON(path);
    expect(stored.mcpServers).toMatchObject({
      filesystem: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        env: { TOKEN: 'super-secret' },
        timeoutMs: 30_000,
      },
      remote: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer abc' },
      },
    });

    const list = await settings.list();
    expect(list.servers.map((server) => server.id)).toEqual(['filesystem', 'remote']);
    expect(list.transports).toEqual(['stdio', 'http']);
    const filesystem = list.servers[0]!;
    expect(filesystem.envKeys).toEqual(['TOKEN']);
    expect(filesystem.headerKeys).toEqual([]);
    expect(filesystem.transport).toBe('stdio');
    expect(JSON.stringify(list)).not.toContain('super-secret');
    expect(JSON.stringify(list)).not.toContain('Bearer abc');
  });

  it('keeps a stored secret when the editor sends a blank value, and clears on request', async () => {
    const { path } = await fixture();
    const settings = await McpSettings.open(path);
    await settings.save('filesystem', {
      type: 'stdio', command: 'npx', env: { TOKEN: 'secret', OTHER: 'keep' },
    });

    await settings.save('filesystem', {
      type: 'stdio', command: 'npx', env: { TOKEN: '' },
    });
    let stored = await readJSON(path);
    expect((stored.mcpServers as Record<string, Record<string, unknown>>).filesystem!.env)
      .toEqual({ TOKEN: 'secret', OTHER: 'keep' });

    await settings.save('filesystem', {
      type: 'stdio', command: 'npx', env: { TOKEN: 'new-value' }, clearEnv: ['OTHER'],
    });
    stored = await readJSON(path);
    expect((stored.mcpServers as Record<string, Record<string, unknown>>).filesystem!.env)
      .toEqual({ TOKEN: 'new-value' });
  });

  it('drops fields that do not belong to the new transport', async () => {
    const { path } = await fixture();
    const settings = await McpSettings.open(path);
    await settings.save('remote', {
      type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' },
    });
    await settings.save('remote', {
      type: 'stdio', command: 'node', args: ['server.js'], env: { A: '1' },
    });
    const stored = await readJSON(path);
    const entry = (stored.mcpServers as Record<string, Record<string, unknown>>).remote!;
    expect(entry.command).toBe('node');
    expect(entry.env).toEqual({ A: '1' });
    expect(entry.url).toBeUndefined();
    expect(entry.headers).toBeUndefined();
  });

  it('tests a draft merged over the stored row so stored secrets still apply', async () => {
    const { path } = await fixture();
    let captured: McpServerConfig | undefined;
    const settings = await McpSettings.open(path, {
      probe: async (server) => { captured = server; return probeResult(server); },
    });
    await settings.save('filesystem', {
      type: 'stdio', command: 'npx', env: { TOKEN: 'secret' },
    });
    const result = await settings.test('filesystem', {
      type: 'stdio', command: 'npx', env: { TOKEN: '' }, args: [],
    });
    expect(result.ok).toBe(true);
    expect(captured?.env).toEqual({ TOKEN: 'secret' });
    expect(captured?.command).toBe('npx');
  });

  it('merges runtime statuses into list rows', async () => {
    const { path } = await fixture({
      ...baseConfig,
      mcpServers: { filesystem: { type: 'stdio', command: 'npx' } },
    });
    const settings = await McpSettings.open(path, {
      statuses: () => [{
        id: 'filesystem',
        transport: 'stdio',
        enabled: true,
        state: 'connected',
        toolCount: 2,
        tools: ['read_file', 'write_file'],
        serverName: 'filesystem-server',
        serverVersion: '1.0.0',
      }],
    });
    const list = await settings.list();
    expect(list.servers[0]?.runtime).toMatchObject({
      state: 'connected', toolCount: 2, serverName: 'filesystem-server',
    });
  });

  it('rejects invalid rows and ids without changing the file', async () => {
    const { path } = await fixture();
    const settings = await McpSettings.open(path);
    const before = await readFile(path, 'utf8');
    await expect(settings.save('Bad Id', { command: 'npx' })).rejects.toBeInstanceOf(InvalidMcpSettings);
    await expect(settings.save('filesystem', { secret: true } as never)).rejects.toBeInstanceOf(InvalidMcpSettings);
    await expect(settings.save('filesystem', { type: 'stdio' })).rejects.toBeInstanceOf(InvalidMcpSettings);
    await expect(settings.save('filesystem', { url: 'https://user:pass@example.com/mcp' }))
      .rejects.toBeInstanceOf(InvalidMcpSettings);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('removes a server and notifies the runtime', async () => {
    const { path } = await fixture();
    let changes = 0;
    const settings = await McpSettings.open(path, { onChange: () => { changes += 1; } });
    await settings.save('filesystem', { command: 'npx' });
    expect(changes).toBe(1);
    expect(await settings.remove('filesystem')).toBe(true);
    expect(changes).toBe(2);
    expect(await settings.remove('filesystem')).toBe(false);
    expect(changes).toBe(2);
    expect((await settings.list()).servers).toEqual([]);
  });
});
