import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { PERMISSION_MODES } from '../protocol/permission';
import type { Rule } from '../protocol/permission';
import { parseRuleSet } from '../permissions/rules';

/**
 * 配置加载。
 *
 * 只读一个文件：~/.omniagent/config.json。项目级配置、多作用域合并留到后面，
 * 但 Rule 上已经有 source 字段，扩展时不用改数据结构。
 */

/**
 * 模型 provider。
 *
 * 只做 OpenAI 兼容协议：官方 OpenAI、DeepSeek、OpenRouter、Ollama、vLLM
 * 都走同一套 Chat Completions，差别只在 baseURL 和 model id。
 * 密钥优先读环境变量，避免把明文写进 ~/.omniagent/config.json。
 */
export const ProviderSchema = z.object({
  type: z.literal('openai').default('openai'),
  /** 兼容端点根地址，如 https://api.deepseek.com/v1；不填则用 SDK 默认值。 */
  baseURL: z.string().url().optional(),
  /** 直接写密钥（不推荐）；不填则读取 apiKeyEnv 指向的环境变量。 */
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().default('OPENAI_API_KEY'),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
});

export type ProviderConfig = z.infer<typeof ProviderSchema>;

export const ConfigSchema = z.object({
  /** 模型 id；接真 provider 时就是它那边的 model 名。 */
  model: z.string().default('fake'),
  /** 不配 provider 时使用 FakeModel 演示剧本。 */
  provider: ProviderSchema.optional(),
  mode: z.enum(PERMISSION_MODES).default('workspace-write'),
  maxSteps: z.number().int().positive().default(25),
  system: z.string().optional(),
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: Config;
  rules: Rule[];
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
      return { config, rules: [], configDir };
    }
    throw error;
  }

  const config = ConfigSchema.parse(JSON.parse(raw));
  const rules = parseRuleSet(config.permissions ?? {}, 'user', configDir);
  return { config, rules, configDir };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
