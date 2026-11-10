import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentDefinitionWriteSchema,
  createSessionForkEvent,
  createSessionPinEvent,
  DEFAULT_SESSION_TITLE_LIMITS,
  estimateModelHistory,
  foldSessionPinned,
  foldSessionTitle,
  hasHumanMessage,
  InvalidAgentSettings,
  lastActivityTime,
  MAX_AGENT_BYTES,
  normalizeSessionTitle,
  projectMessages,
  ScheduleInputError,
  SESSION_FORK_EVENT,
  SESSION_PIN_EVENT,
  SESSION_TITLE_EVENT,
  truncateTitleUtf8,
} from '@omniagent/core';
import type {
  AgentAuthoringService,
  AgentEvent,
  AgentUsage,
  ModelBinding,
  ModelCapabilities,
  ModeSelection,
  ModeStore,
  ResolvedSessionRuntime,
  RuntimeResolver,
  ScheduleCatalogEntry,
  ScheduleCreateRequest,
  ScheduleDeliveryHistoryRequest,
  SchedulePatch,
  ScheduleService,
  ScheduleTargetRequest,
  ScheduleTiming,
  SessionHandle,
  SessionStore,
  SessionSummary,
} from '@omniagent/core';
import {
  createAgentSelectionEvent,
  createAgentSwitch,
  createModeSelectionEvent,
  createModelSelectionEvent,
  createModelSwitch,
  defaultModelBinding,
  discoverSkills,
  KNOWN_TOOL_NAMES,
  ModelBindingSchema,
  projectAgentSelection,
  projectModeSelection,
  projectModelSelection,
  usageAllowsRoot,
} from '@omniagent/core';
import type { ReasoningEffort } from '@omniagent/core';
import { MessageSchema } from '../../core/src/domain/message';
import type { ContentPart } from '../../core/src/domain/message';
import {
  createDshPresetSwitch, createInitialDshPermissionEvent, isDshPermissionPreset,
  projectDshPermissions, resolveDshDefaultPreset, snapshotDshPermissions,
} from '../../core/src/permissions/dsh-permissions';
import type { DshPermissionProjection, DshPermissionSnapshot } from '../../core/src/permissions/dsh-permissions';
import { projectPublicHistory, safePublicMessages } from '../../core/src/session/projection';
import { projectTodos } from '../../core/src/session/todo';
import { createPlanModeEvent, projectPlanMode } from '../../core/src/session/plan';
import type { ApprovalBroker, ApprovalTurn } from './approval';
import { InvalidPermissionSettings } from './permissions';
import type { PermissionSettings } from './permissions';
import { InvalidRoleSettings } from './catalog-settings';
import type { RoleSettings } from './catalog-settings';
import { InvalidModelSettings } from './model-settings';
import type { ModelSettings } from './model-settings';
import { InvalidMcpSettings } from './mcp-settings';
import type { McpSettings } from './mcp-settings';
import { exportSession } from './session-export';
import { projectTraceEvents } from './trace-projection';
import { projectTrajectory } from './trajectory';
import { searchWorkspaceFiles } from './workspace-files';
import { DefaultWorkspaceRemovalError } from './workspaces';
import type { LiveSessionRegistry } from './live-sessions';
import type { Workspace, WorkspaceRegistry } from './workspaces';

export interface WebSession {
  id: string;
  send(input: string | readonly ContentPart[]): AsyncGenerator<AgentEvent>;
  interrupt(): void;
  /** Add a direct human message to the active turn at its next model step. */
  deliverUserMessage?(input: string | readonly ContentPart[]): Promise<'queued'>;
  /** Compact older history before the next model request. */
  requestCompaction?(): void;
  contextMessageEstimate?(): number | undefined;
  readonly activeTurn?: boolean;
}

/** Composer attachment accepted by the message route. */
export interface SendAttachment {
  kind: 'image' | 'text';
  name: string;
  mediaType: string;
  /** Base64 payload without a data URL prefix, for images. */
  data?: string;
  /** UTF-8 file contents, for text-like attachments. */
  text?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  role: string;
  usage: AgentUsage;
  profile: string;
  /** Built-in definitions ship with OmniAgent instead of an agents/*.md file. */
  builtIn?: boolean;
  valid: boolean;
  warnings: string[];
}

export interface RoleSummary {
  id: string;
  name: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ModelSummary {
  provider: string;
  model: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  capabilities: ModelCapabilities;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export interface WebHostOptions {
  host?: string;
  auth?: { enabled: boolean; username?: string; password?: string };
  workspaces: Pick<WorkspaceRegistry, 'list' | 'get' | 'add' | 'remove' | 'touch'>;
  store: Pick<SessionStore, 'list' | 'create' | 'open' | 'delete'>;
  /** Unconfigured composition seam; configured hosts use createRuntimeSession. */
  createSession?: (
    workspace: Workspace,
    handle: SessionHandle,
    permissions: DshPermissionSnapshot,
  ) => WebSession | Promise<WebSession>;
  /** Configured-agent runtime; enables agent/role/model binding APIs. */
  runtime?: RuntimeResolver;
  createRuntimeSession?: (
    workspace: Workspace,
    handle: SessionHandle,
    permissions: DshPermissionSnapshot,
    runtime: ResolvedSessionRuntime,
  ) => WebSession | Promise<WebSession>;
  listAgents?: () => AgentSummary[] | Promise<AgentSummary[]>;
  listRoles?: () => RoleSummary[] | Promise<RoleSummary[]>;
  /** Durable mode presets used for new root sessions. */
  modeStore?: ModeStore;
  /** Editable role table stored in config.json. */
  roleSettings?: RoleSettings;
  /** Editable provider/model sources stored in config.json. */
  modelSettings?: ModelSettings;
  /** Editable MCP server table stored in config.json. */
  mcpSettings?: McpSettings;
  /** Connected MCP tool names, offered to the mode/profile tool selectors. */
  mcpToolNames?: () => string[];
  /** Agent definition files for the manual Settings → Agents editor. */
  agentAuthoring?: AgentAuthoringService;
  readAudit?: (workspace: Workspace, sessionId: string) => Promise<unknown[]>;
  permissionSettings?: Pick<PermissionSettings, 'read' | 'update' | 'snapshot'>;
  approvalBroker?: ApprovalBroker;
  /** Credential-free model metadata for the configured catalog. */
  modelCatalog?: () => ModelSummary[] | Promise<ModelSummary[]>;
  /** Directory containing the built Vite client. Defaults to packages/web/dist. */
  staticDir?: string;
  /** Shared live-session registry so scheduled deliveries reuse an open session runtime. */
  liveSessions?: LiveSessionRegistry;
  /** Host-wide automation tasks shared by the page, HTTP routes, and agent tools. */
  schedule?: ScheduleService;
}

export interface WebHost {
  server: Server;
  address(): string | undefined;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
/** JSON escaping can roughly double an agent body; keep one request above MAX_AGENT_BYTES. */
const MAX_AGENT_REQUEST_BYTES = MAX_AGENT_BYTES * 2 + MAX_BODY_BYTES;
const MAX_MESSAGE_BODY_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_NAME = 256;
const MAX_IMAGE_DATA_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
const MAX_CACHED_WEB_SESSIONS = 64;
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../dist', import.meta.url));
const DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');
const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface RunningTurn {
  session?: WebSession;
  approval?: ApprovalTurn;
  cancelled: boolean;
  /** Settles when this turn has bound a session or can no longer do so. */
  ready?: Promise<void>;
}

interface CachedSession {
  preset: DshPermissionSnapshot['preset'];
  modelKey: string;
  runtimeKey?: string;
  pending: Promise<WebSession>;
}

export function createWebHost(options: WebHostOptions): WebHost {
  const bindHost = options.host ?? '127.0.0.1';
  const auth = options.auth ?? { enabled: false };
  if (auth.enabled && (!auth.username?.trim() || !auth.password?.trim())) {
    throw new Error('Web authentication requires a nonempty username and password');
  }
  const authSessions = new Map<string, { expires: number; responses: Set<ServerResponse> }>();
  const attempts = new Map<string, { count: number; until: number }>();
  const sessions = new Map<string, CachedSession>();
  const running = new Map<string, RunningTurn>();
  const creating = new Map<string, number>();
  const removing = new Set<string>();
  const permissionLocks = new Map<string, Promise<void>>();
  const failedPermissions = new Set<string>();
  const compactRequests = new Set<string>();
  let permissionDefaultUpdates = 0;
  const server = createServer((request, response) => {
    // A client can reset the connection while a response write is in flight;
    // that surfaces as EPIPE/ECONNRESET on the socket, not on the response.
    response.socket?.on('error', () => undefined);
    void (async () => {
      validateOrigin(request, bindHost, auth.enabled);
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const token = sessionToken(request);
      const now = Date.now();
      for (const [key, session] of authSessions) {
        if (session.expires <= now) {
          revokeAuthSession(authSessions, key);
        }
      }
      for (const [key, attempt] of attempts) if (attempt.until <= now) attempts.delete(key);
      const session = token === undefined ? undefined : authSessions.get(token);
      if (pathname === '/api/auth/status' && request.method === 'GET') {
        return json(response, 200, { enabled: auth.enabled, authenticated: !auth.enabled || session !== undefined });
      }
      if (pathname === '/api/auth/login' && request.method === 'POST') {
        if (!auth.enabled) return json(response, 200, { enabled: false, authenticated: true });
        const client = request.socket.remoteAddress ?? 'unknown';
        const attempt = attempts.get(client);
        if (attempt && attempt.count >= 5) {
          response.setHeader('retry-after', String(Math.max(1, Math.ceil((attempt.until - now) / 1000))));
          throw new HttpError(429, 'Too many login attempts');
        }
        if (!attempt && attempts.size >= 10000) throw new HttpError(429, 'Too many login attempts');
        attempts.set(client, { count: (attempt?.count ?? 0) + 1, until: attempt?.until ?? now + 60_000 });
        const body = await readJson(request, 4096);
        const valid = typeof body.username === 'string' && typeof body.password === 'string'
          && secureEqual(body.username, auth.username!) && secureEqual(body.password, auth.password!);
        if (!valid) throw new HttpError(401, 'Invalid credentials');
        attempts.delete(client);
        if (token !== undefined) revokeAuthSession(authSessions, token);
        if (authSessions.size >= 10000) throw new HttpError(503, 'Session capacity reached');
        const newToken = randomBytes(32).toString('hex');
        authSessions.set(newToken, { expires: now + AUTH_SESSION_MS, responses: new Set() });
        response.setHeader('set-cookie', `${AUTH_COOKIE}=${newToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${AUTH_SESSION_MS / 1000}`);
        return json(response, 200, { enabled: true, authenticated: true });
      }
      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        if (token !== undefined) revokeAuthSession(authSessions, token);
        response.setHeader('set-cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        return json(response, 200, { enabled: auth.enabled, authenticated: !auth.enabled });
      }
      if (auth.enabled && (pathname === '/api' || pathname.startsWith('/api/'))) {
        if (!session) throw new HttpError(401, 'Authentication required');
        session.responses.add(response);
        response.once('close', () => session.responses.delete(response));
        const timeout = setTimeout(() => { if (token !== undefined) revokeAuthSession(authSessions, token); }, session.expires - now);
        timeout.unref();
        response.once('close', () => clearTimeout(timeout));
      }
      await route(request, response, options, sessions, running, creating, removing, permissionLocks, failedPermissions,
        compactRequests, () => permissionDefaultUpdates, (value) => { permissionDefaultUpdates = value; });
    })().catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.destroyed && !response.writableEnded) response.end();
        return;
      }
      if (response.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      const message = status === 500 ? 'Internal server error' : (error as Error).message;
      json(response, status, {
        error: message,
        ...(error instanceof HttpError && error.code !== undefined ? { code: error.code } : {}),
      });
    });
  });
  return {
    server,
    address: () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) return undefined;
      const hostname = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;
      return `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${address.port}`;
    },
    close: () => new Promise((resolve, reject) => {
      for (const turn of running.values()) {
        turn.cancelled = true;
        turn.approval?.close();
      }
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    }),
  };
}

export function parseWebPort(override: string | undefined, configured: number): number {
  if (override === undefined) return configured;
  if (!/^\d+$/.test(override)) throw new Error('OMNIAGENT_PORT must be an integer between 1 and 65535');
  const port = Number(override);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('OMNIAGENT_PORT must be an integer between 1 and 65535');
  }
  return port;
}

export async function startWebHost(options: WebHostOptions, port = 0): Promise<WebHost> {
  const host = createWebHost(options);
  await new Promise<void>((resolve, reject) => {
    host.server.once('error', reject);
    host.server.listen(port, options.host ?? '127.0.0.1', () => {
      host.server.off('error', reject);
      resolve();
    });
  });
  return host;
}

function safeStaticPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const relative = decoded.replace(/^\/+/, '');
  const base = resolve(root);
  if (relative === '') return resolve(base, 'index.html');
  const normalized = normalize(relative);
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) return undefined;
  const candidate = resolve(base, normalized);
  return candidate === base || candidate.startsWith(`${base}${sep}`) ? candidate : undefined;
}

/**
 * Serve the built Vite client. Hashed assets are immutable, while document
 * requests always revalidate so a rebuilt bundle is picked up immediately.
 */
async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  root: string,
): Promise<void> {
  const headers = {
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = safeStaticPath(root, requested);
  const content = file === undefined ? undefined : await readFile(file).catch(() => undefined);
  if (file !== undefined && content !== undefined) {
    const extension = extname(file).toLowerCase();
    response.writeHead(200, {
      ...headers,
      'content-type': STATIC_CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'cache-control': requested.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(extension === '.html' ? { 'content-security-policy': DOCUMENT_CSP } : {}),
    });
    response.end(request.method === 'HEAD' ? undefined : content);
    return;
  }
  const navigation = pathname === '/' || (!pathname.startsWith('/assets/') && extname(pathname) === '');
  if (!navigation) {
    response.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : 'Not found');
    return;
  }
  // Unknown extensionless routes are client-side navigation: fall back to the
  // application document, which re-boots the SPA.
  const document = await readFile(resolve(root, 'index.html')).catch(() => undefined);
  if (document === undefined) {
    response.writeHead(503, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD'
      ? undefined
      : 'The web client has not been built. Run "pnpm web:build" first.');
    return;
  }
  response.writeHead(200, {
    ...headers,
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': DOCUMENT_CSP,
    'cache-control': 'no-cache',
  });
  response.end(request.method === 'HEAD' ? undefined : document);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebHostOptions,
  sessions: Map<string, CachedSession>,
  running: Map<string, RunningTurn>,
  creating: Map<string, number>,
  removing: Set<string>,
  permissionLocks: Map<string, Promise<void>>,
  failedPermissions: Set<string>,
  compactRequests: Set<string>,
  getPermissionDefaultUpdates: () => number,
  setPermissionDefaultUpdates: (value: number) => void,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });
  if ((request.method === 'GET' || request.method === 'HEAD')
    && url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
    return serveStatic(request, response, url.pathname, options.staticDir ?? DEFAULT_STATIC_DIR);
  }
  if (request.method === 'GET' && url.pathname === '/api/models') {
    return json(response, 200, { models: await options.modelCatalog?.() ?? [] });
  }
  if (request.method === 'GET' && url.pathname === '/api/sessions/recent') {
    const query = url.searchParams.get('query') ?? '';
    if (query.length > 1_024) throw new HttpError(400, 'The session reference query is too long');
    const requestedLimit = Number(url.searchParams.get('limit') ?? '30');
    const limit = Number.isFinite(requestedLimit) ? Math.min(50, Math.max(1, Math.trunc(requestedLimit))) : 30;
    const currentWorkspaceId = url.searchParams.get('workspaceId');
    const workspaces = await options.workspaces.list();
    if (currentWorkspaceId !== null && workspaces.every((workspace) => workspace.id !== currentWorkspaceId)) {
      throw new HttpError(404, 'Workspace not found');
    }
    const byPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]));
    const sessions = (await options.store.list())
      .filter((session) => session.parentSessionId === undefined && session.depth === undefined)
      .flatMap((session) => {
        const workspace = byPath.get(session.workspace);
        if (workspace === undefined) return [];
        const values = [session.title ?? '', session.description ?? '', workspace.name, session.id];
        if (!likeMatches(values, query)) return [];
        return [{
          id: session.id,
          title: session.title ?? null,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          updatedAt: session.updatedAt,
          blank: session.blank,
          ...(session.agent === undefined ? {} : { agent: session.agent }),
          ...(session.mode === undefined ? {} : { mode: session.mode }),
        }];
      })
      .sort((left, right) => {
        const current = Number(right.workspaceId === currentWorkspaceId) - Number(left.workspaceId === currentWorkspaceId);
        return current || right.updatedAt - left.updatedAt
          || (left.title ?? '').localeCompare(right.title ?? '') || left.id.localeCompare(right.id);
      });
    return json(response, 200, { sessions: sessions.slice(0, limit) });
  }
  if (request.method === 'GET' && url.pathname === '/api/agents') {
    return json(response, 200, { agents: await options.listAgents?.() ?? [] });
  }
  if (request.method === 'GET' && url.pathname === '/api/roles') {
    return json(response, 200, { roles: await options.listRoles?.() ?? [] });
  }
  if (request.method === 'GET' && url.pathname === '/api/modes') {
    if (!options.modeStore) throw new HttpError(404, 'Not found');
    return json(response, 200, {
      modes: await options.modeStore.list(),
      defaultMode: await options.modeStore.defaultId(),
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/modes/options') {
    const workspaceId = url.searchParams.get('workspaceId');
    const workspace = workspaceId === null ? undefined : await options.workspaces.get(workspaceId);
    if (workspaceId !== null && workspace === undefined) throw new HttpError(404, 'Workspace not found');
    let skills: Array<{ name: string; description: string }> = [];
    try {
      skills = (await discoverSkills(workspace === undefined ? {} : { workspace: workspace.path }))
        .map((skill) => ({ name: skill.name, description: skill.description }));
    } catch {
      skills = [];
    }
    return json(response, 200, {
      tools: [...new Set([...KNOWN_TOOL_NAMES, ...(options.mcpToolNames?.() ?? [])])].sort(),
      skills,
    });
  }
  if (url.pathname === '/api/settings/default-mode' && options.modeStore) {
    if (request.method === 'GET') return json(response, 200, { defaultMode: await options.modeStore.defaultId() });
    if (request.method === 'PUT') {
      const body = await readJson(request);
      if (Object.keys(body).length !== 1 || typeof body.mode !== 'string' || body.mode.trim() === '') {
        throw new HttpError(400, 'A valid mode id is required');
      }
      try {
        return json(response, 200, { defaultMode: await options.modeStore.setDefault(body.mode) });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid mode');
      }
    }
  }
  if (url.pathname.startsWith('/api/modes/') && options.modeStore) {
    const id = decodePart(url.pathname.slice('/api/modes/'.length));
    if (id === '' || id.includes('/')) throw new HttpError(404, 'Not found');
    if (request.method === 'PUT') {
      const body = await readJson(request);
      try {
        return json(response, 200, { mode: await options.modeStore.save(id, body) });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid mode');
      }
    }
    if (request.method === 'DELETE') {
      try {
        return json(response, 200, { removed: await options.modeStore.remove(id) });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid mode');
      }
    }
  }
  if (url.pathname === '/api/settings/model-sources' && options.modelSettings) {
    if (request.method === 'GET') return json(response, 200, await options.modelSettings.list());
  }
  if (url.pathname === '/api/settings/model-sources/discover' && options.modelSettings) {
    if (request.method === 'POST') {
      const body = await readJson(request);
      try {
        return json(response, 200, await options.modelSettings.discover(body));
      } catch (error) {
        if (error instanceof InvalidModelSettings) throw new HttpError(400, error.message);
        throw new HttpError(400, error instanceof Error ? error.message : 'Could not fetch models');
      }
    }
  }
  if (url.pathname.startsWith('/api/settings/model-sources/') && options.modelSettings) {
    const id = decodePart(url.pathname.slice('/api/settings/model-sources/'.length));
    if (id === '' || id.includes('/')) throw new HttpError(404, 'Not found');
    if (request.method === 'PUT') {
      const body = await readJson(request);
      try {
        return json(response, 200, { source: await options.modelSettings.save(id, body) });
      } catch (error) {
        if (error instanceof InvalidModelSettings) throw new HttpError(400, error.message);
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid model source');
      }
    }
    if (request.method === 'DELETE') {
      try {
        return json(response, 200, { removed: await options.modelSettings.remove(id) });
      } catch (error) {
        if (error instanceof InvalidModelSettings) throw new HttpError(400, error.message);
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid model source');
      }
    }
  }
  if (url.pathname === '/api/settings/roles' && options.roleSettings) {
    if (request.method === 'GET') return json(response, 200, await options.roleSettings.list());
  }
  if (url.pathname.startsWith('/api/settings/roles/') && options.roleSettings) {
    const id = decodePart(url.pathname.slice('/api/settings/roles/'.length));
    if (id === '' || id.includes('/')) throw new HttpError(404, 'Not found');
    if (request.method === 'PUT') {
      const body = await readJson(request);
      try {
        return json(response, 200, { role: await options.roleSettings.save(id, body) });
      } catch (error) {
        if (error instanceof InvalidRoleSettings) throw new HttpError(400, error.message);
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid role');
      }
    }
    if (request.method === 'DELETE') {
      try {
        return json(response, 200, { removed: await options.roleSettings.remove(id) });
      } catch (error) {
        if (error instanceof InvalidRoleSettings) throw new HttpError(400, error.message);
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid role');
      }
    }
  }
  if (url.pathname === '/api/settings/mcp-servers' && options.mcpSettings) {
    if (request.method === 'GET') return json(response, 200, await options.mcpSettings.list());
  }
  if (url.pathname === '/api/settings/mcp-servers/test' && options.mcpSettings) {
    if (request.method === 'POST') {
      const body = await readJson(request);
      if (typeof body.id !== 'string' || body.id.trim() === '') {
        throw new HttpError(400, 'A server id is required');
      }
      if (body.server !== undefined
        && (typeof body.server !== 'object' || body.server === null || Array.isArray(body.server))) {
        throw new HttpError(400, 'server must be an object');
      }
      try {
        return json(response, 200, await options.mcpSettings.test(body.id.trim(), body.server));
      } catch (error) {
        if (error instanceof InvalidMcpSettings) throw new HttpError(400, error.message);
        throw new HttpError(500, error instanceof Error ? error.message : 'MCP server test failed');
      }
    }
  }
  if (url.pathname.startsWith('/api/settings/mcp-servers/') && options.mcpSettings) {
    const id = decodePart(url.pathname.slice('/api/settings/mcp-servers/'.length));
    if (id === '' || id.includes('/')) throw new HttpError(404, 'Not found');
    if (request.method === 'PUT') {
      const body = await readJson(request);
      try {
        return json(response, 200, { server: await options.mcpSettings.save(id, body) });
      } catch (error) {
        if (error instanceof InvalidMcpSettings) throw new HttpError(400, error.message);
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid MCP server');
      }
    }
    if (request.method === 'DELETE') {
      try {
        return json(response, 200, { removed: await options.mcpSettings.remove(id) });
      } catch (error) {
        if (error instanceof InvalidMcpSettings) throw new HttpError(400, error.message);
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid MCP server');
      }
    }
  }
  if (url.pathname === '/api/settings/agents' && options.agentAuthoring) {
    if (request.method === 'GET') {
      return json(response, 200, {
        agents: await options.agentAuthoring.list(),
        profiles: await options.agentAuthoring.listProfiles(),
      });
    }
  }
  if (url.pathname.startsWith('/api/settings/agents/') && options.agentAuthoring) {
    const id = decodePart(url.pathname.slice('/api/settings/agents/'.length));
    if (id === '' || id.includes('/')) throw new HttpError(404, 'Not found');
    if (request.method === 'GET') {
      try {
        return json(response, 200, {
          agent: await options.agentAuthoring.read(id),
          profiles: await options.agentAuthoring.listProfiles(),
        });
      } catch (error) {
        if (error instanceof InvalidAgentSettings) throw new HttpError(404, error.message);
        throw error;
      }
    }
    if (request.method === 'PUT') {
      const body = await readJson(request, MAX_AGENT_REQUEST_BYTES);
      const parsed = AgentDefinitionWriteSchema.safeParse({ ...body, id });
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid agent definition');
      }
      try {
        const result = await options.agentAuthoring.write(parsed.data);
        return json(response, 200, {
          agent: await options.agentAuthoring.read(id),
          created: result.created,
        });
      } catch (error) {
        if (error instanceof InvalidAgentSettings) throw new HttpError(400, error.message);
        throw error;
      }
    }
    if (request.method === 'DELETE') {
      try {
        return json(response, 200, { removed: await options.agentAuthoring.remove(id) });
      } catch (error) {
        if (error instanceof InvalidAgentSettings) throw new HttpError(400, error.message);
        throw error;
      }
    }
  }
  if (url.pathname === '/api/schedules' || url.pathname.startsWith('/api/schedules/')) {
    if (!options.schedule) throw new HttpError(404, 'Not found');
    return routeSchedules(request, response, url, options.schedule);
  }
  if (url.pathname === '/api/settings/permissions' && options.permissionSettings) {
    if (request.method === 'GET') return json(response, 200, { settings: await options.permissionSettings.read() });
    if (request.method === 'PUT') {
      const body = await readJson(request);
      if (running.size > 0 || creating.size > 0) {
        throw new HttpError(409, 'Cannot change the global permission default while a turn or session creation is active');
      }
      setPermissionDefaultUpdates(getPermissionDefaultUpdates() + 1);
      try {
        try {
          return json(response, 200, { settings: await options.permissionSettings.update(body) });
        } catch (error) {
          if (error instanceof InvalidPermissionSettings) throw new HttpError(400, 'Invalid permission settings');
          throw error;
        }
      } finally {
        setPermissionDefaultUpdates(getPermissionDefaultUpdates() - 1);
      }
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/workspaces') {
    return json(response, 200, { workspaces: await options.workspaces.list() });
  }
  if (request.method === 'POST' && url.pathname === '/api/workspaces') {
    const body = await readJson(request);
    if (typeof body.path !== 'string' || body.path.trim() === '' || !isAbsolute(body.path) ||
      (body.name !== undefined && typeof body.name !== 'string')) {
      throw new HttpError(400, 'An absolute workspace directory path is required');
    }
    try {
      if (!(await stat(body.path)).isDirectory()) throw new HttpError(400, 'The workspace path must be a directory');
      const workspace = await options.workspaces.add(body.path, body.name as string | undefined);
      return json(response, 201, { workspace });
    } catch (error) {
      if (isPathError(error)) throw new HttpError(400, 'The workspace path must be an accessible directory');
      throw error;
    }
  }

  const parts = url.pathname.split('/').filter(Boolean).map(decodePart);
  if (parts[0] !== 'api' || parts[1] !== 'workspaces' || !parts[2]) {
    throw new HttpError(404, 'Not found');
  }
  const workspace = await options.workspaces.get(parts[2]);
  if (!workspace) throw new HttpError(404, 'Workspace not found');
  const workspacePrefix = `${workspace.path}\0`;
  if (request.method === 'GET' && parts.length === 4 && parts[3] === 'files') {
    const query = url.searchParams.get('query') ?? '';
    if (query.length > 1_024) throw new HttpError(400, 'The file reference query is too long');
    const requestedLimit = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(requestedLimit) ? Math.min(50, Math.max(1, Math.trunc(requestedLimit))) : 20;
    return json(response, 200, { entries: await searchWorkspaceFiles(workspace.path, query, limit) });
  }
  if (request.method === 'DELETE' && parts.length === 3) {
    if (workspace.isDefault === true) throw new HttpError(403, 'The default workspace cannot be removed');
    if (removing.has(workspace.id) || creating.has(workspace.id) ||
        [...running.keys()].some((key) => key.startsWith(workspacePrefix)) ||
        [...permissionLocks.keys()].some((key) => key.startsWith(workspacePrefix))) {
      throw new HttpError(409, 'Workspace has an active turn or session creation');
    }
    removing.add(workspace.id);
    try {
      let removed: boolean;
      try {
        removed = await options.workspaces.remove(workspace.id);
      } catch (error) {
        if (error instanceof DefaultWorkspaceRemovalError) throw new HttpError(403, error.message);
        throw error;
      }
      for (const key of sessions.keys()) if (key.startsWith(workspacePrefix)) sessions.delete(key);
      return json(response, 200, { removed });
    } finally {
      removing.delete(workspace.id);
    }
  }
  if (parts[3] !== 'sessions') throw new HttpError(404, 'Not found');
  if (request.method === 'GET' && parts.length === 4) {
    const summaries = await Promise.all((await options.store.list())
      .filter((item) => item.workspace === workspace.path)
      .map(async (item) => {
        try {
          const handle = await options.store.open(item.workspace, item.id);
          const agent = projectAgentSelection(handle.events);
          return { ...item, ...(agent.status === 'selected' ? { agent: agent.agent } : {}) };
        } catch {
          return item;
        }
      }));
    return json(response, 200, {
      sessions: summaries.sort((left, right) =>
        Number(right.pinned === true) - Number(left.pinned === true)
        || right.updatedAt - left.updatedAt),
    });
  }
  if (request.method === 'POST' && parts.length === 4) {
    const body = await readJson(request);
    if (running.size > 0 || creating.size > 0 || getPermissionDefaultUpdates() > 0) throw new HttpError(409, 'Cannot create a session while a turn or session creation is active');
    if (removing.has(workspace.id)) throw new HttpError(409, 'Workspace is being unregistered');
    creating.set(workspace.id, (creating.get(workspace.id) ?? 0) + 1);
    try {
      const registered = await options.workspaces.get(workspace.id);
      if (!registered || registered.path !== workspace.path) throw new HttpError(404, 'Workspace not found');
      let runtime: ResolvedSessionRuntime | undefined;
      let agentId: string | undefined;
      let binding: ModelBinding | undefined;
      let modeSelection: ModeSelection | undefined;
      if (options.runtime) {
        if (Object.keys(body).some((name) => name !== 'mode' && name !== 'agent' && name !== 'model')) {
          throw new HttpError(400, 'Invalid session configuration');
        }
        if (body.mode !== undefined) {
          if (body.agent !== undefined) {
            throw new HttpError(400, 'A mode session cannot also specify an agent');
          }
          if (typeof body.mode !== 'string' || body.mode.length === 0) {
            throw new HttpError(400, 'A valid mode id is required');
          }
          const parsedOverride = body.model === undefined
            ? { success: true as const, data: undefined }
            : ModelBindingSchema.safeParse(body.model);
          if (!parsedOverride.success) throw new HttpError(400, 'A valid model binding is required');
          if (!options.modeStore) throw new HttpError(409, 'Mode presets are unavailable');
          const mode = await options.modeStore.get(body.mode);
          if (mode === undefined) throw new HttpError(409, `Unknown mode "${body.mode}"`);
          if (!mode.valid) throw new HttpError(409, `Mode "${body.mode}" is unavailable: ${mode.warnings.join('; ')}`);
          if (!options.createRuntimeSession) throw new HttpError(500, 'Runtime session composition is unavailable');
          agentId = mode.agent;
          // A mode fixes the agent, tools and skills. The model still defaults
          // to the mode binding but the user may override it for this session.
          binding = parsedOverride.data ?? mode.model;
          try {
            runtime = await options.runtime.resolve({
              cwd: workspace.path,
              agentId,
              binding,
              isRoot: true,
              mode: { id: mode.id, tools: mode.tools, skills: mode.skills },
            });
          } catch (error) {
            throw new HttpError(409, error instanceof Error ? error.message : 'The selected mode is unavailable');
          }
          modeSelection = {
            version: 1,
            mode: mode.id,
            agent: agentId,
            model: runtime.modelBinding,
            tools: runtime.sessionAgent.tools === '*' ? '*' : [...runtime.sessionAgent.tools].sort(),
            skills: runtime.sessionAgent.skills === '*' ? '*' : [...runtime.sessionAgent.skills].sort(),
          };
        } else {
          if (body.agent !== undefined && (typeof body.agent !== 'string' || body.agent.length === 0)) {
            throw new HttpError(400, 'A valid agent id is required');
          }
          const parsedBinding = body.model === undefined
            ? { success: true as const, data: defaultModelBinding() }
            : ModelBindingSchema.safeParse(body.model);
          if (!parsedBinding.success) throw new HttpError(400, 'A valid model binding is required');
          if (!options.createRuntimeSession) throw new HttpError(500, 'Runtime session composition is unavailable');
          agentId = typeof body.agent === 'string' ? body.agent : 'default';
          binding = parsedBinding.data;
          try {
            runtime = await options.runtime.resolve({
              cwd: workspace.path,
              agentId,
              binding,
              isRoot: true,
            });
          } catch (error) {
            throw new HttpError(409, error instanceof Error ? error.message : 'The selected agent is unavailable');
          }
        }
      } else if (Object.keys(body).length > 0) {
        throw new HttpError(400, 'Agent and model selection require a configured runtime');
      }
      const handle = await options.store.create({ workspace: workspace.path, cwd: workspace.path });
      const key = `${workspace.path}\0${handle.id}`;
      await withPermissionLock(permissionLocks, key, async () => {
        const settings = options.permissionSettings?.snapshot() ?? resolveDshDefaultPreset(undefined);
        if (handle.events.length === 0 && !settings.requiresSelection && isDshPermissionPreset(settings.defaultPreset)) {
          try {
            await handle.append(createInitialDshPermissionEvent(settings.defaultPreset));
          } catch (error) {
            failedPermissions.add(key);
            throw error;
          }
        }
        if (runtime !== undefined && agentId !== undefined && binding !== undefined) {
          await handle.append(createAgentSelectionEvent(agentId));
          await handle.append(createModelSelectionEvent(binding));
          if (modeSelection !== undefined) await handle.append(createModeSelectionEvent(modeSelection));
        }
      });
      await options.workspaces.touch(workspace.id);
      return json(response, 201, { session: summarize(handle) });
    } finally {
      const remaining = creating.get(workspace.id)! - 1;
      if (remaining) creating.set(workspace.id, remaining);
      else creating.delete(workspace.id);
    }
  }
  const sessionId = parts[4];
  if (!sessionId || sessionId.length > 256) throw new HttpError(404, 'Session not found');
  const key = `${workspace.path}\0${sessionId}`;

  if (request.method === 'GET' && parts.length === 5) {
    const handle = await openSession(options.store, workspace, sessionId);
    const audit = await options.readAudit?.(workspace, sessionId) ?? [];
    await options.workspaces.touch(workspace.id);
    const selection = await describeSelection(options, workspace, handle);
    const title = foldSessionTitle(handle.events);
    const mode = projectModeSelection(handle.events);
    return json(response, 200, {
      header: handle.header,
      title: title?.title ?? null,
      titleSource: title?.source ?? null,
      blank: !hasHumanMessage(handle.events),
      mode: mode.status === 'selected' ? mode.selection : null,
      running: running.has(key),
      messages: projectPublicHistory(handle.header, handle.events),
      permission: { preset: permissionProjection(handle, key, failedPermissions).preset },
      ...selection,
      plan: projectPlanMode(handle.events),
      todos: projectTodos(handle.events),
      events: projectTraceEvents(handle.events),
      trajectory: projectTrajectory(handle.events),
      audit,
    });
  }
  if (request.method === 'PATCH' && parts.length === 5) {
    const body = await readJson(request);
    if (Object.keys(body).length !== 1 || typeof body.title !== 'string' || body.title.length > 1_000) {
      throw new HttpError(400, 'A session title is required');
    }
    const title = normalizeSessionTitle(body.title, DEFAULT_SESSION_TITLE_LIMITS.maxTitleBytes);
    if (title === '') throw new HttpError(400, 'A non-empty session title is required');
    const handle = await openSession(options.store, workspace, sessionId);
    const current = foldSessionTitle(handle.events);
    if (current?.source.kind !== 'user' || current.title !== title) {
      await handle.append({
        type: SESSION_TITLE_EVENT,
        data: { title, messageSeqs: [], source: { kind: 'user' } },
      });
    }
    return json(response, 200, { title });
  }
  if (request.method === 'DELETE' && parts.length === 5) {
    if (running.has(key)) throw new HttpError(409, 'Cannot delete a session while its turn is active');
    if (removing.has(workspace.id)) throw new HttpError(409, 'Workspace is being unregistered');
    const registered = await options.workspaces.get(workspace.id);
    if (!registered || registered.path !== workspace.path) throw new HttpError(404, 'Workspace not found');
    await openSession(options.store, workspace, sessionId);
    await options.store.delete(workspace.path, sessionId);
    sessions.delete(key);
    options.liveSessions?.delete(key);
    failedPermissions.delete(key);
    return json(response, 200, { deleted: true });
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'pin') {
    const body = await readJson(request);
    if (Object.keys(body).length !== 1 || typeof body.pinned !== 'boolean') {
      throw new HttpError(400, 'A boolean pinned value is required');
    }
    const handle = await openSession(options.store, workspace, sessionId);
    if (foldSessionPinned(handle.events) !== body.pinned) {
      await handle.append(createSessionPinEvent(body.pinned));
    }
    return json(response, 200, { pinned: body.pinned });
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'fork') {
    if (running.size > 0 || creating.size > 0 || getPermissionDefaultUpdates() > 0) {
      throw new HttpError(409, 'Cannot fork a session while a turn or session creation is active');
    }
    if (removing.has(workspace.id)) throw new HttpError(409, 'Workspace is being unregistered');
    const registered = await options.workspaces.get(workspace.id);
    if (!registered || registered.path !== workspace.path) throw new HttpError(404, 'Workspace not found');
    const source = await openSession(options.store, workspace, sessionId);
    const created = await forkSession(options.store, source, workspace);
    await options.workspaces.touch(workspace.id);
    return json(response, 201, { session: summarize(created) });
  }
  if (request.method === 'GET' && parts.length === 6 && parts[5] === 'context') {
    const handle = await openSession(options.store, workspace, sessionId);
    let runtime: ResolvedSessionRuntime | undefined;
    if (options.runtime) {
      const agent = projectAgentSelection(handle.events);
      const binding = projectModelSelection(handle.events);
      if (agent.status === 'selected' && binding.status === 'selected') {
        try {
          runtime = await options.runtime.resolve({
            cwd: handle.header.cwd ?? workspace.path,
            agentId: agent.agent,
            binding: binding.binding,
            isRoot: true,
            ...(modeRuntimeOverride(handle) === undefined ? {} : { mode: modeRuntimeOverride(handle) }),
          });
        } catch { /* An unavailable runtime has no known window. */ }
      }
    }
    const shared = options.liveSessions?.get(key);
    const cached = sessions.get(key);
    const modelKey = runtime === undefined ? '' : JSON.stringify(runtime.modelBinding);
    const revision = runtime?.revision;
    const preset = permissionProjection(handle, key, failedPermissions).preset;
    const matches = (candidate: { preset: unknown; modelKey: string; runtimeKey?: string }): boolean =>
      candidate.preset === preset && candidate.modelKey === modelKey && candidate.runtimeKey === revision;
    const sharedSession = shared?.session as WebSession | undefined;
    let live: WebSession | undefined;
    if (shared && matches(shared)) live = sharedSession;
    else if (cached && matches(cached)) live = await cached.pending.catch(() => undefined);
    const runningNow = running.has(key) || sharedSession?.activeTurn === true || live?.activeTurn === true;
    // A live runtime owns the authoritative post-compaction history. Only use
    // replay when the next turn would create a fresh runtime from the log.
    const estimatedMessageTokens = runningNow ? undefined
      : live ? live.contextMessageEstimate?.() : estimateModelHistory(projectMessages(handle.events));
    return json(response, 200, {
      ...(estimatedMessageTokens === undefined ? {} : { estimatedMessageTokens }),
      ...(runtime?.contextWindowTokens === undefined || runtime.contextWindowSource === undefined ? {} : {
        window: { tokens: runtime.contextWindowTokens, source: runtime.contextWindowSource },
      }),
    });
  }
  if (request.method === 'GET' && parts.length === 6 && parts[5] === 'messages') {
    const handle = await openSession(options.store, workspace, sessionId);
    return json(response, 200, {
      messages: projectPublicHistory(handle.header, handle.events),
    });
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'permission') {
    const body = await readJson(request);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'preset') || !isDshPermissionPreset(body.preset)) {
      throw new HttpError(400, 'A valid permission preset is required');
    }
    const preset = body.preset;
    const permission = await withPermissionLock(permissionLocks, key, async () => {
      if (running.size > 0) throw new HttpError(409, 'Cannot change permissions while a turn is active');
      if (running.has(key)) throw new HttpError(409, 'Cannot change a session permission while its turn is active');
      if (removing.has(workspace.id)) throw new HttpError(409, 'Workspace is being unregistered');
      const registered = await options.workspaces.get(workspace.id);
      if (!registered || registered.path !== workspace.path) throw new HttpError(404, 'Workspace not found');
      const handle = await openSession(options.store, workspace, sessionId);
      const projection = permissionProjection(handle, key, failedPermissions);
      const event = createDshPresetSwitch(projection, preset);
      if (event) {
        try {
          await handle.append(event);
          failedPermissions.delete(key);
        } catch (error) {
          failedPermissions.add(key);
          sessions.delete(key);
          options.liveSessions?.delete(key);
          throw error;
        }
      }
      return { preset };
    });
    return json(response, 200, { permission });
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'agent') {
    if (!options.runtime) throw new HttpError(409, 'Agent selection is not available without a configured runtime');
    const body = await readJson(request);
    if (Object.keys(body).length !== 1 || typeof body.agent !== 'string' ||
        body.agent.trim().length === 0 || body.agent.length > 128) {
      throw new HttpError(400, 'A valid agent id is required');
    }
    const agent = body.agent;
    const result = await withPermissionLock(permissionLocks, key, async () => {
      if (running.size > 0 || running.has(key)) throw new HttpError(409, 'Cannot change the agent while a turn is active');
      if (removing.has(workspace.id)) throw new HttpError(409, 'Workspace is being unregistered');
      const registered = await options.workspaces.get(workspace.id);
      if (!registered || registered.path !== workspace.path) throw new HttpError(404, 'Workspace not found');
      const handle = await openSession(options.store, workspace, sessionId);
      if (projectModeSelection(handle.events).status === 'selected') {
        throw new HttpError(409, 'The session mode is fixed; create a new session to change it');
      }
      const binding = projectModelSelection(handle.events);
      if (binding.status === 'invalid') throw new HttpError(409, 'The session model binding is invalid; select a model again');
      let resolved: ResolvedSessionRuntime;
      try {
        resolved = await options.runtime!.resolve({
          cwd: handle.header.cwd,
          agentId: agent,
          binding: binding.status === 'selected' ? binding.binding : defaultModelBinding(),
          isRoot: true,
        });
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : 'The selected agent is unavailable');
      }
      if (!resolved.agent) throw new HttpError(409, 'The selected agent is unavailable');
      const current = projectAgentSelection(handle.events);
      const event = createAgentSwitch(current, { version: 1, agent });
      if (event) await handle.append(event);
      sessions.delete(key);
      options.liveSessions?.delete(key);
      return agentSummary(resolved);
    });
    return json(response, 200, { agent: result });
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'model') {
    if (!options.runtime) throw new HttpError(409, 'Model selection is not available without a configured runtime');
    const body = await readJson(request);
    const parsed = ModelBindingSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'A valid model binding is required');
    const binding = parsed.data;
    const result = await withPermissionLock(permissionLocks, key, async () => {
      if (running.size > 0 || running.has(key)) throw new HttpError(409, 'Cannot change the model while a turn is active');
      if (removing.has(workspace.id)) throw new HttpError(409, 'Workspace is being unregistered');
      const registered = await options.workspaces.get(workspace.id);
      if (!registered || registered.path !== workspace.path) throw new HttpError(404, 'Workspace not found');
      const handle = await openSession(options.store, workspace, sessionId);
      const agent = projectAgentSelection(handle.events);
      if (agent.status !== 'selected') throw new HttpError(409, 'Select an agent before selecting a model');
      let resolved: ResolvedSessionRuntime;
      try {
        resolved = await options.runtime!.resolve({
          cwd: handle.header.cwd,
          agentId: agent.agent,
          binding,
          isRoot: true,
        });
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : 'The selected model is unavailable');
      }
      const event = createModelSwitch(projectModelSelection(handle.events), binding);
      if (event) await handle.append(event);
      sessions.delete(key);
      options.liveSessions?.delete(key);
      return {
        model: binding,
        resolvedModel: resolvedModelSummary(resolved),
      };
    });
    return json(response, 200, result);
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'plan') {
    const body = await readJson(request);
    const active = body.active;
    if (Object.keys(body).length !== 1 || typeof active !== 'boolean') {
      throw new HttpError(400, 'A boolean plan mode state is required');
    }
    await withPermissionLock(permissionLocks, key, async () => {
      if (running.size > 0 || running.has(key)) throw new HttpError(409, 'Cannot change plan mode while a turn is active');
      if (removing.has(workspace.id)) throw new HttpError(409, 'Workspace is being unregistered');
      const registered = await options.workspaces.get(workspace.id);
      if (!registered || registered.path !== workspace.path) throw new HttpError(404, 'Workspace not found');
      const handle = await openSession(options.store, workspace, sessionId);
      if (projectPlanMode(handle.events).active !== active) {
        await handle.append(createPlanModeEvent(active));
      }
      sessions.delete(key);
      options.liveSessions?.delete(key);
    });
    return json(response, 200, { plan: { active } });
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'plan-review' && options.approvalBroker) {
    const body = await readJson(request);
    if (Object.keys(body).some((name) => name !== 'requestId' && name !== 'approved' && name !== 'feedback') ||
        typeof body.requestId !== 'string' || body.requestId.length === 0 || body.requestId.length > 256 ||
        typeof body.approved !== 'boolean' ||
        (body.feedback !== undefined && (typeof body.feedback !== 'string' || body.feedback.length > 4_000))) {
      throw new HttpError(400, 'A request ID, approval decision, and optional feedback are required');
    }
    await openSession(options.store, workspace, sessionId);
    if (!options.approvalBroker.respondPlan(workspace.path, sessionId, body.requestId, body.approved, body.feedback)) {
      throw new HttpError(409, 'Plan review is no longer active');
    }
    return json(response, 200, { ok: true });
  }
  if (request.method === 'GET' && parts.length === 6 && parts[5] === 'export') {
    const format = url.searchParams.get('format');
    if (format !== 'json' && format !== 'markdown') throw new HttpError(400, 'Unsupported export format');
    const handle = await openSession(options.store, workspace, sessionId);
    const exported = exportSession(handle, format);
    response.writeHead(200, {
      'content-type': exported.mimeType,
      'content-disposition': `attachment; filename="${exported.filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(exported.text);
    return;
  }
  if (request.method === 'GET' && parts.length === 6 && parts[5] === 'events') {
    const handle = await openSession(options.store, workspace, sessionId);
    return json(response, 200, { events: projectTraceEvents(handle.events) });
  }
  if (request.method === 'GET' && parts.length === 6 && parts[5] === 'audit') {
    await openSession(options.store, workspace, sessionId);
    return json(response, 200, { audit: await options.readAudit?.(workspace, sessionId) ?? [] });
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'approvals' && options.approvalBroker) {
    const body = await readJson(request);
    if (Object.keys(body).some((name) => name !== 'requestId' && name !== 'decision') ||
        typeof body.requestId !== 'string' || body.requestId.length === 0 || body.requestId.length > 256 ||
        (body.decision !== 'allow' && body.decision !== 'deny')) {
      throw new HttpError(400, 'A request ID and approval decision are required');
    }
    await openSession(options.store, workspace, sessionId);
    if (!options.approvalBroker.respond(workspace.path, sessionId, body.requestId, body.decision)) {
      throw new HttpError(409, 'Approval request is no longer active');
    }
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'compact') {
    await readJson(request);
    await openSession(options.store, workspace, sessionId);
    if (running.has(key)) throw new HttpError(409, 'The session is running; compact context after the reply finishes');
    compactRequests.add(key);
    return json(response, 202, { ok: true, scheduled: true });
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'interrupt') {
    await readJson(request);
    const turn = running.get(key);
    if (turn) {
      turn.cancelled = true;
      turn.session?.interrupt();
    }
    await openSession(options.store, workspace, sessionId);
    if (!turn) throw new HttpError(409, 'Session is not running');
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && parts.length === 6 && parts[5] === 'messages') {
    const body = await readJson(request, MAX_MESSAGE_BODY_BYTES);
    const text = typeof body.text === 'string' ? body.text : '';
    const attachments = parseSendAttachments(body.attachments);
    if (text.trim().length === 0 && attachments.length === 0) {
      throw new HttpError(400, 'Message text or an attachment is required');
    }
    const content = attachments.length === 0 ? text : composeUserContent(text, attachments);
    const sendMode = body.mode;
    if (sendMode !== undefined && sendMode !== 'steer') {
      throw new HttpError(400, 'A valid send mode is required');
    }
    if (sendMode === 'steer' && running.has(key)) {
      if (removing.has(workspace.id)) throw new HttpError(409, 'Workspace is being unregistered');
      const active = running.get(key)!;
      if (active.ready !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          active.ready,
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000); }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }
      if (active.session?.deliverUserMessage === undefined) {
        throw new HttpError(409, 'The active turn cannot accept another message yet');
      }
      const delivery = await active.session.deliverUserMessage(content);
      return json(response, 202, { accepted: true, delivery });
    }
    if (running.has(key)) throw new HttpError(409, 'Session already has an active turn');
    if (removing.has(workspace.id)) throw new HttpError(409, 'Workspace is being unregistered');
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const turn: RunningTurn = { cancelled: false, ready };
    running.set(key, turn);
    const disconnected = () => {
      if (response.writableEnded) return;
      if (turn.session) turn.session.interrupt();
      else if (running.get(key) === turn) running.delete(key);
      turn.approval?.close();
    };
    const responseError = () => undefined;
    response.on('error', responseError);
    response.once('close', disconnected);
    try {
      const registered = await options.workspaces.get(workspace.id);
      if (!registered || registered.path !== workspace.path) throw new HttpError(404, 'Workspace not found');
      if (response.destroyed) return;
      const { handle, permissions, runtime } = await withPermissionLock(permissionLocks, key, async () => {
        const handle = await openSession(options.store, workspace, sessionId);
        const projection = permissionProjection(handle, key, failedPermissions);
        if (projection.status !== 'ready') throw new HttpError(409, 'A permission preset must be selected');
        const permissions = snapshotDshPermissions(projection);
        if (!options.runtime) return { handle, permissions, runtime: undefined };
        if (!options.createRuntimeSession) throw new HttpError(409, 'Runtime session composition is unavailable');
        const agent = projectAgentSelection(handle.events);
        if (agent.status !== 'selected') {
          throw new HttpError(409, agent.status === 'invalid'
            ? 'The session agent selection is invalid; select an agent again'
            : 'An agent must be selected before sending a message');
        }
        const binding = projectModelSelection(handle.events);
        if (binding.status !== 'selected') {
          throw new HttpError(409, binding.status === 'invalid'
            ? 'The session model binding is invalid; select a model again'
            : 'A model binding must be selected before sending a message');
        }
        let resolved: ResolvedSessionRuntime;
        try {
          resolved = await options.runtime.resolve({
            cwd: handle.header.cwd,
            agentId: agent.agent,
            binding: binding.binding,
            isRoot: true,
            ...(modeRuntimeOverride(handle) === undefined ? {} : { mode: modeRuntimeOverride(handle) }),
          });
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : 'The selected agent is unavailable');
        }
        return { handle, permissions, runtime: resolved };
      });
      if (response.destroyed) return;
      if (turn.cancelled) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-content-type-options': 'nosniff',
          'connection': 'keep-alive',
        });
        response.flushHeaders();
        response.write(`data: ${JSON.stringify({ type: 'turn.end', reason: 'interrupted' })}\n\n`);
        return;
      }
      const session = await getSession(options, sessions, running, workspace, handle, key, permissions, runtime);
      if (response.destroyed) return;
      if (turn.cancelled) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-content-type-options': 'nosniff',
          'connection': 'keep-alive',
        });
        response.flushHeaders();
        response.write(`data: ${JSON.stringify({ type: 'turn.end', reason: 'interrupted' })}\n\n`);
        return;
      }
      turn.session = session;
      if (compactRequests.delete(key)) session.requestCompaction?.();
      markReady();
      turn.approval = options.approvalBroker?.start(workspace.path, sessionId);
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-content-type-options': 'nosniff',
        'connection': 'keep-alive',
      });
      response.flushHeaders();
      const source = session.send(content);
      for await (const event of turn.approval ? turn.approval.stream(source) : source) {
        if (response.destroyed) break;
        const publicEvent = publicAgentEvent(event);
        if (!response.write(`data: ${JSON.stringify(publicEvent)}\n\n`)) {
          await waitForDrain(response);
          if (response.destroyed) break;
        }
      }
    } catch (error) {
      if (!response.headersSent) throw error;
      if (!response.destroyed) {
        response.write(`data: ${JSON.stringify({ type: 'error', error: { message: 'The turn failed' } })}\n\n`);
        response.write(`data: ${JSON.stringify({ type: 'turn.end', reason: 'error' })}\n\n`);
      }
    } finally {
      markReady();
      turn.approval?.close();
      if (running.get(key) === turn) running.delete(key);
      response.off('close', disconnected);
      // A write queued before a client disconnect can surface EPIPE after this
      // cleanup, so the no-op handler stays attached for the response lifetime.
      if (!response.destroyed && response.headersSent && !response.writableEnded) response.end();
    }
    return;
  }
  throw new HttpError(404, 'Not found');
}

/**
 * Automation-task HTTP surface. Errors from the shared Schedule service are
 * translated to JSON status responses so the page can render the same
 * localized validation feedback as the agent tools.
 */
async function routeSchedules(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  schedule: ScheduleService,
): Promise<void> {
  const parts = url.pathname.split('/').filter(Boolean).map(decodePart);
  try {
    if (parts.length === 2) {
      if (request.method === 'GET') {
        const active = url.searchParams.get('active');
        const limit = parsePageNumber(url.searchParams.get('limit'));
        const offset = parsePageNumber(url.searchParams.get('offset'));
        const result = await schedule.list({
          ...(active === 'true' ? { active: true } : active === 'false' ? { active: false } : {}),
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        });
        return json(response, 200, {
          schedules: result.items,
          total: result.total,
          limit: result.limit,
          offset: result.offset,
        });
      }
      if (request.method === 'POST') {
        const body = await readJson(request);
        const created = await schedule.create(parseCreateSchedule(body), actorSessionId(body));
        return json(response, 201, { schedule: created });
      }
    }
    if (parts.length === 3 && parts[2] === 'limits' && request.method === 'GET') {
      return json(response, 200, { limits: schedule.deliveryLimits() });
    }
    if (parts.length === 3 && parts[2] === 'clear-ended' && request.method === 'POST') {
      await readJson(request);
      return json(response, 200, await schedule.deleteInactive());
    }
    const id = parts[2];
    if (id === undefined || id.length === 0 || id.length > 256) throw new HttpError(404, 'Schedule not found');
    if (parts.length === 3) {
      if (request.method === 'GET') {
        const result = await schedule.view({ id });
        if ('code' in result) throw new HttpError(404, 'Schedule not found', result.code);
        return json(response, 200, { schedule: result });
      }
      if (request.method === 'PATCH' || request.method === 'PUT') {
        const body = await readJson(request);
        const patch = parseSchedulePatch(body.patch);
        const expectedUpdatedAt = optionalStringOrNull(body.expectedUpdatedAt, 'expectedUpdatedAt');
        const result = await schedule.edit({
          id,
          action: 'update',
          patch,
          ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
        }, actorSessionId(body));
        if ('code' in result) {
          const status = result.code === 'schedule_conflict' ? 409 : 404;
          throw new HttpError(status, result.code === 'schedule_conflict'
            ? 'The schedule was changed by another editor'
            : 'Schedule not found', result.code);
        }
        if ('deleted' in result) throw new HttpError(500, 'Schedule update returned a deletion');
        return json(response, 200, { schedule: result });
      }
      if (request.method === 'DELETE') {
        const expectedUpdatedAt = optionalStringOrNull(url.searchParams.get('expectedUpdatedAt'), 'expectedUpdatedAt');
        const result = await schedule.edit({
          id,
          action: 'delete',
          ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
        });
        if ('code' in result) {
          const status = result.code === 'schedule_conflict' ? 409 : 404;
          throw new HttpError(status, result.code === 'schedule_conflict'
            ? 'The schedule was changed by another editor'
            : 'Schedule not found', result.code);
        }
        if (!('deleted' in result)) throw new HttpError(500, 'Schedule deletion returned a task');
        return json(response, 200, { deleted: true });
      }
    }
    if (parts.length === 4 && parts[3] === 'run' && request.method === 'POST') {
      await readJson(request);
      const result = await schedule.run({ id });
      if ('code' in result) {
        const status = result.code === 'schedule_execution_pending' ? 409 : 404;
        throw new HttpError(status, result.code === 'schedule_execution_pending'
          ? 'This schedule is already running'
          : 'Schedule not found', result.code);
      }
      return json(response, 200, { schedule: result });
    }
    if (parts.length === 4 && parts[3] === 'history' && request.method === 'GET') {
      const limit = parsePageNumber(url.searchParams.get('limit')) ?? 20;
      const before = url.searchParams.get('before') ?? undefined;
      const historyRequest: ScheduleDeliveryHistoryRequest = {
        id,
        limit,
        ...(before === undefined || before === '' ? {} : { before }),
      };
      const result = await schedule.history(historyRequest);
      if ('code' in result) throw new HttpError(404, 'Schedule not found', result.code);
      return json(response, 200, { history: result });
    }
    throw new HttpError(404, 'Not found');
  } catch (error) {
    if (error instanceof ScheduleInputError) throw new HttpError(400, error.message, error.code);
    throw error;
  }
}

function parsePageNumber(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, 'A whole number is required');
  return parsed;
}

function parseCreateSchedule(body: Record<string, unknown>): ScheduleCreateRequest {
  return {
    title: body.title as string,
    prompt: body.prompt as string,
    timing: body.timing as ScheduleTiming,
    ...(body.target === undefined ? {} : { target: body.target as ScheduleTargetRequest }),
  };
}

function parseSchedulePatch(value: unknown): SchedulePatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'A schedule update patch is required');
  }
  return value as SchedulePatch;
}

function actorSessionId(body: Record<string, unknown>): string | undefined {
  const value = body.actorSessionId;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new HttpError(400, 'A valid actor session id is required');
  }
  return value;
}

function optionalStringOrNull(value: unknown, name: string): string | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  return value;
}

function publicAgentEvent(event: AgentEvent): unknown {
  if (event.type === 'error') {
    return { type: 'error', error: { message: 'The turn failed' } };
  }
  if (event.type === 'assistant.message') {
    return { ...event, message: safePublicMessages([event.message])[0] };
  }
  if (event.type === 'turn.end' && 'history' in event) {
    const { history, ...rest } = event;
    const parsed = MessageSchema.array().safeParse(history);
    return parsed.success ? { ...rest, history: safePublicMessages(parsed.data) } : rest;
  }
  return event;
}

function permissionProjection(
  handle: SessionHandle,
  key: string,
  failedPermissions: Set<string>,
): DshPermissionProjection {
  return failedPermissions.has(key) ? { status: 'invalid', preset: null } : projectDshPermissions(handle.events);
}

function withPermissionLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = (locks.get(key) ?? Promise.resolve()).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  locks.set(key, settled);
  void settled.then(() => { if (locks.get(key) === settled) locks.delete(key); });
  return result;
}

function waitForDrain(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', complete);
      response.off('close', complete);
      response.off('error', fail);
    };
    const complete = () => { cleanup(); resolve(); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    response.once('drain', complete);
    response.once('close', complete);
    response.once('error', fail);
    if (response.destroyed) complete();
  });
}

async function getSession(
  options: WebHostOptions,
  sessions: Map<string, CachedSession>,
  running: Map<string, RunningTurn>,
  workspace: Workspace,
  handle: SessionHandle,
  key: string,
  permissions: DshPermissionSnapshot,
  runtime: ResolvedSessionRuntime | undefined,
): Promise<WebSession> {
  const modelKey = runtime === undefined ? '' : JSON.stringify(runtime.modelBinding);
  const runtimeKey = runtime?.revision;
  const shared = options.liveSessions?.get(key);
  if (shared !== undefined && shared.preset === permissions.preset
    && shared.modelKey === modelKey && shared.runtimeKey === runtimeKey) {
    return shared.session as WebSession;
  }
  let cached = sessions.get(key);
  if (cached && cached.preset === permissions.preset && cached.modelKey === modelKey && cached.runtimeKey === runtimeKey) {
    sessions.delete(key);
    sessions.set(key, cached);
    return cached.pending;
  }
  let pending: Promise<WebSession>;
  if (runtime === undefined) {
    if (!options.createSession) throw new HttpError(500, 'Session composition is unavailable');
    pending = Promise.resolve(options.createSession(workspace, handle, permissions));
  } else {
    if (!options.createRuntimeSession) throw new HttpError(500, 'Runtime session composition is unavailable');
    pending = Promise.resolve(options.createRuntimeSession(workspace, handle, permissions, runtime));
  }
  pending = pending.then((session) => {
    options.liveSessions?.set(key, {
      session,
      preset: permissions.preset,
      modelKey,
      ...(runtimeKey === undefined ? {} : { runtimeKey }),
    });
    return session;
  });
  cached = { preset: permissions.preset, modelKey, ...(runtimeKey === undefined ? {} : { runtimeKey }), pending };
  sessions.set(key, cached);
  const current = cached;
  void pending.catch(() => { if (sessions.get(key) === current) sessions.delete(key); });
  while (sessions.size > MAX_CACHED_WEB_SESSIONS) {
    let evicted = false;
    for (const candidate of sessions.keys()) {
      if (candidate === key || running.has(candidate)) continue;
      sessions.delete(candidate);
      evicted = true;
      break;
    }
    if (!evicted) break;
  }
  return pending;
}

function agentSummary(runtime: ResolvedSessionRuntime): AgentSummary {
  return {
    id: runtime.agent.id,
    name: runtime.agent.name,
    description: runtime.agent.description,
    role: runtime.agent.role,
    usage: runtime.agent.usage,
    profile: runtime.agent.profile,
    builtIn: runtime.agent.sourcePath.startsWith('builtin:'),
    valid: true,
    warnings: [],
  };
}

function resolvedModelSummary(runtime: ResolvedSessionRuntime): Record<string, unknown> | null {
  const model = runtime.modelDescriptor;
  if (!model) return null;
  return {
    provider: model.provider,
    model: model.id,
    name: model.name,
    ...(runtime.reasoningEffort === undefined ? {} : { reasoningEffort: runtime.reasoningEffort }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    capabilities: model.capabilities,
  };
}

function modeRuntimeOverride(handle: SessionHandle): {
  id: string;
  tools: '*' | readonly string[];
  skills: '*' | readonly string[];
} | undefined {
  const mode = projectModeSelection(handle.events);
  return mode.status === 'selected'
    ? { id: mode.selection.mode, tools: mode.selection.tools, skills: mode.selection.skills }
    : undefined;
}

async function describeSelection(
  options: WebHostOptions,
  workspace: Workspace,
  handle: SessionHandle,
): Promise<{
  agent: AgentSummary | null;
  model: ModelBinding | null;
  resolvedModel: Record<string, unknown> | null;
  agentSkills: Array<{ name: string; description: string }>;
  agentError: string | null;
  agentWarnings: string[];
}> {
  if (!options.runtime) {
    return { agent: null, model: null, resolvedModel: null, agentSkills: [], agentError: null, agentWarnings: [] };
  }
  const agent = projectAgentSelection(handle.events);
  const binding = projectModelSelection(handle.events);
  const model = binding.status === 'selected' ? binding.binding : null;
  if (agent.status !== 'selected') {
    return {
      agent: null,
      model,
      resolvedModel: null,
      agentSkills: [],
      agentError: agent.status === 'invalid'
        ? 'The session agent selection is invalid; select an agent again.'
        : 'An agent must be selected before this session can run.',
      agentWarnings: [],
    };
  }
  if (binding.status !== 'selected') {
    return {
      agent: null,
      model: null,
      resolvedModel: null,
      agentSkills: [],
      agentError: binding.status === 'invalid'
        ? 'The session model binding is invalid; select a model again.'
        : 'A model binding must be selected before this session can run.',
      agentWarnings: [],
    };
  }
  try {
    const runtime = await options.runtime.resolve({
      cwd: handle.header.cwd ?? workspace.path,
      agentId: agent.agent,
      binding: binding.binding,
      isRoot: true,
      ...(modeRuntimeOverride(handle) === undefined ? {} : { mode: modeRuntimeOverride(handle) }),
    });
    return {
      agent: agentSummary(runtime),
      model,
      resolvedModel: resolvedModelSummary(runtime),
      agentSkills: runtime.skills.map((skill) => ({ name: skill.name, description: skill.description })),
      agentError: null,
      agentWarnings: runtime.warnings,
    };
  } catch (error) {
    return {
      agent: null,
      model,
      resolvedModel: null,
      agentSkills: [],
      agentError: error instanceof Error ? error.message : 'The session agent is unavailable.',
      agentWarnings: [],
    };
  }
}

async function openSession(store: WebHostOptions['store'], workspace: Workspace, sessionId: string): Promise<SessionHandle> {
  try {
    return await store.open(workspace.path, sessionId);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT') || (error instanceof Error && error.message === 'session identity mismatch')) {
      throw new HttpError(404, 'Session not found');
    }
    throw error;
  }
}

/**
 * Clone a session's transcript and configuration into a new root session.
 *
 * The fork is unlinked from the source's subagent tree: it is a new root
 * conversation with copied events, not a child. The user-visible title keeps a
 * `(fork)` suffix so two identical origins stay distinguishable in the list.
 */
async function forkSession(
  store: WebHostOptions['store'],
  source: SessionHandle,
  workspace: Workspace,
): Promise<SessionHandle> {
  const sourceTitle = foldSessionTitle(source.events);
  const events = source.events
    .filter((event) => event.type !== SESSION_TITLE_EVENT
      && event.type !== SESSION_PIN_EVENT
      && event.type !== SESSION_FORK_EVENT)
    .map(({ type, data, ts }) => ({ type, data, ts }));
  if (sourceTitle !== undefined) {
    const title = truncateTitleUtf8(sourceTitle.title, DEFAULT_SESSION_TITLE_LIMITS.maxTitleBytes - 7) + ' (fork)';
    events.push({
      type: SESSION_TITLE_EVENT,
      ts: Date.now(),
      data: { title, messageSeqs: [], source: { kind: 'user' } },
    });
  }
  events.push({ ...createSessionForkEvent(source.id), ts: Date.now() });
  return store.create({ workspace: workspace.path, cwd: source.header.cwd, events });
}

/** Case-insensitive LIKE-style filter used by the session reference menu. */
function likeMatches(values: readonly string[], query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  return terms.every((term) => values.some((value) => value.toLowerCase().includes(term)));
}

function summarize(handle: SessionHandle): SessionSummary {  const agent = projectAgentSelection(handle.events);
  const mode = projectModeSelection(handle.events);
  const title = foldSessionTitle(handle.events);
  return {
    id: handle.id,
    ...(agent.status === 'selected' ? { agent: agent.agent } : {}),
    ...(mode.status === 'selected' ? { mode: mode.selection.mode } : {}),
    ...(handle.header.agentId === undefined ? {} : { agentId: handle.header.agentId }),
    ...(handle.header.parentSessionId === undefined ? {} : { parentSessionId: handle.header.parentSessionId }),
    ...(handle.header.depth === undefined ? {} : { depth: handle.header.depth }),
    ...(handle.header.description === undefined ? {} : { description: handle.header.description }),
    ...(title === undefined ? {} : { title: title.title, titleSource: title.source }),
    ...(foldSessionPinned(handle.events) ? { pinned: true } : {}),
    blank: !hasHumanMessage(handle.events),
    workspace: handle.header.workspace,
    cwd: handle.header.cwd,
    createdAt: handle.header.createdAt,
    updatedAt: lastActivityTime(handle.events, handle.header.createdAt),
    eventCount: handle.events.length,
  };
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > maxBytes) throw new HttpError(413, 'Request body is too large');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const iterator = request.iterator({ destroyOnReturn: false });
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    const buffer = Buffer.from(next.value as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      void drainRequest(iterator);
      throw new HttpError(413, 'Request body is too large');
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON object');
  }
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function parseSendAttachments(value: unknown): SendAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw new HttpError(400, `Up to ${MAX_ATTACHMENTS} attachments are allowed`);
  }
  return value.map((item): SendAttachment => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new HttpError(400, 'Invalid attachment');
    }
    const attachment = item as Record<string, unknown>;
    if (typeof attachment.name !== 'string' || attachment.name.trim() === ''
      || attachment.name.length > MAX_ATTACHMENT_NAME || /[\u0000-\u001f]/.test(attachment.name)) {
      throw new HttpError(400, 'Attachment names must be valid file names');
    }
    if (attachment.kind === 'image') {
      if (typeof attachment.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(attachment.mediaType)) {
        throw new HttpError(400, 'Only PNG, JPEG, WebP, and GIF images are supported');
      }
      if (typeof attachment.data !== 'string' || attachment.data.length === 0
        || attachment.data.length > MAX_IMAGE_DATA_BYTES * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.data)) {
        throw new HttpError(400, 'Invalid image attachment');
      }
      return { kind: 'image', name: attachment.name, mediaType: attachment.mediaType, data: attachment.data };
    }
    if (attachment.kind === 'text') {
      if (typeof attachment.text !== 'string'
        || Buffer.byteLength(attachment.text, 'utf8') > MAX_TEXT_ATTACHMENT_BYTES) {
        throw new HttpError(400, 'Text attachments are limited to 256 KB');
      }
      return {
        kind: 'text',
        name: attachment.name,
        mediaType: typeof attachment.mediaType === 'string' && attachment.mediaType !== ''
          ? attachment.mediaType
          : 'text/plain',
        text: attachment.text,
      };
    }
    throw new HttpError(400, 'Unsupported attachment kind');
  });
}

function composeUserContent(text: string, attachments: readonly SendAttachment[]): ContentPart[] {
  const content: ContentPart[] = [];
  if (text.trim() !== '') content.push({ type: 'text', text });
  for (const attachment of attachments) {
    if (attachment.kind === 'text') {
      content.push({
        type: 'text',
        text: `[Attached file: ${attachment.name} (${attachment.mediaType})]\n${attachment.text ?? ''}\n[End of attached file: ${attachment.name}]`,
      });
    }
  }
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      content.push({ type: 'image', mediaType: attachment.mediaType, data: attachment.data! });
    }
  }
  return content;
}

async function drainRequest(iterator: AsyncIterator<Buffer | string | Uint8Array>): Promise<void> {
  try {
    while (!(await iterator.next()).done) {}
  } catch {
    return;
  }
}

const AUTH_COOKIE = 'omniagent_session';
const AUTH_SESSION_MS = 12 * 60 * 60 * 1000;

function secureEqual(left: string, right: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

function sessionToken(request: IncomingMessage): string | undefined {
  const matches = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${AUTH_COOKIE}=`));
  if (matches.length !== 1) return undefined;
  const token = matches[0]!.slice(AUTH_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

function revokeAuthSession(sessions: Map<string, { expires: number; responses: Set<ServerResponse> }>, token: string): void {
  const session = sessions.get(token);
  sessions.delete(token);
  if (session) for (const response of session.responses) response.destroy();
}

function validateOrigin(request: IncomingMessage, bindHost: string, authEnabled: boolean): void {
  const host = request.headers.host;
  let url: URL;
  try {
    url = new URL(`http://${host ?? ''}`);
    if (!host || /[\s\/@?#\\,]/.test(host) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      Number(url.port || 80) !== request.socket.localPort) throw new Error();
  } catch {
    throw new HttpError(403, 'Invalid Host');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const localAddress = (request.socket.localAddress ?? '').replace(/^::ffff:/, '').toLowerCase();
  const wildcard = bindHost === '0.0.0.0' || bindHost === '::';
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(hostname);
  const boundLoopback = ['127.0.0.1', '::1', 'localhost'].includes(bindHost.toLowerCase());
  const validHost = wildcard
    ? ((isIP(hostname) !== 0 && hostname === localAddress) || (hostname === 'localhost' && ['127.0.0.1', '::1'].includes(localAddress)))
    : hostname === bindHost.toLowerCase().replace(/^\[|\]$/g, '') || (boundLoopback && loopback);
  if (!validHost) throw new HttpError(403, 'Invalid Host');
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== url.origin) throw new HttpError(403, 'Invalid Origin');
  if (authEnabled && !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '') && origin === undefined) {
    throw new HttpError(403, 'Origin required');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Invalid Origin');
}

function decodePart(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new HttpError(400, 'Invalid URL encoding'); }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

function isPathError(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].some((code) => isErrorCode(error, code));
}
