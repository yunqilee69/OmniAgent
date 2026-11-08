import type { AgentEvent, StopReason } from '@omniagent/core';

export type PermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Workspace {
  id: string;
  name?: string;
  path: string;
  lastUsedAt?: number;
}

export interface SessionSummary {
  id: string;
  workspace?: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  eventCount?: number;
  agent?: string;
  mode?: string;
  agentId?: string;
  parentSessionId?: string;
  depth?: number;
  description?: string;
  title?: string;
  titleSource?: unknown;
  pinned?: boolean;
  blank?: boolean;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  role: string;
  usage: 'primary' | 'subagent' | 'both';
  profile: string;
  builtIn?: boolean;
  valid: boolean;
  warnings: string[];
}

/** Editable agent definition including the system-prompt body. */
export interface AgentDefinitionDetail {
  id: string;
  name: string;
  description: string;
  role: string;
  usage: AgentSummary['usage'];
  profile: string;
  builtIn?: boolean;
  instructions: string;
}

export interface AgentDefinitionWrite {
  name: string;
  description: string;
  role?: string;
  usage?: AgentSummary['usage'];
  profile?: string;
  instructions: string;
  overwrite?: boolean;
}

export interface RoleSummary {
  id: string;
  name: string;
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

/** Editable role row, including invalid definitions that need repair. */
export interface RoleEntry {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  builtIn?: boolean;
  valid: boolean;
  error?: string;
}

export type ModeSelector = '*' | string[];

export interface ModeSummary {
  id: string;
  name: string;
  description: string;
  agent: string;
  model: ModelBinding;
  tools: ModeSelector;
  skills: ModeSelector;
  builtIn: boolean;
  customized: boolean;
  valid: boolean;
  warnings: string[];
}

export interface ModeSelection {
  version: 1;
  mode: string;
  agent: string;
  model: ModelBinding;
  tools: ModeSelector;
  skills: ModeSelector;
}

export interface ModeOptions {
  tools: string[];
  skills: Array<{ name: string; description: string }>;
}

/** A skill the current session agent may load. */
export interface AgentSkill {
  name: string;
  description: string;
}

/** A root session offered by the composer `#` menu. */
export interface RecentSessionSummary {
  id: string;
  title: string | null;
  workspaceId: string;
  workspaceName: string;
  updatedAt: number;
  blank: boolean;
  agent?: string;
  mode?: string;
}

export interface ModelSummary {
  provider: string;
  model: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  capabilities: { imageInput: boolean };
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export type ModelSourceProtocol =
  | 'deepseek-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';

export type ModelInputType = 'text' | 'image';

export interface ModelSourceReasoning {
  efforts: Partial<Record<ReasoningEffort, string | number | null>>;
  default?: ReasoningEffort;
  wire?: Record<string, unknown>;
}

export interface ModelSourceModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input: ModelInputType[];
  reasoning?: ModelSourceReasoning;
  inherited: boolean;
}

export interface ModelSourceSummary {
  id: string;
  name: string;
  api?: ModelSourceProtocol;
  baseURL?: string;
  apiKeyConfigured: boolean;
  apiKeyEnv?: string;
  auth?: 'ambient';
  models: ModelSourceModel[];
  builtIn: boolean;
  legacy: boolean;
  active: boolean;
  removable: boolean;
  valid: boolean;
  error?: string;
}

export interface ModelSourceList {
  sources: ModelSourceSummary[];
  defaultSource?: string;
  defaultModel?: string;
  protocols: string[];
  catalogProviders: string[];
}

export interface ModelSourceModelWrite {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInputType[];
  reasoning?: false | {
    efforts?: Record<string, unknown>;
    default?: string;
    wire?: unknown;
  };
}

export interface ModelSourceWrite {
  name?: string;
  api?: string;
  baseURL?: string;
  clearBaseURL?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
  apiKeyEnv?: string;
  clearApiKeyEnv?: boolean;
  auth?: 'ambient' | false;
  models?: ModelSourceModelWrite[];
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInputType[];
}

export type McpTransport = 'stdio' | 'sse' | 'http' | 'ws';
export type McpServerState = 'connected' | 'disconnected' | 'disabled' | 'invalid';

export interface McpServerRuntime {
  id: string;
  transport?: McpTransport;
  enabled: boolean;
  state: McpServerState;
  toolCount: number;
  tools: string[];
  serverName?: string;
  serverVersion?: string;
  error?: string;
}

export interface McpServerSummary {
  id: string;
  transport: McpTransport;
  enabled: boolean;
  timeoutMs?: number;
  command?: string;
  args: string[];
  envKeys: string[];
  cwd?: string;
  url?: string;
  headerKeys: string[];
  valid: boolean;
  error?: string;
  runtime?: McpServerRuntime;
}

export interface McpServerList {
  servers: McpServerSummary[];
  transports: string[];
}

/** Draft write. A blank value for an existing env/header key keeps the stored value. */
export interface McpServerWrite {
  type?: McpTransport;
  enabled?: boolean;
  timeoutMs?: number | null;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  clearEnv?: string[];
  cwd?: string | null;
  url?: string;
  headers?: Record<string, string>;
  clearHeaders?: string[];
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

export type ModelBinding =
  | { version: 2; kind: 'agent' }
  | { version: 2; kind: 'role'; role: string }
  | {
    version: 2;
    kind: 'model';
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffort;
  };

export interface ResolvedModel {
  provider: string;
  model: string;
  name: string;
  reasoningEffort?: ReasoningEffort;
  contextWindow?: number;
  maxTokens?: number;
  capabilities?: { imageInput: boolean };
}

export interface PlanState {
  active: boolean;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PermissionSettings {
  defaultPreset: PermissionPreset | null;
  requiresSelection: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  raw?: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  truncated: boolean;
  durationMs?: number;
}

export interface ContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image';
  mediaType: string;
  data: string;
}

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
}

/** Browser-side projection of one durable automation task. */
export type ScheduleStatus = 'active' | 'paused' | 'ended';

export interface ScheduleSessionCreate {
  cwd?: string;
  agentPreset?: string;
}

export type ScheduleTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; sessionId: string; create: ScheduleSessionCreate }
  | { kind: 'new'; create: ScheduleSessionCreate };

export type ScheduleTargetRequest =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; create?: ScheduleSessionCreate }
  | { kind: 'new'; create?: ScheduleSessionCreate };

export type ScheduleTiming =
  | { kind: 'after'; after_seconds: number }
  | { kind: 'at'; at: string | { date: string; time: string; time_zone: string } }
  | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: { time: string; time_zone: string } }
  | { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } }
  | { kind: 'cron'; cron: { expression: string; time_zone: string } }
  | { kind: 'rrule'; rrule: string };

export interface ScheduleDeliveryReceipt {
  scheduledAt: string;
  deliveredAt: string;
  messageId: string;
  targetSessionId: string;
}

export interface ScheduleDeliveryRecord extends ScheduleDeliveryReceipt {
  prompt?: string;
}

export interface ScheduleCatalogEntry {
  id: string;
  kind: ScheduleTiming['kind'];
  title: string;
  prompt: string;
  scheduledAt: string;
  afterSeconds?: number;
  everySeconds?: number;
  time?: string;
  timeZone?: string;
  weekdays?: number[];
  expression?: string;
  rrule?: string;
  target: ScheduleTarget;
  involvedSessionIds: string[];
  status: ScheduleStatus;
  createdAt?: string;
  updatedAt?: string;
  executionActive?: true;
  deliveryFloorEndsAt?: string;
  lastDelivery?: ScheduleDeliveryReceipt;
}

export interface ScheduleCreateRequest {
  title: string;
  prompt: string;
  timing: ScheduleTiming;
  target?: ScheduleTargetRequest;
}

export interface SchedulePatch {
  title?: string;
  prompt?: string;
  timing?: ScheduleTiming;
  target?: ScheduleTargetRequest;
  active?: boolean;
}

export interface ScheduleDeliveryHistoryPage {
  id: string;
  records: ScheduleDeliveryRecord[];
  earlierRecordsUnavailable: boolean;
  earlierRecordsPruned: boolean;
  retention: { days: number; records: number };
  nextBefore?: string;
}

/** Validate the catalog row fields the page depends on, retaining timing fields verbatim. */
export function validateScheduleEntry(value: unknown): ScheduleCatalogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid schedule response.');
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || typeof entry.title !== 'string' || typeof entry.prompt !== 'string'
    || typeof entry.scheduledAt !== 'string'
    || !['active', 'paused', 'ended'].includes(entry.status as string)
    || typeof entry.target !== 'object' || entry.target === null
    || typeof entry.kind !== 'string') {
    throw new Error('Invalid schedule response.');
  }
  return entry as unknown as ScheduleCatalogEntry;
}

/** Validate one delivery-history page. */
export function validateScheduleHistory(value: unknown): ScheduleDeliveryHistoryPage {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid schedule history response.');
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.records)) throw new Error('Invalid schedule history response.');
  return page as unknown as ScheduleDeliveryHistoryPage;
}

export interface SendAttachment {
  kind: 'image' | 'text';
  name: string;
  mediaType: string;
  data?: string;
  text?: string;
}

export interface PublicMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: Array<ContentPart | ImageContentPart>;
  toolCalls?: ToolCall[];
  results?: ToolResult[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface SessionDetail {
  header?: Record<string, unknown>;
  title?: string | null;
  titleSource?: unknown;
  blank?: boolean;
  mode?: ModeSelection | null;
  messages?: PublicMessage[];
  permission?: { preset: PermissionPreset | null };
  agent?: AgentSummary | null;
  agentError?: string;
  agentWarnings?: string[];
  model?: ModelBinding | null;
  resolvedModel?: ResolvedModel | null;
  plan?: { active?: boolean } | null;
  todos?: TodoItem[] | null;
  events?: unknown[];
  trajectory?: unknown;
  audit?: unknown[];
}

export interface TraceEvent {
  type: string;
  seq?: number;
  ts?: number;
  data?: Record<string, unknown>;
}

export interface TrajectoryRecord {
  id: string;
  kind: 'input' | 'model' | 'tool';
  seq?: number;
  turnId?: string;
  stepId?: string;
  step?: number;
  timestamp?: number | null;
  durationMs?: number | null;
  name?: string;
  ok?: boolean;
  truncated?: boolean;
  decision?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TrajectoryProjection {
  version: 1;
  records: TrajectoryRecord[];
  timeline: {
    sequence?: Array<{ recordId: string; lane: 'input' | 'model' | 'tools'; start: number; end: number }>;
    time?: Array<{ recordId: string; lane: 'input' | 'model' | 'tools'; start: number; end: number }>;
  };
}

export const permissionPresets: Record<PermissionPreset, { label: string; description: string }> = {
  'read-only': {
    label: 'Read Only',
    description: 'File writes are denied in the standing sandbox.',
  },
  'workspace-write': {
    label: 'Workspace Write',
    description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
  },
  'danger-full-access': {
    label: 'Full access',
    description: 'Full file access without approval prompts.',
  },
};

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && Object.hasOwn(permissionPresets, value);
}

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const reasoningEfforts = REASONING_EFFORTS;
const agentUsages = ['primary', 'subagent', 'both'] as const;

export function validateAgent(value: unknown): AgentSummary | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid agent response.');
  const agent = value as Record<string, unknown>;
  if (typeof agent.id !== 'string' || !agent.id.trim()
    || typeof agent.name !== 'string' || !agent.name.trim()
    || typeof agent.description !== 'string'
    || typeof agent.role !== 'string'
    || !agentUsages.includes(agent.usage as (typeof agentUsages)[number])
    || typeof agent.profile !== 'string'
    || typeof agent.valid !== 'boolean'
    || !Array.isArray(agent.warnings) || !agent.warnings.every((item) => typeof item === 'string')) {
    throw new Error('Invalid agent response.');
  }
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    role: agent.role,
    usage: agent.usage as AgentSummary['usage'],
    profile: agent.profile,
    ...(agent.builtIn === true ? { builtIn: true } : {}),
    valid: agent.valid,
    warnings: agent.warnings.slice() as string[],
  };
}

export function validateAgentDefinition(value: unknown): AgentDefinitionDetail {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid agent definition response.');
  }
  const agent = value as Record<string, unknown>;
  if (typeof agent.id !== 'string' || !agent.id.trim()
    || typeof agent.name !== 'string' || !agent.name.trim()
    || typeof agent.description !== 'string'
    || typeof agent.role !== 'string'
    || !agentUsages.includes(agent.usage as (typeof agentUsages)[number])
    || typeof agent.profile !== 'string'
    || typeof agent.instructions !== 'string') {
    throw new Error('Invalid agent definition response.');
  }
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    role: agent.role,
    usage: agent.usage as AgentDefinitionDetail['usage'],
    profile: agent.profile,
    ...(agent.builtIn === true ? { builtIn: true } : {}),
    instructions: agent.instructions,
  };
}

export function validateAgentProfiles(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error('Invalid agent profiles response.');
  }
  return value.slice() as string[];
}

export function validateRole(value: unknown): RoleSummary {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid role response.');
  const role = value as Record<string, unknown>;
  if (typeof role.id !== 'string' || !role.id.trim()
    || typeof role.name !== 'string'
    || typeof role.provider !== 'string' || !role.provider.trim()
    || typeof role.model !== 'string' || !role.model.trim()
    || (role.reasoningEffort !== undefined && !reasoningEfforts.includes(role.reasoningEffort as ReasoningEffort))) {
    throw new Error('Invalid role response.');
  }
  return {
    id: role.id,
    name: role.name,
    provider: role.provider,
    model: role.model,
    ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort as ReasoningEffort }),
  };
}

export function validateModelSummary(value: unknown): ModelSummary {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid model response.');
  const model = value as Record<string, unknown>;
  if (typeof model.provider !== 'string' || !model.provider.trim()
    || typeof model.model !== 'string' || !model.model.trim()
    || typeof model.name !== 'string' || !model.name.trim()) {
    throw new Error('Invalid model response.');
  }
  const capabilities = typeof model.capabilities === 'object' && model.capabilities !== null
    ? model.capabilities as Record<string, unknown>
    : {};
  return {
    provider: model.provider,
    model: model.model,
    name: model.name,
    ...(typeof model.contextWindow === 'number' && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    ...(typeof model.maxTokens === 'number' && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
    capabilities: { imageInput: capabilities.imageInput === true },
    reasoningEfforts: Array.isArray(model.reasoningEfforts)
      ? model.reasoningEfforts.filter((item): item is ReasoningEffort => reasoningEfforts.includes(item as ReasoningEffort))
      : [],
    ...(reasoningEfforts.includes(model.defaultReasoningEffort as ReasoningEffort)
      ? { defaultReasoningEffort: model.defaultReasoningEffort as ReasoningEffort }
      : {}),
  };
}

const modelSourceProtocols: readonly ModelSourceProtocol[] = [
  'deepseek-messages', 'openai-completions', 'openai-responses', 'anthropic-messages',
];

function validateInputTypes(value: unknown): ModelInputType[] {
  if (!Array.isArray(value)) return ['text'];
  const selected = value.filter((item): item is ModelInputType => item === 'text' || item === 'image');
  return selected.length === 0 ? ['text'] : [...new Set(selected)];
}

function validateModelSourceModel(value: unknown): ModelSourceModel {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid model source response.');
  const model = value as Record<string, unknown>;
  if (typeof model.id !== 'string' || !model.id.trim() || typeof model.name !== 'string') {
    throw new Error('Invalid model source response.');
  }
  const efforts = typeof model.reasoning === 'object' && model.reasoning !== null
    ? (model.reasoning as Record<string, unknown>).efforts
    : undefined;
  const mapped: Partial<Record<ReasoningEffort, string | number | null>> = {};
  if (typeof efforts === 'object' && efforts !== null) {
    for (const level of reasoningEfforts) {
      const wire = (efforts as Record<string, unknown>)[level];
      if (wire === null || typeof wire === 'string' || typeof wire === 'number') mapped[level] = wire;
    }
  }
  const reasoningDefault = typeof model.reasoning === 'object' && model.reasoning !== null
    ? (model.reasoning as Record<string, unknown>).default
    : undefined;
  return {
    id: model.id,
    name: model.name,
    ...(typeof model.contextWindow === 'number' && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    ...(typeof model.maxTokens === 'number' && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
    input: validateInputTypes(model.input),
    ...(Object.keys(mapped).length === 0 ? {} : {
      reasoning: {
        efforts: mapped,
        ...(reasoningEfforts.includes(reasoningDefault as ReasoningEffort)
          ? { default: reasoningDefault as ReasoningEffort } : {}),
      },
    }),
    inherited: model.inherited === true,
  };
}

export function validateModelSource(value: unknown): ModelSourceSummary {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid model source response.');
  const source = value as Record<string, unknown>;
  if (typeof source.id !== 'string' || !source.id.trim() || typeof source.name !== 'string'
    || typeof source.apiKeyConfigured !== 'boolean'
    || typeof source.builtIn !== 'boolean' || typeof source.legacy !== 'boolean'
    || typeof source.active !== 'boolean' || typeof source.removable !== 'boolean'
    || typeof source.valid !== 'boolean' || !Array.isArray(source.models)
    || (source.api !== undefined && !modelSourceProtocols.includes(source.api as ModelSourceProtocol))
    || (source.baseURL !== undefined && typeof source.baseURL !== 'string')
    || (source.apiKeyEnv !== undefined && typeof source.apiKeyEnv !== 'string')
    || (source.auth !== undefined && source.auth !== 'ambient')
    || (source.error !== undefined && typeof source.error !== 'string')) {
    throw new Error('Invalid model source response.');
  }
  return {
    id: source.id,
    name: source.name,
    ...(typeof source.api === 'string' ? { api: source.api as ModelSourceProtocol } : {}),
    ...(typeof source.baseURL === 'string' ? { baseURL: source.baseURL } : {}),
    apiKeyConfigured: source.apiKeyConfigured,
    ...(typeof source.apiKeyEnv === 'string' ? { apiKeyEnv: source.apiKeyEnv } : {}),
    ...(source.auth === 'ambient' ? { auth: 'ambient' as const } : {}),
    models: source.models.map(validateModelSourceModel),
    builtIn: source.builtIn,
    legacy: source.legacy,
    active: source.active,
    removable: source.removable,
    valid: source.valid,
    ...(typeof source.error === 'string' ? { error: source.error } : {}),
  };
}

export function validateModelSourceList(value: unknown): ModelSourceList {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid model sources response.');
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.sources) || !Array.isArray(body.protocols)
    || !body.protocols.every((item) => typeof item === 'string')
    || !Array.isArray(body.catalogProviders)
    || !body.catalogProviders.every((item) => typeof item === 'string')
    || (body.defaultSource !== undefined && typeof body.defaultSource !== 'string')
    || (body.defaultModel !== undefined && typeof body.defaultModel !== 'string')) {
    throw new Error('Invalid model sources response.');
  }
  return {
    sources: body.sources.map(validateModelSource),
    ...(typeof body.defaultSource === 'string' ? { defaultSource: body.defaultSource } : {}),
    ...(typeof body.defaultModel === 'string' ? { defaultModel: body.defaultModel } : {}),
    protocols: body.protocols.slice() as string[],
    catalogProviders: body.catalogProviders.slice() as string[],
  };
}

const mcpTransports: readonly McpTransport[] = ['stdio', 'sse', 'http', 'ws'];
const mcpStates: readonly McpServerState[] = ['connected', 'disconnected', 'disabled', 'invalid'];

function validateMcpRuntime(value: unknown): McpServerRuntime {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid MCP server response.');
  const runtime = value as Record<string, unknown>;
  if (typeof runtime.id !== 'string' || typeof runtime.enabled !== 'boolean'
    || !mcpStates.includes(runtime.state as McpServerState)
    || typeof runtime.toolCount !== 'number' || !Array.isArray(runtime.tools)
    || !runtime.tools.every((item) => typeof item === 'string')
    || (runtime.transport !== undefined && !mcpTransports.includes(runtime.transport as McpTransport))
    || (runtime.error !== undefined && typeof runtime.error !== 'string')
    || (runtime.serverName !== undefined && typeof runtime.serverName !== 'string')) {
    throw new Error('Invalid MCP server response.');
  }
  return runtime as unknown as McpServerRuntime;
}

export function validateMcpServer(value: unknown): McpServerSummary {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid MCP server response.');
  const server = value as Record<string, unknown>;
  if (typeof server.id !== 'string' || !server.id.trim()
    || !mcpTransports.includes(server.transport as McpTransport)
    || typeof server.enabled !== 'boolean' || !Array.isArray(server.args)
    || !server.args.every((item) => typeof item === 'string')
    || !Array.isArray(server.envKeys) || !server.envKeys.every((item) => typeof item === 'string')
    || !Array.isArray(server.headerKeys) || !server.headerKeys.every((item) => typeof item === 'string')
    || typeof server.valid !== 'boolean'
    || (server.timeoutMs !== undefined && typeof server.timeoutMs !== 'number')
    || (server.command !== undefined && typeof server.command !== 'string')
    || (server.cwd !== undefined && typeof server.cwd !== 'string')
    || (server.url !== undefined && typeof server.url !== 'string')
    || (server.error !== undefined && typeof server.error !== 'string')) {
    throw new Error('Invalid MCP server response.');
  }
  return {
    ...(server as unknown as McpServerSummary),
    envKeys: (server.envKeys as string[]).slice(),
    headerKeys: (server.headerKeys as string[]).slice(),
    args: (server.args as string[]).slice(),
    ...(server.runtime === undefined ? {} : { runtime: validateMcpRuntime(server.runtime) }),
  };
}

export function validateMcpServerList(value: unknown): McpServerList {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid MCP servers response.');
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.servers) || !Array.isArray(body.transports)
    || !body.transports.every((item) => typeof item === 'string')) {
    throw new Error('Invalid MCP servers response.');
  }
  return {
    servers: body.servers.map(validateMcpServer),
    transports: body.transports.slice() as string[],
  };
}

export function validateMcpProbeResult(value: unknown): McpProbeResult {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid MCP test response.');
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== 'boolean' || !mcpTransports.includes(result.transport as McpTransport)
    || typeof result.durationMs !== 'number' || !Array.isArray(result.tools)
    || !Array.isArray(result.resources) || !result.resources.every((item) => typeof item === 'string')
    || !Array.isArray(result.prompts) || !result.prompts.every((item) => typeof item === 'string')
    || (result.error !== undefined && typeof result.error !== 'string')) {
    throw new Error('Invalid MCP test response.');
  }
  return {
    ...(result as unknown as McpProbeResult),
    tools: (result.tools as Array<Record<string, unknown>>).map((tool) => {
      if (typeof tool.name !== 'string') throw new Error('Invalid MCP test response.');
      return {
        name: tool.name,
        readOnly: tool.readOnly === true,
        ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      };
    }),
    resources: (result.resources as string[]).slice(),
    prompts: (result.prompts as string[]).slice(),
  };
}

export function validateDiscoveredModels(value: unknown): DiscoveredModel[] {  if (typeof value !== 'object' || value === null) throw new Error('Invalid model discovery response.');
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.models)) throw new Error('Invalid model discovery response.');
  return body.models.flatMap((item): DiscoveredModel[] => {
    if (typeof item !== 'object' || item === null) return [];
    const model = item as Record<string, unknown>;
    if (typeof model.id !== 'string' || !model.id.trim()) return [];
    return [{
      id: model.id,
      ...(typeof model.name === 'string' && model.name !== '' ? { name: model.name } : {}),
      ...(typeof model.contextWindow === 'number' && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
      ...(typeof model.maxTokens === 'number' && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
      ...(Array.isArray(model.input) ? { input: validateInputTypes(model.input) } : {}),
    }];
  });
}

export function validateBinding(value: unknown): ModelBinding | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model binding.');
  const binding = value as Record<string, unknown>;
  if (binding.version !== 2) throw new Error('Invalid model binding.');
  if (binding.kind === 'agent') return { version: 2, kind: 'agent' };
  if (binding.kind === 'role' && typeof binding.role === 'string' && binding.role.trim()) {
    return { version: 2, kind: 'role', role: binding.role };
  }
  if (binding.kind === 'model'
    && typeof binding.provider === 'string' && binding.provider.trim()
    && typeof binding.model === 'string' && binding.model.trim()
    && (binding.reasoningEffort === undefined || reasoningEfforts.includes(binding.reasoningEffort as ReasoningEffort))) {
    return {
      version: 2,
      kind: 'model',
      provider: binding.provider,
      model: binding.model,
      ...(binding.reasoningEffort === undefined ? {} : { reasoningEffort: binding.reasoningEffort as ReasoningEffort }),
    };
  }
  throw new Error('Invalid model binding.');
}

export function validateResolvedModel(value: unknown): ResolvedModel | null {
  if (typeof value !== 'object' || value === null) return null;
  const model = value as Record<string, unknown>;
  if (typeof model.provider !== 'string' || typeof model.model !== 'string' || typeof model.name !== 'string') return null;
  const capabilities = typeof model.capabilities === 'object' && model.capabilities !== null
    ? model.capabilities as Record<string, unknown>
    : {};
  return {
    provider: model.provider,
    model: model.model,
    name: model.name,
    ...(reasoningEfforts.includes(model.reasoningEffort as ReasoningEffort)
      ? { reasoningEffort: model.reasoningEffort as ReasoningEffort }
      : {}),
    ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
    ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
    capabilities: { imageInput: capabilities.imageInput === true },
  };
}

export function validateRoleEntry(value: unknown): RoleEntry {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid role response.');
  const role = value as Record<string, unknown>;
  if (typeof role.id !== 'string' || !role.id.trim()
    || typeof role.name !== 'string'
    || typeof role.valid !== 'boolean'
    || (role.provider !== undefined && typeof role.provider !== 'string')
    || (role.model !== undefined && typeof role.model !== 'string')
    || (role.error !== undefined && typeof role.error !== 'string')) {
    throw new Error('Invalid role response.');
  }
  return {
    id: role.id,
    name: role.name,
    ...(typeof role.provider === 'string' ? { provider: role.provider } : {}),
    ...(typeof role.model === 'string' ? { model: role.model } : {}),
    ...(reasoningEfforts.includes(role.reasoningEffort as ReasoningEffort)
      ? { reasoningEffort: role.reasoningEffort as ReasoningEffort }
      : {}),
    ...(role.builtIn === true ? { builtIn: true } : {}),
    valid: role.valid,
    ...(typeof role.error === 'string' ? { error: role.error } : {}),
  };
}

function validateModeSelector(value: unknown): ModeSelector {
  if (value === '*') return '*';
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    return value.slice() as string[];
  }
  throw new Error('Invalid mode selector.');
}

export function validateModeSummary(value: unknown): ModeSummary {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid mode response.');
  const mode = value as Record<string, unknown>;
  if (typeof mode.id !== 'string' || !mode.id.trim()
    || typeof mode.name !== 'string' || !mode.name.trim()
    || typeof mode.description !== 'string'
    || typeof mode.agent !== 'string' || !mode.agent.trim()
    || typeof mode.builtIn !== 'boolean'
    || typeof mode.customized !== 'boolean'
    || typeof mode.valid !== 'boolean'
    || !Array.isArray(mode.warnings) || !mode.warnings.every((item) => typeof item === 'string')) {
    throw new Error('Invalid mode response.');
  }
  const model = validateBinding(mode.model);
  if (model === null) throw new Error('Invalid mode response.');
  return {
    id: mode.id,
    name: mode.name,
    description: mode.description,
    agent: mode.agent,
    model,
    tools: validateModeSelector(mode.tools),
    skills: validateModeSelector(mode.skills),
    builtIn: mode.builtIn,
    customized: mode.customized,
    valid: mode.valid,
    warnings: mode.warnings.slice() as string[],
  };
}

export function validateModeSelection(value: unknown): ModeSelection | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session mode response.');
  const mode = value as Record<string, unknown>;
  if (mode.version !== 1 || typeof mode.mode !== 'string' || !mode.mode.trim()
    || typeof mode.agent !== 'string' || !mode.agent.trim()) {
    throw new Error('Invalid session mode response.');
  }
  const model = validateBinding(mode.model);
  if (model === null) throw new Error('Invalid session mode response.');
  return {
    version: 1,
    mode: mode.mode,
    agent: mode.agent,
    model,
    tools: validateModeSelector(mode.tools),
    skills: validateModeSelector(mode.skills),
  };
}

export function validateModeOptions(value: unknown): ModeOptions {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid mode options response.');
  const options = value as Record<string, unknown>;
  if (!Array.isArray(options.tools) || !options.tools.every((item) => typeof item === 'string')
    || !Array.isArray(options.skills)) {
    throw new Error('Invalid mode options response.');
  }
  return {
    tools: options.tools.slice() as string[],
    skills: options.skills
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter((item) => typeof item.name === 'string')
      .map((item) => ({ name: item.name as string, description: typeof item.description === 'string' ? item.description : '' })),
  };
}

/** Null means the host did not report a catalog (older host or unavailable runtime). */
export function validateAgentSkills(value: unknown): AgentSkill[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => typeof item.name === 'string' && item.name !== '')
    .map((item) => ({ name: item.name as string, description: typeof item.description === 'string' ? item.description : '' }));
}

export function validateRecentSessions(value: unknown): RecentSessionSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => typeof item.id === 'string' && item.id !== ''
      && typeof item.workspaceId === 'string' && item.workspaceId !== ''
      && typeof item.workspaceName === 'string'
      && typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt))
    .map((item) => ({
      id: item.id as string,
      title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : null,
      workspaceId: item.workspaceId as string,
      workspaceName: item.workspaceName as string,
      updatedAt: item.updatedAt as number,
      blank: item.blank === true,
      ...(typeof item.agent === 'string' ? { agent: item.agent } : {}),
      ...(typeof item.mode === 'string' ? { mode: item.mode } : {}),
    }));
}

export function validatePermissionSettings(value: unknown): PermissionSettings {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid permission settings response.');
  const settings = value as Record<string, unknown>;
  if (!Object.hasOwn(settings, 'defaultPreset')
    || (settings.defaultPreset !== null && !isPermissionPreset(settings.defaultPreset))
    || typeof settings.requiresSelection !== 'boolean') {
    throw new Error('Invalid permission settings response.');
  }
  return {
    defaultPreset: settings.defaultPreset as PermissionPreset | null,
    requiresSelection: settings.requiresSelection,
  };
}

export function normalizePlan(value: unknown): PlanState {
  return { active: typeof value === 'object' && value !== null && (value as { active?: unknown }).active === true };
}

export function normalizeTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: TodoItem[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.content !== 'string' || !['pending', 'in_progress', 'completed'].includes(row.status as string)) return null;
    items.push({ content: row.content, status: row.status as TodoItem['status'] });
  }
  return items;
}

export async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // Fall through to the status message.
  }
  return `Request failed (${response.status}).`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

export function jsonOptions(method: string, value: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export function sessionApiPath(workspaceId: string, sessionId?: string, suffix?: string): string {
  let path = `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`;
  if (sessionId !== undefined) path += `/${encodeURIComponent(sessionId)}`;
  if (suffix !== undefined) path += `/${suffix}`;
  return path;
}

export function workspaceApiPath(workspaceId: string, suffix: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/${suffix}`;
}

export type { AgentEvent, StopReason };
