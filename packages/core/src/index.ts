/**
 * @omniagent/core 的公共出口。
 *
 * 只导出「边界上的东西」：类型契约 + 组合根 + 几个需要被外部构造的实现。
 * 内部模块（rules / bash / evaluate 的具体函数）也导出，是因为这个阶段
 * 你就是要拿它们写测试；等 API 稳定后再收紧。
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
export {
  DECISIONS,
  PERMISSION_MODES,
  RULE_SOURCES,
} from './protocol/permission';
export type {
  ApprovalHandler,
  ApprovalResponse,
  Decision,
  PermissionGate,
  PermissionMode,
  PermissionRequest,
  Rule,
  RuleBasedResult,
  RuleSource,
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

// 工具
export {
  DEFAULT_READ_LINES,
  MAX_OUTPUT_CHARS,
  ToolRegistry,
  builtinTools,
  createDefaultRegistry,
  resolveInside,
  toSpec,
  truncateOutput,
} from './tools';

// 权限
export { decide } from './permissions/evaluate';
export type { DecideInput } from './permissions/evaluate';
export { RuleBasedGate } from './permissions/gate';
export {
  globToRegExp,
  matchesCall,
  matchesToolName,
  parseRule,
  parseRuleSet,
  resolveRulePath,
} from './permissions/rules';
export {
  matchesAllSubcommands,
  matchesAnySubcommand,
  matchesBashRule,
  splitCommand,
  stripLeadingWrappers,
} from './permissions/bash';
export {
  PROTECTED_PATH_SEGMENTS,
  isEditTool,
  touchesProtectedPath,
} from './permissions/modes';

// 循环
export { AgentLoop, DEFAULT_MAX_STEPS } from './loop/agent-loop';
export type { AgentLoopDeps } from './loop/agent-loop';

// 执行
export { ToolExecutor } from './exec/executor';

// 存储
export { AuditLog, digestArgs } from './store/audit';
export type { AuditEntry, AuditSink } from './store/audit';
export { TranscriptStore } from './store/transcript';

// 配置
export {
  ConfigSchema,
  ProviderSchema,
  defaultConfigDir,
  defaultConfigPath,
  loadConfig,
} from './config/load';
export type { Config, LoadedConfig, ProviderConfig } from './config/load';

// 工作区
export { identifyWorkspace } from './workspace/id';
export type { WorkspaceId } from './workspace/id';
export { defaultWorkspaceLayout, workspaceLayout } from './workspace/layout';
export type { WorkspaceLayout } from './workspace/layout';
export {
  WorkspaceConfigSchema,
  ensureWorkspaceConfig,
  readWorkspaceConfig,
} from './workspace/config';
export type { WorkspaceConfig } from './workspace/config';
export { openWorkspace } from './workspace/open';
export type { OpenedWorkspace } from './workspace/open';

// 组合根
export { DEFAULT_SYSTEM_PROMPT, Session, createSessionId } from './session';
export type { SessionOptions } from './session';

// 评测
export { formatEvalResults, runEvalCase, runEvalSuite } from './eval/harness';
export type {
  EvalCase,
  EvalExpectations,
  EvalPermissions,
  EvalResult,
  EvalRunOptions,
  EvalSuiteResult,
  FileExpectation,
} from './eval/harness';
