import type { Config } from './load';
import type { ReasoningEffort } from '../protocol/reasoning';
import { DSH_OFFICIAL_MODELS } from '../providers/dsh-registry';
import { resolvePiAiRoute } from '../providers/pi-catalog';
import type { PiAiRouteConfig } from '../providers/pi-catalog';

export interface ModelCapabilities {
  imageInput: boolean;
}

export interface ReasoningWire {
  enableField?: string;
  enableValue?: string | number | boolean | null;
  disableField?: string;
  disableValue?: string | number | boolean | null;
  effortField?: string;
  budgetField?: string;
}

export interface ModelReasoning {
  efforts: Partial<Record<ReasoningEffort, string | number | null>>;
  budgets?: Partial<Record<ReasoningEffort, number>>;
  default?: ReasoningEffort;
  wire?: ReasoningWire;
}

export type ModelProtocol = 'deepseek-messages' | 'pi-ai' | 'legacy-openai';

export interface ModelDescriptor {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  capabilities: ModelCapabilities;
  reasoning?: ModelReasoning;
  protocol: ModelProtocol;
}

export interface RoleDefinition {
  id: string;
  name: string;
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export interface AgentProfileDefinition {
  id: string;
  tools: '*' | string[];
  skills: '*' | string[];
}

export interface ConfigCatalog {
  providers: Map<string, ModelDescriptor[]>;
  roles: Map<string, RoleDefinition>;
  roleErrors: Map<string, string>;
  profiles: Map<string, AgentProfileDefinition>;
  warnings: string[];
}

type RouteConfig = NonNullable<Config['providers']>[string];
type RouteModel = NonNullable<RouteConfig['models']>[number];

const DSH_DEFAULT_REASONING: ModelReasoning = {
  efforts: { off: null, low: 'low', high: 'high', max: 'max' },
  default: 'high',
};

const PI_DEFAULT_REASONING: ModelReasoning = {
  efforts: {
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  },
};

function modelReasoning(model: RouteModel, protocol: ModelProtocol): ModelReasoning | undefined {
  if (model.reasoning !== undefined && typeof model.reasoning === 'object') {
    return {
      efforts: { ...model.reasoning.efforts },
      ...(model.reasoning.budgets === undefined ? {} : { budgets: { ...model.reasoning.budgets } }),
      ...(model.reasoning.default === undefined ? {} : { default: model.reasoning.default }),
      ...(model.reasoning.wire === undefined ? {} : { wire: { ...model.reasoning.wire } }),
    };
  }
  if (protocol === 'deepseek-messages') return structuredClone(DSH_DEFAULT_REASONING);
  if (protocol === 'pi-ai' && model.reasoning === true) return structuredClone(PI_DEFAULT_REASONING);
  return undefined;
}

function capabilitiesOf(model: RouteModel, input: readonly string[] | undefined): ModelCapabilities {
  const configured = model.capabilities?.imageInput;
  return { imageInput: configured ?? Boolean(input?.includes('image')) };
}

function descriptorForRouteModel(
  provider: string,
  model: RouteModel,
  protocol: ModelProtocol,
  input: readonly string[] | undefined,
  name?: string,
): ModelDescriptor {
  const reasoning = modelReasoning(model, protocol);
  return {
    provider,
    id: model.id,
    name: model.name ?? name ?? model.id,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    capabilities: capabilitiesOf(model, input),
    ...(reasoning === undefined ? {} : { reasoning }),
    protocol,
  };
}

function buildRoute(
  provider: string,
  route: RouteConfig,
  warnings: string[],
  errors: Map<string, string>,
): ModelDescriptor[] {
  const api = route.api;
  if (provider === 'deepseek-official' || api === 'deepseek-messages') {
    if (provider !== 'deepseek-official') {
      errors.set(provider, `provider "${provider}" cannot use deepseek-messages`);
      return [];
    }
    const configured = route.models ?? DSH_OFFICIAL_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      input: model.inputModalities,
    }));
    return configured.map((model) => descriptorForRouteModel(provider, model, 'deepseek-messages', model.input));
  }

  const sanitized: PiAiRouteConfig = {
    ...(route.api === undefined || route.api === 'deepseek-messages' ? {} : { api: route.api }),
    ...(route.baseURL === undefined ? {} : { baseURL: route.baseURL }),
    ...(route.apiKey === undefined ? {} : { apiKey: route.apiKey }),
    ...(route.apiKeyEnv === undefined ? {} : { apiKeyEnv: route.apiKeyEnv }),
    ...(route.auth === undefined ? {} : { auth: route.auth }),
    ...(route.headers === undefined ? {} : { headers: route.headers }),
    ...(route.timeoutMs === undefined ? {} : { timeoutMs: route.timeoutMs }),
    ...(route.maxRetries === undefined ? {} : { maxRetries: route.maxRetries }),
    ...(route.models === undefined ? {} : {
      models: route.models.map((model) => ({
        ...model,
        reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : model.reasoning ? true : undefined,
      })),
    }),
  };
  try {
    const resolved = resolvePiAiRoute(provider, sanitized);
    const configured = new Map((route.models ?? []).map((model) => [model.id, model]));
    return resolved.models.map((model) => {
      const source = configured.get(model.id);
      return {
        provider,
        id: model.id,
        name: source?.name ?? model.name,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        capabilities: { imageInput: model.input.includes('image') },
        ...(source === undefined ? {} : { ...(modelReasoning(source, 'pi-ai') === undefined ? {} : { reasoning: modelReasoning(source, 'pi-ai') }) }),
        protocol: 'pi-ai',
      };
    });
  } catch (error) {
    errors.set(provider, error instanceof Error ? error.message : String(error));
    warnings.push(`Provider "${provider}" is unavailable: ${errors.get(provider)}`);
    return [];
  }
}

function defaultRole(config: Config): RoleDefinition | undefined {
  const explicit = config.roles?.default;
  if (explicit) {
    return {
      id: 'default',
      name: explicit.name ?? 'Default',
      provider: explicit.provider,
      model: explicit.model,
      ...(explicit.reasoningEffort === undefined ? {} : { reasoningEffort: explicit.reasoningEffort }),
    };
  }
  if (typeof config.provider === 'object') {
    if (config.model === 'fake') return undefined;
    return { id: 'default', name: 'Default', provider: 'openai', model: config.model };
  }
  if (typeof config.provider === 'string' && config.model !== 'fake') {
    return {
      id: 'default',
      name: 'Default',
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    };
  }
  return undefined;
}

function validateRole(role: RoleDefinition, providers: Map<string, ModelDescriptor[]>): string | undefined {
  const models = providers.get(role.provider);
  if (!models) return `Unknown provider "${role.provider}" for role "${role.id}"`;
  const model = models.find((entry) => entry.id === role.model);
  if (!model) return `Unknown model "${role.model}" for role "${role.id}"`;
  if (role.reasoningEffort !== undefined) {
    if (!model.reasoning?.efforts || !(role.reasoningEffort in model.reasoning.efforts)) {
      return `Model ${role.provider}/${role.model} does not support reasoning effort "${role.reasoningEffort}"`;
    }
  }
  return undefined;
}

export function buildConfigCatalog(config: Config): ConfigCatalog {
  const warnings: string[] = [];
  const errors = new Map<string, string>();
  const providers = new Map<string, ModelDescriptor[]>();

  if (typeof config.provider === 'object') {
    if (config.model !== 'fake') {
      providers.set('openai', [{
        provider: 'openai',
        id: config.model,
        name: config.model,
        ...(config.contextWindowTokens === undefined ? {} : { contextWindow: config.contextWindowTokens }),
        capabilities: { imageInput: false },
        protocol: 'legacy-openai',
      }]);
    }
  } else {
    const routes = new Map(Object.entries(config.providers ?? {}));
    if (typeof config.provider === 'string' && !routes.has(config.provider)) routes.set(config.provider, {});
    for (const [provider, route] of routes) {
      const models = buildRoute(provider, route, warnings, errors);
      providers.set(provider, models);
    }
  }

  const roles = new Map<string, RoleDefinition>();
  const roleErrors = new Map<string, string>();
  const builtInDefault = defaultRole(config);
  if (builtInDefault) {
    const error = validateRole(builtInDefault, providers);
    if (error) roleErrors.set('default', error);
    else roles.set('default', builtInDefault);
  }
  for (const [id, role] of Object.entries(config.roles ?? {})) {
    if (id === 'default') continue;
    const definition: RoleDefinition = {
      id,
      name: role.name ?? id,
      provider: role.provider,
      model: role.model,
      ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort }),
    };
    const error = validateRole(definition, providers);
    if (error) roleErrors.set(id, error);
    else roles.set(id, definition);
  }

  const profiles = new Map<string, AgentProfileDefinition>();
  if (config.agentProfiles === undefined) {
    profiles.set('default', { id: 'default', tools: '*', skills: '*' });
  } else {
    for (const [id, profile] of Object.entries(config.agentProfiles)) {
      profiles.set(id, {
        id,
        tools: profile.tools === '*' ? '*' : [...profile.tools],
        skills: profile.skills === '*' ? '*' : [...(profile.skills ?? [])],
      });
    }
  }

  for (const [provider, message] of errors) warnings.push(`Provider "${provider}": ${message}`);
  return { providers, roles, roleErrors, profiles, warnings };
}

export function listCatalogModels(catalog: ConfigCatalog): ModelDescriptor[] {
  return [...catalog.providers.values()].flat();
}

export function findCatalogModel(
  catalog: ConfigCatalog,
  provider: string,
  model: string,
): ModelDescriptor | undefined {
  return catalog.providers.get(provider)?.find((entry) => entry.id === model);
}

export function supportedReasoningEfforts(model: ModelDescriptor): ReasoningEffort[] {
  return model.reasoning === undefined
    ? []
    : Object.keys(model.reasoning.efforts) as ReasoningEffort[];
}
