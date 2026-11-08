/**
 * Web-side editor for the `mcpServers` map in config.json.
 *
 * Secrets live in stdio `env` values and remote `headers`; the read API only
 * exposes their keys, mirroring the model-source editor. Writes are serialized
 * with the other config.json editors through {@link ConfigFile}, and a save
 * never invalidates an unrelated section of the file.
 */

import {
  ConfigSchema,
  MCP_STANDARD_TRANSPORTS,
  MCP_TRANSPORTS,
  parseMcpServerEntry,
  probeMcpServer,
} from '@omniagent/core';
import type {
  McpProbeResult,
  McpServerConfig,
  McpServerRuntimeStatus,
  McpTransport,
} from '@omniagent/core';
import { ConfigFile, isObject } from './config-file';

const SERVER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TIMEOUT_MS = 600_000;

export interface McpServerSummary {
  id: string;
  transport: McpTransport;
  enabled: boolean;
  timeoutMs?: number;
  command?: string;
  args: string[];
  envKeys: string[];
  cwd?: string;
  url?: string;
  headerKeys: string[];
  valid: boolean;
  error?: string;
  runtime?: McpServerRuntimeStatus;
}

export interface McpServerList {
  servers: McpServerSummary[];
  transports: readonly string[];
}

/** Draft write. An empty string for an existing secret keeps the stored value. */
export interface McpServerWrite {
  type?: string;
  enabled?: boolean;
  timeoutMs?: number | null;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  clearEnv?: string[];
  cwd?: string | null;
  url?: string;
  headers?: Record<string, string>;
  clearHeaders?: string[];
}

export class InvalidMcpSettings extends Error {}

export interface McpSettingsOptions {
  /** Runtime statuses are shown alongside the stored rows. */
  statuses?: () => McpServerRuntimeStatus[];
  /** Called after a successful write or removal; a changed config needs a resync. */
  onChange?: () => Promise<void> | void;
  /** Test seam for probeMcpServer. */
  probe?: (server: McpServerConfig) => Promise<McpProbeResult>;
}

function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InvalidMcpSettings(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > max) throw new InvalidMcpSettings(`${field} must be at most ${max} characters`);
  return trimmed;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new InvalidMcpSettings(`${field} must be an array of strings`);
  }
  return [...value];
}

function secretRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new InvalidMcpSettings(`${field} must be an object`);
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.trim() === '') throw new InvalidMcpSettings(`${field} keys must not be empty`);
    if (typeof item !== 'string') throw new InvalidMcpSettings(`${field}.${key} must be a string`);
    record[key] = item;
  }
  return record;
}

function keyList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new InvalidMcpSettings(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function parseWrite(input: unknown): McpServerWrite {
  if (!isObject(input)) throw new InvalidMcpSettings('MCP server must be an object');
  const allowed = new Set([
    'type', 'enabled', 'timeoutMs', 'command', 'args', 'env', 'clearEnv', 'cwd', 'url', 'headers', 'clearHeaders',
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new InvalidMcpSettings(`unknown MCP server field "${unknown}"`);
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new InvalidMcpSettings('enabled must be a boolean');
  }
  let timeoutMs: number | null | undefined;
  if (input.timeoutMs === null) {
    timeoutMs = null;
  } else if (input.timeoutMs !== undefined) {
    if (typeof input.timeoutMs !== 'number' || !Number.isSafeInteger(input.timeoutMs)
      || input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMEOUT_MS) {
      throw new InvalidMcpSettings(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
    }
    timeoutMs = input.timeoutMs;
  }
  if (input.cwd !== undefined && input.cwd !== null && typeof input.cwd !== 'string') {
    throw new InvalidMcpSettings('cwd must be a string or null');
  }
  const type = text(input.type, 'type', 40);
  const command = text(input.command, 'command', 4096);
  const url = text(input.url, 'url', 2048);
  const args = stringArray(input.args, 'args');
  const env = secretRecord(input.env, 'env');
  const headers = secretRecord(input.headers, 'headers');
  return {
    ...(type === undefined ? {} : { type }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(keyList(input.clearEnv, 'clearEnv') === undefined ? {} : { clearEnv: keyList(input.clearEnv, 'clearEnv')! }),
    ...(input.cwd === null ? { cwd: null } : text(input.cwd, 'cwd', 4096) === undefined ? {} : { cwd: text(input.cwd, 'cwd', 4096)! }),
    ...(url === undefined ? {} : { url }),
    ...(headers === undefined ? {} : { headers }),
    ...(keyList(input.clearHeaders, 'clearHeaders') === undefined
      ? {} : { clearHeaders: keyList(input.clearHeaders, 'clearHeaders')! }),
  };
}

function record(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function mergeSecrets(
  existing: Record<string, string>,
  update: Record<string, string> | undefined,
  clear: string[] | undefined,
): Record<string, string> {
  const next = { ...existing };
  for (const key of clear ?? []) delete next[key];
  for (const [key, value] of Object.entries(update ?? {})) {
    // Blank means "leave the stored secret alone", which keeps the UI from
    // ever needing to send a secret back to the browser.
    if (value === '' && Object.hasOwn(existing, key)) continue;
    next[key] = value;
  }
  return next;
}

function existingEntry(raw: Record<string, unknown>, id: string): Record<string, unknown> {
  const servers = isObject(raw.mcpServers) ? raw.mcpServers : {};
  return isObject(servers[id]) ? servers[id] as Record<string, unknown> : {};
}

function typeOf(write: McpServerWrite, existing: Record<string, unknown>): string | undefined {
  if (write.type !== undefined) return write.type;
  const declared = existing.type ?? existing.transport;
  return typeof declared === 'string' ? declared : undefined;
}

function buildEntry(
  id: string,
  raw: Record<string, unknown>,
  write: McpServerWrite,
): Record<string, unknown> {
  const existing = existingEntry(raw, id);
  const existingEnv = record(existing.env);
  const existingHeaders = record(existing.headers);
  const declared = typeOf(write, existing);
  let source: Record<string, unknown> = { ...existing };
  if (write.type !== undefined) {
    // Switching transports must not leave the other shape behind, otherwise
    // the parser rejects the entry as ambiguous.
    delete source.command;
    delete source.args;
    delete source.env;
    delete source.cwd;
    delete source.url;
    delete source.headers;
    delete source.type;
    delete source.transport;
  }
  if (write.enabled !== undefined) source.enabled = write.enabled;
  if (write.timeoutMs === null) delete source.timeoutMs;
  else if (write.timeoutMs !== undefined) source.timeoutMs = write.timeoutMs;
  if (write.command !== undefined) source.command = write.command;
  if (write.args !== undefined) source.args = [...write.args];
  if (write.cwd === null) delete source.cwd;
  else if (write.cwd !== undefined) source.cwd = write.cwd;
  if (write.env !== undefined || write.clearEnv !== undefined) {
    source.env = mergeSecrets(existingEnv, write.env, write.clearEnv);
  }
  if (write.url !== undefined) source.url = write.url;
  if (write.headers !== undefined || write.clearHeaders !== undefined) {
    source.headers = mergeSecrets(existingHeaders, write.headers, write.clearHeaders);
  }
  if (write.type !== undefined) source.type = write.type;
  else if (declared !== undefined) {
    source.type = declared;
  } else if (typeof source.command === 'string') {
    source.type = 'stdio';
  } else if (typeof source.url === 'string') {
    source.type = 'http';
  }
  return source;
}

function summaryOf(id: string, entry: Record<string, unknown>): McpServerSummary {
  const parsed = parseMcpServerEntry(id, entry);
  if (parsed.ok) {
    return {
      id,
      transport: parsed.server.transport,
      enabled: parsed.server.enabled,
      timeoutMs: parsed.server.timeoutMs,
      ...(parsed.server.command === undefined ? {} : { command: parsed.server.command }),
      args: parsed.server.args,
      envKeys: Object.keys(parsed.server.env).sort(),
      ...(parsed.server.cwd === undefined ? {} : { cwd: parsed.server.cwd }),
      ...(parsed.server.url === undefined ? {} : { url: parsed.server.url }),
      headerKeys: Object.keys(parsed.server.headers).sort(),
      valid: true,
    };
  }
  const declared = entry.type ?? entry.transport;
  const transport: McpTransport = typeof declared === 'string' && (MCP_TRANSPORTS as readonly string[]).includes(declared)
    ? declared as McpTransport
    : typeof entry.command === 'string' ? 'stdio' : 'http';
  return {
    id,
    transport,
    enabled: entry.enabled !== false && entry.disabled !== true,
    ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
    ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
    args: Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === 'string') : [],
    envKeys: Object.keys(record(entry.env)).sort(),
    ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
    ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
    headerKeys: Object.keys(record(entry.headers)).sort(),
    valid: false,
    error: parsed.error,
  };
}

export class McpSettings {
  private constructor(
    private readonly file: ConfigFile,
    private readonly options: McpSettingsOptions,
  ) {}

  static async open(path: string, options: McpSettingsOptions & { trustedHome?: string } = {}): Promise<McpSettings> {
    const { trustedHome, ...rest } = options;
    return new McpSettings(await ConfigFile.open(path, trustedHome === undefined ? {} : { trustedHome }), rest);
  }

  async list(): Promise<McpServerList> {
    const { raw } = await this.file.read();
    const stored = isObject(raw.mcpServers) ? raw.mcpServers : {};
    const runtime = new Map((this.options.statuses?.() ?? []).map((status) => [status.id, status]));
    const ids = new Set([...Object.keys(stored), ...runtime.keys()]);
    const servers = [...ids].sort().map((id) => {
      const entry = isObject(stored[id]) ? stored[id] as Record<string, unknown> : {};
      const summary = summaryOf(id, entry);
      const status = runtime.get(id);
      return status === undefined ? summary : { ...summary, runtime: status };
    });
    return { servers, transports: MCP_STANDARD_TRANSPORTS };
  }

  async save(id: string, input: unknown): Promise<McpServerSummary> {
    if (!SERVER_ID.test(id)) throw new InvalidMcpSettings('server id must match [a-z0-9][a-z0-9._-]{0,63}');
    const write = parseWrite(input);
    const result = await this.file.mutate(async ({ raw }) => {
      const entry = buildEntry(id, raw, write);
      const parsed = parseMcpServerEntry(id, entry);
      if (!parsed.ok) throw new InvalidMcpSettings(parsed.error);
      const servers = isObject(raw.mcpServers) ? { ...raw.mcpServers } : {};
      servers[id] = entry;
      const next = { ...raw, mcpServers: servers };
      ConfigSchema.parse(next);
      return { raw: next, result: summaryOf(id, entry) };
    });
    this.changed();
    return result;
  }

  async remove(id: string): Promise<boolean> {
    if (!SERVER_ID.test(id)) throw new InvalidMcpSettings('invalid server id');
    const removed = await this.file.mutate(async ({ raw }) => {
      const servers = isObject(raw.mcpServers) ? { ...raw.mcpServers } : {};
      if (!Object.hasOwn(servers, id)) return { raw, result: false };
      delete servers[id];
      return { raw: { ...raw, mcpServers: servers }, result: true };
    });
    if (removed) this.changed();
    return removed;
  }

  /**
   * Probe a stored server or an unsaved draft. A draft is merged over the
   * stored row exactly like a save, so blank secret fields keep the old value.
   */
  async test(id: string, input?: unknown): Promise<McpProbeResult> {
    if (!SERVER_ID.test(id)) throw new InvalidMcpSettings('server id must match [a-z0-9][a-z0-9._-]{0,63}');
    const { raw } = await this.file.read();
    const entry = input === undefined
      ? existingEntry(raw, id)
      : buildEntry(id, raw, parseWrite(input));
    const parsed = parseMcpServerEntry(id, entry);
    if (!parsed.ok) throw new InvalidMcpSettings(parsed.error);
    const probe = this.options.probe ?? ((server: McpServerConfig) => probeMcpServer(server));
    return probe(parsed.server);
  }

  private changed(): void {
    if (this.options.onChange === undefined) return;
    try {
      void Promise.resolve(this.options.onChange()).catch(() => undefined);
    } catch {
      // Runtime refresh is best-effort; the settings write already succeeded.
    }
  }
}
