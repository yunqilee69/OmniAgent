/**
 * Web-side editor for model sources in config.json.
 *
 * A model source is one route in `config.providers` (or the historical
 * `config.provider` object, which is migrated on its first save). The API
 * exposes display metadata and a configured-or-not API-key flag, never the
 * stored key itself. Writes preserve fields this page does not edit and are
 * serialized with role edits through {@link ConfigFile}.
 */

import {
  ConfigSchema,
  REASONING_EFFORTS,
  buildConfigCatalog,
  listPiAiCatalogProviders,
  resolvePiAiRoute,
} from '@omniagent/core';
import type { Config, ConfigCatalog, ReasoningEffort } from '@omniagent/core';
import { ConfigFile, isObject } from './config-file';

const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MODEL_ID = /^[^\s]{1,256}$/;
const API_KEY = /^[\x21-\x7E]{1,8192}$/;
const PROTOCOLS = ['deepseek-messages', 'openai-completions', 'openai-responses', 'anthropic-messages'] as const;
const CUSTOM_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
const INPUT_TYPES = ['text', 'image'] as const;

export type ModelSourceProtocol = typeof PROTOCOLS[number];
export type ModelInputType = typeof INPUT_TYPES[number];

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
  /** True when the row comes from the adapter catalog rather than config.json. */
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
  protocols: readonly string[];
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

export interface DiscoveryRequest {
  provider?: string;
  api?: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

export class InvalidModelSettings extends Error {}

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new InvalidModelSettings(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new InvalidModelSettings(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') {
    if (required) throw new InvalidModelSettings(`${field} is required`);
    return undefined;
  }
  if (trimmed.length > max) throw new InvalidModelSettings(`${field} must be at most ${max} characters`);
  return trimmed;
}

function positive(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidModelSettings(`${field} must be a positive integer`);
  }
  return value;
}

function httpURL(value: unknown, field: string): string | undefined {
  const raw = text(value, field, 2048);
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidModelSettings(`${field} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new InvalidModelSettings(`${field} must be an HTTP(S) URL without credentials`);
  }
  return raw;
}

function parseProtocol(value: unknown, field = 'api'): ModelSourceProtocol | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(PROTOCOLS as readonly string[]).includes(value)) {
    throw new InvalidModelSettings(`${field} must be one of ${PROTOCOLS.join(', ')}`);
  }
  return value as ModelSourceProtocol;
}

function parseReasoning(value: unknown): ModelSourceModelWrite['reasoning'] {
  if (value === undefined || value === false) return value;
  if (!isObject(value)) throw new InvalidModelSettings('model reasoning must be an object or false');
  const allowed = new Set(['efforts', 'default', 'wire']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new InvalidModelSettings(`unknown reasoning field "${key}"`);
  }
  if (!isObject(value.efforts)) throw new InvalidModelSettings('reasoning efforts are required');
  const efforts: Record<string, string | number | null> = {};
  for (const [level, wire] of Object.entries(value.efforts)) {
    if (!(REASONING_EFFORTS as readonly string[]).includes(level)) {
      throw new InvalidModelSettings(`unknown reasoning level "${level}"`);
    }
    if (wire !== null && typeof wire !== 'string' && typeof wire !== 'number') {
      throw new InvalidModelSettings(`reasoning value for "${level}" must be a string, number or null`);
    }
    efforts[level] = wire;
  }
  if (Object.keys(efforts).length === 0) throw new InvalidModelSettings('a reasoning model needs at least one level');
  if (!Object.keys(efforts).some((level) => level !== 'off')) {
    throw new InvalidModelSettings('a reasoning model needs a level other than off');
  }
  if (value.default !== undefined) {
    if (typeof value.default !== 'string' || !Object.hasOwn(efforts, value.default)) {
      throw new InvalidModelSettings('the default reasoning level must be one of the declared levels');
    }
  }
  if (value.wire !== undefined && !isObject(value.wire)) {
    throw new InvalidModelSettings('reasoning wire must be an object');
  }
  return {
    efforts,
    ...(value.default === undefined ? {} : { default: value.default as string }),
    ...(value.wire === undefined ? {} : { wire: value.wire }),
  };
}

function parseModel(value: unknown): ModelSourceModelWrite {
  if (!isObject(value)) throw new InvalidModelSettings('each model must be an object');
  const allowed = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning']);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new InvalidModelSettings(`unknown model field "${unknown}"`);
  if (typeof value.id !== 'string' || !MODEL_ID.test(value.id.trim())) {
    throw new InvalidModelSettings('each model needs a non-empty id without whitespace');
  }
  let input: ModelInputType[] | undefined;
  if (value.input !== undefined) {
    if (!Array.isArray(value.input) || value.input.length === 0
      || value.input.some((item) => !(INPUT_TYPES as readonly unknown[]).includes(item))) {
      throw new InvalidModelSettings('model input types must be a non-empty subset of text and image');
    }
    input = [...new Set(value.input as ModelInputType[])];
  }
  return {
    id: value.id.trim(),
    ...(text(value.name, 'model name', 256) === undefined ? {} : { name: text(value.name, 'model name', 256)! }),
    ...(positive(value.contextWindow, 'contextWindow') === undefined
      ? {} : { contextWindow: positive(value.contextWindow, 'contextWindow')! }),
    ...(positive(value.maxTokens, 'maxTokens') === undefined
      ? {} : { maxTokens: positive(value.maxTokens, 'maxTokens')! }),
    ...(input === undefined ? {} : { input }),
    ...(value.reasoning === undefined ? {} : { reasoning: parseReasoning(value.reasoning) }),
  };
}

function parseWrite(input: unknown): ModelSourceWrite {
  if (!isObject(input)) throw new InvalidModelSettings('model source must be an object');
  const allowed = new Set([
    'name', 'api', 'baseURL', 'clearBaseURL', 'apiKey', 'clearApiKey',
    'apiKeyEnv', 'clearApiKeyEnv', 'auth', 'models',
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new InvalidModelSettings(`unknown model source field "${unknown}"`);
  if (input.clearBaseURL !== undefined && typeof input.clearBaseURL !== 'boolean') {
    throw new InvalidModelSettings('clearBaseURL must be a boolean');
  }
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') {
    throw new InvalidModelSettings('clearApiKey must be a boolean');
  }
  if (input.clearApiKeyEnv !== undefined && typeof input.clearApiKeyEnv !== 'boolean') {
    throw new InvalidModelSettings('clearApiKeyEnv must be a boolean');
  }
  if (input.auth !== undefined && input.auth !== false && input.auth !== 'ambient') {
    throw new InvalidModelSettings('auth must be "ambient" or false');
  }
  let apiKey: string | undefined;
  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== 'string') throw new InvalidModelSettings('apiKey must be a string');
    const trimmed = input.apiKey.trim();
    if (trimmed !== '') {
      if (!API_KEY.test(trimmed)) throw new InvalidModelSettings('apiKey contains invalid characters');
      apiKey = trimmed;
    }
  }
  let apiKeyEnv: string | undefined;
  if (input.apiKeyEnv !== undefined) {
    if (typeof input.apiKeyEnv !== 'string' || !ENV_NAME.test(input.apiKeyEnv.trim())) {
      throw new InvalidModelSettings('apiKeyEnv must be an environment variable name');
    }
    apiKeyEnv = input.apiKeyEnv.trim();
  }
  let models: ModelSourceModelWrite[] | undefined;
  if (input.models !== undefined) {
    if (!Array.isArray(input.models)) throw new InvalidModelSettings('models must be an array');
    models = input.models.map(parseModel);
    const ids = new Set<string>();
    for (const model of models) {
      if (ids.has(model.id)) throw new InvalidModelSettings(`duplicate model id "${model.id}"`);
      ids.add(model.id);
    }
  }
  return {
    ...(text(input.name, 'name', 120) === undefined ? {} : { name: text(input.name, 'name', 120)! }),
    ...(parseProtocol(input.api) === undefined ? {} : { api: parseProtocol(input.api)! }),
    ...(httpURL(input.baseURL, 'baseURL') === undefined ? {} : { baseURL: httpURL(input.baseURL, 'baseURL')! }),
    ...(input.clearBaseURL === true ? { clearBaseURL: true } : {}),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(input.clearApiKey === true ? { clearApiKey: true } : {}),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(input.clearApiKeyEnv === true ? { clearApiKeyEnv: true } : {}),
    ...(input.auth === false || input.auth === 'ambient' ? { auth: input.auth } : {}),
    ...(models === undefined ? {} : { models }),
  };
}

function isBuiltIn(provider: string): boolean {
  return provider === 'deepseek-official' || listPiAiCatalogProviders().includes(provider);
}

/** Endpoint and protocol a built-in pi-ai provider uses until a route overrides them. */
function builtInDefaults(provider: string): { api?: ModelSourceProtocol; baseURL?: string } {
  if (provider === 'deepseek-official' || !isBuiltIn(provider)) return {};
  try {
    const resolved = resolvePiAiRoute(provider, {});
    const model = resolved.models[0];
    const api = parseProtocol(model?.api);
    return {
      ...(api === undefined ? {} : { api }),
      ...(model?.baseUrl === undefined ? {} : { baseURL: model.baseUrl }),
    };
  } catch {
    return {};
  }
}

function legacyRoute(raw: Record<string, unknown>, config: Config): Record<string, unknown> {
  const provider = isObject(raw.provider) ? raw.provider : {};
  const route: Record<string, unknown> = {
    api: 'openai-completions',
    displayName: typeof provider.displayName === 'string' ? provider.displayName : 'OpenAI',
  };
  for (const key of ['baseURL', 'apiKey', 'apiKeyEnv', 'headers', 'timeoutMs', 'maxRetries'] as const) {
    if (provider[key] !== undefined) route[key] = provider[key];
  }
  if (config.model !== 'fake') {
    route.models = [{
      id: config.model,
      ...(config.contextWindowTokens === undefined ? {} : { contextWindow: config.contextWindowTokens }),
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    }];
  }
  return route;
}

function reasoningOf(raw: unknown, fallback?: unknown): ModelSourceReasoning | undefined {
  if (raw === false) return undefined;
  const source = isObject(raw) ? raw : raw === undefined && isObject(fallback) ? fallback : undefined;
  if (source === undefined) return undefined;
  const efforts: Partial<Record<ReasoningEffort, string | number | null>> = {};
  if (isObject(source.efforts)) {
    for (const level of REASONING_EFFORTS) {
      const value = source.efforts[level];
      if (value === null || typeof value === 'string' || typeof value === 'number') efforts[level] = value;
    }
  }
  if (Object.keys(efforts).length === 0) return undefined;
  return {
    efforts,
    ...(typeof source.default === 'string' && Object.hasOwn(efforts, source.default)
      ? { default: source.default as ReasoningEffort } : {}),
    ...(isObject(source.wire) ? { wire: { ...source.wire } } : {}),
  };
}

function modelsOf(
  rawRoute: Record<string, unknown>,
  catalog: ConfigCatalog,
  provider: string,
): ModelSourceModel[] {
  const rawModels = Array.isArray(rawRoute.models)
    ? rawRoute.models.filter(isObject)
    : [];
  const rawById = new Map(rawModels.map((model) => [String(model.id ?? ''), model]));
  const descriptors = catalog.providers.get(provider) ?? [];
  const rows: ModelSourceModel[] = [];
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    const raw = rawById.get(descriptor.id);
    const models = rawModels.filter((model) => model.id === descriptor.id);
    const source = models.length > 0 ? models[0] : undefined;
    const input = source !== undefined && Array.isArray(source.input)
      ? source.input.filter((value): value is ModelInputType => (INPUT_TYPES as readonly unknown[]).includes(value))
      : descriptor.capabilities.imageInput ? ['text', 'image'] as ModelInputType[] : ['text'] as ModelInputType[];
    const reasoning = source === undefined ? reasoningOf(descriptor.reasoning) : reasoningOf(source.reasoning, descriptor.reasoning);
    rows.push({
      id: descriptor.id,
      name: typeof source?.name === 'string' && source.name !== '' ? source.name : descriptor.name,
      ...(typeof source?.contextWindow === 'number' ? { contextWindow: source.contextWindow }
        : descriptor.contextWindow === undefined ? {} : { contextWindow: descriptor.contextWindow }),
      ...(typeof source?.maxTokens === 'number' ? { maxTokens: source.maxTokens }
        : descriptor.maxTokens === undefined ? {} : { maxTokens: descriptor.maxTokens }),
      input: input.length === 0 ? ['text'] : input,
      ...(reasoning === undefined ? {} : { reasoning }),
      inherited: source === undefined,
    });
    seen.add(descriptor.id);
  }
  // A route whose adapter rejects the configuration still shows the rows the
  // user stored, so they can be repaired rather than being invisible.
  for (const raw of rawModels) {
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (id === '' || seen.has(id)) continue;
    rows.push({
      id,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
      ...(typeof raw.contextWindow === 'number' ? { contextWindow: raw.contextWindow } : {}),
      ...(typeof raw.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {}),
      input: Array.isArray(raw.input)
        ? raw.input.filter((value): value is ModelInputType => (INPUT_TYPES as readonly unknown[]).includes(value))
        : ['text'],
      ...(reasoningOf(raw.reasoning) === undefined ? {} : { reasoning: reasoningOf(raw.reasoning)! }),
      inherited: false,
    });
    seen.add(id);
  }
  return rows;
}

function sourceSummary(
  id: string,
  rawRoute: Record<string, unknown>,
  raw: Record<string, unknown>,
  config: Config,
  catalog: ConfigCatalog,
  legacy: boolean,
): ModelSourceSummary {
  const models = modelsOf(rawRoute, catalog, id);
  const builtIn = isBuiltIn(id);
  const warning = catalog.warnings.find((message) => message.includes(`"${id}"`));
  const api = parseProtocol(rawRoute.api) ?? (id === 'deepseek-official' ? 'deepseek-messages' : undefined);
  const apiKeyEnv = typeof rawRoute.apiKeyEnv === 'string' ? rawRoute.apiKeyEnv : undefined;
  const apiKey = typeof rawRoute.apiKey === 'string' ? rawRoute.apiKey : '';
  const envKey = apiKeyEnv === undefined ? undefined : process.env[apiKeyEnv];
  const auth = rawRoute.auth === 'ambient' ? 'ambient' as const : undefined;
  const active = legacy ? isObject(raw.provider) : raw.provider === id;
  const error = models.length === 0
    ? 'No models are configured for this provider'
    : warning;
  return {
    id,
    name: typeof rawRoute.displayName === 'string' && rawRoute.displayName.trim() !== ''
      ? rawRoute.displayName
      : id === 'deepseek-official' ? 'DeepSeek' : id,
    ...(api === undefined ? {} : { api }),
    ...(typeof rawRoute.baseURL === 'string' ? { baseURL: rawRoute.baseURL } : {}),
    apiKeyConfigured: apiKey !== '' || (envKey !== undefined && envKey !== '') || auth !== undefined,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(auth === undefined ? {} : { auth }),
    models,
    builtIn,
    legacy,
    active,
    removable: !legacy && !builtIn,
    valid: error === undefined,
    ...(error === undefined ? {} : { error }),
  };
}

function allSources(raw: Record<string, unknown>, config: Config): ModelSourceSummary[] {
  const catalog = buildConfigCatalog(config);
  const sources: ModelSourceSummary[] = [];
  if (isObject(raw.provider)) {
    sources.push(sourceSummary('openai', legacyRoute(raw, config), raw, config, catalog, true));
  }
  const routes = isObject(raw.providers) ? raw.providers : {};
  const ids = new Set<string>(Object.keys(routes));
  if (typeof raw.provider === 'string' && raw.provider !== 'fake') ids.add(raw.provider);
  for (const id of ids) {
    const route = isObject(routes[id]) ? routes[id] as Record<string, unknown> : {};
    sources.push(sourceSummary(id, route, raw, config, catalog, false));
  }
  const order = (source: ModelSourceSummary): number =>
    source.active ? 0 : source.id === 'deepseek-official' ? 1 : source.builtIn ? 2 : 3;
  return sources.sort((left, right) =>
    order(left) - order(right)
    || Number(right.valid) - Number(left.valid)
    || left.name.localeCompare(right.name));
}

function listOf(raw: Record<string, unknown>, config: Config): ModelSourceList {
  return {
    sources: allSources(raw, config),
    ...(typeof raw.provider === 'string' && raw.provider !== 'fake'
      ? { defaultSource: raw.provider } : isObject(raw.provider) ? { defaultSource: 'openai' } : {}),
    ...(config.model === 'fake' ? {} : { defaultModel: config.model }),
    protocols: [...PROTOCOLS],
    catalogProviders: [...listPiAiCatalogProviders()].sort(),
  };
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function mergeModel(base: Record<string, unknown>, model: ModelSourceModelWrite): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base, id: model.id };
  setOrDelete(next, 'name', model.name);
  setOrDelete(next, 'contextWindow', model.contextWindow);
  setOrDelete(next, 'maxTokens', model.maxTokens);
  if (model.input !== undefined) next.input = [...model.input];
  if (model.reasoning === false) {
    next.reasoning = false;
  } else if (model.reasoning !== undefined) {
    const existing = isObject(base.reasoning) ? base.reasoning : {};
    next.reasoning = {
      ...existing,
      efforts: { ...model.reasoning.efforts },
      ...(model.reasoning.default === undefined ? {} : { default: model.reasoning.default }),
      ...(model.reasoning.wire === undefined ? {} : { wire: model.reasoning.wire }),
    };
  }
  return next;
}

function copyRoute(route: Record<string, unknown>): Record<string, unknown> {
  return { ...route };
}

function buildRoute(
  id: string,
  existing: Record<string, unknown>,
  write: ModelSourceWrite,
  isNew: boolean,
): Record<string, unknown> {
  const route = copyRoute(existing);
  if (write.name !== undefined) route.displayName = write.name;
  if (write.api !== undefined) route.api = write.api;
  if (write.clearBaseURL === true) delete route.baseURL;
  else if (write.baseURL !== undefined) route.baseURL = write.baseURL;
  if (write.clearApiKey === true) delete route.apiKey;
  else if (write.apiKey !== undefined) route.apiKey = write.apiKey;
  if (write.clearApiKeyEnv === true) delete route.apiKeyEnv;
  else if (write.apiKeyEnv !== undefined) route.apiKeyEnv = write.apiKeyEnv;
  if (write.auth === false) delete route.auth;
  else if (write.auth === 'ambient') route.auth = 'ambient';
  if (write.models !== undefined) {
    const existingModels = Array.isArray(existing.models) ? existing.models.filter(isObject) : [];
    route.models = write.models.map((model) => mergeModel(
      existingModels.find((entry) => entry.id === model.id) ?? {},
      model,
    ));
  }
  if (isNew) {
    if (route.api === undefined && write.api === undefined && !isBuiltIn(id)) {
      throw new InvalidModelSettings('A custom model source needs an API protocol');
    }
    if (!Array.isArray(route.models) || route.models.length === 0) {
      throw new InvalidModelSettings('A new model source needs at least one model');
    }
    if (write.api === 'deepseek-messages' && id !== 'deepseek-official') {
      throw new InvalidModelSettings('deepseek-messages is reserved for the deepseek-official source');
    }
  }
  if (write.api === 'deepseek-messages' && id !== 'deepseek-official') {
    throw new InvalidModelSettings('deepseek-messages is reserved for the deepseek-official source');
  }
  if (!isBuiltIn(id) && typeof route.api !== 'string') {
    throw new InvalidModelSettings('A custom model source needs an API protocol');
  }
  return route;
}

function discoverURL(api: string, baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '');
  if (api === 'anthropic-messages') {
    return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/models`;
}

function discoveredModel(value: unknown): DiscoveredModel | undefined {
  if (!isObject(value) || typeof value.id !== 'string' || value.id.trim() === '') return undefined;
  const id = value.id.trim();
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim()
    : typeof value.display_name === 'string' && value.display_name.trim() !== '' ? value.display_name.trim()
      : undefined;
  const number = (key: string): number | undefined => {
    const candidate = value[key];
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : undefined;
  };
  const architecture = isObject(value.architecture) ? value.architecture : {};
  const modalities = Array.isArray(value.input_modalities) ? value.input_modalities
    : Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
  let input = modalities.filter((item): item is ModelInputType => (INPUT_TYPES as readonly unknown[]).includes(item));
  if (input.length === 0 && isObject(value.capabilities) && value.capabilities.vision === true) {
    input = ['text', 'image'];
  }
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(number('context_window') === undefined ? {} : { contextWindow: number('context_window')! }),
    ...(number('context_length') === undefined ? {} : { contextWindow: number('context_length')! }),
    ...(number('max_context_length') === undefined ? {} : { contextWindow: number('max_context_length')! }),
    ...(number('max_output_tokens') === undefined ? {} : { maxTokens: number('max_output_tokens')! }),
    ...(number('max_completion_tokens') === undefined ? {} : { maxTokens: number('max_completion_tokens')! }),
    ...(number('max_tokens') === undefined ? {} : { maxTokens: number('max_tokens')! }),
    ...(input.length === 0 ? {} : { input: [...new Set(input)] }),
  };
}

function errorBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isObject(parsed)) {
      const message = parsed.error;
      if (typeof message === 'string') return message.slice(0, 300);
      if (isObject(message) && typeof message.message === 'string') return message.message.slice(0, 300);
      if (typeof parsed.message === 'string') return parsed.message.slice(0, 300);
    }
  } catch {
    // Plain text is still useful, just truncated.
  }
  return trimmed.slice(0, 300);
}

export class ModelSettings {
  private constructor(private readonly file: ConfigFile) {}

  static async open(path: string, options: { trustedHome?: string } = {}): Promise<ModelSettings> {
    return new ModelSettings(await ConfigFile.open(path, options));
  }

  async list(): Promise<ModelSourceList> {
    const { raw, config } = await this.file.read();
    return listOf(raw, config);
  }

  async save(id: string, input: unknown): Promise<ModelSourceSummary> {
    if (!SOURCE_ID.test(id)) {
      throw new InvalidModelSettings('model source id must match [a-z0-9][a-z0-9._-]{0,63}');
    }
    const write = parseWrite(input);
    return this.file.mutate(async ({ raw, config }) => {
      const before = buildConfigCatalog(config);
      const legacy = isObject(raw.provider);
      const routes = isObject(raw.providers) ? { ...raw.providers } : {};
      const existingRaw = isObject(routes[id]) ? routes[id] as Record<string, unknown> : undefined;
      const existing = legacy && id === 'openai'
        ? legacyRoute(raw, config)
        : existingRaw ?? {};
      const isNew = existingRaw === undefined && !(legacy && id === 'openai');

      const route = buildRoute(id, existing, write, isNew);
      if (legacy) routes.openai = legacyRoute(raw, config);
      routes[id] = route;

      const next: Record<string, unknown> = { ...raw, providers: routes };
      if (legacy) next.provider = 'openai';
      if (!legacy && (raw.provider === undefined || raw.provider === 'fake')
        && !before.roles.has('default') && !before.roleErrors.has('default')) {
        const first = Array.isArray(route.models) && isObject(route.models[0]) ? route.models[0].id : undefined;
        if (typeof first === 'string') {
          next.provider = id;
          next.model = first;
        }
      }
      if (next.provider === id && Array.isArray(route.models)
        && !route.models.some((model) => isObject(model) && model.id === next.model)) {
        const first = route.models.find(isObject)?.id;
        if (typeof first === 'string') next.model = first;
      }

      const parsed = ConfigSchema.parse(next);
      const catalog = buildConfigCatalog(parsed);
      for (const [roleId, role] of before.roles) {
        if (catalog.roleErrors.has(roleId)) {
          throw new InvalidModelSettings(
            `Role "${roleId}" uses ${role.provider}/${role.model}; update the role before removing or renaming that model`,
          );
        }
      }
      const summary = allSources(next, parsed).find((source) => source.id === id);
      if (summary === undefined) throw new InvalidModelSettings(`Model source "${id}" was not saved`);
      if (!summary.valid) throw new InvalidModelSettings(summary.error ?? `Model source "${id}" is invalid`);
      return { raw: next, result: summary };
    });
  }

  async remove(id: string): Promise<boolean> {
    if (!SOURCE_ID.test(id)) throw new InvalidModelSettings('invalid model source id');
    return this.file.mutate(async ({ raw, config }) => {
      const routes = isObject(raw.providers) ? { ...raw.providers } : {};
      if (!Object.hasOwn(routes, id)) return { raw, result: false };
      if (isBuiltIn(id)) {
        throw new InvalidModelSettings('Built-in model sources cannot be removed; edit or reset them instead');
      }
      if (raw.provider === id) {
        throw new InvalidModelSettings('The default model source cannot be removed');
      }
      const before = buildConfigCatalog(config);
      delete routes[id];
      const next = { ...raw, providers: routes };
      const after = buildConfigCatalog(ConfigSchema.parse(next));
      for (const roleId of before.roles.keys()) {
        if (after.roleErrors.has(roleId)) {
          throw new InvalidModelSettings(`Role "${roleId}" uses this model source; update the role first`);
        }
      }
      return { raw: next, result: true };
    });
  }

  async discover(input: unknown): Promise<{ models: DiscoveredModel[] }> {
    if (!isObject(input)) throw new InvalidModelSettings('discovery request must be an object');
    const request = input as DiscoveryRequest;
    const { raw, config } = await this.file.read();
    const provider = typeof request.provider === 'string' && request.provider.trim() !== ''
      ? request.provider.trim() : undefined;
    const routes = isObject(raw.providers) ? raw.providers : {};
    const route = provider === undefined ? {}
      : isObject(routes[provider]) ? routes[provider] as Record<string, unknown>
        : provider === 'openai' && isObject(raw.provider) ? legacyRoute(raw, config) : {};
    const defaults: { api?: ModelSourceProtocol; baseURL?: string } =
      provider === undefined ? {} : builtInDefaults(provider);
    const api = parseProtocol(request.api) ?? parseProtocol(route.api) ?? defaults.api
      ?? (provider === 'deepseek-official' ? 'deepseek-messages' : 'openai-completions');
    if (api === 'deepseek-messages') {
      throw new InvalidModelSettings('This protocol does not expose a model list; add models manually');
    }
    const baseURL = httpURL(request.baseURL, 'baseURL')
      ?? (typeof route.baseURL === 'string' ? route.baseURL : defaults.baseURL);
    if (baseURL === undefined) throw new InvalidModelSettings('A base URL is required to fetch models');
    const requestEnv = request.apiKeyEnv === undefined ? undefined : request.apiKeyEnv.trim();
    if (requestEnv !== undefined && requestEnv !== '' && !ENV_NAME.test(requestEnv)) {
      throw new InvalidModelSettings('apiKeyEnv must be an environment variable name');
    }
    const apiKeyEnv = requestEnv !== undefined && requestEnv !== ''
      ? requestEnv
      : typeof route.apiKeyEnv === 'string' ? route.apiKeyEnv : undefined;
    const typedKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : '';
    if (typedKey !== '' && !API_KEY.test(typedKey)) {
      throw new InvalidModelSettings('apiKey contains invalid characters');
    }
    const apiKey = typedKey !== '' ? typedKey
      : typeof route.apiKey === 'string' && route.apiKey !== '' ? route.apiKey
        : apiKeyEnv === undefined ? undefined : process.env[apiKeyEnv];
    const url = discoverURL(api, baseURL);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (api === 'anthropic-messages') {
      headers['anthropic-version'] = '2023-06-01';
      if (apiKey !== undefined && apiKey !== '') headers['x-api-key'] = apiKey;
    } else if (apiKey !== undefined && apiKey !== '') {
      headers.authorization = `Bearer ${apiKey}`;
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InvalidModelSettings(`Could not reach the model endpoint: ${message}`);
    }
    const body = await response.text();
    if (!response.ok) {
      const detail = errorBody(body);
      throw new InvalidModelSettings(`Model endpoint returned HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
    }
    if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) {
      throw new InvalidModelSettings('The model endpoint returned more than 2 MB');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new InvalidModelSettings('The model endpoint did not return JSON');
    }
    const list: unknown[] = Array.isArray(parsed) ? parsed
      : isObject(parsed) && Array.isArray(parsed.data) ? parsed.data
        : isObject(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
    const models = new Map<string, DiscoveredModel>();
    for (const value of list) {
      const model = discoveredModel(value);
      if (model !== undefined && !models.has(model.id)) models.set(model.id, model);
    }
    return { models: [...models.values()] };
  }
}
