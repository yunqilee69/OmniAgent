/**
 * Runtime owner for configured MCP servers.
 *
 * The service refreshes from config.json, keeps one live client per enabled
 * server, and exposes the remote tools as ordinary OmniAgent tools. Connection
 * failures are isolated: one broken server never prevents the others (or the
 * turn itself) from working.
 */

import { z } from 'zod';
import type { Tool as SdkMcpTool } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolOutput } from '../domain/tool';
import type { McpServerConfig, ParsedMcpServers } from './config';
import { isMcpToolName, mcpToolName, parseMcpServers } from './config';
import type { McpClientHandle, McpConnectionOptions } from './client';
import { callMcpTool, connectMcpServer, listAllMcpTools } from './client';

export interface McpServerRuntimeStatus {
  id: string;
  transport?: McpServerConfig['transport'];
  enabled: boolean;
  state: 'connected' | 'disconnected' | 'disabled' | 'invalid';
  toolCount: number;
  tools: string[];
  serverName?: string;
  serverVersion?: string;
  error?: string;
}

export interface McpServiceOptions {
  /** Re-read the raw `mcpServers` map; called once per sync. */
  loadServers: () => Promise<unknown> | unknown;
  log?: (message: string) => void;
  /** Test seam used by in-memory transport tests. */
  transportFactory?: McpConnectionOptions['transportFactory'];
}

interface Connection {
  server: McpServerConfig;
  handle: McpClientHandle;
  tools: SdkMcpTool[];
  serverName?: string;
  serverVersion?: string;
}

function parametersFor(tool: SdkMcpTool): z.ZodType {
  try {
    return z.fromJSONSchema(tool.inputSchema as unknown as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function fingerprint(server: McpServerConfig): string {
  return JSON.stringify(server);
}

export class McpService {
  private readonly connections = new Map<string, Connection>();
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly parseErrors = new Map<string, string>();
  private readonly connectionErrors = new Map<string, string>();
  private readonly connecting = new Map<string, Promise<Connection>>();
  private syncTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: McpServiceOptions) {}

  /** Reconcile live clients with config.json. Safe to call concurrently. */
  sync(): Promise<void> {
    const run = this.syncTail.then(() => this.runSync(), () => this.runSync());
    this.syncTail = run.catch(() => undefined);
    return run;
  }

  private async runSync(): Promise<void> {
    if (this.closed) return;
    let parsed: ParsedMcpServers;
    try {
      parsed = parseMcpServers(await this.options.loadServers());
    } catch (error) {
      this.options.log?.(`MCP configuration could not be read: ${errorMessage(error)}`);
      return;
    }
    this.parseErrors.clear();
    for (const entry of parsed.errors) this.parseErrors.set(entry.id, entry.error);
    const next = new Map(parsed.servers.map((server) => [server.id, server]));
    this.servers.clear();
    for (const server of parsed.servers) this.servers.set(server.id, server);

    const work: Array<Promise<void>> = [];
    for (const [id, connection] of [...this.connections]) {
      const candidate = next.get(id);
      if (candidate === undefined || !candidate.enabled || fingerprint(candidate) !== fingerprint(connection.server)) {
        this.connections.delete(id);
        this.connectionErrors.delete(id);
        work.push(connection.handle.close());
      }
    }
    for (const server of parsed.servers) {
      if (!server.enabled || this.connections.has(server.id)) continue;
      work.push(this.connect(server));
    }
    await Promise.all(work);
  }

  private async connect(server: McpServerConfig): Promise<void> {
    if (this.closed) return;
    const previous = this.connecting.get(server.id);
    if (previous !== undefined) {
      await previous.catch(() => undefined);
      return;
    }
    const task = (async (): Promise<Connection> => {
      const handle = await connectMcpServer(server, {
        ...(this.options.transportFactory === undefined ? {} : { transportFactory: this.options.transportFactory }),
      });
      try {
        const tools = await listAllMcpTools(handle.client, server);
        const info = handle.client.getServerVersion();
        return {
          server,
          handle,
          tools,
          ...(info === undefined ? {} : { serverName: info.name, serverVersion: info.version }),
        };
      } catch (error) {
        await handle.close();
        throw error;
      }
    })();
    this.connecting.set(server.id, task);
    try {
      const connection = await task;
      if (this.closed) {
        await connection.handle.close();
        return;
      }
      this.connections.set(server.id, connection);
      this.connectionErrors.delete(server.id);
    } catch (error) {
      const message = errorMessage(error);
      this.connectionErrors.set(server.id, message);
      this.options.log?.(`MCP server "${server.id}" is unavailable: ${message}`);
    } finally {
      this.connecting.delete(server.id);
    }
  }

  private async ensure(serverId: string): Promise<Connection> {
    const existing = this.connections.get(serverId);
    if (existing !== undefined) return existing;
    const server = this.servers.get(serverId);
    if (server === undefined) throw new Error(`MCP server "${serverId}" is not configured`);
    if (!server.enabled) throw new Error(`MCP server "${serverId}" is disabled`);
    const pending = this.connecting.get(serverId);
    if (pending !== undefined) return await pending;
    await this.connect(server);
    const connected = this.connections.get(serverId);
    if (connected === undefined) {
      throw new Error(this.connectionErrors.get(serverId) ?? `MCP server "${serverId}" is unavailable`);
    }
    return connected;
  }

  private drop(serverId: string): void {
    const connection = this.connections.get(serverId);
    if (connection === undefined) return;
    this.connections.delete(serverId);
    void connection.handle.close();
  }

  /** Invoke a remote tool by its un-namespaced MCP name. */
  async callTool(serverId: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<ToolOutput> {
    const connection = await this.ensure(serverId);
    try {
      return await callMcpTool(connection.handle.client, connection.server, toolName, args, {
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      this.drop(serverId);
      throw error;
    }
  }

  /**
   * Build ordinary OmniAgent tools for the current live connections. Names are
   * namespaced and collision-checked so providers see valid, unique names.
   */
  tools(): Tool[] {
    const used = new Set<string>();
    const tools: Tool[] = [];
    for (const id of [...this.connections.keys()].sort()) {
      const connection = this.connections.get(id);
      if (connection === undefined) continue;
      for (const tool of [...connection.tools].sort((left, right) => left.name.localeCompare(right.name))) {
        let name = mcpToolName(id, tool.name);
        if (used.has(name)) {
          const suffix = `_${shortHash(`${id}\0${tool.name}`)}`;
          name = `${name.slice(0, 64 - suffix.length)}${suffix}`;
        }
        used.add(name);
        const description = tool.description ?? tool.title ?? tool.name;
        tools.push({
          name,
          description: `${description}\n\n(MCP server: ${id}; tool: ${tool.name})`,
          parameters: parametersFor(tool),
          mutating: tool.annotations?.readOnlyHint !== true,
          execute: async (args, ctx) => await this.callTool(id, tool.name, args, ctx.signal),
        });
      }
    }
    return tools;
  }

  /** Snapshot used by Settings → MCP servers. Never includes configured secrets. */
  statuses(): McpServerRuntimeStatus[] {
    const ids = new Set([
      ...this.servers.keys(),
      ...this.parseErrors.keys(),
      ...this.connectionErrors.keys(),
    ]);
    return [...ids].sort().map((id) => {
      const server = this.servers.get(id);
      const connection = this.connections.get(id);
      const invalid = this.parseErrors.get(id);
      const error = invalid ?? this.connectionErrors.get(id);
      return {
        id,
        ...(server === undefined ? {} : { transport: server.transport }),
        enabled: server?.enabled ?? false,
        state: invalid !== undefined ? 'invalid' as const
          : server === undefined || !server.enabled ? 'disabled' as const
            : connection !== undefined ? 'connected' as const : 'disconnected' as const,
        toolCount: connection?.tools.length ?? 0,
        tools: connection?.tools.map((tool) => tool.name) ?? [],
        ...(connection?.serverName === undefined ? {} : { serverName: connection.serverName }),
        ...(connection?.serverVersion === undefined ? {} : { serverVersion: connection.serverVersion }),
        ...(error === undefined ? {} : { error }),
      };
    });
  }

  /** Names of connected tools, for Settings → Modes selectors. */
  toolNames(): string[] {
    return this.tools().map((tool) => tool.name);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((connection) => connection.handle.close()));
  }
}

export { isMcpToolName };

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}
