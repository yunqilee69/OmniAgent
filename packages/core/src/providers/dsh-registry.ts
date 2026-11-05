import { DeepSeekMessagesModel } from './dsh-deepseek';
import type { DeepSeekMessagesOptions } from './dsh-deepseek';
import { OpenAIModel } from './openai';
import type { OpenAIModelOptions } from './openai';
import type { ModelClient } from './types';

export interface DshModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  inputModalities?: Array<'text' | 'image'>;
}
export interface DshProviderInfo {
  id: string;
  displayName: string;
  protocol: string;
  models: DshModelInfo[];
}
export interface DshProviderRegistration extends DshProviderInfo { createClient: () => ModelClient }
export interface DshOpenAIRoute extends DshProviderInfo { protocol: 'openai-completions'; options: OpenAIModelOptions }
export interface DshRegistryOptions { deepseek?: false | DeepSeekMessagesOptions; routes?: DshOpenAIRoute[] }
export const DSH_OFFICIAL_MODELS: readonly DshModelInfo[] = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576, inputModalities: ['text', 'image'] },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_048_576, inputModalities: ['text'] },
];
function copyModel(model: DshModelInfo): DshModelInfo {
  return { ...model, ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }) };
}

/** Select a provider/model pair without conflating identically named models on different routes. */
export class DshModelRegistry {
  private readonly providers = new Map<string, DshProviderRegistration>();
  register(entry: DshProviderRegistration): void {
    if (!entry.id.trim() || !entry.displayName.trim() || !entry.protocol.trim()) throw new Error('Provider identity must be non-empty');
    if (this.providers.has(entry.id)) throw new Error(`Duplicate provider "${entry.id}"`);
    const seen = new Set<string>();
    for (const model of entry.models) {
      if (!model.id.trim() || !model.name.trim() || seen.has(model.id)) throw new Error(`Invalid or duplicate model "${model.id}"`);
      seen.add(model.id);
    }
    this.providers.set(entry.id, { ...entry, models: entry.models.map(copyModel) });
  }
  list(): DshProviderInfo[] {
    return [...this.providers.values()].map(({ id, displayName, protocol, models }) => ({ id, displayName, protocol, models: models.map(copyModel) }));
  }
  select(providerId: string, modelId: string): { provider: DshProviderInfo; model: DshModelInfo; client: ModelClient } {
    const registration = this.providers.get(providerId);
    if (!registration) throw new Error(`Unknown provider "${providerId}"`);
    const model = registration.models.find((item) => item.id === modelId);
    if (!model) throw new Error(`Unknown model "${modelId}" for provider "${providerId}"`);
    const { id, displayName, protocol, models } = registration;
    return { provider: { id, displayName, protocol, models: models.map(copyModel) }, model: copyModel(model), client: registration.createClient() };
  }
}
export function createDshRegistry(options: DshRegistryOptions = {}): DshModelRegistry {
  const registry = new DshModelRegistry();
  if (options.deepseek !== false) {
    const config = options.deepseek ?? {};
    registry.register({ id: 'deepseek-official', displayName: 'DeepSeek', protocol: 'deepseek-messages',
      models: DSH_OFFICIAL_MODELS.map(copyModel), createClient: () => new DeepSeekMessagesModel(config) });
  }
  for (const route of options.routes ?? []) {
    if (route.protocol !== 'openai-completions') throw new Error(`Unsupported provider protocol "${String(route.protocol)}"`);
    const { options: config, ...entry } = route;
    registry.register({ ...entry, createClient: () => new OpenAIModel({ ...config, name: route.id }) });
  }
  return registry;
}
