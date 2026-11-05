import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Message, ToolCall } from './domain/message';
import type { Tool, ToolSpec } from './domain/tool';
import { userMessage } from './domain/message';
import type { AgentEvent } from './protocol/events';
import type {
  ApprovalHandler,
  PermissionMode,
  PermissionRequest,
  Rule,
} from './protocol/permission';
import type { SubagentNotice, SubagentService } from './domain/subagent';
import { SUBAGENT_NOTICE_EVENT } from './domain/subagent';
import type { ModelClient } from './providers/types';
import type { AuditSink } from './store/audit';
import { createDefaultRegistry, ToolRegistry } from './tools';
import { listDirTool } from './tools/builtin/list-dir';
import { readFileTool } from './tools/builtin/read-file';
import { skillTool } from './tools/builtin/skill';
import { writeFileTool } from './tools/builtin/write-file';
import { createDshShellTool } from './tools/builtin/dsh-shell';
import { createTodoWriteTool } from './tools/builtin/todo-write';
import { createExitPlanModeTool, EXIT_PLAN_MODE_TOOL_NAME } from './tools/builtin/exit-plan-mode';
import type { PlanReviewResponse } from './tools/builtin/exit-plan-mode';
import { createSubagentTools, SUBAGENT_TOOL_NAME } from './tools/builtin/subagent';
import { TODO_WRITE_EVENT } from './session/todo';
import type { TodoItem } from './session/todo';
import {
  createPlanModeEvent,
  PLAN_MODE_EVENT,
  PLAN_MODE_GUIDANCE,
  projectPlanMode,
} from './session/plan';
import { ToolExecutor } from './exec/executor';
import { DSH_PRESET_BUNDLES, isDshPermissionPreset, snapshotDshPermissions } from './permissions/dsh-permissions';
import type { DshPermissionSnapshot, DshSandboxMode } from './permissions/dsh-permissions';
import { checkDshMutation } from './sandbox/dsh-fs';
import type { DshSandboxPolicy } from './sandbox/dsh-policy';
import { AgentLoop, DEFAULT_MAX_STEPS } from './loop/agent-loop';
import type { PreparedToolCall } from './loop/agent-loop';
import type { SessionHandle } from './session/store';
import { projectMessages } from './session/projection';
import type { SessionModelSelection } from './session/model-selection';

/**
 * 组合根（composition root）。
 *
 * 全项目只有这里知道「怎么把零件拼起来」：模型 + 工具 + 权限 + 循环 + 审计。
 * 其他模块互相之间只认接口，不认具体实现。
 */

export const DEFAULT_SYSTEM_PROMPT = `你是一个运行在用户本机的个人智能体。

工作方式：
- 需要了解文件时先列目录或读取，不要凭空猜测内容。
- 修改文件用 write_file，写入前先读一遍确认当前内容。
- 需要执行命令时使用 bash；它受当前会话的沙盒策略限制。
- 多步骤任务先使用 todo_write 建立任务清单，并在推进过程中更新状态。
- 复杂或可并行的调查可以交给 subagent；它会继承你的工作区、模型和权限预设。
- 每次工具调用都会经过权限检查，被拒绝时不要重复同样的调用，换一种做法或直接说明。
- 回答保持简洁，说明你做了什么、结果如何。`;

export function createSessionId(): string {
  return `s_${Date.now().toString(36)}`;
}

export interface SessionOptions {
  cwd: string;
  workspace?: string;
  model: ModelClient;
  modelId?: string;
  modelSelection?: SessionModelSelection;
  system?: string;
  /** Legacy fields are retained for source compatibility and never authorize calls. */
  mode?: PermissionMode;
  rules?: Rule[];
  dshPermissions?: DshPermissionSnapshot;
  /** UI 提供：渲染一次确认提示并返回结果。 */
  approve?: (request: PermissionRequest, signal: AbortSignal) => ReturnType<ApprovalHandler>;
  /** UI 提供：审阅计划并决定是否退出 plan 模式。 */
  reviewPlan?: (plan: string, signal: AbortSignal) => Promise<PlanReviewResponse>;
  maxSteps?: number;
  contextWindowTokens?: number;
  retainContextTokens?: number;
  sessionId?: string;
  audit?: AuditSink;
  tools?: ToolRegistry;
  session?: SessionHandle;
  /** Parent link/depth when this session is a subagent. */
  depth?: number;
  /** Initial plan state for an in-memory session without persisted events. */
  planActive?: boolean;
  /** Shared subagent runtime; enables delegation tools. */
  subagents?: SubagentService;
  /** Called for events produced by turns started outside a UI send() call. */
  onBackgroundEvent?: (event: AgentEvent) => void;
}

export class Session {
  readonly id: string;
  readonly #dshPermissions: DshPermissionSnapshot | undefined;
  private history: Message[] = [];
  private readonly loop: AgentLoop;
  private readonly tools: ToolRegistry;
  private readonly trusted = new Set<Tool>();
  private readonly dshShell?: Tool;
  private readonly dshWrite?: Tool;
  private readonly session?: SessionHandle;
  private readonly baseSystem: string;
  private readonly cwdValue: string;
  private readonly workspacePath?: string;
  private readonly modelSelectionValue?: SessionModelSelection;
  private readonly subagents?: SubagentService;
  private readonly reviewPlanHandler?: SessionOptions['reviewPlan'];
  private readonly onBackgroundEvent?: SessionOptions['onBackgroundEvent'];
  private readonly inbox: Message[] = [];
  private planActive: boolean;
  private controller?: AbortController;

  constructor(options: SessionOptions) {
    this.session = options.session;
    this.id = options.session?.id ?? options.sessionId ?? `s_${Date.now().toString(36)}`;
    this.#dshPermissions = copyDshPermissions(options.dshPermissions);
    this.workspacePath = options.workspace ?? options.session?.header.workspace;
    this.modelSelectionValue = options.modelSelection;
    this.subagents = options.subagents;
    this.reviewPlanHandler = options.reviewPlan;
    this.onBackgroundEvent = options.onBackgroundEvent;
    this.baseSystem = options.system ?? DEFAULT_SYSTEM_PROMPT;
    this.cwdValue = options.cwd;
    this.planActive = options.session === undefined
      ? options.planActive ?? false
      : projectPlanMode(options.session.events).active;
    if (options.session) this.history = projectMessages(options.session.events);

    const cwd = options.cwd;
    const approve = options.approve;
    this.tools = new ToolRegistry();
    for (const tool of (options.tools ?? createDefaultRegistry()).list()) {
      if (tool === writeFileTool) {
        this.dshWrite = dshWriteFileTool({ mode: 'read-only', workspaceRoot: options.cwd });
        this.tools.register(this.dshWrite);
        this.trusted.add(this.dshWrite);
      } else {
        this.tools.register(tool);
        // Confined modes have no sandbox policy for arbitrary extension tools,
        // so only the fully trusted preset may execute them. The session-owned
        // read/write/shell capabilities are trusted separately below.
        if (this.#dshPermissions?.sandbox === 'danger-full-access') this.trusted.add(tool);
      }
    }
    if (!this.tools.has('bash')) {
      this.dshShell = createDshShellTool({
        policy: { mode: this.#dshPermissions?.sandbox ?? 'read-only', workspaceRoot: options.cwd },
      });
      this.tools.register(this.dshShell);
      this.trusted.add(this.dshShell);
    }
    this.trusted.add(readFileTool);
    this.trusted.add(listDirTool);
    this.trusted.add(skillTool);

    const todoTool = createTodoWriteTool({
      append: async (todos: TodoItem[]) => {
        if (!this.session) throw new Error('todo_write requires an owning session');
        await this.session.append({ type: TODO_WRITE_EVENT, data: { todos } });
      },
    });
    this.tools.register(todoTool);
    this.trusted.add(todoTool);

    if (this.reviewPlanHandler) {
      const exitPlanTool = createExitPlanModeTool({
        review: (plan, signal) => this.reviewPlanHandler!(plan, signal),
        onApproved: async () => {
          await this.applyPlanMode(false);
        },
      });
      this.tools.register(exitPlanTool);
      this.trusted.add(exitPlanTool);
    }

    if (this.subagents) {
      for (const tool of createSubagentTools(this, this.subagents)) {
        this.tools.register(tool);
        this.trusted.add(tool);
      }
    }

    this.loop = new AgentLoop({
      model: options.model,
      modelId: options.modelId ?? 'fake',
      system: () => this.planActive
        ? `${this.baseSystem}\n\n${PLAN_MODE_GUIDANCE}`
        : this.baseSystem,
      tools: this.tools,
      toolSpecs: () => this.visibleToolSpecs(),
      takeQueuedMessages: () => this.inbox.splice(0),
      permissions: { check: async () => ({ decision: 'deny', source: 'DSH execution policy required' }) },
      prepareToolCall: (call, signal) => this.prepareToolCall(call, signal, this.tools, cwd, approve),
      cwd,
      sessionId: this.id,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      ...(options.contextWindowTokens === undefined ? {} : { contextWindowTokens: options.contextWindowTokens }),
      ...(options.retainContextTokens === undefined ? {} : { retainContextTokens: options.retainContextTokens }),
      ...(options.audit ? { audit: options.audit } : {}),
    });
  }

  get dshPermissions(): DshPermissionSnapshot | undefined {
    return this.#dshPermissions;
  }

  get messages(): readonly Message[] {
    return this.history;
  }

  get cwd(): string {
    return this.cwdValue;
  }

  get workspace(): string | undefined {
    return this.workspacePath;
  }

  get depth(): number {
    return this.session?.header.depth ?? 0;
  }

  get parentSessionId(): string | undefined {
    return this.session?.header.parentSessionId;
  }

  get modelSelection(): SessionModelSelection | undefined {
    return this.modelSelectionValue;
  }

  get planMode(): boolean {
    return this.planActive;
  }

  get systemPrompt(): string {
    return this.planActive ? `${this.baseSystem}\n\n${PLAN_MODE_GUIDANCE}` : this.baseSystem;
  }

  get baseSystemPrompt(): string {
    return this.baseSystem;
  }

  get sessionHandle(): SessionHandle | undefined {
    return this.session;
  }

  get activeTurn(): boolean {
    return this.controller !== undefined;
  }

  interrupt(): void {
    this.controller?.abort();
  }

  /** Persist a plan-mode selection. UI callers reject changes during active turns. */
  async setPlanMode(active: boolean): Promise<void> {
    if (typeof active !== 'boolean') throw new TypeError('Plan mode state must be a boolean');
    if (this.controller) throw new Error('Plan mode cannot change during an active turn');
    await this.applyPlanMode(active);
  }

  private async applyPlanMode(active: boolean): Promise<void> {
    if (typeof active !== 'boolean') throw new TypeError('Plan mode state must be a boolean');
    if (this.planActive === active) return;
    if (this.session) await this.session.append(createPlanModeEvent(active));
    this.planActive = active;
  }

  /** Consume events yourself; when persistence is enabled messages/traces are written first. */
  async *send(input: string): AsyncGenerator<AgentEvent> {
    if (this.controller) throw new Error('A turn is already active in this session');
    const user = userMessage(input);
    this.history.push(user);
    await this.appendMessage('message/user', { text: input });
    yield* this.runTurn(false);
  }

  /**
   * Deliver a message from another agent. A running turn receives it at its next
   * step; an idle session starts a new turn immediately.
   */
  async deliverExternalMessage(text: string, source = 'agent'): Promise<'queued' | 'started'> {
    if (typeof text !== 'string' || text.trim().length === 0) throw new Error('A non-empty message is required');
    const message = userMessage(text);
    this.history.push(message);
    await this.appendMessage('message/notice', { text, source });
    if (this.controller) {
      this.inbox.push(message);
      return 'queued';
    }
    this.runBackgroundTurn();
    return 'started';
  }

  /** Called by the subagent manager when a child settles. */
  async receiveSubagentNotice(notice: SubagentNotice): Promise<void> {
    const message = userMessage(formatSubagentNotice(notice));
    this.history.push(message);
    await this.appendMessage(SUBAGENT_NOTICE_EVENT, { ...notice });
    if (this.controller) {
      this.inbox.push(message);
      return;
    }
    this.runBackgroundTurn();
  }

  private async *runTurn(background: boolean): AsyncGenerator<AgentEvent> {
    if (this.controller) throw new Error('A turn is already active in this session');
    const controller = new AbortController();
    this.controller = controller;
    let generator: AsyncGenerator<AgentEvent, Message[]> | undefined;
    let terminal = false;
    let failed = false;
    let recordedError = false;
    let pendingAudit = false;

    try {
      const modelHistory = prepareModelHistory(this.history);
      generator = this.loop.run(modelHistory.messages, controller.signal);

      while (true) {
        if (controller.signal.aborted && !terminal) {
          if (pendingAudit) {
            pendingAudit = false;
            try {
              await generator.next();
            } catch (error) {
              failed = true;
              throw error;
            }
          }
          const event: AgentEvent = { type: 'turn.end', reason: 'interrupted' };
          await this.appendTrace(event);
          terminal = true;
          if (background) this.onBackgroundEvent?.(event);
          yield event;
          return;
        }

        pendingAudit = false;
        const next = await generator.next();
        if (next.done) {
          if (!modelHistory.repaired) this.history = next.value;
          return;
        }

        const event = next.value;
        if (event.type === 'tool.result') pendingAudit = true;
        if (event.type === 'assistant.message') {
          await this.appendMessage('message/assistant', event.message);
          this.history.push(event.message);
        } else if (event.type === 'tool.result') {
          await this.appendMessage('message/tool-result', { result: event.result });
          const previous = this.history.at(-1);
          if (previous?.role === 'tool') previous.results.push(event.result);
          else this.history.push({ role: 'tool', results: [event.result] });
        }
        await this.appendTrace(event);
        if (event.type === 'turn.end') terminal = true;
        if (event.type === 'error') {
          recordedError = true;
          failed = true;
        }
        if (background) this.onBackgroundEvent?.(event);
        yield event;
      }
    } catch (error) {
      if (controller.signal.aborted && !failed) {
        if (!terminal) {
          const event: AgentEvent = { type: 'turn.end', reason: 'interrupted' };
          await this.appendTrace(event);
          terminal = true;
          if (background) this.onBackgroundEvent?.(event);
          yield event;
        }
        return;
      }
      failed = true;
      if (!recordedError) await this.appendTrace({ type: 'error', error: { message: '' } });
      throw error;
    } finally {
      if (!terminal) controller.abort();
      try {
        if (generator && pendingAudit) {
          pendingAudit = false;
          try {
            await generator.next();
          } catch (error) {
            failed = true;
            if (!recordedError) {
              await this.appendTrace({ type: 'error', error: { message: '' } });
              recordedError = true;
            }
            throw error;
          }
        }
      } finally {
        try {
          if (generator) await generator.return(this.history);
        } finally {
          try {
            if (!terminal) {
              await this.appendTrace({ type: 'turn.end', reason: failed ? 'error' : 'interrupted' });
            }
          } finally {
            this.controller = undefined;
            // A notice or external message can arrive after the last model
            // step. Its text is already in history, so retire the step queue
            // and continue in a background turn instead of leaving it unread.
            if (!controller.signal.aborted && this.inbox.length > 0) {
              this.inbox.length = 0;
              this.runBackgroundTurn();
            }
          }
        }
      }
    }
  }

  private runBackgroundTurn(): void {
    void (async () => {
      try {
        for await (const _event of this.runTurn(true)) {
          // Events are persisted and forwarded through onBackgroundEvent.
        }
      } catch {
        // runTurn persists a redacted trace/error before rethrowing.
      }
    })();
  }

  private visibleToolSpecs(): ToolSpec[] {
    return this.tools.specs().filter((tool) => {
      if (tool.name === EXIT_PLAN_MODE_TOOL_NAME) return this.planActive;
      if (tool.name === SUBAGENT_TOOL_NAME) return this.subagents?.canStart(this) ?? false;
      return true;
    });
  }

  private async prepareToolCall(
    call: ToolCall,
    signal: AbortSignal,
    tools: ToolRegistry,
    cwd: string,
    handler: SessionOptions['approve'],
  ): Promise<PreparedToolCall> {
    const deny = (source: string): PreparedToolCall => ({ decision: 'deny', source });
    const snapshot = this.#dshPermissions;
    if (!snapshot) return deny('DSH permission selection is required');
    signal.throwIfAborted();

    const tool = tools.get(call.name);
    let cleanCall: ToolCall = call;
    let mode = snapshot.sandbox;
    const args = call.arguments;
    const canEscalate = tool === this.dshWrite || tool === this.dshShell;
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
      let fields: Record<string, unknown>;
      try {
        fields = structuredClone(args) as Record<string, unknown>;
      } catch {
        return deny('Invalid DSH tool arguments');
      }
      cleanCall = { ...cleanCall, arguments: fields };
      if (Object.hasOwn(fields, 'sandbox_permissions') || Object.hasOwn(fields, 'justification')) {
        if (!canEscalate) return deny('Sandbox escalation is only available for write_file and bash');
        const target = fields.sandbox_permissions;
        const justification = fields.justification;
        if (!isDshPermissionPreset(target) || typeof justification !== 'string' || !justification.trim() ||
            !isStrictlyWider(mode, target) || !call.id.trim() || !call.name.trim()) {
          return deny('Invalid DSH sandbox escalation request');
        }
        if (snapshot.approval !== 'ask' || !handler) return deny('DSH escalation approval is unavailable');
        const response = await this.approve({
          id: call.id,
          call: structuredClone(call),
          reason: `Allow one call to use ${target}: ${justification}`,
        }, handler);
        signal.throwIfAborted();
        if (response !== 'allow') return deny('DSH escalation was not approved');
        mode = target;
        const { sandbox_permissions: _target, justification: _justification, ...safeArgs } = fields;
        cleanCall = { ...cleanCall, arguments: safeArgs };
      }
    }

    if (tool?.name === EXIT_PLAN_MODE_TOOL_NAME && !this.planActive) {
      return deny('exit_plan_mode is only available in plan mode');
    }
    if (tool?.name === SUBAGENT_TOOL_NAME && (!this.subagents || !this.subagents.canStart(this))) {
      return deny('Subagent delegation depth or capacity is exhausted');
    }
    if (!tool || !this.trusted.has(tool)) {
      return deny('No trusted sandbox enforcement for this tool');
    }
    const policy: DshSandboxPolicy = Object.freeze({
      mode,
      workspaceRoot: mode === 'workspace-write' ? await realpath(cwd) : cwd,
      sessionId: this.id,
    });
    signal.throwIfAborted();
    let selected: Tool | undefined = tool;
    if (tool === this.dshWrite) selected = dshWriteFileTool(policy);
    else if (tool === this.dshShell) selected = createDshShellTool({ policy });
    const registry = new ToolRegistry();
    if (selected) registry.register(selected);
    const executor = new ToolExecutor(registry, { cwd, signal });
    return {
      decision: 'allow',
      source: `DSH ${mode}`,
      execute: async () => {
        signal.throwIfAborted();
        return executor.execute(cleanCall);
      },
    };
  }

  private async approve(request: PermissionRequest, handler: NonNullable<SessionOptions['approve']>): ReturnType<ApprovalHandler> {
    const signal = this.controller?.signal;
    if (!signal) return 'deny';
    signal.throwIfAborted();
    let abort!: () => void;
    return new Promise<'allow' | 'deny'>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return handler(request, signal);
      }).then(resolve, reject);
    }).finally(() => signal.removeEventListener('abort', abort));
  }

  private async appendTrace(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'turn.start':
        await this.appendMessage('trace/turn.start', { step: event.step });
        break;
      case 'turn.end':
        await this.appendMessage('trace/turn.end', { reason: event.reason });
        break;
      case 'tool.call':
        await this.appendMessage('trace/tool.call', { id: event.call.id, name: event.call.name });
        break;
      case 'permission.decided':
        // Rule text can contain sensitive paths or command arguments.
        await this.appendMessage('trace/permission.decided', { callId: event.callId, decision: event.decision });
        break;
      case 'tool.result':
        await this.appendMessage('trace/tool.result', {
          callId: event.result.callId,
          name: event.result.name,
          ok: event.result.ok,
          truncated: event.result.truncated,
          ...(event.result.durationMs === undefined ? {} : { durationMs: event.result.durationMs }),
        });
        break;
      case 'context.compacted':
        await this.appendMessage('trace/context.compacted', {
          beforeTokens: event.beforeTokens,
          afterTokens: event.afterTokens,
        });
        break;
      case 'error':
        // Provider and tool errors can contain arbitrary credentials or conversation content.
        await this.appendMessage('trace/error', { message: 'An error occurred during the turn.' });
        break;
    }
  }

  private async appendMessage(type: string, data: unknown): Promise<void> {
    await this.session?.append({ type, data });
  }
}

function formatSubagentNotice(notice: SubagentNotice): string {
  const title = `[Subagent ${notice.childId} ${notice.status}]`;
  const description = notice.description ? `\n${notice.description}` : '';
  const result = notice.result?.trim() ? `\n\n${notice.result.trim()}` : '';
  return `${title}${description}${result}\n\nReview the result before relying on it; open the child session for full details.`;
}

function copyDshPermissions(value: DshPermissionSnapshot | undefined): DshPermissionSnapshot | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || !isDshPermissionPreset(value.preset)) {
    throw new TypeError('Invalid DSH permission snapshot');
  }
  const bundle = DSH_PRESET_BUNDLES[value.preset];
  if (value.sandbox !== bundle.sandbox || value.approval !== bundle.approval) {
    throw new TypeError('Invalid DSH permission snapshot');
  }
  return snapshotDshPermissions({ status: 'ready', preset: value.preset });
}

function isStrictlyWider(current: DshSandboxMode, target: DshSandboxMode): boolean {
  return current === 'read-only'
    ? target === 'workspace-write' || target === 'danger-full-access'
    : current === 'workspace-write' && target === 'danger-full-access';
}

function dshWriteFileTool(policy: DshSandboxPolicy): Tool {
  const params = z.object({ path: z.string(), content: z.string() }).strict();
  return {
    ...writeFileTool,
    parameters: params.extend({
      sandbox_permissions: z.enum(['workspace-write', 'danger-full-access']).optional(),
      justification: z.string().optional(),
    }),
    async execute(args, ctx) {
      const { path, content } = params.parse(args);
      ctx.signal.throwIfAborted();
      const target = await checkDshMutation(resolve(ctx.cwd, path), policy);
      ctx.signal.throwIfAborted();
      await mkdir(dirname(target), { recursive: true });
      ctx.signal.throwIfAborted();
      await writeFile(target, content, 'utf8');
      return { content: `Wrote ${path} (${content.length} characters)` };
    },
  };
}

/** Repair only the provider input; the session transcript remains an exact record of events. */
function prepareModelHistory(history: readonly Message[]): { messages: Message[]; repaired: boolean } {
  const messages: Message[] = [];
  let repaired = false;

  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (!message) continue;
    if (message.role === 'tool') {
      repaired = true;
      continue;
    }
    if (message.role !== 'assistant' || message.toolCalls.length === 0) {
      messages.push(message);
      continue;
    }

    const seen = new Set<string>();
    const calls = message.toolCalls.filter((call) => {
      if (seen.has(call.id)) return false;
      seen.add(call.id);
      return true;
    });
    const remaining = new Map(calls.map((call) => [call.id, call]));
    if (calls.length !== message.toolCalls.length) repaired = true;
    messages.push(calls.length === message.toolCalls.length ? message : { ...message, toolCalls: calls });

    const results: Extract<Message, { role: 'tool' }>['results'] = [];
    while (history[index + 1]?.role === 'tool') {
      const toolMessage = history[++index];
      if (toolMessage?.role !== 'tool') break;
      for (const result of toolMessage.results) {
        if (!remaining.has(result.callId)) {
          repaired = true;
          continue;
        }
        remaining.delete(result.callId);
        results.push(result);
      }
    }
    for (const call of remaining.values()) {
      repaired = true;
      results.push({
        callId: call.id,
        name: call.name,
        ok: false,
        content: 'Tool result is unavailable because the previous turn was interrupted or failed. Execution status is unknown; the tool may or may not have run. Do not assume it ran or retry it without checking.',
        truncated: false,
      });
    }
    messages.push({ role: 'tool', results });
  }

  return { messages, repaired };
}
