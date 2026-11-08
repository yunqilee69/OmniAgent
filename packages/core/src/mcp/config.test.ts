import { describe, expect, it } from 'vitest';
import {
  expandMcpValue,
  isMcpToolName,
  mcpToolName,
  parseMcpServerEntry,
  parseMcpServers,
} from './config';

describe('MCP server configuration', () => {
  it('infers stdio from command and normalizes common fields', () => {
    const parsed = parseMcpServerEntry('filesystem', {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
      env: { LOG_LEVEL: 'info' },
      cwd: '/tmp',
    });
    expect(parsed).toEqual({
      ok: true,
      server: {
        id: 'filesystem',
        transport: 'stdio',
        explicitTransport: false,
        enabled: true,
        timeoutMs: 60_000,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        env: { LOG_LEVEL: 'info' },
        cwd: '/tmp',
        headers: {},
      },
    });
  });

  it('infers remote HTTP from url and accepts transport aliases', () => {
    expect(parseMcpServerEntry('remote', { url: 'https://example.com/mcp' })).toMatchObject({
      ok: true,
      server: { transport: 'http', explicitTransport: false, url: 'https://example.com/mcp' },
    });
    expect(parseMcpServerEntry('remote', { type: 'streamable-http', url: 'https://example.com/mcp' }))
      .toMatchObject({ ok: true, server: { transport: 'http', explicitTransport: true } });
    expect(parseMcpServerEntry('remote', { transport: 'sse', url: 'https://example.com/sse' }))
      .toMatchObject({ ok: true, server: { transport: 'sse' } });
    expect(parseMcpServerEntry('socket', { type: 'websocket', url: 'wss://example.com/mcp' }))
      .toMatchObject({ ok: true, server: { transport: 'ws' } });
  });

  it('supports the disabled alias and explicit enabled flag', () => {
    expect(parseMcpServerEntry('a', { command: 'node', disabled: true }))
      .toMatchObject({ ok: true, server: { enabled: false } });
    expect(parseMcpServerEntry('a', { command: 'node', enabled: false, disabled: true }))
      .toMatchObject({ ok: true, server: { enabled: false } });
    expect(parseMcpServerEntry('a', { command: 'node', enabled: true, disabled: true }))
      .toMatchObject({ ok: true, server: { enabled: true } });
  });

  it('reports unusable rows without hiding valid siblings', () => {
    const parsed = parseMcpServers({
      good: { command: 'node', args: ['server.js'] },
      missing: { type: 'stdio' },
      badId: { command: 'node' },
      mixed: { command: 'node', url: 'https://example.com' },
      broken: 'nope',
    });
    expect(parsed.servers.map((server) => server.id)).toEqual(['good']);
    expect(parsed.errors.map((error) => error.id).sort()).toEqual(['badId', 'broken', 'missing', 'mixed']);
  });

  it('rejects credentials in URLs and invalid timeouts', () => {
    expect(parseMcpServerEntry('a', { url: 'https://user:pass@example.com/mcp' }).ok).toBe(false);
    expect(parseMcpServerEntry('a', { url: 'ftp://example.com/mcp' }).ok).toBe(false);
    expect(parseMcpServerEntry('a', { command: 'node', timeoutMs: 0 }).ok).toBe(false);
    expect(parseMcpServerEntry('a', { command: 'node', timeoutMs: 600_001 }).ok).toBe(false);
  });

  it('expands ${VAR} references and reports missing variables', () => {
    expect(expandMcpValue('${HOME}/bin', { HOME: '/home/me' })).toBe('/home/me/bin');
    expect(() => expandMcpValue('${MISSING}', {})).toThrow(/MISSING/);
  });

  it('builds provider-safe, namespaced tool names', () => {
    expect(mcpToolName('github', 'list issues')).toBe('mcp__github__list_issues');
    expect(isMcpToolName(mcpToolName('github', 'list issues'))).toBe(true);
    const long = mcpToolName('my-server', 'a'.repeat(120));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(isMcpToolName(long)).toBe(true);
    expect(mcpToolName('a', 'x')).not.toBe(mcpToolName('b', 'x'));
  });
});
