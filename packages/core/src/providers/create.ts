import type { Config, ProviderConfig } from '../config/load';
import { ConfigSchema } from '../config/load';
import type { ModelDescriptor } from '../config/models';
import type { ReasoningEffort } from '../protocol/reasoning';
import { DeepSeekMessagesModel } from './dsh-deepseek';
import type { DshReasoningEffort } from './dsh-deepseek';
import { DSH_OFFICIAL_MODELS } from './dsh-registry';
import { OpenAIModel } from './openai';
import { PiAiModel, resolvePiAiRoute } from './pi-model';
import type { PiAiRouteConfig } from './pi-model';
import type { ModelClient } from './types';

/** Construct the explicitly selected route. No provider leaves fake fallback to the caller. */
export function createConfiguredModel(input: Config, descriptor?: ModelDescriptor): ModelClient | undefined {
  // Callers can construct Config programmatically and bypass the loader.
  const config = ConfigSchema.parse(input);
  const provider = config.provider;
  if (!provider) return undefined;

  if (config.model === 'fake') {
    throw new Error(
      '配置了 provider，但 model 仍是 fake：请在配置里填写真实的模型 id（如 deepseek-flash）。',
    );
  }

  if (typeof provider !== 'string') return createLegacyOpenAI(provider, config);

  const profile = Object.hasOwn(config.providers ?? {}, provider) ? config.providers?.[provider] : undefined;
  if (provider === 'deepseek-official') {
    if (profile?.api !== undefined && profile.api !== 'deepseek-messages') {
      throw new Error('deepseek-official requires the deepseek-messages protocol');
    }
    if (profile?.type !== undefined && profile.type !== 'deepseek-messages') {
      throw new Error('deepseek-official requires a deepseek-messages route type');
    }
    const knownModels = profile?.models ?? DSH_OFFICIAL_MODELS;
    const ids = new Set<string>();
    for (const model of knownModels) {
      if (ids.has(model.id)) throw new Error(`Duplicate DeepSeek model "${model.id}"`);
      ids.add(model.id);
    }
    const selectedModel = knownModels.find((model) => model.id === config.model);
    if (!selectedModel) {
      throw new Error(`Unknown model "${config.model}" for provider "deepseek-official"`);
    }
    const modelOptions = profile?.models?.find((model) => model.id === config.model);
    if (profile?.auth !== undefined || profile?.reasoning !== undefined || profile?.timeoutMs !== undefined || profile?.maxRetries !== undefined) {
      throw new Error('Unsupported deepseek-official route option');
    }
    const effort = config.reasoningEffort ?? profile?.reasoningEffort;
    const allowedEfforts = descriptor?.reasoning?.efforts
      ? Object.keys(descriptor.reasoning.efforts)
      : ['off', 'low', 'high', 'max'];
    if (effort !== undefined && !allowedEfforts.includes(effort)) {
      throw new Error(`Unsupported DeepSeek reasoning effort "${effort}"`);
    }
    const keyEnv = profile?.apiKeyEnv;
    const apiKey = profile?.apiKey ?? (keyEnv === undefined ? undefined : process.env[keyEnv]);
    if (keyEnv !== undefined && !apiKey) throw new Error(`Missing API key in environment variable ${keyEnv}`);
    const maxTokens = config.maxTokens ?? modelOptions?.maxTokens ?? profile?.maxTokens;
    return new DeepSeekMessagesModel({
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(profile?.baseURL === undefined ? {} : { baseURL: profile.baseURL }),
      ...(profile?.headers === undefined ? {} : { headers: profile.headers }),
      ...(profile?.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: profile.streamIdleTimeoutMs }),
      ...(profile?.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: profile.systemPromptUpdate }),
      ...(effort === undefined ? {} : { reasoningEffort: effort as DshReasoningEffort }),
      ...(descriptor?.reasoning === undefined ? {} : { reasoning: descriptor.reasoning }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  }

  if (profile?.type !== undefined && profile.type !== 'pi-ai') throw new Error('Unsupported pi-ai route type');
  if (profile?.api === 'deepseek-messages') throw new Error('DeepSeek Messages requires the deepseek-official route');
  if (config.maxTokens !== undefined || profile?.maxTokens !== undefined) {
    throw new Error('pi-ai does not support a configured per-request maxTokens output cap');
  }
  if (profile?.streamIdleTimeoutMs !== undefined || profile?.systemPromptUpdate !== undefined) {
    throw new Error('Unsupported pi-ai route option');
  }
  const effort = config.reasoningEffort ?? profile?.reasoningEffort ?? profile?.reasoning;
  if (effort === 'off' && descriptor?.reasoning?.wire === undefined) {
    throw new Error('pi-ai adapter does not support explicit reasoning effort "off"');
  }
  const models = profile?.models?.map((model) => ({
    ...model,
    reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : model.reasoning ? true : undefined,
  }));
  const route: PiAiRouteConfig = {
    ...(profile?.api === undefined ? {} : { api: profile.api }),
    ...(profile?.baseURL === undefined ? {} : { baseURL: profile.baseURL }),
    ...(models === undefined ? {} : { models }),
    ...(profile?.apiKey === undefined ? {} : { apiKey: profile.apiKey }),
    ...(profile?.apiKeyEnv === undefined ? {} : { apiKeyEnv: profile.apiKeyEnv }),
    ...(profile?.auth === undefined ? {} : { auth: profile.auth }),
    ...(profile?.headers === undefined ? {} : { headers: profile.headers }),
    ...(profile?.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs }),
    ...(profile?.maxRetries === undefined ? {} : { maxRetries: profile.maxRetries }),
    ...(effort === undefined || effort === 'off' ? {} : { reasoning: effort }),
    ...(descriptor?.reasoning?.efforts === undefined ? {} : { reasoningEfforts: descriptor.reasoning.efforts }),
    ...(descriptor?.reasoning?.budgets === undefined ? {} : { reasoningBudgets: descriptor.reasoning.budgets }),
    ...(descriptor?.reasoning?.wire === undefined ? {} : { reasoningWire: descriptor.reasoning.wire }),
    ...(descriptor?.reasoning?.default === undefined ? {} : { defaultReasoningEffort: descriptor.reasoning.default }),
  };
  const resolved = resolvePiAiRoute(provider, route);
  if (!resolved.models.some((model) => model.id === config.model)) {
    throw new Error(`Unknown model "${config.model}" for provider "${provider}"`);
  }
  return new PiAiModel({ provider, routes: { [provider]: route } });
}

/** Preserve the historical OpenAI endpoint and credential behavior. */
function createLegacyOpenAI(provider: ProviderConfig, config: Config): OpenAIModel {
  if (provider.type !== 'openai') throw new Error('Unsupported legacy provider type');
  if (config.reasoningEffort !== undefined || config.maxTokens !== undefined) {
    throw new Error('Legacy OpenAI provider does not support DSH generation settings');
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

/** Construct a model from a validated catalog descriptor. */
export function createCatalogModel(
  config: Config,
  descriptor: ModelDescriptor,
  reasoningEffort?: ReasoningEffort,
): ModelClient {
  if (descriptor.protocol === 'legacy-openai') {
    const model = createConfiguredModel(config);
    if (!model) throw new Error('The legacy OpenAI model is not configured');
    return model;
  }
  const model = createConfiguredModel({
    ...config,
    provider: descriptor.provider,
    model: descriptor.id,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }, descriptor);
  if (!model) throw new Error(`No model client is configured for provider "${descriptor.provider}"`);
  return model;
}
