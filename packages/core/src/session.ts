import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Message, ToolCall } from './domain/message';
import type { Tool, ToolSpec } from './domain/tool';
import { userMessage } from './domain/message';
import type { AgentEvent, StopReason } from './protocol/events';
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
import { editTextFile, writeTextFile } from './tools/fs-io';
import { displayPath } from './tools/paths';
import { editFileTool, formatEditOutput, parseEditArgs } from './tools/builtin/edit-file';
import { globTool } from './tools/builtin/glob';
import { grepTool } from './tools/builtin/grep';
import { listDirTool } from './tools/builtin/list-dir';
import { readFileTool } from './tools/builtin/read-file';
import { skillTool, createSkillTool } from './tools/builtin/skill';
import { formatWriteOutput, parseWriteArgs, writeFileTool } from './tools/builtin/write-file';
import { webFetchTool } from './tools/builtin/web-fetch';
import { createDshShellTool } from './tools/builtin/dsh-shell';
import { createTodoWriteTool } from './tools/builtin/todo-write';
import { createExitPlanModeTool, EXIT_PLAN_MODE_TOOL_NAME } from './tools/builtin/exit-plan-mode';
import type { PlanReviewResponse } from './tools/builtin/exit-plan-mode';
import { createSubagentTools, SUBAGENT_TOOL_NAME } from './tools/builtin/subagent';
import { createGoalTools, CREATE_GOAL_TOOL_NAME, GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME } from './tools/builtin/goal';
import { TODO_WRITE_EVENT } from './session/todo';
import type { TodoItem } from './session/todo';
import { GoalController, goalRefOf } from './session/goal-controller';
import {
  GOAL_DEFAULT_BLOCKED_AFTER,
  renderGoalRoundPrompt,
  renderGoalToolGuidance,
} from './session/goal';
import type { GoalView } from './session/goal';
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
import type { SessionAgent } from './session/runtime';
import type { ModelCapabilities } from './config/models';
import { DEFAULT_SYSTEM_PROMPT } from './prompts';

/**
 * 组合根（composition root）。
 *
 * 全项目只有这里知道「怎么把零件拼起来」：模型 + 工具 + 权限 + 循环 + 审计。
 * 其他模块互相之间只认接口，不认具体实现。
 */

export { DEFAULT_SYSTEM_PROMPT } from './prompts';

export interface SessionOptions {
  cwd: string;
  workspace?: string;
  model: ModelClient;
  modelId?: string;
  /** Resolved agent profile; absent keeps the unrestricted default tool set. */
  agent?: SessionAgent;
  /** Known capabilities of the selected model. */
  modelCapabilities?: ModelCapabilities;
  /** Allow several todo items to remain in_progress when work runs in parallel. */
  todoAllowParallelInProgress?: boolean;
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

interface GoalRoundContext {
  goalId: string;
  revision: number;
  round: number;
  prompt: string;
}

interface GoalCompletionAuthority {
  kind: 'direct-human' | 'goal-round';
  goal: GoalView;
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
  private readonly dshEdit?: Tool;
  private readonly session?: SessionHandle;
  private readonly baseSystem: string;
  private readonly cwdValue: string;
  private readonly workspacePath?: string;
  private readonly agentValue?: SessionAgent;
  private readonly modelCapabilities?: ModelCapabilities;
  private readonly subagents?: SubagentService;
  private readonly reviewPlanHandler?: SessionOptions['reviewPlan'];
  private readonly onBackgroundEvent?: SessionOptions['onBackgroundEvent'];
  private readonly inbox: Message[] = [];
  private readonly inboxWaiters = new Set<() => void>();
  private readonly goalController: GoalController;
  private planActive: boolean;
  private controller?: AbortController;
  private executing = false;
  private turnSource: 'human' | 'goal' | 'external' | 'notice' | 'system' = 'system';
  private currentGoalRound?: GoalRoundContext;

  constructor(options: SessionOptions) {
    this.session = options.session;
    this.id = options.session?.id ?? options.sessionId ?? `s_${Date.now().toString(36)}`;
    this.#dshPermissions = copyDshPermissions(options.dshPermissions);
    this.workspacePath = options.workspace ?? options.session?.header.workspace;
    this.agentValue = options.agent;
    this.modelCapabilities = options.modelCapabilities;
    this.subagents = options.subagents;
    this.reviewPlanHandler = options.reviewPlan;
    this.onBackgroundEvent = options.onBackgroundEvent;
    this.baseSystem = options.system ?? DEFAULT_SYSTEM_PROMPT;
    this.cwdValue = options.cwd;
    this.planActive = options.session === undefined
      ? options.planActive ?? false
      : projectPlanMode(options.session.events).active;
    if (options.session) this.history = projectMessages(options.session.events);
    this.goalController = new GoalController({
      ...(options.session === undefined ? {} : {
        events: options.session.events,
        append: (event) => options.session!.append(event),
      }),
    });

    const cwd = options.cwd;
    const approve = options.approve;
    const allows = (name: string): boolean => this.allowsTool(name);
    this.tools = new ToolRegistry();
    for (const tool of (options.tools ?? createDefaultRegistry()).list()) {
      if (!allows(tool.name)) continue;
      if (tool === writeFileTool) {
        this.dshWrite = dshWriteFileTool({ mode: 'read-only', workspaceRoot: options.cwd });
        this.tools.register(this.dshWrite);
        this.trusted.add(this.dshWrite);
      } else if (tool === editFileTool) {
        this.dshEdit = dshEditFileTool({ mode: 'read-only', workspaceRoot: options.cwd });
        this.tools.register(this.dshEdit);
        this.trusted.add(this.dshEdit);
      } else if (tool === skillTool && options.agent !== undefined) {
        const restricted = createSkillTool({ allowed: options.agent.skills });
        this.tools.register(restricted);
        this.trusted.add(restricted);
      } else {
        this.tools.register(tool);
        // Confined modes have no sandbox policy for arbitrary extension tools,
        // so only the fully trusted preset may execute them. The session-owned
        // read/write/shell capabilities are trusted separately below.
        if (this.#dshPermissions?.sandbox === 'danger-full-access') this.trusted.add(tool);
      }
    }
    if (allows('bash') && !this.tools.has('bash')) {
      this.dshShell = createDshShellTool({
        policy: { mode: this.#dshPermissions?.sandbox ?? 'read-only', workspaceRoot: options.cwd },
      });
      this.tools.register(this.dshShell);
      this.trusted.add(this.dshShell);
    }
    if (allows('read_file')) this.trusted.add(readFileTool);
    if (allows('list_dir')) this.trusted.add(listDirTool);
    if (allows('glob')) this.trusted.add(globTool);
    if (allows('grep')) this.trusted.add(grepTool);
    if (allows('web_fetch')) this.trusted.add(webFetchTool);
    if (allows('skill')) this.trusted.add(skillTool);

    if (allows('todo_write')) {
      const todoTool = createTodoWriteTool({
        allowParallel: options.todoAllowParallelInProgress ?? false,
        append: async (todos: TodoItem[]) => {
          if (!this.session) throw new Error('todo_write requires an owning session');
          await this.session.append({ type: TODO_WRITE_EVENT, data: { todos } });
        },
      });
      this.tools.register(todoTool);
      this.trusted.add(todoTool);
    }

    if (allows('exit_plan_mode') && this.reviewPlanHandler) {
      const exitPlanTool = createExitPlanModeTool({
        review: (plan, signal) => this.reviewPlanHandler!(plan, signal),
        onApproved: async () => {
          await this.applyPlanMode(false);
        },
      });
      this.tools.register(exitPlanTool);
      this.trusted.add(exitPlanTool);
    }

    for (const tool of createGoalTools(this)) {
      if (!allows(tool.name)) continue;
      this.tools.register(tool);
      this.trusted.add(tool);
    }

    if (this.subagents) {
      for (const tool of createSubagentTools(this, this.subagents)) {
        if (!allows(tool.name)) continue;
        this.tools.register(tool);
        this.trusted.add(tool);
      }
    }

    this.loop = new AgentLoop({
      model: options.model,
      modelId: options.modelId ?? 'fake',
      system: () => this.systemText(),
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

  get agent(): SessionAgent | undefined {
    return this.agentValue;
  }

  private allowsTool(name: string): boolean {
    const tools = this.agentValue?.tools;
    return tools === undefined || tools === '*' || tools.has(name);
  }

  get planMode(): boolean {
    return this.planActive;
  }

  get goals(): GoalController {
    return this.goalController;
  }

  get systemPrompt(): string {
    return this.systemText();
  }

  private systemText(): string {
    const parts = [this.baseSystem];
    if (this.planActive) parts.push(PLAN_MODE_GUIDANCE);
    if (this.hasGoalTools()) parts.push(renderGoalToolGuidance(GOAL_DEFAULT_BLOCKED_AFTER));
    if (this.depth === 0 && this.subagents !== undefined) {
      const guidance: string[] = [];
      if (this.allowsTool('send_message')) {
        guidance.push('To message other agents, use send_message({ agent_id: "<agent-id>", message: "..." }).');
      }
      if (this.allowsTool('list_agents')) {
        guidance.push('Use list_agents({}) to find your collaborator agents and their ids.');
      }
      if (guidance.length > 0) {
        parts.push(
          `You are the root agent. Your agent id is ${JSON.stringify(this.id)}.\n\n${guidance.join('\n')}`,
        );
      }
    }
    return parts.filter(Boolean).join('\n\n');
  }

  private hasGoalTools(): boolean {
    return this.allowsTool(CREATE_GOAL_TOOL_NAME)
      || this.allowsTool(GET_GOAL_TOOL_NAME)
      || this.allowsTool(UPDATE_GOAL_TOOL_NAME);
  }

  get sessionHandle(): SessionHandle | undefined {
    return this.session;
  }

  get activeTurn(): boolean {
    return this.controller !== undefined || this.executing;
  }

  /** Whether the current model turn was started by a direct top-level human message. */
  get directHumanTurn(): boolean {
    return this.turnSource === 'human' && this.depth === 0 && this.parentSessionId === undefined;
  }

  assertGoalDirectHuman(): void {
    if (!this.directHumanTurn) {
      throw new Error('this goal operation requires a direct human turn on a top-level agent');
    }
  }

  goalCompletionAuthority(): GoalCompletionAuthority {
    const goal = this.goals.view();
    if (this.directHumanTurn) {
      if (goal === undefined) throw new Error('no current goal');
      return { kind: 'direct-human', goal };
    }
    if (goal !== undefined
      && this.turnSource === 'goal'
      && this.currentGoalRound?.goalId === goal.id
      && this.currentGoalRound.revision === goal.revision
      && this.currentGoalRound.round === goal.roundsStarted) {
      return { kind: 'goal-round', goal };
    }
    throw new Error('complete and blocked require a direct human turn or the current goal round');
  }

  /**
   * Add a short model-facing notice for the next step of this turn and persist
   * it in the session log.
   */
  async deferGoalContext(text: string): Promise<void> {
    const message = userMessage(text);
    await this.appendMessage('message/notice', { text, source: 'tool-goal' });
    this.inbox.push(message);
    this.notifyInbox();
  }

  /** Resolve when a message or notice is waiting for the next model step. */
  async waitForInput(timeoutMs: number, signal: AbortSignal): Promise<{ timedOut: boolean }> {
    if (this.inbox.length > 0) return { timedOut: false };
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inboxWaiters.delete(onInput);
        signal.removeEventListener('abort', onAbort);
        operation();
      };
      const onInput = (): void => {
        if (this.inbox.length > 0) finish(() => resolve({ timedOut: false }));
      };
      const onAbort = (): void => {
        finish(() => reject(signal.reason ?? new Error('Input wait aborted')));
      };
      const timer = setTimeout(() => finish(() => resolve({ timedOut: true })), timeoutMs);
      timer.unref?.();
      this.inboxWaiters.add(onInput);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      else onInput();
    });
  }

  interrupt(): void {
    this.controller?.abort();
  }

  /** Persist a plan-mode selection. UI callers reject changes during active turns. */
  async setPlanMode(active: boolean): Promise<void> {
    if (typeof active !== 'boolean') throw new TypeError('Plan mode state must be a boolean');
    if (this.executing) throw new Error('Plan mode cannot change during an active turn');
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
    if (this.executing) throw new Error('A turn is already active in this session');
    this.executing = true;
    try {
      const user = userMessage(input);
      this.history.push(user);
      await this.appendMessage('message/user', { text: input });
      yield* this.runGoalChain(false, 'human');
    } finally {
      this.executing = false;
      this.resumeQueuedBackground();
    }
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
    if (this.executing) {
      this.inbox.push(message);
      this.notifyInbox();
      return 'queued';
    }
    this.runBackgroundTurn('external');
    return 'started';
  }

  /** Called by the subagent manager when a child settles. */
  async receiveSubagentNotice(notice: SubagentNotice): Promise<void> {
    const message = userMessage(formatSubagentNotice(notice));
    this.history.push(message);
    await this.appendMessage(SUBAGENT_NOTICE_EVENT, { ...notice });
    if (this.executing) {
      this.inbox.push(message);
      this.notifyInbox();
      return;
    }
    this.runBackgroundTurn('notice');
  }

  private notifyInbox(): void {
    for (const waiter of [...this.inboxWaiters]) waiter();
  }

  private async *runGoalChain(
    background: boolean,
    initialSource: 'human' | 'external' | 'notice',
  ): AsyncGenerator<AgentEvent> {
    let source: 'human' | 'goal' | 'external' | 'notice' = initialSource;
    let goalRound: GoalRoundContext | undefined;
    try {
      while (true) {
        this.turnSource = source;
        this.currentGoalRound = goalRound;
        const reason = yield* this.runTurn(background);
        if (reason === 'error' || reason === 'max_tokens' || reason === 'max_steps') {
          this.goalController.disarm();
        } else if (source === 'goal' && reason === 'interrupted') {
          await this.pauseGoalAfterCancelledRound();
        }
        if (reason !== 'end_turn' && reason !== 'tool_use') return;
        const next = await this.nextGoalRound();
        if (next === undefined) return;
        await this.appendMessage('message/user', {
          text: next.prompt,
          source: {
            kind: 'goal',
            goalId: next.goalId,
            revision: next.revision,
            round: next.round,
          },
        });
        this.history.push(userMessage(next.prompt));
        this.goalController.recordRound(next.round);
        source = 'goal';
        goalRound = next;
      }
    } catch (error) {
      this.goalController.disarm();
      throw error;
    } finally {
      this.turnSource = 'system';
      this.currentGoalRound = undefined;
    }
  }

  private async pauseGoalAfterCancelledRound(): Promise<void> {
    try {
      const goal = this.goalController.view();
      if (goal?.phase !== 'active' || goal.activation !== 'armed') return;
      await this.goalController.pause(goalRefOf(goal));
    } catch {
      this.goalController.disarm();
    }
  }

  private async nextGoalRound(): Promise<GoalRoundContext | undefined> {
    let goal: GoalView | undefined;
    try {
      goal = this.goalController.view();
    } catch {
      this.goalController.disarm();
      return undefined;
    }
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return undefined;
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      try {
        await this.goalController.block(goalRefOf(goal), {
          code: 'round-limit',
          message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
        });
      } catch {
        this.goalController.disarm();
      }
      return undefined;
    }
    const round = goal.roundsStarted + 1;
    return {
      goalId: goal.id,
      revision: goal.revision,
      round,
      prompt: renderGoalRoundPrompt(goal, round),
    };
  }

  private async *runTurn(background: boolean): AsyncGenerator<AgentEvent, StopReason> {
    if (this.controller) throw new Error('A turn is already active in this session');
    if (this.planActive && !this.allowsTool(EXIT_PLAN_MODE_TOOL_NAME)) {
      throw new Error('The current agent profile must allow exit_plan_mode while plan mode is active');
    }
    if (this.modelCapabilities !== undefined && !this.modelCapabilities.imageInput && containsImage(this.history)) {
      throw new Error('The selected model does not support image input');
    }
    const controller = new AbortController();
    this.controller = controller;
    let generator: AsyncGenerator<AgentEvent, Message[]> | undefined;
    let terminal = false;
    let failed = false;
    let recordedError = false;
    let pendingAudit = false;
    let stopReason: StopReason = 'interrupted';

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
          return 'interrupted';
        }

        pendingAudit = false;
        const next = await generator.next();
        if (next.done) {
          if (!modelHistory.repaired) this.history = next.value;
          return stopReason;
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
        if (event.type === 'turn.end') {
          terminal = true;
          stopReason = event.reason;
        }
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
        return 'interrupted';
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
            if (!controller.signal.aborted && !this.executing && this.inbox.length > 0) {
              this.inbox.length = 0;
              this.runBackgroundTurn('external');
            }
          }
        }
      }
    }
  }

  private runBackgroundTurn(source: 'external' | 'notice'): void {
    if (this.executing) return;
    this.executing = true;
    void (async () => {
      try {
        for await (const _event of this.runGoalChain(true, source)) {
          // Events are persisted and forwarded through onBackgroundEvent.
        }
      } catch {
        // runTurn persists a redacted trace/error before rethrowing.
      } finally {
        this.executing = false;
        this.resumeQueuedBackground();
      }
    })();
  }

  private resumeQueuedBackground(): void {
    if (this.executing || this.controller !== undefined || this.inbox.length === 0) return;
    this.inbox.length = 0;
    this.runBackgroundTurn('external');
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
    if (tool && !this.allowsTool(tool.name)) return deny('Tool is not available to this agent');
    let cleanCall: ToolCall = call;
    let mode = snapshot.sandbox;
    const args = call.arguments;
    const canEscalate = tool === this.dshWrite || tool === this.dshEdit || tool === this.dshShell;
    if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
      let fields: Record<string, unknown>;
      try {
        fields = structuredClone(args) as Record<string, unknown>;
      } catch {
        return deny('Invalid DSH tool arguments');
      }
      cleanCall = { ...cleanCall, arguments: fields };
      if (Object.hasOwn(fields, 'sandbox_permissions') || Object.hasOwn(fields, 'justification')) {
        if (!canEscalate) return deny('Sandbox escalation is only available for write_file, edit_file and bash');
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
    else if (tool === this.dshEdit) selected = dshEditFileTool(policy);
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

function containsImage(history: readonly Message[]): boolean {
  return history.some((message) =>
    message.role === 'user' && message.content.some((part) => part.type === 'image'));
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
  const params = z.object({
    file_path: z.string(),
    content: z.string(),
    sandbox_permissions: z.enum(['workspace-write', 'danger-full-access']).optional(),
    justification: z.string().optional(),
  }).strict();
  return {
    ...writeFileTool,
    parameters: params,
    async execute(args, ctx) {
      const input = parseWriteArgs(params.parse(args));
      ctx.signal.throwIfAborted();
      const target = await checkDshMutation(resolve(ctx.cwd, input.filePath), policy);
      ctx.signal.throwIfAborted();
      const outcome = await writeTextFile(target, input.filePath, input.content, ctx.signal);
      return { content: formatWriteOutput(displayPath(ctx.cwd, target), outcome.operation) };
    },
  };
}

function dshEditFileTool(policy: DshSandboxPolicy): Tool {
  const params = z.object({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
    sandbox_permissions: z.enum(['workspace-write', 'danger-full-access']).optional(),
    justification: z.string().optional(),
  }).strict();
  return {
    ...editFileTool,
    parameters: params,
    async execute(args, ctx) {
      const input = parseEditArgs(params.parse(args));
      ctx.signal.throwIfAborted();
      const target = await checkDshMutation(resolve(ctx.cwd, input.filePath), policy);
      ctx.signal.throwIfAborted();
      await editTextFile(
        target,
        input.filePath,
        input.oldString,
        input.newString,
        input.replaceAll,
        ctx.signal,
      );
      return { content: formatEditOutput(displayPath(ctx.cwd, target), input.replaceAll) };
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
