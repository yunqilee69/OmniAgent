/**
 * @omniagent/core 的公共出口。
 *
 * 只导出「边界上的东西」：类型契约 + 组合根 + 几个需要被外部构造的实现。
 */

// 领域数据
export {
  ContentPartSchema,
  ToolCallSchema,
  ToolResultSchema,
  MessageSchema,
  UsageSchema,
  assistantText,
  text,
  userMessage,
} from './domain/message';
export type {
  AssistantMessage,
  ContentPart,
  Message,
  SystemMessage,
  ToolCall,
  ToolMessage,
  ToolResult,
  Usage,
  UserMessage,
} from './domain/message';
export type { Tool, ToolContext, ToolOutput, ToolSpec } from './domain/tool';

// 对外协议
export { isTerminalEvent } from './protocol/events';
export type {
  AgentCommand,
  AgentError,
  AgentEvent,
  AgentEventHandler,
  StopReason,
} from './protocol/events';
export { DECISIONS } from './protocol/permission';
export type {
  ApprovalHandler,
  ApprovalResponse,
  Decision,
  PermissionGate,
  PermissionRequest,
} from './protocol/permission';

// 模型
export type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStreamDelta,
} from './providers/types';
export { FakeModel, textResponse, toolCallResponse } from './providers/fake';
export type { FakeStep } from './providers/fake';
export {
  OpenAIModel,
  toModelResponse,
  toModelStream,
  toOpenAIMessages,
  toOpenAITools,
} from './providers/openai';
export type { OpenAIModelOptions } from './providers/openai';
export { createConfiguredModel } from './providers/create';
export {
  DeepSeekMessagesError,
  DeepSeekMessagesModel,
  DEFAULT_DSH_MODEL,
  serializeDshRequest,
} from './providers/dsh-deepseek';
export type { DeepSeekMessagesOptions } from './providers/dsh-deepseek';
export {
  DSH_OFFICIAL_MODELS,
  DshModelRegistry,
  createDshRegistry,
} from './providers/dsh-registry';
export type { DshModelInfo, DshOpenAIRoute, DshProviderInfo, DshRegistryOptions } from './providers/dsh-registry';
export {
  PiAiModel,
  listPiAiCatalogProviders,
  resolvePiAiRoute,
} from './providers/pi-model';
export type {
  PiAiConfig,
  PiAiCustomApi,
  PiAiModelConfig,
  PiAiModelDependencies,
  PiAiResolvedRoute,
  PiAiRouteConfig,
} from './providers/pi-model';

// 工具
export {
  MAX_OUTPUT_CHARS,
  ToolRegistry,
  builtinTools,
  createDefaultRegistry,
  resolveInside,
  resolveInsidePhysical,
  toSpec,
  truncateOutput,
} from './tools';

// MCP
export {
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_MAX_TIMEOUT_MS,
  MCP_STANDARD_TRANSPORTS,
  MCP_TOOL_PREFIX,
  MCP_TRANSPORTS,
  McpService,
  callMcpTool,
  connectMcpServer,
  expandMcpValue,
  formatMcpToolResult,
  isMcpServerId,
  isMcpToolName,
  listAllMcpPrompts,
  listAllMcpResources,
  listAllMcpTools,
  mcpToolName,
  parseMcpServerEntry,
  parseMcpServers,
  probeMcpServer,
} from './mcp';
export type {
  CallMcpToolOptions,
  ListOptions,
  McpClientHandle,
  McpConnectionOptions,
  McpProbeResult,
  McpProbeTool,
  McpServerConfig,
  McpServerParseResult,
  McpServerRuntimeStatus,
  McpServiceOptions,
  McpTransport,
  ParsedMcpServers,
} from './mcp';

// 循环
export { AgentLoop, DEFAULT_MAX_STEPS } from './loop/agent-loop';
export type { AgentLoopDeps } from './loop/agent-loop';

// 执行
export { ToolExecutor } from './exec/executor';

// 存储
export { AuditLog, digestArgs } from './store/audit';
export type { AuditEntry, AuditSink } from './store/audit';
export { TranscriptStore } from './store/transcript';
export {
  SESSION_FORMAT_VERSION,
  SessionEventSchema,
  SessionHeaderSchema,
} from './session/types';
export type { SessionEvent, SessionEventInput, SessionHeader } from './session/types';
export { SessionLog, SessionStore, sessionPath, workspaceKey, encodeSegment } from './session/store';
export type { SessionHandle, SessionSummary } from './session/store';
export {
  DEFAULT_SESSION_TITLE_LIMITS,
  DEFAULT_SESSION_TITLE_LLM_OPTIONS,
  SESSION_TITLE_EVENT,
  collectSessionTitleMessages,
  fallbackSessionTitle,
  foldSessionTitle,
  hasHumanMessage,
  lastActivityTime,
  normalizeSessionTitle,
  resolveSessionTitleLimits,
  resolveSessionTitleLlmOptions,
  sessionTitleMessage,
  titleFromModelOutput,
  truncateTitleUtf8,
} from './session/title';
export type {
  SessionTitleEventData,
  SessionTitleLimits,
  SessionTitleLlmOptions,
  SessionTitleMessage,
  SessionTitleModelIdentity,
  SessionTitleOptions,
  SessionTitleSnapshot,
  SessionTitleSource,
} from './session/title';
export { SESSION_PIN_EVENT, createSessionPinEvent, foldSessionPinned } from './session/pin';
export type { SessionPinEventData } from './session/pin';
export { SESSION_FORK_EVENT, createSessionForkEvent, foldSessionForkSource } from './session/fork';
export type { SessionForkEventData } from './session/fork';
export { projectMessages, safePublicMessages } from './session/projection';
export {
  TODO_STATUSES,
  TODO_WRITE_EVENT,
  TodoItemSchema,
  TodoListSchema,
  parseTodoList,
  projectTodos,
  todoCounts,
} from './session/todo';
export type { TodoItem, TodoList, TodoStatus } from './session/todo';
export {
  PLAN_MODE_EVENT,
  PLAN_MODE_GUIDANCE,
  createPlanModeEvent,
  projectPlanMode,
} from './session/plan';
export type { PlanProjection } from './session/plan';
export {
  GOAL_ACTIVATIONS,
  GOAL_CHANGE_EVENT,
  GOAL_CHANGE_VERSION,
  GOAL_DEFAULT_BLOCKED_AFTER,
  GOAL_DEFAULT_MAX_ROUNDS,
  GOAL_PHASES,
  GoalChangeSchema,
  GoalError,
  GoalRefSchema,
  GoalSnapshotSchema,
  applyGoalChange,
  applyGoalEvent,
  decodeGoalChange,
  emptyGoalFoldState,
  goalChangeRef,
  projectGoal,
  renderGoalRoundPrompt,
  renderGoalToolGuidance,
  renderGoalWrapup,
  resolveBlockReason,
  resolveMaxGoalRounds,
  resolveObjective,
} from './session/goal';
export type {
  GoalActivation,
  GoalBlockReason,
  GoalChange,
  GoalClearChange,
  GoalErrorCode,
  GoalFoldState,
  GoalMessageSource,
  GoalOperation,
  GoalPhase,
  GoalProjection,
  GoalProjectionState,
  GoalRef,
  GoalSnapshot,
  GoalSnapshotChange,
  GoalView,
} from './session/goal';
export { GoalController, goalRefOf } from './session/goal-controller';
export type { CreateGoalRequest, EditGoalRequest, GoalControllerOptions } from './session/goal-controller';
export {
  DSH_DEFAULT_PRESET,
  DSH_PERMISSION_EVENT,
  DSH_PERMISSION_PRESETS,
  DSH_PRESET_BUNDLES,
  createDshPresetSwitch,
  createInitialDshPermissionEvent,
  isDshPermissionPreset,
  projectDshPermissions,
  resolveDshDefaultPreset,
  snapshotDshPermissions,
} from './permissions/dsh-permissions';
export type {
  DshApprovalPolicy,
  DshPermissionEvent,
  DshPermissionPreset,
  DshPermissionProjection,
  DshPermissionSettings,
  DshPermissionSnapshot,
  DshPresetBundle,
  DshSandboxMode,
} from './permissions/dsh-permissions';
export { runDshEscalation, DshEscalationError } from './permissions/dsh-escalation';
export type {
  DshApprovalOutcome,
  DshEscalationApprovalRequest,
  DshEscalationApprover,
  DshEscalationRequest,
} from './permissions/dsh-escalation';

// Context
export { compactMessages, estimateMessageTokens, estimateMessages } from './context/compaction';
export { estimateModelHistory } from './session';
export type { CompactionOptions, CompactionResult } from './context/compaction';

// Sandbox and skills
export { DshSandboxError, DshSandboxUnavailableError, assertDshMode, dshPhysicalDirectory, dshWorkspaceWritableRoots, dshWritableRoots } from './sandbox/dsh-policy';
export type { DshConfinedMode, DshSandboxMode as DshSandboxExecutionMode, DshSandboxPolicy } from './sandbox/dsh-policy';
export { checkDshMutation, checkDshMutations } from './sandbox/dsh-fs';
export { assertNoHardlinkedFiles } from './sandbox/dsh-hardlinks';
export { confineDshArgv, probeDshSandbox } from './sandbox/dsh-sandbox';
export type { DshConfinedArgv, DshSandboxBackend, DshSandboxCapability, DshSandboxOptions } from './sandbox/dsh-sandbox';
export { executeDshShell, createDshShellTool } from './tools/builtin/dsh-shell';
export type { DshShellRequest, DshShellResult } from './tools/builtin/dsh-shell';
export { createTodoWriteTool, describeTodoWrite, TODO_WRITE_TOOL_NAME } from './tools/builtin/todo-write';
export {
  EXIT_PLAN_MODE_TOOL_NAME,
  createExitPlanModeTool,
  hasPlanHeading,
} from './tools/builtin/exit-plan-mode';
export type { PlanReviewResponse } from './tools/builtin/exit-plan-mode';
export {
  CREATE_GOAL_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  createGoalTools,
} from './tools/builtin/goal';
export {
  INTERRUPT_AGENT_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  WAIT_AGENT_TOOL_NAME,
  createSubagentTools,
} from './tools/builtin/subagent';
export {
  SUBAGENT_END_EVENT,
  SUBAGENT_NOTICE_EVENT,
  SUBAGENT_START_EVENT,
} from './domain/subagent';
export type {
  SubagentInfo,
  SubagentListEntry,
  SubagentListStatus,
  SubagentNotice,
  SubagentOutcome,
  SubagentService,
  SubagentStartRequest,
  SubagentStartResult,
  SubagentStatus,
} from './domain/subagent';
export { SubagentManager } from './subagents/manager';
export type { SubagentManagerOptions } from './subagents/manager';
export { SandboxUnavailableError, createSandboxRunner, sandboxCommand } from './sandbox/runner';
export type { SandboxCommand, SandboxPlatform, SandboxProfile } from './sandbox/runner';
export { discoverSkills, filterSkills, loadSkill, loadSkillByName, renderSkillCatalog } from './skills/filesystem';
export type { LoadedSkill, SkillSummary } from './skills/filesystem';
export {
  AgentAuthoringService,
  AgentCatalog,
  AgentDefinitionWriteSchema,
  InvalidAgentSettings,
  LIST_AGENT_DEFINITIONS_TOOL_NAME,
  MAX_AGENT_BYTES,
  WRITE_AGENT_DEFINITION_TOOL_NAME,
  createAgentAuthoringTools,
  parseMarkdown,
  renderAgentCatalog,
} from './agents';
export type {
  AgentAuthoringServiceOptions,
  AgentCatalogSnapshot,
  AgentDefinition,
  AgentDefinitionDetail,
  AgentDefinitionSummary,
  AgentDefinitionWrite,
  AgentDefinitionWriteResult,
  AgentError as AgentCatalogError,
} from './agents';
export { AGENT_SELECTION_EVENT, AGENT_SELECTION_VERSION, AGENT_USAGES, AgentSelectionSchema, AgentUsageSchema, createAgentSelectionEvent, createAgentSwitch, projectAgentSelection, usageAllowsRoot, usageAllowsSubagent } from './session/agent-selection';
export type { AgentSelection, AgentSelectionProjection, AgentUsage } from './session/agent-selection';
export { MODEL_SELECTION_EVENT, MODEL_SELECTION_VERSION, ModelBindingSchema, createModelSelectionEvent, createModelSwitch, defaultModelBinding, projectModelSelection, resolveModelBinding } from './session/model-binding';
export type { ModelBinding, ModelSelectionProjection, ResolvedModelBinding } from './session/model-binding';
export { MODE_SELECTION_EVENT, MODE_SELECTION_VERSION, ModeSelectionSchema, createModeSelectionEvent, hasModeSelection, projectModeSelection } from './session/mode-selection';
export type { ModeSelection, ModeSelectionProjection } from './session/mode-selection';
export { ModeConfigError, ModeStore } from './modes';
export type { ModeDefinition, ModeSelector, ModeStoreOptions, ModeSummary, ModeWrite } from './modes';
export { RuntimeResolver } from './session/runtime';
export type { ResolvedSessionRuntime, ResolveSessionInput, RuntimeResolverOptions, SessionAgent } from './session/runtime';
export { ConfigError, ConfigStore } from './config/store';
export type { ConfigSnapshot } from './config/store';
export { buildConfigCatalog, findCatalogModel, listCatalogModels, supportedReasoningEfforts } from './config/models';
export type { AgentProfileDefinition, ConfigCatalog, ModelCapabilities, ModelDescriptor, ModelProtocol, ModelReasoning, ReasoningWire, RoleDefinition } from './config/models';
export { REASONING_EFFORTS, ReasoningEffortSchema } from './protocol/reasoning';
export type { ReasoningEffort } from './protocol/reasoning';
export { createSkillTool } from './tools/builtin/skill';
export { createCatalogModel } from './providers/create';
export { expandToolSelector, KNOWN_TOOL_NAMES, SUBAGENT_TOOL_GROUP } from './tools/names';

// 配置
export {
  ConfigSchema,
  ProviderSchema,
  defaultConfigDir,
  defaultConfigPath,
  loadConfig,
} from './config/load';
export type { Config, LoadedConfig, ProviderConfig } from './config/load';

// 组合根
export { DEFAULT_SYSTEM_PROMPT, Session } from './session';
export { isInitCommand } from './session/init-command';
export type { SessionOptions } from './session';

// 调度任务
export * from './schedule/index.ts';

// 评测
export { formatEvalResults, runEvalCase, runEvalSuite } from './eval/harness';
export type {
  EvalCase,
  EvalExpectations,
  EvalResult,
  EvalRunOptions,
  EvalSuiteResult,
  FileExpectation,
} from './eval/harness';
