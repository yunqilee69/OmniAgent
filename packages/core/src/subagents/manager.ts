import { randomUUID } from 'node:crypto';
import { createInitialDshPermissionEvent, projectDshPermissions, snapshotDshPermissions } from '../permissions/dsh-permissions';
import { projectMessages } from '../session/projection';
import type { SessionEvent } from '../session/types';
import { assistantText } from '../domain/message';
import type { AgentEvent } from '../protocol/events';
import type { AuditEntry } from '../store/audit';
import type { ModelClient } from '../providers/types';
import type { SessionOptions } from '../session';
import { Session } from '../session';
import { createAgentSelectionEvent, projectAgentSelection } from '../session/agent-selection';
import { createModelSelectionEvent as createBindingEvent, defaultModelBinding, ModelBindingSchema, projectModelSelection as projectBinding } from '../session/model-binding';
import type { ModelBinding } from '../session/model-binding';
import type { ResolvedSessionRuntime, RuntimeResolver } from '../session/runtime';
import { resolveInsidePhysical } from '../tools/paths';
import type { SessionHandle, SessionStore } from '../session/store';
import {
  SUBAGENT_END_EVENT,
  SUBAGENT_NOTICE_EVENT,
  SUBAGENT_START_EVENT,
} from '../domain/subagent';
import type {
  SubagentInfo,
  SubagentNotice,
  SubagentOutcome,
  SubagentService,
  SubagentStartRequest,
  SubagentStartResult,
  SubagentStatus,
} from '../domain/subagent';

const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_ACTIVE = 8;
const MAX_RESULT_CHARS = 8_000;

export interface SubagentManagerOptions {
  store: SessionStore;
  /** Fallback for demo mode when the resolved role has no configured client. */
  createModel(): ModelClient;
  maxSteps?: number;
  retainContextTokens?: number;
  approve?: SessionOptions['approve'];
  audit?: (entry: AuditEntry, workspace: string) => void | Promise<void>;
  maxDepth?: number;
  maxActive?: number;
  onBackgroundEvent?(sessionId: string, event: AgentEvent): void;
  /** Resolves configured agents, roles, skills, and tool profiles for children. */
  runtime: RuntimeResolver;
}

interface ManagedChild {
  info: SubagentInfo;
  handle: SessionHandle;
  session: Session;
  parent?: Session;
  parentHandle?: SessionHandle;
  status: SubagentStatus;
  agent: string;
  result?: string;
  queue: Promise<void>;
  started?: Promise<void>;
  resolveStarted?: () => void;
  settled?: Promise<void>;
  resolveSettled?: () => void;
}

function nonEmpty(value: unknown, name: string, max = 2_000): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  if (value.length > max) throw new Error(`${name} is too long`);
  return value.trim();
}

function clipResult(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= MAX_RESULT_CHARS ? trimmed : `${trimmed.slice(0, MAX_RESULT_CHARS)}\n…[truncated]`;
}

function turnOutcome(reason: string): Exclude<SubagentStatus, 'running'> {
  if (reason === 'interrupted') return 'interrupted';
  if (reason === 'error') return 'failed';
  return 'completed';
}

function lastTurnState(events: readonly { type: string; data: unknown }[]): Exclude<SubagentStatus, 'running'> {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'trace/turn.end') continue;
    const reason = typeof event.data === 'object' && event.data !== null
      ? (event.data as Record<string, unknown>).reason
      : undefined;
    return turnOutcome(typeof reason === 'string' ? reason : 'error');
  }
  return 'idle';
}

function lastAssistant(events: readonly { type: string; data: unknown }[]): string | undefined {
  const messages = projectMessages(events as readonly SessionEvent[]);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const text = assistantText(message).trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

export class SubagentManager implements SubagentService {
  private readonly children = new Map<string, ManagedChild>();
  private readonly live = new Map<string, Session>();
  private readonly maxDepth: number;
  private readonly maxActive: number;
  private activeRuns = 0;
  private reservedRuns = 0;
  private closing = false;

  constructor(private readonly options: SubagentManagerOptions) {
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
    if (!Number.isSafeInteger(this.maxDepth) || this.maxDepth < 0) throw new RangeError('maxDepth must be a non-negative integer');
    if (!Number.isSafeInteger(this.maxActive) || this.maxActive < 1) throw new RangeError('maxActive must be a positive integer');
  }

  canStart(parent: Session): boolean {
    return !this.closing && parent.depth < this.maxDepth && this.activeRuns + this.reservedRuns < this.maxActive
      && parent.sessionHandle !== undefined && parent.dshPermissions !== undefined;
  }

  async start(parent: Session, request: SubagentStartRequest): Promise<SubagentStartResult> {
    if (this.closing) throw new Error('Subagent runtime is shutting down');
    if (parent.depth >= this.maxDepth) throw new Error(`Subagent depth limit (${this.maxDepth}) reached`);
    if (this.activeRuns + this.reservedRuns >= this.maxActive) throw new Error(`Subagent capacity (${this.maxActive}) reached`);
    const parentHandle = parent.sessionHandle;
    const workspace = parent.workspace;
    if (!parentHandle || !workspace) throw new Error('Subagent delegation requires a persisted parent session');
    const permissions = parent.dshPermissions;
    if (!permissions) throw new Error('Subagent delegation requires an explicit permission preset');

    this.reservedRuns += 1;
    try {
      const description = nonEmpty(request.description, 'description', 200);
      const prompt = nonEmpty(request.prompt, 'prompt', 100_000);
      const cwd = request.cwd
        ? await resolveInsidePhysical(parent.cwd, request.cwd)
        : parent.cwd;
      const agentId = request.agent ?? parent.agent?.id ?? 'default';
      const binding = this.selectBinding(request);
      const runtime = await this.options.runtime.resolve({ cwd, agentId, binding, isRoot: false });

      const depth = parent.depth + 1;
      const handle = await this.options.store.create({
        workspace,
        cwd,
        parentSessionId: parent.id,
        depth,
        description,
      });
      await handle.append(createInitialDshPermissionEvent(permissions.preset));
      await handle.append(createAgentSelectionEvent(agentId));
      await handle.append(createBindingEvent(binding));

      const child = await this.createSession(handle, permissions, depth, parent, runtime);
      const info: SubagentInfo = {
        id: handle.id,
        parentId: parent.id,
        depth,
        description,
        agent: runtime.agent.id,
        status: 'running',
        createdAt: handle.header.createdAt,
        updatedAt: Date.now(),
      };
      const managed: ManagedChild = {
        info,
        handle,
        session: child,
        parent,
        parentHandle,
        status: 'running',
        agent: runtime.agent.id,
        queue: Promise.resolve(),
      };
      this.children.set(handle.id, managed);
      this.live.set(handle.id, child);
      this.live.set(parent.id, parent);
      try {
        await parentHandle.append({ type: SUBAGENT_START_EVENT, data: { ...info } });
      } catch (error) {
        this.children.delete(handle.id);
        this.live.delete(handle.id);
        throw error;
      }
      this.reservedRuns -= 1;
      this.launch(managed, prompt);
      return { id: handle.id, status: 'running' };
    } catch (error) {
      this.reservedRuns -= 1;
      throw error;
    }
  }

  async send(caller: Session, targetId: string, message: string): Promise<{ messageId: string }> {
    const text = nonEmpty(message, 'message', 100_000);
    await this.assertMember(caller, targetId);
    let child = this.children.get(targetId);
    if (child === undefined) {
      if (await this.isAncestor(targetId, caller.id)) {
        const live = this.live.get(targetId);
        if (live === undefined) throw new Error(`Agent ${targetId} is not live in this process`);
        const messageId = randomUUID();
        await live.deliverExternalMessage(`${text}\n\n[message from agent ${caller.id}; message ${messageId}]`, 'agent');
        return { messageId };
      }
      child = await this.ensureChild(targetId);
    }
    const messageId = randomUUID();
    if (child.status === 'running') {
      // Wait until a just-launched turn owns its controller; otherwise the
      // message could start a competing background turn.
      await child.started?.catch(() => undefined);
      if (child.status === 'running' && child.session.activeTurn) {
        await child.session.deliverExternalMessage(`${text}\n\n[message from agent ${caller.id}; message ${messageId}]`, 'agent');
      } else if (child.status === 'running') {
        throw new Error(`Agent ${targetId} is not ready to receive a message`);
      } else {
        this.launch(child, text, caller.id, messageId);
      }
    } else {
      this.launch(child, text, caller.id, messageId);
    }
    return { messageId };
  }

  async list(caller: Session): Promise<SubagentInfo[]> {
    const summaries = await this.options.store.list();
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    const callerRoot = this.rootOf(caller.id, byId) ?? caller.id;
    const result: SubagentInfo[] = [];
    for (const summary of summaries) {
      if (summary.id === caller.id) continue;
      if (summary.workspace !== caller.workspace) continue;
      if ((this.rootOf(summary.id, byId) ?? summary.id) !== callerRoot) continue;
      const live = this.children.get(summary.id);
      if (live) {
        result.push({ ...live.info, status: live.status, updatedAt: Date.now() });
        continue;
      }
      result.push(await this.storedInfo(summary, summary.workspace));
    }
    return result.sort((left, right) => left.depth - right.depth || left.createdAt - right.createdAt);
  }

  async wait(caller: Session, targetId: string, timeoutMs: number, signal: AbortSignal): Promise<SubagentOutcome> {
    await this.assertMember(caller, targetId);
    const child = this.children.get(targetId);
    if (child) {
      if (child.status !== 'running' || !child.settled) {
        return { id: targetId, status: child.status, ...(child.result === undefined ? {} : { result: child.result }) };
      }
      const timeout = new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
      });
      const aborted = new Promise<'aborted'>((resolve) => {
        if (signal.aborted) return resolve('aborted');
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
      const outcome = await Promise.race([child.settled.then(() => 'settled' as const), timeout, aborted]);
      if (outcome === 'aborted') throw signal.reason ?? new Error('Wait aborted');
      if (outcome === 'timeout') return { id: targetId, status: 'running' };
      return { id: targetId, status: child.status, ...(child.result === undefined ? {} : { result: child.result }) };
    }
    const handle = await this.options.store.open(caller.workspace!, targetId);
    const status = lastTurnState(handle.events);
    const result = clipResult(lastAssistant(handle.events));
    return { id: targetId, status, ...(result === undefined ? {} : { result }) };
  }

  async interrupt(caller: Session, targetId: string): Promise<boolean> {
    if (targetId === caller.id) throw new Error('An agent cannot interrupt itself');
    await this.assertDescendant(caller, targetId);
    const child = this.children.get(targetId);
    if (!child) return false;
    if (child.status !== 'running') return false;
    return this.requestInterrupt(child);
  }

  private async requestInterrupt(child: ManagedChild): Promise<boolean> {
    // A launch is queued as a microtask and its first durable append can take
    // time. `started` resolves at the first yielded turn event, when the
    // Session's abort controller exists, so an immediate interrupt is safe.
    await child.started?.catch(() => undefined);
    if (child.status !== 'running') return false;
    if (!child.session.activeTurn) {
      for (let attempt = 0; attempt < 20 && child.status === 'running' && !child.session.activeTurn; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (child.status !== 'running') return false;
    if (!child.session.activeTurn) return false;
    child.session.interrupt();
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    const running = [...this.children.values()].filter((child) => child.status === 'running');
    for (const child of running) await this.requestInterrupt(child);
    await Promise.all(running.map((child) => child.settled?.catch(() => undefined)).filter(Boolean));
  }

  private selectBinding(request: SubagentStartRequest): ModelBinding {
    if (request.role !== undefined && (request.provider !== undefined || request.model !== undefined)) {
      throw new Error('role cannot be combined with provider/model');
    }
    if (request.provider !== undefined || request.model !== undefined) {
      if (!request.provider || !request.model) throw new Error('provider and model must be supplied together');
      return ModelBindingSchema.parse({
        version: 2,
        kind: 'model',
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      });
    }
    if (request.reasoningEffort !== undefined) {
      throw new Error('reasoning_effort requires an explicit provider/model for a configured agent');
    }
    if (request.role !== undefined) {
      return ModelBindingSchema.parse({ version: 2, kind: 'role', role: request.role });
    }
    return defaultModelBinding();
  }

  private async createSession(
    handle: SessionHandle,
    permissions: NonNullable<Session['dshPermissions']>,
    depth: number,
    parent: Session | undefined,
    runtime: ResolvedSessionRuntime,
  ): Promise<Session> {
    const model = runtime.model ?? this.options.createModel();
    let session!: Session;
    const creator = parent?.id ?? handle.header.parentSessionId ?? 'unknown';
    const identity = `\n\nYou are a subagent delegated by agent ${JSON.stringify(creator)}. `
      + `Your agent id is ${JSON.stringify(handle.id)}. Work independently on the delegated task, `
      + 'report the result directly, and do not assume the parent can see your files or conversation.';
    const system = `${runtime.system}${identity}`;
    session = new Session({
      cwd: handle.header.cwd,
      workspace: handle.header.workspace,
      model,
      ...(runtime.modelId === undefined ? {} : { modelId: runtime.modelId }),
      agent: runtime.sessionAgent,
      modelCapabilities: runtime.capabilities,
      system,
      dshPermissions: snapshotDshPermissions({ status: 'ready', preset: permissions.preset }),
      maxSteps: this.options.maxSteps,
      ...(runtime.contextWindowTokens === undefined ? {} : { contextWindowTokens: runtime.contextWindowTokens }),
      ...(this.options.retainContextTokens === undefined ? {} : { retainContextTokens: this.options.retainContextTokens }),
      ...(this.options.approve === undefined ? {} : { approve: this.options.approve }),
      ...(this.options.audit === undefined
        ? {}
        : { audit: (entry: AuditEntry) => this.options.audit!(entry, handle.header.workspace) }),
      session: handle,
      depth,
      subagents: this,
      onBackgroundEvent: (event) => {
        this.options.onBackgroundEvent?.(handle.id, event);
        const managed = this.children.get(handle.id);
        if (managed && event.type === 'turn.start' && managed.status !== 'running') {
          managed.status = 'running';
          managed.info.status = 'running';
          managed.info.updatedAt = Date.now();
          managed.settled = new Promise<void>((resolve) => { managed.resolveSettled = resolve; });
          this.activeRuns += 1;
        }
        if (event.type === 'turn.end') void this.settleBackground(session, event.reason);
      },
    });
    return session;
  }

  private launch(child: ManagedChild, prompt: string, from?: string, messageId?: string): void {
    child.status = 'running';
    child.info.status = 'running';
    child.info.updatedAt = Date.now();
    child.started = new Promise<void>((resolve) => { child.resolveStarted = resolve; });
    child.settled = new Promise<void>((resolve) => { child.resolveSettled = resolve; });
    this.activeRuns += 1;
    const text = from === undefined || messageId === undefined
      ? prompt
      : `${prompt}\n\n[message from agent ${from}; message ${messageId}]`;
    const task = async (): Promise<void> => {
      let status: Exclude<SubagentStatus, 'running'> = 'completed';
      let result: string | undefined;
      const markStarted = () => {
        child.resolveStarted?.();
        child.resolveStarted = undefined;
        child.started = undefined;
      };
      try {
        for await (const event of child.session.send(text)) {
          markStarted();
          if (event.type === 'assistant.message') {
            const text = assistantText(event.message).trim();
            if (text.length > 0) result = text;
          } else if (event.type === 'turn.end') {
            status = turnOutcome(event.reason);
          }
        }
      } catch {
        // runTurn converts user interruption into a normal turn.end event.
        status = 'failed';
      } finally {
        markStarted();
        this.activeRuns -= 1;
        this.finishTurn(child, status, result);
      }
    };
    void child.queue.then(task, task).catch(() => undefined);
  }

  private finishTurn(child: ManagedChild, status: Exclude<SubagentStatus, 'running'>, result: string | undefined): void {
    child.status = status;
    child.info.status = status;
    child.info.updatedAt = Date.now();
    const clipped = clipResult(result);
    if (clipped === undefined) delete child.result;
    else child.result = clipped;
    if (clipped === undefined) delete child.info.result;
    else child.info.result = clipped;
    void this.publishSettlement(child, status, clipped);
    child.resolveSettled?.();
    child.resolveSettled = undefined;
    child.settled = undefined;
  }

  private async settleBackground(session: Session, reason: string): Promise<void> {
    const child = this.children.get(session.id);
    if (!child) return;
    const status = turnOutcome(reason);
    const handle = session.sessionHandle;
    if (!handle) return;
    if (child.status === 'running') this.activeRuns = Math.max(0, this.activeRuns - 1);
    const result = clipResult(lastAssistant(handle.events));
    this.finishTurn(child, status, result);
  }

  private async publishSettlement(
    child: ManagedChild,
    status: Exclude<SubagentStatus, 'running'>,
    result: string | undefined,
  ): Promise<void> {
    const notice: SubagentNotice = {
      childId: child.info.id,
      ...(child.info.description === undefined ? {} : { description: child.info.description }),
      status,
      ...(result === undefined ? {} : { result }),
    };
    try {
      const parentHandle = child.parent?.sessionHandle ?? child.parentHandle;
      await parentHandle?.append({ type: SUBAGENT_END_EVENT, data: { ...notice, depth: child.info.depth } });
      if (child.parent) {
        await child.parent.receiveSubagentNotice(notice);
      } else {
        // The creator is not live in this process; persist the notice so the
        // resumed parent sees it on its next turn.
        await parentHandle?.append({ type: SUBAGENT_NOTICE_EVENT, data: { ...notice } });
      }
    } catch {
      // The child result is still available through wait_agent/list_agents.
    }
  }

  private async ensureChild(targetId: string): Promise<ManagedChild> {
    const existing = this.children.get(targetId);
    if (existing) return existing;
    const summaries = await this.options.store.list();
    const summary = summaries.find((item) => item.id === targetId);
    if (!summary) throw new Error(`Unknown agent ${targetId}`);
    const handle = await this.options.store.open(summary.workspace, targetId);
    if (!handle.header.parentSessionId) throw new Error(`Agent ${targetId} is not a subagent`);
    const permissions = projectDshPermissions(handle.events);
    if (permissions.status !== 'ready') throw new Error(`Agent ${targetId} has no valid permission preset`);
    const agentProjection = projectAgentSelection(handle.events);
    if (agentProjection.status !== 'selected') throw new Error(`Agent ${targetId} has no valid agent selection`);
    const bindingProjection = projectBinding(handle.events);
    if (bindingProjection.status !== 'selected') throw new Error(`Agent ${targetId} has no valid model selection`);
    const runtime = await this.options.runtime.resolve({
      cwd: handle.header.cwd,
      agentId: agentProjection.agent,
      binding: bindingProjection.binding,
      isRoot: false,
    });
    const parent = this.live.get(handle.header.parentSessionId);
    let parentHandle: SessionHandle | undefined;
    try {
      parentHandle = await this.options.store.open(summary.workspace, handle.header.parentSessionId);
    } catch {
      parentHandle = undefined;
    }
    const session = await this.createSession(
      handle,
      snapshotDshPermissions(permissions),
      handle.header.depth ?? summary.depth ?? 1,
      parent,
      runtime,
    );
    const status = lastTurnState(handle.events);
    const result = clipResult(lastAssistant(handle.events));
    const info: SubagentInfo = {
      id: handle.id,
      parentId: handle.header.parentSessionId,
      depth: handle.header.depth ?? summary.depth ?? 1,
      ...(handle.header.description === undefined ? {} : { description: handle.header.description }),
      agent: runtime.agent.id,
      status,
      createdAt: handle.header.createdAt,
      updatedAt: handle.events.at(-1)?.ts ?? handle.header.createdAt,
      ...(result === undefined ? {} : { result }),
    };
    const managed: ManagedChild = {
      info,
      handle,
      session,
      ...(parent === undefined ? {} : { parent }),
      ...(parentHandle === undefined ? {} : { parentHandle }),
      status,
      agent: runtime.agent.id,
      ...(result === undefined ? {} : { result }),
      queue: Promise.resolve(),
    };
    this.children.set(targetId, managed);
    this.live.set(targetId, session);
    return managed;
  }

  private async isAncestor(candidateId: string, descendantId: string): Promise<boolean> {
    const summaries = await this.options.store.list();
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    let current = byId.get(descendantId);
    const seen = new Set<string>();
    while (current?.parentSessionId) {
      if (current.parentSessionId === candidateId) return true;
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      current = byId.get(current.parentSessionId);
    }
    return false;
  }

  private async assertMember(caller: Session, targetId: string): Promise<void> {
    if (!targetId || targetId === caller.id) throw new Error('send_message requires another agent');
    const summaries = await this.options.store.list();
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    if (!byId.has(targetId)) throw new Error(`Unknown agent ${targetId}`);
    const callerRoot = this.rootOf(caller.id, byId) ?? caller.id;
    const targetRoot = this.rootOf(targetId, byId) ?? targetId;
    if (callerRoot !== targetRoot) throw new Error(`Agent ${targetId} is not in your collaboration tree`);
  }

  private async assertDescendant(caller: Session, targetId: string): Promise<void> {
    const summaries = await this.options.store.list();
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    let current = byId.get(targetId);
    const seen = new Set<string>();
    while (current?.parentSessionId) {
      if (current.parentSessionId === caller.id) return;
      if (seen.has(current.id)) break;
      seen.add(current.id);
      current = byId.get(current.parentSessionId);
    }
    throw new Error(`Agent ${targetId} is not one of your descendants`);
  }

  private rootOf(id: string, byId: Map<string, { id: string; parentSessionId?: string }>): string | undefined {
    let current = byId.get(id);
    if (!current && this.children.has(id)) return undefined;
    const seen = new Set<string>();
    while (current?.parentSessionId) {
      if (seen.has(current.id)) return undefined;
      seen.add(current.id);
      const parent = byId.get(current.parentSessionId);
      if (!parent) return current.parentSessionId;
      current = parent;
    }
    return current?.id;
  }

  private async storedInfo(
    summary: { id: string; parentSessionId?: string; depth?: number; description?: string; createdAt: number },
    workspace: string,
  ): Promise<SubagentInfo> {
    let handle: SessionHandle | undefined;
    try {
      handle = await this.options.store.open(workspace, summary.id);
    } catch {
      handle = undefined;
    }
    const events = handle?.events ?? [];
    const result = handle ? clipResult(lastAssistant(events)) : undefined;
    const agentSelection = handle ? projectAgentSelection(events) : { status: 'legacy' as const, agent: null };
    return {
      id: summary.id,
      ...(summary.parentSessionId === undefined ? {} : { parentId: summary.parentSessionId }),
      depth: summary.depth ?? 0,
      ...(summary.description === undefined ? {} : { description: summary.description }),
      ...(agentSelection.status === 'selected' ? { agent: agentSelection.agent } : {}),
      status: handle ? lastTurnState(events) : 'idle',
      createdAt: summary.createdAt,
      updatedAt: handle?.events.at(-1)?.ts ?? summary.createdAt,
      ...(result === undefined ? {} : { result }),
    };
  }
}
