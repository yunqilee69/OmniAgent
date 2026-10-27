import type { Config } from '../config/load';
import { OpenAIModel } from './openai';
import type { ModelClient } from './types';

/**
 * 根据配置构造 provider。
 *
 * 没配置 provider 时返回 undefined，由调用方决定回退到什么
 * （TUI 当前回退到 FakeModel 演示剧本）。
 *
 * 目前只有一种 type：所有 OpenAI 兼容端点都走同一套 Chat Completions，
 * 差别只在 baseURL 和 model id。
 */
export function createConfiguredModel(config: Config): ModelClient | undefined {
  const provider = config.provider;
  if (!provider) {
    return undefined;
  }

  if (config.model === 'fake') {
    throw new Error(
      '配置了 provider，但 model 仍是 fake：请在配置里填写真实的模型 id（如 deepseek-chat）。',
    );
  }

  const apiKey = provider.apiKey ?? process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `未找到 API key：请设置环境变量 ${provider.apiKeyEnv}，或在配置的 provider.apiKey 里直接填写。`,
    );
  }

  return new OpenAIModel({
    apiKey,
    name: provider.type,
    ...(provider.baseURL !== undefined ? { baseURL: provider.baseURL } : {}),
    ...(provider.headers !== undefined ? { headers: provider.headers } : {}),
    ...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
    ...(provider.maxRetries !== undefined ? { maxRetries: provider.maxRetries } : {}),
  });
}
