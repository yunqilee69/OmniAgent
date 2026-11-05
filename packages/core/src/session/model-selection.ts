import { z } from 'zod';
import type { Config } from '../config/load';
import { DSH_OFFICIAL_MODELS } from '../providers/dsh-registry';
import { resolvePiAiRoute } from '../providers/pi-catalog';
import type { PiAiCustomApi, PiAiRouteConfig } from '../providers/pi-catalog';
import { createConfiguredModel } from '../providers/create';
import type { ModelClient } from '../providers/types';

export const MODEL_SELECTION_EVENT = 'model/selected';
export const MODEL_SELECTION_VERSION = 1;

export const ReasoningEffortSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/**
 * A model choice that is safe to persist: no endpoint, headers, key, or other
 * credential material. The current config remains the source of credentials.
 */
export const SessionModelSelectionSchema = z.object({
  version: z.literal(MODEL_SELECTION_VERSION),
  provider: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(256),
  reasoningEffort: ReasoningEffortSchema.optional(),
}).strict();
export type SessionModelSelection = z.infer<typeof SessionModelSelectionSchema>;

export interface ModelChoice {
  provider: string;
  model: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
}

export type ModelSelectionProjection =
  | { status: 'selected'; selection: SessionModelSelection }
  | { status: 'legacy' | 'invalid'; selection: null };

type RouteConfig = NonNullable<Config['providers']>[string];

function routeModels(provider: string, route: RouteConfig | undefined): ModelChoice[] {
  if (provider === 'deepseek-official') {
    return (route?.models ?? DSH_OFFICIAL_MODELS).map((model) => ({
      provider,
      model: model.id,
      name: model.name ?? model.id,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    }));
  }
  if (route?.api === 'deepseek-messages') {
    throw new Error(`Provider "${provider}" cannot use the deepseek-messages API`);
  }
  const { api, ...rest } = route ?? {};
  const piRoute: PiAiRouteConfig = {
    ...rest,
    ...(api === undefined ? {} : { api: api as PiAiCustomApi }),
  };
  const resolved = resolvePiAiRoute(provider, piRoute);
  return resolved.models.map((model) => ({
    provider,
    model: model.id,
    name: model.name,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
  }));
}

/**
 * List model choices the current config can construct. Credentials stay in the
 * config/environment; this function only exposes route and model identifiers.
 */
export function listConfiguredModels(config: Config): ModelChoice[] {
  const choices: ModelChoice[] = [];
  if (typeof config.provider === 'object') {
    choices.push({
      provider: 'openai',
      model: config.model,
      name: config.model,
      ...(config.contextWindowTokens === undefined ? {} : { contextWindow: config.contextWindowTokens }),
    });
  } else if (typeof config.provider === 'string') {
    const providers = new Map(Object.entries(config.providers ?? {}));
    const current = config.provider;
    if (!providers.has(current)) providers.set(current, {});
    for (const [provider, route] of providers) {
      try {
        choices.push(...routeModels(provider, route));
      } catch (error) {
        // An unrelated invalid route must not make an otherwise valid current
        // selection unusable; the selected route still fails closed.
        if (provider === current) throw error;
      }
    }
  }
  const seen = new Set<string>();
  return choices.filter((choice) => {
    const key = `${choice.provider}\0${choice.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function defaultModelSelection(config: Config): SessionModelSelection | undefined {
  if (!config.provider) return undefined;
  const reasoningEffort = config.reasoningEffort;
  return {
    version: MODEL_SELECTION_VERSION,
    provider: typeof config.provider === 'string' ? config.provider : 'openai',
    model: config.model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

export function modelChoiceFor(config: Config, selection: SessionModelSelection): ModelChoice | undefined {
  return listConfiguredModels(config).find((choice) =>
    choice.provider === selection.provider && choice.model === selection.model);
}

/** Resolve the model client for a persisted selection. Never reuses another route's key. */
export function createSelectedModel(config: Config, input: unknown): ModelClient {
  const selection = SessionModelSelectionSchema.parse(input);
  if (typeof config.provider === 'object') {
    if (selection.provider !== 'openai') {
      throw new Error(`Unknown model provider "${selection.provider}" in the current configuration`);
    }
    if (selection.reasoningEffort !== undefined) {
      throw new Error('The legacy OpenAI-compatible route does not support reasoning effort selection');
    }
    const model = createConfiguredModel({ ...config, model: selection.model });
    if (!model) throw new Error('The legacy OpenAI-compatible model is not configured');
    return model;
  }
  const model = createConfiguredModel({
    ...config,
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  });
  if (!model) throw new Error(`No model client is configured for provider "${selection.provider}"`);
  return model;
}

/** Explicit config cap wins; otherwise use the selected model's catalog context window. */
export function resolveContextWindowTokens(
  config: Config,
  selection: SessionModelSelection | undefined,
): number | undefined {
  if (config.contextWindowTokens !== undefined) return config.contextWindowTokens;
  return selection ? modelChoiceFor(config, selection)?.contextWindow : undefined;
}

export function createModelSelectionEvent(selection: unknown): { type: typeof MODEL_SELECTION_EVENT; data: SessionModelSelection } {
  return { type: MODEL_SELECTION_EVENT, data: SessionModelSelectionSchema.parse(selection) };
}

/** Fold committed events in order; an empty model history is legacy, not a selection. */
export function projectModelSelection(events: readonly { type: string; data: unknown }[]): ModelSelectionProjection {
  let projection: ModelSelectionProjection = { status: 'legacy', selection: null };
  for (const event of events) {
    if (event.type !== MODEL_SELECTION_EVENT) continue;
    const parsed = SessionModelSelectionSchema.safeParse(event.data);
    projection = parsed.success
      ? { status: 'selected', selection: parsed.data }
      : { status: 'invalid', selection: null };
  }
  return projection;
}

/** Return a change event only for a real, well-formed selection change. */
export function createModelSwitch(
  projection: ModelSelectionProjection,
  target: unknown,
): { type: typeof MODEL_SELECTION_EVENT; data: SessionModelSelection } | undefined {
  const selection = SessionModelSelectionSchema.parse(target);
  if (projection.status === 'selected' &&
      projection.selection.provider === selection.provider &&
      projection.selection.model === selection.model &&
      projection.selection.reasoningEffort === selection.reasoningEffort) {
    return undefined;
  }
  return createModelSelectionEvent(selection);
}
