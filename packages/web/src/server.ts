import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { projectMessages } from '@omniagent/core';
import type {
  AgentEvent,
  AgentUsage,
  ModelBinding,
  ModelCapabilities,
  ResolvedSessionRuntime,
  RuntimeResolver,
  SessionHandle,
  SessionStore,
  SessionSummary,
} from '@omniagent/core';
import {
  createAgentSelectionEvent,
  createAgentSwitch,
  createModelSelectionEvent,
  createModelSwitch,
  defaultModelBinding,
  ModelBindingSchema,
  projectAgentSelection,
  projectModelSelection,
  usageAllowsRoot,
} from '@omniagent/core';
import type { ReasoningEffort } from '@omniagent/core';
import { MessageSchema } from '../../core/src/domain/message';
import {
  createDshPresetSwitch, createInitialDshPermissionEvent, isDshPermissionPreset,
  projectDshPermissions, resolveDshDefaultPreset, snapshotDshPermissions,
} from '../../core/src/permissions/dsh-permissions';
import type { DshPermissionProjection, DshPermissionSnapshot } from '../../core/src/permissions/dsh-permissions';
import { safePublicMessages } from '../../core/src/session/projection';
import { projectTodos } from '../../core/src/session/todo';
import { createPlanModeEvent, projectPlanMode } from '../../core/src/session/plan';
import { WEB_CLIENT_HTML } from './client';
import type { ApprovalBroker, ApprovalTurn } from './approval';
import { InvalidPermissionSettings } from './permissions';
import type { PermissionSettings } from './permissions';
import { exportSession } from './session-export';
import { projectTraceEvents } from './trace-projection';
import { projectTrajectory } from './trajectory';
import type { Workspace, WorkspaceRegistry } from './workspaces';

export interface WebSession {
  id: string;
  send(input: string): AsyncGenerator<AgentEvent>;
  interrupt(): void;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  role: string;
  usage: AgentUsage;
  profile: string;
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
  workspaces: Pick<WorkspaceRegistry, 'list' | 'get' | 'add' | 'remove' | 'touch'>;
  store: Pick<SessionStore, 'list' | 'create' | 'open'>;
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
  readAudit?: (workspace: Workspace, sessionId: string) => Promise<unknown[]>;
  permissionSettings?: Pick<PermissionSettings, 'read' | 'update' | 'snapshot'>;
  approvalBroker?: ApprovalBroker;
  /** Credential-free model metadata for the configured catalog. */
  modelCatalog?: () => ModelSummary[] | Promise<ModelSummary[]>;
}

export interface WebHost {
  server: Server;
  address(): string | undefined;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CACHED_WEB_SESSIONS = 64;
const DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface RunningTurn {
  session?: WebSession;
  approval?: ApprovalTurn;
  cancelled: boolean;
}

interface CachedSession {
  preset: DshPermissionSnapshot['preset'];
  modelKey: string;
  runtimeKey?: string;
  pending: Promise<WebSession>;
}

export function createWebHost(options: WebHostOptions): WebHost {
  const sessions = new Map<string, CachedSession>();
  const running = new Map<string, RunningTurn>();
  const creating = new Map<string, number>();
  const removing = new Set<string>();
  const permissionLocks = new Map<string, Promise<void>>();
  const failedPermissions = new Set<string>();
  let permissionDefaultUpdates = 0;
  const server = createServer((request, response) => {
    // A client can reset the connection while a response write is in flight;
    // that surfaces as EPIPE/ECONNRESET on the socket, not on the response.
    response.socket?.on('error', () => undefined);
    void route(request, response, options, sessions, running, creating, removing, permissionLocks, failedPermissions,
      () => permissionDefaultUpdates, (value) => { permissionDefaultUpdates = value; }).catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.destroyed && !response.writableEnded) response.end();
        return;
      }
      if (response.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      const message = status === 500 ? 'Internal server error' : (error as Error).message;
      json(response, status, { error: message });
    });
  });
  return {
    server,
    address: () => {
      const address = server.address();
      return typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : undefined;
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

export async function startWebHost(options: WebHostOptions, port = 0): Promise<WebHost> {
  const host = createWebHost(options);
  await new Promise<void>((resolve, reject) => {
    host.server.once('error', reject);
    host.server.listen(port, '127.0.0.1', () => {
      host.server.off('error', reject);
      resolve();
    });
  });
  return host;
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
  getPermissionDefaultUpdates: () => number,
  setPermissionDefaultUpdates: (value: number) => void,
): Promise<void> {
  validateOrigin(request);
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': DOCUMENT_CSP,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    });
    response.end(WEB_CLIENT_HTML);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });
  if (request.method === 'GET' && url.pathname === '/api/models') {
    return json(response, 200, { models: await options.modelCatalog?.() ?? [] });
  }
  if (request.method === 'GET' && url.pathname === '/api/agents') {
    return json(response, 200, { agents: await options.listAgents?.() ?? [] });
  }
  if (request.method === 'GET' && url.pathname === '/api/roles') {
    return json(response, 200, { roles: await options.listRoles?.() ?? [] });
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
  if (request.method === 'DELETE' && parts.length === 3) {
    if (removing.has(workspace.id) || creating.has(workspace.id) ||
        [...running.keys()].some((key) => key.startsWith(workspacePrefix)) ||
        [...permissionLocks.keys()].some((key) => key.startsWith(workspacePrefix))) {
      throw new HttpError(409, 'Workspace has an active turn or session creation');
    }
    removing.add(workspace.id);
    try {
      const removed = await options.workspaces.remove(workspace.id);
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
      sessions: summaries.sort((left, right) => right.updatedAt - left.updatedAt),
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
      if (options.runtime) {
        if (Object.keys(body).some((name) => name !== 'agent' && name !== 'model')) {
          throw new HttpError(400, 'Invalid session configuration');
        }
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
    return json(response, 200, {
      header: handle.header,
      messages: safePublicMessages(projectMessages(handle.events)),
      permission: { preset: permissionProjection(handle, key, failedPermissions).preset },
      ...selection,
      plan: projectPlanMode(handle.events),
      todos: projectTodos(handle.events),
      events: projectTraceEvents(handle.events),
      trajectory: projectTrajectory(handle.events),
      audit,
    });
  }
  if (request.method === 'GET' && parts.length === 6 && parts[5] === 'messages') {
    const handle = await openSession(options.store, workspace, sessionId);
    return json(response, 200, { messages: safePublicMessages(projectMessages(handle.events)) });
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
    const body = await readJson(request);
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      throw new HttpError(400, 'Message text is required');
    }
    if (running.has(key)) throw new HttpError(409, 'Session already has an active turn');
    if (removing.has(workspace.id)) throw new HttpError(409, 'Workspace is being unregistered');
    const turn: RunningTurn = { cancelled: false };
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
      turn.approval = options.approvalBroker?.start(workspace.path, sessionId);
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-content-type-options': 'nosniff',
        'connection': 'keep-alive',
      });
      response.flushHeaders();
      const source = session.send(body.text);
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

async function describeSelection(
  options: WebHostOptions,
  workspace: Workspace,
  handle: SessionHandle,
): Promise<{
  agent: AgentSummary | null;
  model: ModelBinding | null;
  resolvedModel: Record<string, unknown> | null;
  agentError: string | null;
  agentWarnings: string[];
}> {
  if (!options.runtime) {
    return { agent: null, model: null, resolvedModel: null, agentError: null, agentWarnings: [] };
  }
  const agent = projectAgentSelection(handle.events);
  const binding = projectModelSelection(handle.events);
  const model = binding.status === 'selected' ? binding.binding : null;
  if (agent.status !== 'selected') {
    return {
      agent: null,
      model,
      resolvedModel: null,
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
    });
    return {
      agent: agentSummary(runtime),
      model,
      resolvedModel: resolvedModelSummary(runtime),
      agentError: null,
      agentWarnings: runtime.warnings,
    };
  } catch (error) {
    return {
      agent: null,
      model,
      resolvedModel: null,
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

function summarize(handle: SessionHandle): SessionSummary {
  const agent = projectAgentSelection(handle.events);
  return {
    id: handle.id,
    ...(agent.status === 'selected' ? { agent: agent.agent } : {}),
    ...(handle.header.agentId === undefined ? {} : { agentId: handle.header.agentId }),
    ...(handle.header.parentSessionId === undefined ? {} : { parentSessionId: handle.header.parentSessionId }),
    ...(handle.header.depth === undefined ? {} : { depth: handle.header.depth }),
    ...(handle.header.description === undefined ? {} : { description: handle.header.description }),
    workspace: handle.header.workspace,
    cwd: handle.header.cwd,
    createdAt: handle.header.createdAt,
    updatedAt: handle.events.at(-1)?.ts ?? handle.header.createdAt,
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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const iterator = request.iterator({ destroyOnReturn: false });
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    const buffer = Buffer.from(next.value as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
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

async function drainRequest(iterator: AsyncIterator<Buffer | string | Uint8Array>): Promise<void> {
  try {
    while (!(await iterator.next()).done) {}
  } catch {
    return;
  }
}

function validateOrigin(request: IncomingMessage): void {
  const host = request.headers.host;
  if (!host || !isLocalUrl(`http://${host}`, request.socket.localPort)) throw new HttpError(403, 'Invalid Host');
  const origin = request.headers.origin;
  if (origin && (!isLocalUrl(origin, request.socket.localPort) ||
      new URL(origin).origin !== new URL(`http://${host}`).origin)) {
    throw new HttpError(403, 'Invalid Origin');
  }
}

function isLocalUrl(value: string, port: number | undefined): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash &&
      Number(url.port || 80) === port;
  } catch {
    return false;
  }
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
