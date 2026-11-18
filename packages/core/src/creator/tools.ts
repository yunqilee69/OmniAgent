/**
 * Model-facing configuration tools for the built-in Creator agent.
 *
 * These tools are only registered when the host injects {@link CreatorServices}.
 * The host owns validation and persistence; this module owns the model contract,
 * the mutating flags and the explicit "no credentials in chat" boundary.
 *
 * @module @omniagent/core/creator/tools
 */

import { z } from 'zod';
import type { Tool, ToolOutput } from '../domain/tool';
import { ARCHIVE_MAX_RETENTION_MS, ARCHIVE_MIN_RETENTION_MS } from '../config/archive';
import { isAskUserTimeout } from '../config/ask-user';
import { MCP_MAX_TIMEOUT_MS } from '../mcp/config';
import { ReasoningEffortSchema } from '../protocol/reasoning';
import { ASK_USER_MAX_TIMEOUT_SEC } from '../tools/builtin/ask-user';
import type { ModelBinding } from '../session/model-binding';
import type {
  CreatorMcpServerWrite,
  CreatorModeService,
  CreatorModelSourceModelWrite,
  CreatorModelSourceWrite,
  CreatorRoleWrite,
  CreatorServices,
} from './types';

export const LIST_MODES_TOOL_NAME = 'list_modes';
export const WRITE_MODE_TOOL_NAME = 'write_mode';
export const DELETE_MODE_TOOL_NAME = 'delete_mode';
export const SET_DEFAULT_MODE_TOOL_NAME = 'set_default_mode';
export const LIST_MODE_OPTIONS_TOOL_NAME = 'list_mode_options';

export const LIST_MODEL_ROLES_TOOL_NAME = 'list_model_roles';
export const WRITE_MODEL_ROLE_TOOL_NAME = 'write_model_role';
export const DELETE_MODEL_ROLE_TOOL_NAME = 'delete_model_role';
export const LIST_MODEL_SOURCES_TOOL_NAME = 'list_model_sources';
export const WRITE_MODEL_SOURCE_TOOL_NAME = 'write_model_source';
export const DELETE_MODEL_SOURCE_TOOL_NAME = 'delete_model_source';
export const DISCOVER_MODELS_TOOL_NAME = 'discover_models';

export const GET_OMNIAGENT_SETTINGS_TOOL_NAME = 'get_omniagent_settings';
export const UPDATE_PERMISSION_DEFAULT_TOOL_NAME = 'update_permission_default';
export const UPDATE_ARCHIVE_SETTINGS_TOOL_NAME = 'update_archive_settings';
export const UPDATE_ASK_USER_TIMEOUT_TOOL_NAME = 'update_ask_user_timeout';

export const LIST_MCP_SERVERS_TOOL_NAME = 'list_mcp_servers';
export const WRITE_MCP_SERVER_TOOL_NAME = 'write_mcp_server';
export const DELETE_MCP_SERVER_TOOL_NAME = 'delete_mcp_server';
export const TEST_MCP_SERVER_TOOL_NAME = 'test_mcp_server';

export const CREATOR_MODE_TOOL_GROUP = [
  LIST_MODES_TOOL_NAME,
  LIST_MODE_OPTIONS_TOOL_NAME,
  WRITE_MODE_TOOL_NAME,
  DELETE_MODE_TOOL_NAME,
  SET_DEFAULT_MODE_TOOL_NAME,
] as const;

export const CREATOR_MODEL_TOOL_GROUP = [
  LIST_MODEL_ROLES_TOOL_NAME,
  WRITE_MODEL_ROLE_TOOL_NAME,
  DELETE_MODEL_ROLE_TOOL_NAME,
  LIST_MODEL_SOURCES_TOOL_NAME,
  WRITE_MODEL_SOURCE_TOOL_NAME,
  DELETE_MODEL_SOURCE_TOOL_NAME,
  DISCOVER_MODELS_TOOL_NAME,
] as const;

export const CREATOR_SETTINGS_TOOL_GROUP = [
  GET_OMNIAGENT_SETTINGS_TOOL_NAME,
  UPDATE_PERMISSION_DEFAULT_TOOL_NAME,
  UPDATE_ARCHIVE_SETTINGS_TOOL_NAME,
  UPDATE_ASK_USER_TIMEOUT_TOOL_NAME,
] as const;

export const CREATOR_MCP_TOOL_GROUP = [
  LIST_MCP_SERVERS_TOOL_NAME,
  WRITE_MCP_SERVER_TOOL_NAME,
  DELETE_MCP_SERVER_TOOL_NAME,
  TEST_MCP_SERVER_TOOL_NAME,
] as const;

export const CREATOR_TOOL_GROUP = [
  ...CREATOR_MODE_TOOL_GROUP,
  ...CREATOR_MODEL_TOOL_GROUP,
  ...CREATOR_SETTINGS_TOOL_GROUP,
  ...CREATOR_MCP_TOOL_GROUP,
] as const;

const nonEmpty = z.string().trim().min(1).max(256);
const idText = (label: string): z.ZodString => z.string().trim().min(1).max(64)
  .describe(`${label} id: lowercase letters, digits, dots, dashes or underscores, at most 64 characters.`);
const selector = z.union([z.literal('*'), z.array(nonEmpty).max(256)])
  .describe('"*" for every entry, or an explicit list of names.');
const permissionPreset = z.enum(['read-only', 'workspace-write'])
  .describe('Default permission preset for new sessions. danger-full-access is refused here; use Settings → General.');

/** A mode binding without the event version, which the tool adds. */
const CreatorModelBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agent') }),
  z.strictObject({ kind: z.literal('role'), role: nonEmpty }),
  z.strictObject({
    kind: z.literal('model'),
    provider: nonEmpty,
    model: nonEmpty,
    reasoningEffort: ReasoningEffortSchema.optional(),
  }),
]);

type CreatorModelBinding = z.infer<typeof CreatorModelBindingSchema>;

function bindingWithVersion(binding: CreatorModelBinding): ModelBinding {
  if (binding.kind === 'agent') return { version: 2, kind: 'agent' };
  if (binding.kind === 'role') return { version: 2, kind: 'role', role: binding.role };
  return {
    version: 2,
    kind: 'model',
    provider: binding.provider,
    model: binding.model,
    ...(binding.reasoningEffort === undefined ? {} : { reasoningEffort: binding.reasoningEffort }),
  };
}

const ModeMemberParams = z.object({
  id: nonEmpty.describe('Stable member id used inside this team mode.'),
  name: z.string().trim().min(1).max(120).describe('Member display name.'),
  agent: nonEmpty.describe('Agent id from list_agent_definitions; primary-only agents cannot be members.'),
  model: CreatorModelBindingSchema.optional().describe('Member model binding; omit to follow the member agent role.'),
  prompt: z.string().max(20_000).optional().describe('Extra instruction prepended to each delegation to this member.'),
  tools: selector.optional().describe('Member tool allowlist; omit for the mode value.'),
  skills: selector.optional().describe('Member skill allowlist; omit for the mode value.'),
}).strict();

const TeamPolicyParams = z.object({
  maxActive: z.number().int().min(1).max(8).optional().describe('Maximum members working at once.'),
  maxSteps: z.number().int().min(1).max(500).optional().describe('Step budget for each delegated member.'),
  failure: z.enum(['stop', 'continue']).optional().describe('Whether one member failure stops the team.'),
  allowPlan: z.boolean().optional().describe('Whether members may use plan mode.'),
  allowGoal: z.boolean().optional().describe('Whether members may create goals.'),
}).strict();

const WriteModeParams = z.object({
  id: idText('Mode'),
  type: z.enum(['single', 'team']).optional().describe('single runs one agent; team delegates to members. Defaults to single.'),
  name: z.string().trim().min(1).max(120).describe('Display name shown in the mode picker.'),
  description: z.string().max(2_000).optional().describe('Short explanation of when to use this mode.'),
  agent: nonEmpty.describe('Coordinator agent id. It must be usable as a main agent.'),
  model: CreatorModelBindingSchema.optional().describe('Default model binding for new sessions in this mode.'),
  tools: selector.optional().describe('Tool allowlist for the mode. Unknown names make the mode invalid.'),
  skills: selector.optional().describe('Skill allowlist for the mode. Missing skills only warn at runtime.'),
  members: z.array(ModeMemberParams).min(1).max(8).optional().describe('Team members; required for team modes.'),
  policy: TeamPolicyParams.optional().describe('Team execution policy.'),
}).strict();

const DeleteModeParams = z.object({ id: idText('Mode') }).strict();
const SetDefaultModeParams = z.object({ id: idText('Mode') }).strict();
const NoParams = z.object({}).strict();

const WriteRoleParams = z.object({
  id: idText('Role'),
  name: z.string().trim().min(1).max(120).optional().describe('Display name; defaults to the role id.'),
  provider: nonEmpty.describe('Provider source id from list_model_sources.'),
  model: nonEmpty.describe('Model id from that provider source.'),
  reasoningEffort: ReasoningEffortSchema.optional().describe('Reasoning level supported by the model.'),
}).strict();

const DeleteRoleParams = z.object({ id: idText('Role') }).strict();

const ReasoningWireParams = z.object({
  enableField: z.string().trim().min(1).max(512).optional(),
  enableValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  disableField: z.string().trim().min(1).max(512).optional(),
  disableValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  effortField: z.string().trim().min(1).max(512).optional(),
  budgetField: z.string().trim().min(1).max(512).optional(),
}).strict().describe('Dotted request-body paths used to encode reasoning levels.');

const ModelReasoningParams = z.object({
  efforts: z.record(ReasoningEffortSchema, z.union([z.string(), z.number(), z.null()]))
    .describe('Map each supported reasoning level to its wire value; null disables reasoning.'),
  default: ReasoningEffortSchema.optional().describe('Default level when the binding does not choose one.'),
  wire: ReasoningWireParams.optional(),
}).strict();

const ModelSourceModelParams = z.object({
  id: z.string().trim().min(1).max(256).describe('Model id as the provider expects it.'),
  name: z.string().trim().min(1).max(256).optional().describe('Display name.'),
  contextWindow: z.number().int().positive().optional().describe('Input context window in tokens.'),
  maxTokens: z.number().int().positive().optional().describe('Maximum output tokens.'),
  input: z.array(z.enum(['text', 'image'])).min(1).optional().describe('Accepted input modalities.'),
  reasoning: z.union([z.literal(false), ModelReasoningParams]).optional(),
}).strict();

const WriteModelSourceParams = z.object({
  id: idText('Model source'),
  name: z.string().trim().min(1).max(120).optional().describe('Display name for the source.'),
  api: z.enum(['deepseek-messages', 'openai-completions', 'openai-responses', 'anthropic-messages'])
    .optional().describe('Wire protocol. deepseek-messages is reserved for deepseek-official.'),
  baseURL: z.string().url().max(2_048).optional().describe('HTTP(S) endpoint without credentials.'),
  clearBaseURL: z.boolean().optional().describe('Remove the stored endpoint.'),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).optional()
    .describe('Environment variable holding the API key. Never pass the key itself.'),
  clearApiKeyEnv: z.boolean().optional().describe('Remove the stored environment variable name.'),
  auth: z.union([z.literal('ambient'), z.literal(false)]).optional()
    .describe('ambient uses the provider built-in credentials; false removes that setting.'),
  maxRetries: z.union([z.number().int().min(0).max(8), z.null()]).optional()
    .describe('Extra attempts after a retryable failure; null restores the default.'),
  models: z.array(ModelSourceModelParams).min(1).optional()
    .describe('Complete replacement model list. Omit to keep stored models; list first and include every model you want to keep.'),
}).strict();

const DeleteModelSourceParams = z.object({ id: idText('Model source') }).strict();

const DiscoverModelsParams = z.object({
  provider: nonEmpty.optional().describe('Stored source id whose endpoint and env key should be used.'),
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages'])
    .optional().describe('Protocol used to shape the model-list request.'),
  baseURL: z.string().url().max(2_048).optional().describe('Endpoint to query instead of the stored one.'),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).optional()
    .describe('Environment variable holding the API key. Never pass the key itself.'),
}).strict();

const UpdatePermissionDefaultParams = z.object({ defaultPreset: permissionPreset }).strict();

const UpdateArchiveParams = z.object({
  enabled: z.boolean().describe('Turn automatic archiving on or off.'),
  retentionMs: z.number().int().min(ARCHIVE_MIN_RETENTION_MS).max(ARCHIVE_MAX_RETENTION_MS)
    .describe('Idle time before an unpinned root session is archived.'),
}).strict();

const UpdateAskUserTimeoutParams = z.object({
  timeoutSec: z.number().int().refine(isAskUserTimeout, {
    message: `timeoutSec must be -1 or an integer from 1 to ${ASK_USER_MAX_TIMEOUT_SEC}`,
  }).describe('-1 waits until answered; otherwise seconds, up to one day.'),
}).strict();

/** Secret values never enter chat: only ${VAR} references are accepted. */
const SECRET_REFERENCE = /^(?=.*\$\{[A-Za-z_][A-Za-z0-9_]*\})(?:[^$]|\$\{[A-Za-z_][A-Za-z0-9_]*\})*$/;
const secretReference = z.string().trim().min(1).max(2_048)
  .regex(SECRET_REFERENCE, 'value must contain only ${VAR} references (for example "Bearer ${MCP_TOKEN}")')
  .describe('Template containing ${VAR} references resolved from the host environment. Literal secrets are refused.');
const secretRecord = z.record(z.string().trim().min(1).max(256), secretReference);

const WriteMcpServerParams = z.object({
  id: idText('MCP server'),
  type: z.enum(['stdio', 'http']).optional().describe('stdio runs a command; http connects to a URL.'),
  enabled: z.boolean().optional().describe('Whether the host should connect to this server.'),
  timeoutMs: z.union([z.number().int().positive().max(MCP_MAX_TIMEOUT_MS), z.null()]).optional()
    .describe('Connection/call timeout in milliseconds; null restores the default.'),
  command: z.string().trim().min(1).max(4_096).optional().describe('stdio executable.'),
  args: z.array(z.string()).max(256).optional().describe('stdio arguments.'),
  env: secretRecord.optional().describe('stdio environment. Values must be ${VAR} references.'),
  clearEnv: z.array(z.string().trim().min(1).max(256)).optional().describe('Environment keys to remove.'),
  cwd: z.union([z.string().trim().min(1).max(4_096), z.null()]).optional().describe('stdio working directory; null removes it.'),
  url: z.string().trim().min(1).max(2_048).optional().describe('HTTP MCP endpoint.'),
  headers: secretRecord.optional().describe('HTTP headers. Values must contain only ${VAR} references.'),
  clearHeaders: z.array(z.string().trim().min(1).max(256)).optional().describe('Header keys to remove.'),
}).strict();

const DeleteMcpServerParams = z.object({ id: idText('MCP server') }).strict();
const TestMcpServerParams = z.object({ id: idText('MCP server') }).strict();

function failure(error: unknown): ToolOutput {
  const message = error instanceof Error ? error.message : String(error);
  return { content: JSON.stringify({ code: 'creator_settings_failed', message }), ok: false };
}

async function run(work: () => Promise<unknown>): Promise<ToolOutput> {
  try {
    return { content: JSON.stringify(await work()) };
  } catch (error) {
    return failure(error);
  }
}

function modeWrite(input: z.infer<typeof WriteModeParams>): Record<string, unknown> {
  return {
    type: input.type ?? 'single',
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    agent: input.agent,
    ...(input.model === undefined ? {} : { model: bindingWithVersion(input.model) }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.skills === undefined ? {} : { skills: input.skills }),
    ...(input.members === undefined ? {} : {
      members: input.members.map((member) => ({
        id: member.id,
        name: member.name,
        agent: member.agent,
        ...(member.model === undefined ? {} : { model: bindingWithVersion(member.model) }),
        ...(member.prompt === undefined ? {} : { prompt: member.prompt }),
        ...(member.tools === undefined ? {} : { tools: member.tools }),
        ...(member.skills === undefined ? {} : { skills: member.skills }),
      })),
    }),
    ...(input.policy === undefined ? {} : { policy: input.policy }),
  };
}

function roleWrite(input: z.infer<typeof WriteRoleParams>): CreatorRoleWrite {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    provider: input.provider,
    model: input.model,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
  };
}

function sourceWrite(input: z.infer<typeof WriteModelSourceParams>): CreatorModelSourceWrite {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.api === undefined ? {} : { api: input.api }),
    ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
    ...(input.clearBaseURL === undefined ? {} : { clearBaseURL: input.clearBaseURL }),
    ...(input.apiKeyEnv === undefined ? {} : { apiKeyEnv: input.apiKeyEnv }),
    ...(input.clearApiKeyEnv === undefined ? {} : { clearApiKeyEnv: input.clearApiKeyEnv }),
    ...(input.auth === undefined ? {} : { auth: input.auth }),
    ...(input.maxRetries === undefined ? {} : { maxRetries: input.maxRetries }),
    ...(input.models === undefined ? {} : { models: input.models as CreatorModelSourceModelWrite[] }),
  };
}

function mcpWrite(input: z.infer<typeof WriteMcpServerParams>): CreatorMcpServerWrite {
  return {
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.clearEnv === undefined ? {} : { clearEnv: input.clearEnv }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.clearHeaders === undefined ? {} : { clearHeaders: input.clearHeaders }),
  };
}

const AUTHORIZATION =
  'Only change OmniAgent configuration at the user\'s explicit request. '
  + 'Never accept or write API keys or literal MCP secrets; use apiKeyEnv or ${VAR} references instead.';

/** System-prompt reminder shared by every mounted Creator configuration tool. */
export function renderCreatorToolGuidance(): string {
  return `${AUTHORIZATION} Do not hand-edit ~/.omniagent/config.json or modes.json; these tools own the writes. `
    + 'State which change will take effect only for new turns or new sessions when it matters.';
}

/** Whether a tool name belongs to the Creator configuration group. */
export function isCreatorToolName(name: string): boolean {
  return (CREATOR_TOOL_GROUP as readonly string[]).includes(name);
}

function modeTools(service: CreatorModeService): Tool[] {
  return [
    {
      name: LIST_MODES_TOOL_NAME,
      description: 'List mode presets and the default mode for new sessions. Read this before changing a mode.',
      parameters: NoParams,
      mutating: false,
      async execute() {
        return run(async () => {
          const [modes, defaultMode] = await Promise.all([service.list(), service.defaultId()]);
          return { modes, defaultMode };
        });
      },
    },
    {
      name: LIST_MODE_OPTIONS_TOOL_NAME,
      description: 'List the tool and skill names accepted by write_mode for the current workspace. MCP tools appear as mcp__<server>__<tool>.',
      parameters: NoParams,
      mutating: false,
      async execute(_args, ctx) {
        return run(async () => service.options(ctx.cwd));
      },
    },
    {
      name: WRITE_MODE_TOOL_NAME,
      description: 'Create or replace one mode preset in ~/.omniagent/modes.json. A mode fixes the agent, tools, skills and default model for new sessions; existing sessions keep their snapshot. This replaces the whole mode, so list first and include every field you want to keep. The host validates agents, tools, skills and model bindings.',
      parameters: WriteModeParams,
      mutating: true,
      async execute(args) {
        const input = WriteModeParams.parse(args);
        return run(async () => ({ mode: await service.save(input.id, modeWrite(input)) }));
      },
    },
    {
      name: DELETE_MODE_TOOL_NAME,
      description: 'Remove a custom mode preset or a built-in override. Deleting an override restores the built-in mode. Existing sessions are unaffected.',
      parameters: DeleteModeParams,
      mutating: true,
      async execute(args) {
        const input = DeleteModeParams.parse(args);
        return run(async () => ({ id: input.id, removed: await service.remove(input.id) }));
      },
    },
    {
      name: SET_DEFAULT_MODE_TOOL_NAME,
      description: 'Choose the mode new sessions start from. Only an existing, valid mode is accepted.',
      parameters: SetDefaultModeParams,
      mutating: true,
      async execute(args) {
        const input = SetDefaultModeParams.parse(args);
        return run(async () => ({ defaultMode: await service.setDefault(input.id) }));
      },
    },
  ];
}

export function createCreatorTools(services: CreatorServices): Tool[] {
  const tools: Tool[] = [
    ...modeTools(services.modes),
    {
      name: LIST_MODEL_ROLES_TOOL_NAME,
      description: 'List model roles from config.json, including invalid explicit entries. A role points at one provider/model pair and an optional reasoning level.',
      parameters: NoParams,
      mutating: false,
      async execute() {
        return run(async () => ({ roles: await services.roles.list() }));
      },
    },
    {
      name: WRITE_MODEL_ROLE_TOOL_NAME,
      description: 'Create or replace one named model role. The provider and model must already exist in list_model_sources. Changes apply to the next turn for sessions using this role; a running turn keeps its model.',
      parameters: WriteRoleParams,
      mutating: true,
      async execute(args) {
        const input = WriteRoleParams.parse(args);
        return run(async () => ({ role: await services.roles.save(input.id, roleWrite(input)) }));
      },
    },
    {
      name: DELETE_MODEL_ROLE_TOOL_NAME,
      description: 'Remove an explicit model role. The implicit default role cannot be deleted; agents referencing a removed role must be updated.',
      parameters: DeleteRoleParams,
      mutating: true,
      async execute(args) {
        const input = DeleteRoleParams.parse(args);
        return run(async () => ({ id: input.id, removed: await services.roles.remove(input.id) }));
      },
    },
    {
      name: LIST_MODEL_SOURCES_TOOL_NAME,
      description: 'List configured model sources, their models, protocols and whether an API key is configured. Never returns the key itself.',
      parameters: NoParams,
      mutating: false,
      async execute() {
        return run(async () => services.modelSources.list());
      },
    },
    {
      name: WRITE_MODEL_SOURCE_TOOL_NAME,
      description: 'Create or update one model source. API keys are never accepted here: configure apiKeyEnv or set the key in Settings → Model configuration. Saving a complete models list replaces the stored list; omit models to keep it. A new source needs an API protocol and at least one model.',
      parameters: WriteModelSourceParams,
      mutating: true,
      async execute(args) {
        const input = WriteModelSourceParams.parse(args);
        return run(async () => ({ source: await services.modelSources.save(input.id, sourceWrite(input)) }));
      },
    },
    {
      name: DELETE_MODEL_SOURCE_TOOL_NAME,
      description: 'Remove a custom model source. The active default source, built-in sources, and sources referenced by a role are refused.',
      parameters: DeleteModelSourceParams,
      mutating: true,
      async execute(args) {
        const input = DeleteModelSourceParams.parse(args);
        return run(async () => ({ id: input.id, removed: await services.modelSources.remove(input.id) }));
      },
    },
    {
      name: DISCOVER_MODELS_TOOL_NAME,
      description: 'Fetch the model list from an OpenAI-compatible or Anthropic endpoint. Uses the stored key or apiKeyEnv; never accepts a literal key. deepseek-messages has no model-list endpoint. This performs a network request, so use it only when the user asks.',
      parameters: DiscoverModelsParams,
      mutating: false,
      async execute(args) {
        const input = DiscoverModelsParams.parse(args);
        return run(async () => services.modelSources.discover({
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.api === undefined ? {} : { api: input.api }),
          ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
          ...(input.apiKeyEnv === undefined ? {} : { apiKeyEnv: input.apiKeyEnv }),
        }));
      },
    },
    {
      name: GET_OMNIAGENT_SETTINGS_TOOL_NAME,
      description: 'Read the default permission preset, automatic archiving, ask_user timeout and default mode. Does not return credentials.',
      parameters: NoParams,
      mutating: false,
      async execute() {
        return run(async () => services.settings.read());
      },
    },
    {
      name: UPDATE_PERMISSION_DEFAULT_TOOL_NAME,
      description: 'Set the permission preset new sessions start from. Only read-only and workspace-write are accepted; danger-full-access requires the risk confirmation on Settings → General.',
      parameters: UpdatePermissionDefaultParams,
      mutating: true,
      async execute(args) {
        const input = UpdatePermissionDefaultParams.parse(args);
        return run(async () => ({ permissions: await services.settings.updatePermission(input) }));
      },
    },
    {
      name: UPDATE_ARCHIVE_SETTINGS_TOOL_NAME,
      description: 'Turn automatic session archiving on or off and set the idle retention window. Archiving only removes sessions from listings; it never deletes them.',
      parameters: UpdateArchiveParams,
      mutating: true,
      async execute(args) {
        const input = UpdateArchiveParams.parse(args);
        return run(async () => ({ archive: await services.settings.updateArchive(input) }));
      },
    },
    {
      name: UPDATE_ASK_USER_TIMEOUT_TOOL_NAME,
      description: 'Set how long ask_user waits for an answer before the agent continues. The question stays answerable. Applies to new sessions; -1 waits until answered.',
      parameters: UpdateAskUserTimeoutParams,
      mutating: true,
      async execute(args) {
        const input = UpdateAskUserTimeoutParams.parse(args);
        return run(async () => ({ askUser: await services.settings.updateAskUser(input) }));
      },
    },
  ];

  if (services.mcp !== undefined) {
    const mcp = services.mcp;
    tools.push(
      {
        name: LIST_MCP_SERVERS_TOOL_NAME,
        description: 'List MCP servers with connection state and exposed tool names. Environment and header values are never returned, only their keys.',
        parameters: NoParams,
        mutating: false,
        async execute() {
          return run(async () => mcp.list());
        },
      },
      {
        name: WRITE_MCP_SERVER_TOOL_NAME,
        description: 'Create or update one MCP server. Literal secrets are refused: env and header values must be ${VAR} references resolved from the host environment, or be set in Settings → MCP servers. Saving triggers a reconnect; new sessions see new tools.',
        parameters: WriteMcpServerParams,
        mutating: true,
        async execute(args) {
          const input = WriteMcpServerParams.parse(args);
          return run(async () => ({ server: await mcp.save(input.id, mcpWrite(input)) }));
        },
      },
      {
        name: DELETE_MCP_SERVER_TOOL_NAME,
        description: 'Remove one stored MCP server. Existing sessions keep the tools they already registered; new sessions will not see them.',
        parameters: DeleteMcpServerParams,
        mutating: true,
        async execute(args) {
          const input = DeleteMcpServerParams.parse(args);
          return run(async () => ({ id: input.id, removed: await mcp.remove(input.id) }));
        },
      },
      {
        name: TEST_MCP_SERVER_TOOL_NAME,
        description: 'Probe a stored MCP server and return its tools, resources and prompts. Save a draft first; this can take up to the server timeout.',
        parameters: TestMcpServerParams,
        mutating: false,
        async execute(args) {
          const input = TestMcpServerParams.parse(args);
          return run(async () => mcp.test(input.id));
        },
      },
    );
  }

  return tools;
}
