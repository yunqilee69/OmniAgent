/**
 * MCP client plumbing built on the official SDK.
 *
 * Supported transports are the ones used by mainstream MCP servers: stdio,
 * the legacy HTTP+SSE transport, streamable HTTP, and WebSocket. A remote
 * server configured with only `url` tries streamable HTTP first and falls back
 * to legacy SSE, which is the migration-friendly behavior most clients use.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Prompt, Resource, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { Stream } from 'node:stream';
import type { ToolOutput } from '../domain/tool';
import { truncateOutput } from '../tools/tool';
import type { McpServerConfig, McpTransport } from './config';
import { expandMcpValue } from './config';

export const MCP_CLIENT_NAME = 'omniagent';
export const MCP_CLIENT_VERSION = '0.0.0';
const MAX_PAGES = 100;
const MAX_STDERR_TAIL = 4_096;

export interface McpClientHandle {
  readonly client: Client;
  readonly transport: McpTransport;
  close(): Promise<void>;
}

export interface McpConnectionOptions {
  signal?: AbortSignal;
  /** Test seam: replace transport construction while keeping client behavior. */
  transportFactory?: (server: McpServerConfig) => Promise<Transport> | Transport;
}

export interface McpProbeTool {
  name: string;
  title?: string;
  description?: string;
  readOnly: boolean;
}

export interface McpProbeResult {
  ok: boolean;
  transport: McpTransport;
  durationMs: number;
  serverName?: string;
  serverVersion?: string;
  tools: McpProbeTool[];
  resources: string[];
  prompts: string[];
  error?: string;
}

function expandedHeaders(server: McpServerConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, expandMcpValue(value)]));
}

function mergedHeaders(base: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(base);
  for (const [key, value] of Object.entries(extra)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return headers;
}

function stderrTail(stream: Stream | NodeJS.ReadableStream | null | undefined): () => string {
  if (stream == null) return () => '';
  let tail = '';
  stream.on('data', (chunk: Buffer | string) => {
    tail = `${tail}${chunk.toString()}`.slice(-MAX_STDERR_TAIL);
  });
  stream.on('error', () => undefined);
  return () => tail.trim();
}

function createTransport(server: McpServerConfig): { transport: Transport; stderr?: () => string } {
  if (server.transport === 'stdio') {
    const command = expandMcpValue(server.command ?? '');
    const transport = new StdioClientTransport({
      command,
      args: server.args.map((arg) => expandMcpValue(arg)),
      env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expandMcpValue(value)])),
      ...(server.cwd === undefined ? {} : { cwd: expandMcpValue(server.cwd) }),
      stderr: 'pipe',
    });
    return { transport, stderr: stderrTail(transport.stderr) };
  }
  if (server.url === undefined) throw new Error('remote MCP server has no url');
  const url = new URL(expandMcpValue(server.url));
  const headers = expandedHeaders(server);
  if (server.transport === 'ws') {
    if (Object.keys(headers).length > 0) {
      throw new Error('WebSocket MCP servers do not support headers; authenticate with the URL or configure an SSE/HTTP server');
    }
    return { transport: new WebSocketClientTransport(url) };
  }
  if (server.transport === 'sse') {
    return {
      transport: new SSEClientTransport(url, {
        requestInit: { headers, redirect: 'error' },
        eventSourceInit: {
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: mergedHeaders(init?.headers, headers),
          }),
        },
      }),
    };
  }
  return {
    transport: new StreamableHTTPClientTransport(url, {
      requestInit: { headers, redirect: 'error' },
    }),
  };
}

function transportCandidates(server: McpServerConfig): McpTransport[] {
  // Many deployments still speak the legacy HTTP+SSE transport. Trying SSE
  // after a streamable-HTTP failure makes one URL configuration work for both.
  if (server.transport === 'http') return ['http', 'sse'];
  return [server.transport];
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = typeof (error as unknown as { code?: unknown }).code === 'number'
      ? ` (${(error as unknown as { code: number }).code})`
      : '';
    return `${error.message}${code}`;
  }
  return String(error);
}

function withStderr(message: string, stderr: (() => string) | undefined): string {
  const tail = stderr?.();
  return tail ? `${message}\nServer stderr:\n${tail}` : message;
}

async function connectOne(
  server: McpServerConfig,
  transport: Transport,
  options: McpConnectionOptions,
): Promise<Client> {
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { capabilities: {} },
  );
  const signals = [AbortSignal.timeout(server.timeoutMs)];
  if (options.signal !== undefined) signals.push(options.signal);
  try {
    await client.connect(transport, {
      signal: AbortSignal.any(signals),
      timeout: server.timeoutMs,
    });
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/** Open one MCP connection, applying the remote transport fallback. */
export async function connectMcpServer(
  server: McpServerConfig,
  options: McpConnectionOptions = {},
): Promise<McpClientHandle> {
  const failures: string[] = [];
  for (const transportType of transportCandidates(server)) {
    const attempt = server.transport === transportType ? server : { ...server, transport: transportType };
    let stderr: (() => string) | undefined;
    let transport: Transport | undefined;
    try {
      if (options.transportFactory !== undefined) {
        transport = await options.transportFactory(attempt);
        if (transportType === 'stdio') stderr = stderrTail((transport as StdioClientTransport).stderr);
      } else {
        const created = createTransport(attempt);
        transport = created.transport;
        stderr = created.stderr;
      }
      const client = await connectOne(server, transport, options);
      let closed = false;
      return {
        client,
        transport: transportType,
        async close() {
          if (closed) return;
          closed = true;
          await client.close().catch(() => undefined);
        },
      };
    } catch (error) {
      await transport?.close().catch(() => undefined);
      const stderrDetail = transportType === 'stdio' ? withStderr('', stderr) : '';
      failures.push(`${transportType}: ${errorText(error)}${stderrDetail}`);
    }
  }
  throw new Error(`Could not connect to MCP server "${server.id}" (${failures.join('; ')})`);
}

export interface ListOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function requestOptions(server: McpServerConfig, options: ListOptions): Promise<{ signal: AbortSignal; timeout: number }> {
  const timeout = options.timeoutMs ?? server.timeoutMs;
  const signals = [AbortSignal.timeout(timeout)];
  if (options.signal !== undefined) signals.push(options.signal);
  return { signal: AbortSignal.any(signals), timeout };
}

/** List every tool, following pagination cursors. */
export async function listAllMcpTools(
  client: Client,
  server: McpServerConfig,
  options: ListOptions = {},
): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.listTools(
      cursor === undefined ? undefined : { cursor },
      await requestOptions(server, options),
    );
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor === undefined || cursor === '') break;
  }
  return tools;
}

export async function listAllMcpResources(
  client: Client,
  server: McpServerConfig,
  options: ListOptions = {},
): Promise<Resource[]> {
  const resources: Resource[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.listResources(
      cursor === undefined ? undefined : { cursor },
      await requestOptions(server, options),
    );
    resources.push(...result.resources);
    cursor = result.nextCursor;
    if (cursor === undefined || cursor === '') break;
  }
  return resources;
}

export async function listAllMcpPrompts(
  client: Client,
  server: McpServerConfig,
  options: ListOptions = {},
): Promise<Prompt[]> {
  const prompts: Prompt[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.listPrompts(
      cursor === undefined ? undefined : { cursor },
      await requestOptions(server, options),
    );
    prompts.push(...result.prompts);
    cursor = result.nextCursor;
    if (cursor === undefined || cursor === '') break;
  }
  return prompts;
}

function formatContent(content: CallToolResult['content']): string[] {
  const parts: string[] = [];
  for (const item of content) {
    switch (item.type) {
      case 'text':
        parts.push(item.text);
        break;
      case 'image':
        parts.push(`[Image: ${item.mimeType}, ${Buffer.byteLength(item.data, 'base64')} bytes]`);
        break;
      case 'audio':
        parts.push(`[Audio: ${item.mimeType}, ${Buffer.byteLength(item.data, 'base64')} bytes]`);
        break;
      case 'resource': {
        const resource = item.resource;
        if ('text' in resource && typeof resource.text === 'string') {
          parts.push(`Resource ${resource.uri}:\n${resource.text}`);
        } else {
          const blob = 'blob' in resource && typeof resource.blob === 'string' ? resource.blob : '';
          const size = blob === '' ? 0 : Buffer.byteLength(blob, 'base64');
          parts.push(`[Resource: ${resource.uri}${resource.mimeType === undefined ? '' : `, ${resource.mimeType}`}, ${size} bytes]`);
        }
        break;
      }
      case 'resource_link':
        parts.push(`[Resource link: ${item.name ?? item.uri} <${item.uri}>]`);
        break;
      default:
        break;
    }
  }
  return parts;
}

/** Convert one tool result into the string-only ToolOutput contract. */
export function formatMcpToolResult(result: CallToolResult): ToolOutput {
  const parts = formatContent(result.content ?? []);
  if (result.structuredContent !== undefined) {
    parts.push(`Structured result:\n${JSON.stringify(result.structuredContent, null, 2)}`);
  }
  const text = parts.filter((part) => part !== '').join('\n\n');
  const output = truncateOutput(text === '' ? '(MCP tool returned no content)' : text);
  return {
    content: output.content,
    ok: result.isError !== true,
    ...(output.truncated === true ? { truncated: true } : {}),
  };
}

export interface CallMcpToolOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Invoke one MCP tool with cancellation and a per-call timeout. */
export async function callMcpTool(
  client: Client,
  server: McpServerConfig,
  toolName: string,
  args: unknown,
  options: CallMcpToolOptions = {},
): Promise<ToolOutput> {
  const timeout = options.timeoutMs ?? server.timeoutMs;
  const signals = [AbortSignal.timeout(timeout)];
  if (options.signal !== undefined) signals.push(options.signal);
  const result = await client.callTool(
    {
      name: toolName,
      arguments: args !== null && typeof args === 'object' && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {},
    },
    undefined,
    { signal: AbortSignal.any(signals), timeout },
  );
  const maybe = result as { content?: CallToolResult['content']; toolResult?: unknown };
  if (maybe.content !== undefined) return formatMcpToolResult(result as CallToolResult);
  const legacy = maybe.toolResult;
  const text = legacy === undefined ? '(MCP tool returned no content)' : JSON.stringify(legacy, null, 2);
  return { content: truncateOutput(text).content };
}

/** Connect, describe capabilities, and disconnect. Used by Settings → MCP. */
export async function probeMcpServer(
  server: McpServerConfig,
  options: McpConnectionOptions = {},
): Promise<McpProbeResult> {
  const startedAt = Date.now();
  let handle: McpClientHandle | undefined;
  const base: Omit<McpProbeResult, 'ok' | 'durationMs'> = {
    transport: server.transport,
    tools: [],
    resources: [],
    prompts: [],
  };
  try {
    handle = await connectMcpServer(server, options);
    const serverInfo = handle.client.getServerVersion();
    const capabilities = handle.client.getServerCapabilities();
    const tools = await listAllMcpTools(handle.client, server, options);
    const resources = capabilities?.resources === undefined
      ? []
      : (await listAllMcpResources(handle.client, server, options)).map((resource) => resource.uri);
    const prompts = capabilities?.prompts === undefined
      ? []
      : (await listAllMcpPrompts(handle.client, server, options)).map((prompt) => prompt.name);
    return {
      ...base,
      transport: handle.transport,
      ok: true,
      durationMs: Date.now() - startedAt,
      ...(serverInfo === undefined ? {} : { serverName: serverInfo.name, serverVersion: serverInfo.version }),
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        readOnly: tool.annotations?.readOnlyHint === true,
      })),
      resources,
      prompts,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: errorText(error),
    };
  } finally {
    await handle?.close();
  }
}
