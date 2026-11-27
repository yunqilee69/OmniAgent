import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AssistantMessage, ContentPart, Message, ToolCall } from './domain/message';
import type { Tool, ToolSpec } from './domain/tool';
import { assistantText, text, userMessage } from './domain/message';
import type { SessionEvent } from './session/types';
import {
  SESSION_TITLE_EVENT,
  collectSessionTitleMessages,
  fallbackSessionTitle,
  foldSessionTitle,
  normalizeSessionTitle,
  resolveSessionTitleLimits,
  resolveSessionTitleLlmOptions,
  titleFromModelOutput,
  truncateTitleUtf8,
} from './session/title';
import type { SessionTitleLimits, SessionTitleLlmOptions, SessionTitleMessage, SessionTitleOptions } from './session/title';
import type { AgentEvent, StopReason } from './protocol/events';
import type {
  ApprovalHandler,
  PermissionRequest,
} from './protocol/permission';
import type { SubagentNotice, SubagentOutcome, SubagentService } from './domain/subagent';
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
import { createWebSearchTool } from './tools/builtin/web-search';
import type { WebSearchProvider } from './tools/builtin/web-search';
import { createDshShellTool } from './tools/builtin/dsh-shell';
import { createTodoWriteTool } from './tools/builtin/todo-write';
import { createExitPlanModeTool, EXIT_PLAN_MODE_TOOL_NAME } from './tools/builtin/exit-plan-mode';
import type { PlanReviewResponse } from './tools/builtin/exit-plan-mode';
import {
  ASK_USER_DEFAULT_TIMEOUT_SEC,
  ASK_USER_TOOL_NAME,
  createAskUserTool,
  renderLateAskUserAnswer,
} from './tools/builtin/ask-user';
import type { AskUserAnswerItem, AskUserQuestion, AskUserToolResult } from './tools/builtin/ask-user';
import { createSubagentTools, SUBAGENT_TOOL_NAME } from './tools/builtin/subagent';
import { createTeamDelegationTool, renderTeamGuidance } from './tools/builtin/team';
import { createTeamBoardTools, rootBoardHost } from './tools/builtin/team-board';
import type { TeamBoardToolHost } from './tools/builtin/team-board';
import type { TeamMemberSnapshot } from './session/mode-selection';
import { createGoalTools, CREATE_GOAL_TOOL_NAME, GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME } from './tools/builtin/goal';
import { createScheduleTools, renderScheduleToolGuidance, SCHEDULE_TOOL_GROUP } from './schedule/tools';
import type { ScheduleService } from './schedule/service';
import { createAgentAuthoringTools, WRITE_AGENT_DEFINITION_TOOL_NAME } from './agents/authoring';
import type { AgentAuthoringService } from './agents/authoring';
import { createCreatorTools, CREATOR_TOOL_GROUP, renderCreatorToolGuidance } from './creator/tools';
import type { CreatorServices } from './creator/types';
import { TODO_WRITE_EVENT } from './session/todo';
import {
  PLAN_DOCUMENT_EVENT,
  PlanDocumentSchema,
  assertNextPlanVersion,
  nextPlanDocumentId,
  projectPlanDocuments,
} from './session/development-plan';
import { TEAM_TASK_EVENT, boardHasOpenWork } from './session/team-board';
import type { TeamTaskSnapshot } from './session/team-board';
import {
  createPermissionPendingEvent,
  createPlanReviewDecisionEvent,
  createPlanReviewPendingEvent,
  projectPendingPlanReview,
} from './session/plan';
import type { TodoItem } from './session/todo';
import { GoalController, goalRefOf } from './session/goal-controller';
import {
  GOAL_DEFAULT_BLOCKED_AFTER,
  renderGoalGrantGuidance,
  renderGoalRoundPrompt,
  renderGoalToolGuidance,
} from './session/goal';
import { createGoalGrantEvent, projectGoalGrant } from './session/goal-grant';
import type { GoalView } from './session/goal';
import {
  createPlanModeEvent,
  PLAN_MODE_EVENT,
  PLAN_MODE_GUIDANCE,
  projectPlanMode,
} from './session/plan';
import {
  answersForPendingAskUser,
  createAskUserContinuedEvent,
  createAskUserDecisionEvent,
  createAskUserPendingEvent,
  projectPendingAskUser,
} from './session/ask-user';
import { ToolExecutor } from './exec/executor';
import { DSH_PRESET_BUNDLES, isDshPermissionPreset, snapshotDshPermissions } from './permissions/dsh-permissions';
import type { DshPermissionSnapshot, DshSandboxMode } from './permissions/dsh-permissions';
import { checkDshMutation } from './sandbox/dsh-fs';
import type { DshSandboxPolicy } from './sandbox/dsh-policy';
import type { DshSandboxOptions } from './sandbox/dsh-sandbox';
import { AgentLoop, DEFAULT_MAX_STEPS, projectCommandInput } from './loop/agent-loop';
import { estimateMessages } from './context/compaction';
import { projectContext } from './context/projection';
import { projectImageInput } from './context/image-input';
import type { PreparedToolCall } from './loop/agent-loop';
import type { SessionHandle } from './session/store';
import { projectMessages } from './session/projection';
import type { SessionAgent } from './session/runtime';
import type { ModelCapabilities } from './config/models';
import { DEFAULT_SYSTEM_PROMPT } from './prompts';
import { expandInitCommand } from './session/init-command';
import { readWorkspaceInstructions } from './session/workspace-instructions';

const TEAM_BOARD_ROUND_LIMIT = 32;

const TEAM_PLAN_GUIDANCE = [
  'Development plan: while the user is still deciding what to build, ask and restate. Do not create tasks yet.',
  'When the requirements are settled, write one plan and present it with exit_plan_mode. The plan states the goal,',
  'what is out of scope, acceptance, the design (modules, types, interfaces, invariants), and delivery slices.',
  'A slice names its plan heading, acceptance, paths, and which other slices it depends on. It does not name a status.',
  'After the user confirms the plan, create one board task per slice with team_task_create, citing that plan version.',
  'A later user correction is itself the confirmation: append the next plan version with team_plan_revise, then',
  'update tasks that have not started. Do not ask for another plan review.',
].join(' ');

const TEAM_MEMBER_GUIDANCE = [
  'You are a team member with a shared task board. Before working, team_task_get the task you were given and',
  'team_plan_section the cited heading at that plan version. Do only that slice. When it meets the acceptance,',
  'team_task_update action submit. You cannot accept your own task. If you are reviewing, accept only when the',
  'acceptance is met; otherwise return with a note that says what is missing. Do not edit the plan.',
].join(' ');

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
  dshPermissions?: DshPermissionSnapshot;
  /** Trusted host-only sandbox configuration; never populated from tool arguments. */
  dshSandbox?: DshSandboxOptions;
  /** UI 提供：渲染一次确认提示并返回结果。 */
  approve?: (request: PermissionRequest, signal: AbortSignal) => ReturnType<ApprovalHandler>;
  /**
   * UI 提供：审阅计划并决定是否退出 plan 模式。
   * The third argument is the request id already persisted for this review, when
   * the session has one; the prompt must reuse it so a later decision matches.
   */
  reviewPlan?: (plan: string, signal: AbortSignal, requestId?: string) => Promise<PlanReviewResponse>;
  /**
   * UI 提供：向用户提问并等待回答。
   * 时限到达时返回 pending，而不是伪造答案。requestId 复用已持久化的 id。
   * timeoutSec 为 -1 时一直等到回答或取消。
   */
  askUser?: (
    questions: readonly AskUserQuestion[],
    signal: AbortSignal,
    request: { requestId?: string; timeoutSec: number },
  ) => Promise<AskUserToolResult>;
  /** Foreground wait used when a call omits timeout_sec. Defaults to five minutes. */
  askUserTimeoutSec?: number;
  maxSteps?: number;
  /** Extra attempts after a retryable model failure. Defaults to 2. */
  maxRetries?: number;
  contextWindowTokens?: number;
  /** Keep at most this many recent tokens when compacting; clamped to half the budget. */
  retainContextTokens?: number;
  /**
   * The selected model's output ceiling. The loop reserves it out of the context
   * window before deriving how much history it may send; absent falls back to a
   * share of the window (TUI and subagents do not pass it yet).
   */
  outputTokenReserve?: number;
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
  /** Immutable team snapshot. Members can only be delegated from this list. */
  teamMembers?: readonly TeamMemberSnapshot[];
  /** Step budget applied to each delegated team member. */
  teamMaxSteps?: number;
  /** Maximum members of this team that may work at the same time. */
  teamMaxActive?: number;
  /**
   * Shared board on another session's log. Set for a team member so its tools
   * read and update the root board. The root session leaves this unset and uses
   * its own log.
   */
  teamBoard?: TeamBoardToolHost;
  /** Host-wide scheduled tasks; enables the schedule tools. */
  schedule?: ScheduleService;
  /** Optional persisted title plus background model title generation. */
  title?: SessionTitleOptions;
  /** Creator-mode agent definition authoring; enables list/write agent tools. */
  agentAuthoring?: AgentAuthoringService;
  /**
   * Host-provided Creator configuration capabilities (modes, roles, model
   * sources, general settings and MCP). Only interactive Creator sessions
   * receive this object, so ordinary sessions never see these tools.
   */
  creator?: CreatorServices;
  /**
   * Tools discovered from configured MCP servers. They run outside the local
   * sandbox, so they are trusted by the permission layer; the server entry
   * itself is user-authored configuration.
   */
  mcpTools?: readonly Tool[];
  /** Called for events produced by turns started outside a UI send() call. */
  onBackgroundEvent?: (event: AgentEvent) => void;
  /** Latest Tavily credentials for web_search. Absence keeps the tool visible but failing closed. */
  webSearch?: {
    resolve: () => Promise<{ apiKey?: string; maxResults?: number } | undefined> | { apiKey?: string; maxResults?: number } | undefined;
    provider?: WebSearchProvider;
  };
}

/** Observe background-turn events without replacing the listener the host set. */
export interface BackgroundEventSource {
  addBackgroundListener(listener: (event: AgentEvent) => void): () => void;
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
  /**
   * The messages the running turn will actually send, mirrored from the loop.
   * Kept only while a turn is active: the loop owns the authoritative order
   * (including compaction results) and `this.history` is a transcript that may
   * be a step behind.
   */
  #projectionHistory: readonly Message[] | undefined;
  private readonly contextProvider: string;
  private readonly contextModel: string;
  private readonly tools: ToolRegistry;
  private readonly trusted = new Set<Tool>();
  private readonly dshShell?: Tool;
  private readonly dshSandbox?: DshSandboxOptions;
  private readonly dshWrite?: Tool;
  private readonly dshEdit?: Tool;
  private readonly session?: SessionHandle;
  private readonly baseSystem: string;
  private readonly cwdValue: string;
  private readonly workspacePath?: string;
  private readonly agentValue?: SessionAgent;
  private readonly modelCapabilities?: ModelCapabilities;
  private readonly subagents?: SubagentService;
  private readonly creatorServices?: CreatorServices;
  private readonly teamMembers?: readonly TeamMemberSnapshot[];
  private readonly teamMaxActive?: number;
  private readonly teamBoard?: TeamBoardToolHost;
  private readonly reviewPlanHandler?: SessionOptions['reviewPlan'];
  private readonly askUserHandler?: SessionOptions['askUser'];
  private readonly askUserTimeoutSec: number;
  private readonly onBackgroundEvent?: SessionOptions['onBackgroundEvent'];
  private readonly backgroundListeners = new Set<(event: AgentEvent) => void>();
  private readonly titleOptions?: SessionTitleOptions;
  private readonly titleLimits: SessionTitleLimits;
  private readonly titleLlm?: Required<SessionTitleLlmOptions>;
  private titleAttempted = false;
  private titleController?: AbortController;
  private titleGeneration?: Promise<void>;
  private readonly inbox: Message[] = [];
  private readonly inboxWaiters = new Set<() => void>();
  private readonly steerWrites: Promise<void>[] = [];
  private readonly steerInbox: Message[] = [];
  private readonly acceptedSteers: Message[] = [];
  private steerClosed = false;
  private readonly goalController: GoalController;
  private planActive: boolean;
  private compactRequested = false;
  private controller?: AbortController;
  private executing = false;
  private interruptRequested = false;
  /** Tool escalations asked during the current turn and not yet decided. */
  private readonly pendingPermissions = new Map<string, { requestId: string; callId: string; name: string; reason: string }>();
  /** Request id reserved for the plan review the current turn is presenting. */
  private pendingPlanReview?: { requestId: string; callId: string };
  /** Request id reserved for the question the current turn is asking. */
  private pendingAskUser?: { requestId: string; callId: string };
  private turnSource: 'human' | 'goal' | 'external' | 'notice' | 'system' = 'system';
  /** Last event seq when the current turn started. Board continuation compares against it. */
  private boardFloorSeq = -1;
  private currentGoalRound?: GoalRoundContext;
  private goalCreateGrant = false;

  constructor(options: SessionOptions) {
    this.session = options.session;
    this.contextProvider = options.model.name;
    this.contextModel = options.modelId ?? 'fake';
    this.id = options.session?.id ?? options.sessionId ?? `s_${Date.now().toString(36)}`;
    this.#dshPermissions = copyDshPermissions(options.dshPermissions);
    this.dshSandbox = options.dshSandbox && { ...options.dshSandbox };
    this.workspacePath = options.workspace ?? options.session?.header.workspace;
    this.agentValue = options.agent;
    this.modelCapabilities = options.modelCapabilities;
    this.subagents = options.subagents;
    this.creatorServices = options.creator;
    this.teamMembers = options.teamMembers;
    this.teamMaxActive = options.teamMaxActive;
    this.teamBoard = options.teamBoard;
    this.reviewPlanHandler = options.reviewPlan;
    this.askUserHandler = options.askUser;
    this.askUserTimeoutSec = options.askUserTimeoutSec ?? ASK_USER_DEFAULT_TIMEOUT_SEC;
    this.onBackgroundEvent = options.onBackgroundEvent;
    this.titleOptions = options.title;
    this.titleLimits = resolveSessionTitleLimits(options.title);
    this.titleLlm = options.title === undefined ? undefined : resolveSessionTitleLlmOptions(options.title);
    this.baseSystem = options.system ?? DEFAULT_SYSTEM_PROMPT;
    this.cwdValue = options.cwd;
    this.planActive = options.session === undefined
      ? options.planActive ?? false
      : projectPlanMode(options.session.events).active;
    this.goalCreateGrant = options.session === undefined
      ? false
      : projectGoalGrant(options.session.events)?.consumed === false;
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
    const allowedMcp = options.agent?.mcp ?? '*';
    for (const tool of options.mcpTools ?? []) {
      const serverId = tool.name.split('__')[1];
      if (allowedMcp !== '*' && (serverId === undefined || !allowedMcp.has(serverId))) continue;
      if (!allows(tool.name) || this.tools.has(tool.name)) continue;
      this.tools.register(tool);
      // MCP calls execute in the configured server process, not inside the
      // local filesystem sandbox, so the sandbox preset cannot confine them.
      this.trusted.add(tool);
    }
    if (allows('bash') && !this.tools.has('bash')) {
      this.dshShell = createDshShellTool({
        policy: { mode: this.#dshPermissions?.sandbox ?? 'read-only', workspaceRoot: options.cwd },
        sandbox: this.dshSandbox,
      });
      this.tools.register(this.dshShell);
      this.trusted.add(this.dshShell);
    }
    if (allows('read_file')) this.trusted.add(readFileTool);
    if (allows('list_dir')) this.trusted.add(listDirTool);
    if (allows('glob')) this.trusted.add(globTool);
    if (allows('grep')) this.trusted.add(grepTool);
    if (allows('web_fetch')) this.trusted.add(webFetchTool);
    if (allows('web_search') && !this.tools.has('web_search')) {
      const searchTool = createWebSearchTool({
        resolve: async () => {
          const resolved = await options.webSearch?.resolve();
          return resolved?.apiKey === undefined ? undefined : {
            apiKey: resolved.apiKey,
            ...(resolved.maxResults === undefined ? {} : { maxResults: resolved.maxResults }),
          };
        },
        ...(options.webSearch?.provider === undefined ? {} : { provider: options.webSearch.provider }),
      });
      this.tools.register(searchTool);
      this.trusted.add(searchTool);
    }
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
        review: (plan, signal) => this.reviewPlanHandler!(plan, signal, this.pendingPlanReview?.requestId),
        onApproved: async () => {
          await this.applyPlanMode(false);
          const plan = this.latestPlanBody();
          if (plan !== undefined) await this.confirmDevelopmentPlan(plan);
        },
      });
      this.tools.register(exitPlanTool);
      this.trusted.add(exitPlanTool);
    }

    if (allows(ASK_USER_TOOL_NAME) && this.askUserHandler) {
      const askUserTool = createAskUserTool({
        defaultTimeoutSec: this.askUserTimeoutSec,
        callId: () => this.pendingAskUser?.callId,
        ask: async (request) => {
          if (this.depth !== 0 || this.parentSessionId !== undefined) {
            throw new Error(
              'ask_user is unavailable while this agent is owned by another live agent; '
              + 'include the unresolved question in the final result',
            );
          }
          const reserved = this.pendingAskUser?.requestId;
          const result = await this.askUserHandler!(request.questions, request.signal, {
            ...(reserved === undefined ? {} : { requestId: reserved }),
            timeoutSec: request.timeoutSec,
          });
          if ('pending' in result && result.pending && this.pendingAskUser !== undefined && this.session !== undefined) {
            await this.session.append(createAskUserContinuedEvent(this.pendingAskUser));
          }
          return result;
        },
      });
      this.tools.register(askUserTool);
      this.trusted.add(askUserTool);
    }

    for (const tool of createGoalTools(this)) {
      if (!allows(tool.name)) continue;
      this.tools.register(tool);
      this.trusted.add(tool);
    }

    if (this.subagents && this.teamMembers !== undefined && this.teamMembers.length > 0) {
      const teamTool = createTeamDelegationTool(
        this,
        this.subagents,
        this.teamMembers,
        options.teamMaxSteps,
        this.teamMaxActive,
      );
      this.tools.register(teamTool);
      this.trusted.add(teamTool);
    }

    const boardHost = this.teamBoardHost();
    if (boardHost !== undefined) {
      for (const tool of createTeamBoardTools(boardHost)) {
        if (!allows(tool.name)) continue;
        this.tools.register(tool);
        this.trusted.add(tool);
      }
    }

    if (this.subagents) {
      for (const tool of createSubagentTools(this, this.subagents)) {
        // Team mode delegates only through the configured member list; the
        // generic subagent tool would bypass that snapshot.
        if (this.teamMembers !== undefined && tool.name === SUBAGENT_TOOL_NAME) continue;
        if (!allows(tool.name)) continue;
        this.tools.register(tool);
        this.trusted.add(tool);
      }
    }

    if (options.schedule) {
      for (const tool of createScheduleTools(this, options.schedule)) {
        if (!allows(tool.name)) continue;
        this.tools.register(tool);
        this.trusted.add(tool);
      }
    }

    if (options.agentAuthoring) {
      for (const tool of createAgentAuthoringTools(options.agentAuthoring)) {
        if (!allows(tool.name)) continue;
        this.tools.register(tool);
        this.trusted.add(tool);
      }
    }

    if (options.creator) {
      for (const tool of createCreatorTools(options.creator)) {
        if (!allows(tool.name)) continue;
        this.tools.register(tool);
        this.trusted.add(tool);
      }
    }

    this.loop = new AgentLoop({
      model: options.model,
      modelId: options.modelId ?? 'fake',
      ...(options.modelCapabilities === undefined ? {} : { imageInput: options.modelCapabilities.imageInput }),
      system: () => this.systemText(),
      tools: this.tools,
      toolSpecs: () => this.visibleToolSpecs(),
      takeQueuedMessages: () => this.consumeSteers(this.steerInbox.splice(0)).concat(this.inbox.splice(0)),
      beforeNaturalEnd: () => this.drainSteers(),
      afterToolBatch: (signal) => this.settleStartedChildren(signal),
      takeForceCompact: () => {
        const requested = this.compactRequested;
        this.compactRequested = false;
        return requested;
      },
      permissions: { check: async () => ({ decision: 'deny', source: 'DSH execution policy required' }) },
      prepareToolCall: (call, signal) => this.prepareToolCall(call, signal, this.tools, cwd, approve),
      cwd,
      sessionId: this.id,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.contextWindowTokens === undefined ? {} : { contextWindowTokens: options.contextWindowTokens }),
      ...(options.retainContextTokens === undefined ? {} : { retainContextTokens: options.retainContextTokens }),
      ...(options.outputTokenReserve === undefined ? {} : { outputTokenReserveTokens: options.outputTokenReserve }),
      // Contract from the loop: called synchronously, never awaited. This only
      // assigns a reference, so it cannot throw mid-turn.
      onTurnHistory: (messages) => { this.#projectionHistory = messages; },
      ...(options.audit ? { audit: options.audit } : {}),
    });
  }

  get dshPermissions(): DshPermissionSnapshot | undefined {
    return this.#dshPermissions;
  }

  get messages(): readonly Message[] {
    return this.history;
  }

  /**
   * Projection of the next request.
   *
   * During a turn the loop owns the mutable history, so the mirror it published
   * at the last step boundary is what the next request will carry — compacted
   * history included. Reading `this.history` mid-turn would show a stale,
   * larger transcript that the next step never sends.
   */
  contextProjection(): ReturnType<typeof projectContext> | undefined {
    const history = this.activeTurn ? this.#projectionHistory ?? this.history : this.history;
    return projectContext(projectImageInput(projectCommandInput(prepareModelHistory(history).messages), this.modelCapabilities?.imageInput), this.systemText(), this.visibleToolSpecs(),
      this.contextProvider, this.contextModel);
  }

  /** Estimate the prepared history for the next request, mid-turn included. */
  contextMessageEstimate(): number | undefined {
    const history = this.activeTurn ? this.#projectionHistory ?? this.history : this.history;
    return estimateModelHistory(history, this.modelCapabilities?.imageInput);
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

  /** Configured team member ids, present only on a team root. Children use this to join the board. */
  get teamMemberIds(): readonly string[] | undefined {
    return this.teamMembers?.map((member) => member.id);
  }

  get agent(): SessionAgent | undefined {
    return this.agentValue;
  }

  private allowsTool(name: string): boolean {
    const tools = this.agentValue?.tools;
    if (tools === undefined || tools === '*') return true;
    // The shared board is a session capability, like delegation. A member agent
    // allowlist must not strip it, or the member cannot claim or submit work.
    if (this.teamBoard !== undefined && name.startsWith('team_')) return true;
    if (this.teamMembers !== undefined && (name.startsWith('team_') || name === SUBAGENT_TOOL_NAME)) return true;
    return tools.has(name);
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
    const parts = [this.baseSystem, readWorkspaceInstructions(this.workspacePath ?? this.cwdValue)];
    if (this.planActive) parts.push(PLAN_MODE_GUIDANCE);
    if (this.hasGoalTools()) parts.push(renderGoalToolGuidance(GOAL_DEFAULT_BLOCKED_AFTER));
    if (this.goalCreateGrant && this.allowsTool(CREATE_GOAL_TOOL_NAME)) parts.push(renderGoalGrantGuidance());
    if (this.teamMembers !== undefined && this.teamMembers.length > 0) {
      parts.push(renderTeamGuidance(this.teamMembers, this.teamMaxActive ?? this.teamMembers.length));
      parts.push(TEAM_PLAN_GUIDANCE);
    }
    if (this.teamBoard !== undefined) parts.push(TEAM_MEMBER_GUIDANCE);
    if (this.hasScheduleTools()) parts.push(renderScheduleToolGuidance());
    if (this.hasCreatorTools()) parts.push(renderCreatorToolGuidance());
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

  private hasScheduleTools(): boolean {
    return SCHEDULE_TOOL_GROUP.some((name) => this.allowsTool(name));
  }

  private hasCreatorTools(): boolean {
    return this.creatorServices !== undefined && CREATOR_TOOL_GROUP.some((name) => this.allowsTool(name));
  }

  get sessionHandle(): SessionHandle | undefined {
    return this.session;
  }

  get activeTurn(): boolean {
    return this.controller !== undefined || this.executing;
  }

  /**
   * Receive events from turns this session starts on its own, such as the turn
   * that carries out an approved plan. The returned function removes the listener.
   */
  addBackgroundListener(listener: (event: AgentEvent) => void): () => void {
    this.backgroundListeners.add(listener);
    return () => { this.backgroundListeners.delete(listener); };
  }

  private emitBackground(event: AgentEvent): void {
    this.onBackgroundEvent?.(event);
    for (const listener of this.backgroundListeners) listener(event);
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

  /** Allow the next direct human turn to create one goal, then consume the grant. */
  async grantGoalCreation(): Promise<void> {
    if (this.depth !== 0 || this.parentSessionId !== undefined) {
      throw new Error('A team member cannot grant goal creation');
    }
    if (this.session) {
      const messageSeq = this.session.events.filter((event) => event.type === 'message/user').length;
      await this.session.append(createGoalGrantEvent(messageSeq));
    }
    this.goalCreateGrant = true;
  }

  assertGoalCreateGrant(): void {
    this.assertGoalDirectHuman();
    if (!this.goalCreateGrant) {
      throw new Error('create_goal requires an explicit user goal grant');
    }
    this.goalCreateGrant = false;
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

  trackStartedChild?(childId: string): void {
    this.subagents?.trackChild(this, childId);
  }

  private async settleStartedChildren(signal: AbortSignal): Promise<Message[]> {
    if (!this.subagents) return [];
    const outcomes = await this.subagents.waitForStartedChildren(this, signal);
    return outcomes.map((outcome) => userMessage(
      `Subagent ${outcome.id} finished with status ${outcome.status}.${outcome.result ? ` Result:\n${outcome.result}` : ''}`,
    ));
  }

  /** Resolve when a message or notice is waiting for the next model step. */
  async waitForInput(timeoutMs: number, signal: AbortSignal): Promise<{ timedOut: boolean }> {
    if (this.inbox.length > 0 || this.steerInbox.length > 0) return { timedOut: false };
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
        if (this.inbox.length > 0 || this.steerInbox.length > 0) finish(() => resolve({ timedOut: false }));
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
    if (this.executing) this.interruptRequested = true;
    this.controller?.abort();
  }

  /** Compact older history before the next model request in this session. */
  requestCompaction(): void {
    if (this.executing) throw new Error('Context cannot be compacted during an active turn');
    this.compactRequested = true;
  }

  /** Persist a plan-mode selection. UI callers reject changes during active turns. */
  async setPlanMode(active: boolean): Promise<void> {
    if (typeof active !== 'boolean') throw new TypeError('Plan mode state must be a boolean');
    if (this.executing) throw new Error('Plan mode cannot change during an active turn');
    if (this.session !== undefined && projectPendingPlanReview(this.session.events) !== null) {
      throw new Error('Plan mode cannot change while a plan review is pending');
    }
    if (active && this.reviewPlanHandler === undefined) {
      throw new Error('Plan mode requires a review handler');
    }
    await this.applyPlanMode(active);
  }

  private async applyPlanMode(active: boolean): Promise<void> {
    if (typeof active !== 'boolean') throw new TypeError('Plan mode state must be a boolean');
    if (this.planActive === active) return;
    if (this.session) await this.session.append(createPlanModeEvent(active));
    this.planActive = active;
  }

  /**
   * Consume events yourself; when persistence is enabled messages/traces are
   * written first. Content-part input carries an already composed user message
   * (text and/or images), while a plain string preserves the legacy event shape.
   */
  async *send(input: string | readonly ContentPart[]): AsyncGenerator<AgentEvent> {
    if (this.executing) throw new Error('A turn is already active in this session');
    const content = typeof input === 'string' ? userMessage(input).content : input.slice();
    if (content.length === 0) throw new Error('A non-empty message is required');
    if (!content.some((part) => part.type === 'image' || (part.type === 'text' && part.text.trim() !== ''))) {
      throw new Error('A non-empty message is required');
    }
    this.executing = true;
    try {
      const message: Message = expandInitCommand(content) === undefined
        ? { role: 'user', content }
        : { role: 'user', content, initCommand: true };
      this.history.push(message);
      await this.appendMessage('message/user', typeof input === 'string' ? { text: input } : { content });
      const title = await this.ensureTitle();
      if (title !== undefined) yield { type: 'session.title', title };
      const granted = this.goalCreateGrant;
      try {
        yield* this.runGoalChain(false, 'human');
      } finally {
        if (granted) this.goalCreateGrant = false;
      }
    } finally {
      this.executing = false;
      this.interruptRequested = false;
      this.resumeQueuedBackground();
    }
  }

  /**
   * Continue a plan review whose turn ended before the user answered.
   *
   * The decision is written first, then the matching tool result, and only then
   * does a new turn start. Approval is what leaves plan mode; sending the plan
   * back keeps it active and gives the model the feedback. A decision for a
   * review that is no longer pending does nothing and starts no turn.
   */
  async resumePlanReview(decision: { requestId: string; approved: boolean; feedback?: string }): Promise<boolean> {
    if (this.executing || this.session === undefined) return false;
    const pending = projectPendingPlanReview(this.session.events);
    if (pending === null || pending.requestId !== decision.requestId) return false;
    if (projectPlanMode(this.session.events).active !== true) return false;
    if (this.history.some((message) => message.role === 'tool'
      && message.results.some((result) => result.callId === pending.callId))) return false;
    const feedback = decision.feedback?.trim() ?? '';
    await this.session.append(createPlanReviewDecisionEvent({
      requestId: pending.requestId,
      callId: pending.callId,
      approved: decision.approved,
      ...(feedback === '' ? {} : { feedback }),
    }));
    if (decision.approved) {
      await this.applyPlanMode(false);
      await this.confirmDevelopmentPlan(pending.plan);
    }
    const content = decision.approved
      ? 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
      : feedback === ''
        ? 'The user chose to keep planning; revise the plan and present it again.'
        : `The user chose to keep planning; their feedback: ${feedback}`;
    const result = {
      callId: pending.callId,
      name: EXIT_PLAN_MODE_TOOL_NAME,
      ok: decision.approved,
      content,
      truncated: false,
    };
    await this.appendMessage('message/tool-result', { result });
    const previous = this.history.at(-1);
    if (previous?.role === 'tool') previous.results.push(result);
    else this.history.push({ role: 'tool', results: [result] });
    this.runBackgroundTurn('external');
    return true;
  }

  /**
   * Accept an answer or cancellation for the question this session is still asking.
   *
   * An open question finishes the tool call and continues the turn. A question
   * whose wait already expired keeps that pending tool result and delivers the
   * answer as a user message. A second answer, or one for a closed question,
   * does nothing.
   */
  async resumeAskUser(input: {
    requestId: string;
    action: 'answer' | 'cancel';
    answers?: readonly AskUserAnswerItem[];
  }): Promise<boolean> {
    if (this.session === undefined) return false;
    const pending = projectPendingAskUser(this.session.events);
    if (pending === null || pending.requestId !== input.requestId) return false;
    if (input.action === 'cancel') {
      await this.session.append(createAskUserDecisionEvent({
        requestId: pending.requestId,
        callId: pending.callId,
        kind: 'cancel',
      }));
      if (pending.state === 'open') {
        await this.finishOpenAskUser(pending.callId, {
          ok: false,
          content: 'ask_user was cancelled before the user answered',
        });
      }
      return true;
    }
    let answers: AskUserAnswerItem[];
    try {
      answers = answersForPendingAskUser(pending, input.answers ?? []);
    } catch {
      return false;
    }
    await this.session.append(createAskUserDecisionEvent({
      requestId: pending.requestId,
      callId: pending.callId,
      kind: 'answer',
      answers,
    }));
    if (pending.state === 'open') {
      const { renderAskUserResult } = await import('./tools/builtin/ask-user');
      await this.finishOpenAskUser(pending.callId, {
        ok: true,
        content: renderAskUserResult({ answers }),
      });
      return true;
    }
    const text = renderLateAskUserAnswer({ callId: pending.callId, questions: pending.questions, answers });
    const message = userMessage(text);
    this.history.push(message);
    await this.appendMessage('message/user', {
      text,
      source: { kind: 'ask-user-reply', callId: pending.callId, outcome: 'answered' },
    });
    if (this.executing) {
      this.inbox.push(message);
      this.notifyInbox();
    } else {
      this.runBackgroundTurn('external');
    }
    return true;
  }

  /** Write the tool result for a question whose call is still open, then continue. */
  private async finishOpenAskUser(callId: string, result: { ok: boolean; content: string }): Promise<void> {
    const toolResult = {
      callId,
      name: ASK_USER_TOOL_NAME,
      ok: result.ok,
      content: result.content,
      truncated: false,
    };
    await this.appendMessage('message/tool-result', { result: toolResult });
    const previous = this.history.at(-1);
    if (previous?.role === 'tool') previous.results.push(toolResult);
    else this.history.push({ role: 'tool', results: [toolResult] });
    if (!this.executing) this.runBackgroundTurn('external');
  }

  /**
   * Deliver a direct human message into the active turn. The model sees it at
   * the next step, so the turn keeps streaming instead of being restarted.
   */
  async deliverUserMessage(input: string | readonly ContentPart[]): Promise<'queued'> {
    if (!this.executing || this.steerClosed) throw new SteerNotAcceptedError();
    const content = typeof input === 'string' ? userMessage(input).content : input.slice();
    if (content.length === 0
      || !content.some((part) => part.type === 'image' || (part.type === 'text' && part.text.trim() !== ''))) {
      throw new Error('A non-empty message is required');
    }
    const message: Message = expandInitCommand(content) === undefined
      ? { role: 'user', content }
      : { role: 'user', content, initCommand: true };
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const write = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    this.steerWrites.push(write);
    try {
      await this.appendMessage('message/user', typeof input === 'string'
        ? { text: input, source: { kind: 'steer', state: 'accepted_pending' } }
        : { content, source: { kind: 'steer', state: 'accepted_pending' } });
      this.history.push(message);
      this.acceptedSteers.push(message);
      this.steerInbox.push(message);
      this.notifyInbox();
      finish();
      return 'queued';
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      const index = this.steerWrites.indexOf(write);
      if (index >= 0) this.steerWrites.splice(index, 1);
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
        this.boardFloorSeq = this.session?.events.at(-1)?.seq ?? -1;
        const reason = yield* this.runTurn(background);
        if (reason === 'error' || reason === 'max_tokens' || reason === 'max_steps') {
          this.goalController.disarm();
        } else if (source === 'goal' && reason === 'interrupted') {
          await this.pauseGoalAfterCancelledRound();
        }
        if (reason !== 'end_turn' && reason !== 'tool_use') return;
        const next = await this.nextGoalRound();
        if (next !== undefined) {
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
          continue;
        }
        const board = this.nextBoardRound();
        if (board === undefined) return;
        await this.appendMessage('message/user', {
          text: board,
          source: { kind: 'team-board' },
        });
        this.history.push(userMessage(board));
        source = 'external';
        goalRound = undefined;
        continue;
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

  /**
   * One more coordinator turn while the shared board still has work.
   * Only the root of a team, and only when no armed goal already claimed the
   * next round. The prompt tells the model to read the board; it does not copy it.
   */
  private nextBoardRound(): string | undefined {
    if (this.depth !== 0 || this.teamMembers === undefined || this.session === undefined) return undefined;
    if (!boardHasOpenWork(this.session.events)) return undefined;
    const rounds = this.session.events.filter((event) => event.type === 'message/user'
      && typeof event.data === 'object' && event.data !== null
      && (event.data as { source?: { kind?: string } }).source?.kind === 'team-board').length;
    if (rounds >= TEAM_BOARD_ROUND_LIMIT) return undefined;
    // Continue only when the turn that just finished appended a task. The floor
    // is the last event before that turn, so approving the plan and creating
    // the tasks schedules one read, and the read itself does not schedule another.
    if (!this.boardChangedSince({ seq: this.boardFloorSeq })) return undefined;
    return '<team_board>\n'
      + 'The shared task board still has unfinished work. Read it with team_task_list before acting. '
      + 'Delegate ready pending tasks, submit nothing yourself, and have a different member accept reviews. '
      + 'If the user changed the plan, update the plan document and the tasks that have not started, then '
      + 'send_message the members already working. Leave finished tasks as they are.\n'
      + '</team_board>';
  }

  private boardChangedSince(since: { seq: number }): boolean {
    if (this.session === undefined) return false;
    const floor = since?.seq ?? -1;
    return this.session.events.some((event) => event.seq > floor && event.type === TEAM_TASK_EVENT);
  }

  private teamBoardHost(): TeamBoardToolHost | undefined {
    if (this.teamBoard !== undefined) return this.teamBoard;
    if (this.depth !== 0 || this.teamMembers === undefined || this.session === undefined) return undefined;
    const handle = this.session;
    return rootBoardHost({
      sessionId: this.id,
      events: () => handle.events,
      appendTask: async (task: TeamTaskSnapshot) => {
        await handle.append({ type: TEAM_TASK_EVENT, data: { version: 1, task } });
      },
      revisePlan: (id, body) => this.reviseDevelopmentPlan(id, body),
    });
  }

  /**
   * Record a confirmed development plan on this session.
   * Called when the user approves a plan review in a team session. Later edits
   * go through the model, which appends the next version of the same id.
   */
  async confirmDevelopmentPlan(body: string): Promise<void> {
    if (this.depth !== 0 || this.teamMembers === undefined || this.session === undefined) return;
    const title = planTitle(body);
    if (title === undefined) return;
    const events = this.session.events;
    const existing = projectPlanDocuments(events);
    const id = existing.length === 1 ? existing[0]!.id : nextPlanDocumentId(events);
    const version = existing.find((document) => document.id === id)?.version;
    const next = (version ?? 0) + 1;
    assertNextPlanVersion(events, id, next);
    const document = PlanDocumentSchema.parse({
      id,
      version: next,
      title,
      body: body.trim(),
      confirmedAt: Date.now(),
    });
    await this.session.append({ type: PLAN_DOCUMENT_EVENT, data: document });
  }

  /** Append the next version of one confirmed plan. The coordinator calls this after the user corrects the plan. */
  async reviseDevelopmentPlan(id: string, body: string): Promise<void> {
    if (this.depth !== 0 || this.teamMembers === undefined || this.session === undefined) {
      throw new Error('only the team coordinator can revise a development plan');
    }
    const title = planTitle(body);
    if (title === undefined) throw new Error('a development plan needs a level-one heading');
    const events = this.session.events;
    const current = projectPlanDocuments(events).find((document) => document.id === id);
    if (current === undefined) throw new Error(`unknown plan ${id}`);
    const version = current.version + 1;
    assertNextPlanVersion(events, id, version);
    const document = PlanDocumentSchema.parse({
      id,
      version,
      title,
      body: body.trim(),
      confirmedAt: Date.now(),
    });
    await this.session.append({ type: PLAN_DOCUMENT_EVENT, data: document });
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
    const controller = new AbortController();
    this.controller = controller;
    this.steerClosed = false;
    if (this.interruptRequested) controller.abort();
    let generator: AsyncGenerator<AgentEvent, Message[]> | undefined;
    let terminal = false;
    let failed = false;
    let recordedError = false;
    let pendingAudit = false;
    let compactedThisTurn = false;
    let partialAssistantText = '';
    let stopReason: StopReason = 'interrupted';

    try {
      // Seeded from the transcript so the first mid-turn reading is available
      // before the loop publishes its first step; the loop corrects it next.
      this.#projectionHistory = this.history;
      const modelHistory = prepareModelHistory(this.history);
      generator = this.loop.run(modelHistory.messages, controller.signal);

      while (true) {
        const next = await generator.next();
        pendingAudit = false;
        if (next.done) {
          // Adopt the loop's history unless the only difference is a repair:
          // the transcript stays an exact record of events, so placeholder tool
          // results are never written back. A compaction this turn produced is
          // adopted even then, otherwise the next turn would compact the same
          // messages again and the idle reading would jump back to pre-compaction.
          // No event is appended for either case.
          if (!modelHistory.repaired || compactedThisTurn) this.history = withoutOmittedAssistants(next.value);
          for (const steer of this.acceptedSteers.splice(0)) {
            if (!this.history.includes(steer)) this.history.push(steer);
          }
          return stopReason;
        }

        const event = next.value;
        if (controller.signal.aborted && event.type !== 'tool.result'
          && !(event.type === 'turn.end' && event.reason === 'interrupted')) continue;
        if (controller.signal.aborted && event.type === 'turn.end' && event.reason !== 'interrupted') continue;
        if (event.type === 'assistant.delta') partialAssistantText += event.text;
        if (event.type === 'assistant.message') partialAssistantText = '';
        if (event.type === 'context.compacted') compactedThisTurn = true;
        if (event.type === 'tool.result') pendingAudit = true;
        if (event.type === 'permission.decided' || event.type === 'tool.result') {
          const callId = event.type === 'permission.decided' ? event.callId : event.result.callId;
          this.pendingPermissions.delete(callId);
          if (event.type === 'tool.result' && event.result.callId === this.pendingPlanReview?.callId) {
            this.pendingPlanReview = undefined;
          }
          if (event.type === 'tool.result' && event.result.callId === this.pendingAskUser?.callId) {
            this.pendingAskUser = undefined;
          }
        }
        if (event.type === 'assistant.message') {
          await this.appendMessage('message/assistant', event.message);
          this.history.push(event.message);
        } else if (event.type === 'tool.result') {
          await this.appendMessage('message/tool-result', { result: event.result });
          const previous = this.history.at(-1);
          if (previous?.role === 'tool') previous.results.push(event.result);
          else this.history.push({ role: 'tool', results: [event.result] });
        }
        if (event.type === 'turn.end') {
          this.steerClosed = true;
          await Promise.allSettled(this.steerWrites);
        }
        if (event.type === 'turn.end' && event.reason === 'interrupted' && partialAssistantText !== '') {
          await this.persistInterruptedAssistant(partialAssistantText);
          partialAssistantText = '';
        }
        await this.appendTrace(event);
        if (event.type === 'turn.end') {
          terminal = true;
          stopReason = event.reason;
          this.steerClosed = true;
        }
        if (event.type === 'error') {
          recordedError = true;
          failed = true;
        }
        if (background) this.emitBackground(event);
        yield event;
      }
    } catch (error) {
      if (controller.signal.aborted && !failed) {
        if (!terminal) {
          const event: AgentEvent = { type: 'turn.end', reason: 'interrupted' };
          await this.appendTrace(event);
          terminal = true;
          if (partialAssistantText !== '') await this.persistInterruptedAssistant(partialAssistantText);
          if (background) this.emitBackground(event);
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
              const reason = failed ? 'error' : 'interrupted';
              if (reason === 'interrupted' && partialAssistantText !== '') {
                await this.persistInterruptedAssistant(partialAssistantText);
                partialAssistantText = '';
              }
              await this.appendTrace({ type: 'turn.end', reason });
            }
          } finally {
            if (!failed) await this.recordAbandonedPermissions();
            this.#projectionHistory = undefined;
            this.steerClosed = true;
            await Promise.allSettled(this.steerWrites);
            if (controller.signal.aborted) this.steerInbox.length = 0;
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

  private async drainSteers(): Promise<Message[]> {
    while (this.steerWrites.length > 0) await Promise.allSettled([...this.steerWrites]);
    if (this.controller?.signal.aborted) return [];
    const queued = this.steerInbox.splice(0);
    if (queued.length === 0) this.steerClosed = true;
    return this.consumeSteers(queued);
  }

  private consumeSteers(queued: Message[]): Message[] {
    const consumed = new Set(queued);
    this.acceptedSteers.splice(0, this.acceptedSteers.length, ...this.acceptedSteers.filter((message) => !consumed.has(message)));
    return queued;
  }

  /** Keep only visible text published since the last complete assistant message. */
  private async persistInterruptedAssistant(content: string): Promise<void> {
    if (content === '') return;
    await this.appendMessage('message/assistant', {
      role: 'assistant', content: [text(content)], toolCalls: [], display: 'partial', context: 'omit',
    });
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
        this.interruptRequested = false;
        this.resumeQueuedBackground();
      }
    })();
  }

  private resumeQueuedBackground(): void {
    if (this.executing || this.controller !== undefined || this.inbox.length === 0) return;
    this.inbox.length = 0;
    this.runBackgroundTurn('external');
  }

  /**
   * Persist a plan review before its prompt starts waiting.
   *
   * The request id is allocated here and reused by the prompt, so a decision
   * made after a restart still matches the record. The call id is the plan the
   * model just submitted.
   */
  private async recordPlanReview(plan: string): Promise<void> {
    const callId = this.latestPlanCallId();
    if (callId === undefined || this.session === undefined) return;
    const { randomUUID } = await import('node:crypto');
    const requestId = randomUUID();
    this.pendingPlanReview = { requestId, callId };
    await this.session.append(createPlanReviewPendingEvent({ requestId, callId, plan }));
  }

  /**
   * Persist a question before its prompt starts waiting.
   *
   * The request id is allocated here and reused by the prompt, so an answer
   * made after a restart still matches the record.
   */
  private async recordAskUser(questions: readonly unknown[]): Promise<void> {
    const callId = this.latestToolCallId(ASK_USER_TOOL_NAME);
    if (callId === undefined || this.session === undefined) return;
    const { randomUUID } = await import('node:crypto');
    const { parseAskUserQuestions, parseAskUserTimeout } = await import('./tools/builtin/ask-user');
    let parsed: AskUserQuestion[];
    try {
      parsed = parseAskUserQuestions({ questions });
    } catch {
      return;
    }
    const args = this.latestToolArguments(ASK_USER_TOOL_NAME);
    const timeoutSec = parseAskUserTimeout(
      args !== undefined && typeof args === 'object' && args !== null && !Array.isArray(args)
        ? (args as { timeout_sec?: unknown }).timeout_sec
        : undefined,
      this.askUserTimeoutSec,
    );
    const requestId = randomUUID();
    this.pendingAskUser = { requestId, callId };
    await this.session.append(createAskUserPendingEvent({ requestId, callId, questions: parsed, timeoutSec }));
  }

  /** The call the model just submitted, which the review record has to point at. */
  private latestPlanBody(): string | undefined {
    const args = this.latestToolArguments(EXIT_PLAN_MODE_TOOL_NAME);
    if (typeof args !== 'object' || args === null || !('plan' in args)) return undefined;
    const plan = (args as { plan?: unknown }).plan;
    return typeof plan === 'string' ? plan : undefined;
  }

  private latestPlanCallId(): string | undefined {
    return this.latestToolCallId(EXIT_PLAN_MODE_TOOL_NAME);
  }

  private latestToolCallId(name: string): string | undefined {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const message = this.history[index];
      if (message?.role !== 'assistant') continue;
      const call = message.toolCalls.findLast((item) => item.name === name);
      return call?.id;
    }
    return undefined;
  }

  private latestToolArguments(name: string): unknown {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const message = this.history[index];
      if (message?.role !== 'assistant') continue;
      return message.toolCalls.findLast((item) => item.name === name)?.arguments;
    }
    return undefined;
  }

  /**
   * Remember an escalation the turn stopped before the user answered.
   *
   * The record is not a grant. Reopening the session shows that the call was
   * waiting; it does not execute the call or carry the approval forward.
   */
  private async recordAbandonedPermissions(): Promise<void> {
    const pending = [...this.pendingPermissions.values()];
    this.pendingPermissions.clear();
    if (this.session === undefined) return;
    for (const request of pending) {
      try {
        await this.session.append(createPermissionPendingEvent(request));
      } catch {
        // A record that cannot be persisted must not block the turn from ending.
      }
    }
  }

  private planDenies(name: string): boolean {
    const tool = this.tools.get(name);
    return name === 'bash'
      || name === SUBAGENT_TOOL_NAME
      || name === WRITE_AGENT_DEFINITION_TOOL_NAME
      || tool?.mutating === true;
  }

  private visibleToolSpecs(): ToolSpec[] {
    return this.tools.specs().filter((tool) => {
      if (tool.name === EXIT_PLAN_MODE_TOOL_NAME) return this.planActive;
      if (this.planActive && this.planDenies(tool.name)) return false;
      if (tool.name === CREATE_GOAL_TOOL_NAME) return this.goalCreateGrant;
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
    if (this.planActive && this.planDenies(call.name)) return deny('This tool is unavailable while plan mode is active');
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

    if (tool?.name === EXIT_PLAN_MODE_TOOL_NAME) {
      if (!this.planActive) return deny('exit_plan_mode is only available in plan mode');
      const plan = typeof args === 'object' && args !== null && !Array.isArray(args)
        ? (args as { plan?: unknown }).plan : undefined;
      if (typeof plan !== 'string') return deny('exit_plan_mode requires a plan');
      await this.recordPlanReview(plan);
      signal.throwIfAborted();
    }
    if (tool?.name === SUBAGENT_TOOL_NAME && (!this.subagents || !this.subagents.canStart(this))) {
      return deny('Subagent delegation depth or capacity is exhausted');
    }
    if (tool?.name === ASK_USER_TOOL_NAME) {
      if (this.depth !== 0 || this.parentSessionId !== undefined) {
        return deny('ask_user is unavailable to a delegated agent');
      }
      const questions = typeof args === 'object' && args !== null && !Array.isArray(args)
        ? (args as { questions?: unknown }).questions : undefined;
      if (!Array.isArray(questions) || questions.length === 0) return deny('ask_user requires at least one question');
      await this.recordAskUser(questions);
      signal.throwIfAborted();
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
    else if (tool === this.dshShell) selected = createDshShellTool({ policy, sandbox: this.dshSandbox });
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
    const { randomUUID } = await import('node:crypto');
    this.pendingPermissions.set(request.call.id, {
      requestId: randomUUID(),
      callId: request.call.id,
      name: request.call.name,
      reason: request.reason,
    });
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
      case 'error': {
        // Structured provider failures carry a redacted, bounded summary.
        // Everything else can contain credentials or conversation content.
        if (event.error.code === undefined && event.error.status === undefined) {
          await this.appendMessage('trace/error', { message: 'An error occurred during the turn.' });
          break;
        }
        await this.appendMessage('trace/error', {
          message: event.error.message,
          ...(event.error.code === undefined ? {} : { code: event.error.code }),
          ...(event.error.status === undefined ? {} : { status: event.error.status }),
          ...(event.error.retryable === undefined ? {} : { retryable: event.error.retryable }),
        });
        break;
      }
    }
  }

  /**
   * Materialize the deterministic fallback and, when configured, start one
   * non-blocking model title attempt for the first human message.
   * @returns the newly written fallback title, if one was created.
   */
  private async ensureTitle(): Promise<string | undefined> {
    const options = this.titleOptions;
    const handle = this.session;
    if (options === undefined || handle === undefined) return;
    try {
      const first = collectSessionTitleMessages(handle.events)[0];
      if (first === undefined) return;
      let current = foldSessionTitle(handle.events);
      if (current?.source.kind === 'user') return;
      let fallbackTitle: string | undefined;
      if (current === undefined) {
        const fallback = fallbackSessionTitle(
          first.text,
          this.titleLimits.fallbackMaxWords,
          this.titleLimits.fallbackMaxBytes,
        );
        if (fallback.length === 0) return;
        await handle.append({
          type: SESSION_TITLE_EVENT,
          data: {
            title: fallback,
            messageSeqs: [first.seq],
            source: { kind: 'fallback' },
          },
        });
        current = foldSessionTitle(handle.events);
        fallbackTitle = current?.title;
      }
      if (this.titleAttempted || this.titleLlm === undefined
        || options.model === undefined || options.modelId === undefined) return fallbackTitle;
      // The model title is only for the root conversation, never a subagent.
      if (this.depth !== 0 || this.parentSessionId !== undefined) return fallbackTitle;
      if (current?.source.kind === 'provider') return fallbackTitle;
      this.titleAttempted = true;
      this.titleGeneration = this.generateModelTitle(first, options);
      void this.titleGeneration.catch(() => undefined);
      return fallbackTitle;
    } catch {
      // Title persistence must never fail the user's turn.
    }
  }

  /** Run one auxiliary title request and replace the fallback only on success. */
  private async generateModelTitle(
    first: SessionTitleMessage,
    options: SessionTitleOptions,
  ): Promise<void> {
    const handle = this.session;
    const llm = this.titleLlm;
    const model = options.model;
    const modelId = options.modelId;
    if (handle === undefined || llm === undefined || model === undefined || modelId === undefined) return;
    const controller = new AbortController();
    this.titleController = controller;
    try {
      const text = truncateTitleUtf8(first.text, Math.max(256, llm.maxInputBytes - 256));
      const input = `Generate the session title from this JSON array of human messages:\n${JSON.stringify([{ seq: first.seq, text }])}`;
      if (Buffer.byteLength(input, 'utf8') > llm.maxInputBytes) return;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(llm.timeoutMs)]);
      const response = await model.complete({
        model: modelId,
        system: renderTitleSystemPrompt(llm),
        messages: [userMessage(input)],
        tools: [],
        maxTokens: llm.maxOutputTokens,
        signal,
      });
      if (response.stopReason !== 'end_turn' || response.message.toolCalls.length > 0) return;
      const title = normalizeSessionTitle(
        titleFromModelOutput(assistantText(response.message)),
        this.titleLimits.maxTitleBytes,
      );
      if (title.length === 0) return;
      const latest = foldSessionTitle(handle.events);
      if (latest?.source.kind === 'user' || latest?.source.kind === 'provider') return;
      const provider = options.provider ?? model.name;
      await handle.append({
        type: SESSION_TITLE_EVENT,
        data: {
          title,
          messageSeqs: [first.seq],
          source: {
            kind: 'provider',
            provider,
            model: { provider, model: modelId },
          },
        },
      });
    } catch {
      // The accepted fallback remains the final title.
    } finally {
      if (this.titleController === controller) this.titleController = undefined;
      this.titleGeneration = undefined;
    }
  }

  private async appendMessage(type: string, data: unknown): Promise<void> {
    await this.session?.append({ type, data });
  }
}

/** Auxiliary title instruction. It must never look like a tool-using turn. */
/** First level-one heading, or undefined when the plan has none. */
function planTitle(body: string): string | undefined {
  for (const line of body.split(/\r?\n/u)) {
    const match = /^#\s+(.+?)\s*$/u.exec(line);
    if (match?.[1] !== undefined && match[1].trim() !== '') return match[1].trim().slice(0, 200);
  }
  return undefined;
}

function renderTitleSystemPrompt(options: Required<SessionTitleLlmOptions>): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${options.targetWords} words in non-CJK languages or ${options.targetCjkCharacters} CJK characters.`,
    'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
  ].join('\n');
}

function formatSubagentNotice(notice: SubagentNotice): string {
  const title = `[Subagent ${notice.childId} ${notice.status}]`;
  const description = notice.description ? `\n${notice.description}` : '';
  const result = notice.result?.trim() ? `\n\n${notice.result.trim()}` : '';
  return `${title}${description}${result}\n\nReview the result before relying on it; open the child session for full details.`;
}

/** A steer was refused before its persistence was accepted. Unknown failures stay ordinary errors. */
export class SteerNotAcceptedError extends Error {
  readonly code = 'steer_not_accepted';
  constructor() { super('The active turn cannot accept another message'); this.name = 'SteerNotAcceptedError'; }
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
export function estimateModelHistory(history: readonly Message[], imageInput?: boolean): number {
  return estimateMessages(projectImageInput(projectCommandInput(prepareModelHistory(history).messages), imageInput));
}

/** A partial assistant is a display log only. It must not re-enter provider history. */
function omittedAssistantContext(message: AssistantMessage): unknown {
  const persisted = message as AssistantMessage & { context?: unknown };
  return 'context' in persisted ? persisted.context : undefined;
}

function isOmittedAssistant(message: Message): boolean {
  return message.role === 'assistant' && omittedAssistantContext(message) === 'omit';
}

function withoutOmittedAssistants(messages: readonly Message[]): Message[] {
  return messages.filter((message) => !isOmittedAssistant(message));
}

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
    if (isOmittedAssistant(message)) continue;
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
