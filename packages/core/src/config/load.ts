import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ReasoningEffortSchema } from '../protocol/reasoning';

/**
 * 配置加载。
 *
 * 只读一个文件：~/.omniagent/config.json。
 */

/** Legacy OpenAI Chat Completions settings. Missing type retains the historical default. */
export const ProviderSchema = z.object({
  type: z.literal('openai').default('openai'),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().default('OPENAI_API_KEY'),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
}).passthrough();

export type ProviderConfig = z.infer<typeof ProviderSchema>;

const nonEmpty = z.string().trim().min(1);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reasoningEffort = ReasoningEffortSchema;

const safePathSegment = z.string().min(1).max(128).refine(
  (segment) => !['__proto__', 'constructor', 'prototype'].includes(segment),
  'unsafe field path segment',
);
const wireField = z.string().trim().min(1).max(512).refine((path) => {
  const segments = path.split('.');
  if (segments.length === 0 || segments.some((segment) => !safePathSegment.safeParse(segment).success)) return false;
  return !['model', 'messages', 'stream', 'tools'].includes(segments[0]!);
}, 'invalid dotted field path');
const wireValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const reasoningWire = z.object({
  enableField: wireField.optional(),
  enableValue: wireValue.optional(),
  disableField: wireField.optional(),
  disableValue: wireValue.optional(),
  effortField: wireField.optional(),
  budgetField: wireField.optional(),
}).strict();

const modelReasoning = z.object({
  efforts: z.partialRecord(reasoningEffort, z.union([z.string(), z.number(), z.null()])).optional(),
  budgets: z.partialRecord(reasoningEffort, positiveInteger).optional(),
  default: reasoningEffort.optional(),
  wire: reasoningWire.optional(),
}).strict().superRefine((value, context) => {
  if (value.default !== undefined && (value.efforts === undefined || !(value.default in value.efforts))) {
    context.addIssue({
      code: 'custom',
      path: ['default'],
      message: `default reasoning effort "${value.default}" is not present in efforts`,
    });
  }
});

const modelCapabilities = z.object({
  imageInput: z.boolean().optional(),
}).strict();

const routeModel = z.object({
  id: nonEmpty,
  name: nonEmpty.optional(),
  contextWindow: positiveInteger.optional(),
  maxTokens: positiveInteger.optional(),
  input: z.array(z.enum(['text', 'image'])).min(1).optional(),
  /** Boolean is the historical pi-ai flag; object adds explicit level/wire mapping. */
  reasoning: z.union([z.boolean(), modelReasoning]).optional(),
  capabilities: modelCapabilities.optional(),
}).passthrough();

const role = z.object({
  name: nonEmpty.optional(),
  provider: nonEmpty,
  model: nonEmpty,
  reasoningEffort: reasoningEffort.optional(),
}).strict();

const agentProfile = z.object({
  tools: z.union([z.literal('*'), z.array(nonEmpty)]),
  skills: z.union([z.literal('*'), z.array(nonEmpty)]).optional(),
}).strict();

/** Provider profiles use the DSH convention: the map key is the route id. */
const route = z.object({
  api: z.enum(['deepseek-messages', 'openai-completions', 'openai-responses', 'anthropic-messages']).optional(),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: nonEmpty.optional(),
  auth: z.literal('ambient').optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(routeModel).optional(),
  timeoutMs: positiveInteger.optional(),
  streamIdleTimeoutMs: positiveInteger.max(2_147_483_647).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  reasoning: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  reasoningEffort: reasoningEffort.optional(),
  maxTokens: positiveInteger.optional(),
  systemPromptUpdate: z.enum(['in-history', 'latest']).optional(),
}).passthrough();

const webAuth = z.object({
  enabled: z.boolean().default(false),
  username: z.string().optional(),
  password: z.string().optional(),
}).strict().superRefine((auth, context) => {
  if (!auth.enabled) return;
  for (const field of ['username', 'password'] as const) {
    if (!auth[field]?.trim()) context.addIssue({ code: 'custom', path: [field], message: 'Required when web authentication is enabled' });
  }
});

const webConfig = z.object({
  host: nonEmpty.default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(4317),
  auth: webAuth.prefault({}),
}).strict();

export const ConfigSchema = z.object({
  web: webConfig.prefault({}),
  model: nonEmpty.default('fake'),
  /** String route for DSH/pi-ai; object is the legacy OpenAI configuration. */
  provider: z.union([nonEmpty, ProviderSchema]).optional(),
  providers: z.record(nonEmpty, route).optional(),
  /** Additional named model roles. `default` may override the top-level default role. */
  roles: z.record(nonEmpty, role).optional(),
  /** Named tool/skill allowlists referenced by agent Markdown files. */
  agentProfiles: z.record(nonEmpty, agentProfile).optional(),
  /**
   * MCP servers keyed by server id. Entries stay opaque here so one broken
   * server can be repaired from Settings instead of invalidating all config;
   * `mcp/config.ts` validates the accepted stdio/SSE/HTTP/WebSocket shapes.
   */
  mcpServers: z.record(nonEmpty, z.unknown()).optional(),
  reasoningEffort: reasoningEffort.optional(),
  maxTokens: positiveInteger.optional(),
  /** Optional input budget for pre-request compaction; defaults to the model catalog. */
  contextWindowTokens: positiveInteger.optional(),
  retainContextTokens: positiveInteger.optional(),
  // Invalid stored permission values must remain available for explicit repair.
  dsh: z.unknown().optional(),
  maxSteps: z.number().int().positive().default(300),
  /** Subagent delegation limits. Depth counts root as 0. */
  subagents: z.object({
    maxDepth: z.number().int().nonnegative().default(1),
    maxActive: z.number().int().positive().default(8),
  }).passthrough().optional(),
  /** Model-facing todo policy. Parallel active items suit workflows that delegate work to subagents. */
  todo: z.object({
    allowParallelInProgress: z.boolean().default(false),
  }).passthrough().optional(),
  system: z.string().optional(),
}).passthrough();

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: Config;
  configDir: string;
}

export function defaultConfigDir(): string {
  return join(homedir(), '.omniagent');
}

export function defaultConfigPath(): string {
  return join(defaultConfigDir(), 'config.json');
}

export async function loadConfig(
  path: string = defaultConfigPath(),
): Promise<LoadedConfig> {
  const configDir = dirname(path);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      const config = ConfigSchema.parse({});
      return { config, configDir };
    }
    throw error;
  }

  const config = ConfigSchema.parse(JSON.parse(raw));
  return { config, configDir };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
