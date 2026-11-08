import { describe, expect, it, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from './config';
import { McpService } from './service';
import { probeMcpServer } from './client';

const servers: McpServer[] = [];
const services: McpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createServer(name = 'test-server'): McpServer {
  const server = new McpServer({ name, version: '1.0.0' });
  server.registerTool('add', {
    title: 'Add',
    description: 'Add two numbers',
    inputSchema: { a: z.number(), b: z.number() },
    annotations: { readOnlyHint: true },
  }, async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }));
  server.registerTool('fail', {
    description: 'Always fails',
    inputSchema: { message: z.string().optional() },
  }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'boom' }],
  }));
  server.registerTool('structured', {
    description: 'Returns structured content',
    inputSchema: { value: z.number() },
    outputSchema: { doubled: z.number() },
  }, async ({ value }) => ({
    content: [{ type: 'text', text: `value=${value}` }],
    structuredContent: { doubled: value * 2 },
  }));
  server.registerResource('readme', 'file:///readme.md', { description: 'Read me' }, async (uri) => ({
    contents: [{ uri: uri.href, text: '# Read me' }],
  }));
  servers.push(server);
  return server;
}

function linkedTransport(server: McpServer): Transport {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return clientTransport;
}

function factory(brokenId?: string) {
  return async (config: McpServerConfig): Promise<Transport> => {
    if (config.id === brokenId) throw new Error('spawn failed');
    return linkedTransport(createServer(`${config.id}-server`));
  };
}

const CONFIG = { command: 'ignored', args: [] } as const;

describe('McpService', () => {
  it('connects, lists tools and executes them', async () => {
    const service = new McpService({
      loadServers: () => ({ demo: CONFIG }),
      transportFactory: factory(),
    });
    services.push(service);
    await service.sync();

    const statuses = service.statuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      id: 'demo',
      state: 'connected',
      toolCount: 3,
      serverName: 'demo-server',
      serverVersion: '1.0.0',
    });

    const tools = service.tools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'mcp__demo__add', 'mcp__demo__fail', 'mcp__demo__structured',
    ]);
    const add = tools.find((tool) => tool.name === 'mcp__demo__add')!;
    expect(add.mutating).toBe(false);
    const result = await add.execute(add.parameters.parse({ a: 2, b: 3 }), {
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ content: '5', ok: true });

    const fail = tools.find((tool) => tool.name === 'mcp__demo__fail')!;
    const failed = await fail.execute({}, { cwd: process.cwd(), signal: new AbortController().signal });
    expect(failed).toMatchObject({ content: 'boom', ok: false });
    expect(fail.mutating).toBe(true);
  });

  it('formats structured content alongside text', async () => {
    const service = new McpService({
      loadServers: () => ({ demo: CONFIG }),
      transportFactory: factory(),
    });
    services.push(service);
    await service.sync();
    const tool = service.tools().find((entry) => entry.name === 'mcp__demo__structured')!;
    const result = await tool.execute({ value: 4 }, { cwd: process.cwd(), signal: new AbortController().signal });
    expect(result.content).toContain('value=4');
    expect(result.content).toContain('"doubled": 8');
  });

  it('keeps one failing server from hiding the others', async () => {
    const logs: string[] = [];
    const service = new McpService({
      loadServers: () => ({ good: CONFIG, broken: CONFIG }),
      transportFactory: factory('broken'),
      log: (message) => logs.push(message),
    });
    services.push(service);
    await service.sync();

    const statuses = service.statuses();
    expect(statuses.find((status) => status.id === 'good')).toMatchObject({ state: 'connected' });
    expect(statuses.find((status) => status.id === 'broken')).toMatchObject({
      state: 'disconnected',
      error: expect.stringContaining('spawn failed'),
    });
    expect(service.tools().every((tool) => tool.name.startsWith('mcp__good__'))).toBe(true);
    expect(logs.some((line) => line.includes('broken'))).toBe(true);
  });

  it('reconciles removed and changed servers on resync', async () => {
    let config: Record<string, unknown> = { demo: CONFIG };
    const service = new McpService({
      loadServers: () => config,
      transportFactory: factory(),
    });
    services.push(service);
    await service.sync();
    expect(service.statuses().map((status) => status.id)).toEqual(['demo']);

    config = { renamed: CONFIG };
    await service.sync();
    expect(service.statuses().map((status) => status.id)).toEqual(['renamed']);
    expect(service.tools().map((tool) => tool.name).sort()).toEqual([
      'mcp__renamed__add', 'mcp__renamed__fail', 'mcp__renamed__structured',
    ]);
  });

  it('reports disabled servers without connecting them', async () => {
    const service = new McpService({
      loadServers: () => ({ demo: { ...CONFIG, enabled: false } }),
      transportFactory: factory(),
    });
    services.push(service);
    await service.sync();
    expect(service.statuses()[0]).toMatchObject({ state: 'disabled', toolCount: 0 });
    expect(service.tools()).toEqual([]);
  });

  it('probes capabilities and tools through the same transport seam', async () => {
    const server = createServer('probe-server');
    const result = await probeMcpServer({
      id: 'probe',
      transport: 'stdio',
      explicitTransport: true,
      enabled: true,
      timeoutMs: 5_000,
      command: 'ignored',
      args: [],
      env: {},
      headers: {},
    }, { transportFactory: async () => linkedTransport(server) });
    expect(result).toMatchObject({
      ok: true,
      transport: 'stdio',
      serverName: 'probe-server',
      serverVersion: '1.0.0',
    });
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(['add', 'fail', 'structured']);
    expect(result.tools.find((tool) => tool.name === 'add')?.readOnly).toBe(true);
    expect(result.resources).toEqual(['file:///readme.md']);
  });
});
