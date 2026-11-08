/**
 * User-facing MCP server configuration.
 *
 * The on-disk shape follows the convention used by Claude Desktop, Cursor and
 * other MCP clients: a `mcpServers` map keyed by server id, where stdio servers
 * declare `command`/`args`/`env` and remote servers declare `url`/`headers`.
 * This module only normalizes that shape; connection logic lives in
 * {@link ./client.ts}.
 */

import { isAbsolute, resolve } from 'node:path';

export const MCP_TRANSPORTS = ['stdio', 'sse', 'http', 'ws'] as const;
export type McpTransport = typeof MCP_TRANSPORTS[number];

/**
 * Transports offered when creating a server. The MCP specification defines
 * stdio and Streamable HTTP; `sse` and `ws` remain accepted when parsing for
 * compatibility with older configs.
 */
export const MCP_STANDARD_TRANSPORTS = ['stdio', 'http'] as const satisfies readonly McpTransport[];

export const MCP_DEFAULT_TIMEOUT_MS = 60_000;
export const MCP_MAX_TIMEOUT_MS = 600_000;
export const MCP_TOOL_PREFIX = 'mcp__';
const MCP_SERVER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const MAX_TOOL_NAME_LENGTH = 64;

export interface McpServerConfig {
  id: string;
  transport: McpTransport;
  /** True when `type`/`transport` was explicit rather than inferred. */
  explicitTransport: boolean;
  enabled: boolean;
  timeoutMs: number;
  /** stdio fields. */
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Remote fields. */
  url?: string;
  headers: Record<string, string>;
}

export type McpServerParseResult =
  | { ok: true; server: McpServerConfig }
  | { ok: false; error: string };

export function isMcpServerId(value: string): boolean {
  return MCP_SERVER_ID.test(value);
}

/** Names are namespaced so provider tool-name rules (64 chars, [A-Za-z0-9_-]) hold. */
export function isMcpToolName(value: string): boolean {
  return MCP_TOOL_NAME.test(value);
}

function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return trimmed;
}

function requiredText(value: unknown, field: string, max: number): string {
  const parsed = text(value, field, max);
  if (parsed === undefined) throw new Error(`${field} is required`);
  return parsed;
}

function stringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.trim() === '') throw new Error(`${field} keys must not be empty`);
    if (typeof item !== 'string') throw new Error(`${field}.${key} must be a string`);
    record[key] = item;
  }
  return record;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...value];
}

function transportOf(raw: Record<string, unknown>): { transport: McpTransport; explicit: boolean } | undefined {
  const declared = raw.type ?? raw.transport;
  if (declared !== undefined) {
    if (typeof declared !== 'string') throw new Error('type must be a string');
    switch (declared.trim().toLowerCase()) {
      case 'stdio':
        return { transport: 'stdio', explicit: true };
      case 'sse':
        return { transport: 'sse', explicit: true };
      case 'http':
      case 'streamable-http':
      case 'streamablehttp':
      case 'streamable_http':
        return { transport: 'http', explicit: true };
      case 'ws':
      case 'websocket':
      case 'web-socket':
        return { transport: 'ws', explicit: true };
      default:
        throw new Error(`unsupported MCP transport "${declared}"`);
    }
  }
  if (raw.command !== undefined) return { transport: 'stdio', explicit: false };
  if (raw.url !== undefined) return { transport: 'http', explicit: false };
  return undefined;
}

function urlFor(value: unknown, transport: McpTransport): string {
  const raw = requiredText(value, 'url', 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('url must be a valid URL');
  }
  const allowed = transport === 'ws' ? ['ws:', 'wss:', 'http:', 'https:'] : ['http:', 'https:'];
  if (!allowed.includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new Error(transport === 'ws'
      ? 'url must be a WebSocket URL without credentials'
      : 'url must be an HTTP(S) URL without credentials');
  }
  return raw;
}

function cwdFor(value: unknown): string | undefined {
  const raw = text(value, 'cwd', 4096);
  if (raw === undefined) return undefined;
  return isAbsolute(raw) ? resolve(raw) : raw;
}

/**
 * Normalize one stored entry. Errors are returned instead of thrown so the
 * settings page can show and repair a broken row without hiding the rest.
 */
export function parseMcpServerEntry(id: string, raw: unknown): McpServerParseResult {
  try {
    if (!isMcpServerId(id)) {
      throw new Error('server id must match [a-z0-9][a-z0-9._-]{0,63}');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('server configuration must be an object');
    }
    const entry = raw as Record<string, unknown>;
    const resolved = transportOf(entry);
    if (resolved === undefined) {
      throw new Error('an MCP server needs either command (stdio) or url (remote)');
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') {
      throw new Error('disabled must be a boolean');
    }
    const timeout = entry.timeoutMs;
    if (timeout !== undefined
      && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MCP_MAX_TIMEOUT_MS)) {
      throw new Error(`timeoutMs must be an integer between 1 and ${MCP_MAX_TIMEOUT_MS}`);
    }
    const enabled = entry.enabled !== undefined
      ? entry.enabled
      : entry.disabled === true ? false : true;
    const base = {
      id,
      transport: resolved.transport,
      explicitTransport: resolved.explicit,
      enabled,
      timeoutMs: timeout ?? MCP_DEFAULT_TIMEOUT_MS,
    };
    if (resolved.transport === 'stdio') {
      if (entry.url !== undefined) throw new Error('stdio servers cannot declare url');
      return {
        ok: true,
        server: {
          ...base,
          command: requiredText(entry.command, 'command', 4096),
          args: stringArray(entry.args, 'args') ?? [],
          env: stringRecord(entry.env, 'env') ?? {},
          ...(cwdFor(entry.cwd) === undefined ? {} : { cwd: cwdFor(entry.cwd)! }),
          headers: {},
        },
      };
    }
    if (entry.command !== undefined) throw new Error('remote servers cannot declare command');
    return {
      ok: true,
      server: {
        ...base,
        args: [],
        env: {},
        url: urlFor(entry.url, resolved.transport),
        headers: stringRecord(entry.headers, 'headers') ?? {},
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ParsedMcpServers {
  servers: McpServerConfig[];
  errors: Array<{ id: string; error: string }>;
}

/** Parse the `mcpServers` map, keeping valid rows and reporting invalid ones. */
export function parseMcpServers(raw: unknown): ParsedMcpServers {
  if (raw === undefined) return { servers: [], errors: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { servers: [], errors: [{ id: '', error: 'mcpServers must be an object' }] };
  }
  const servers: McpServerConfig[] = [];
  const errors: ParsedMcpServers['errors'] = [];
  for (const [id, entry] of Object.entries(raw)) {
    const parsed = parseMcpServerEntry(id, entry);
    if (parsed.ok) servers.push(parsed.server);
    else errors.push({ id, error: parsed.error });
  }
  servers.sort((left, right) => left.id.localeCompare(right.id));
  return { servers, errors };
}

/**
 * Expand `${VAR}` references in user-authored fields. A missing variable is an
 * error rather than a silent empty string, so a typo surfaces in the test view.
 */
export function expandMcpValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) throw new Error(`environment variable ${name} is not set`);
    return resolved;
  });
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned === '' ? 'tool' : cleaned;
}

/** Deterministic, provider-safe exposed name for one MCP tool. */
export function mcpToolName(serverId: string, toolName: string): string {
  const name = `${MCP_TOOL_PREFIX}${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`;
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  const suffix = shortHash(name);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length - 1)}_${suffix}`;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}
