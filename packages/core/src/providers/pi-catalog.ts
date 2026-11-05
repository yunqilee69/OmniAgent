/*
 * Portions adapted from deepseek-harness/packages/llm/llm-pi-ai (MIT).
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Api, Model, Provider, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

export type PiAiCustomApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export interface PiAiModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
  reasoning?: boolean;
}

export interface PiAiRouteConfig {
  api?: PiAiCustomApi;
  baseURL?: string;
  models?: PiAiModelConfig[];
  apiKey?: string;
  apiKeyEnv?: string;
  /** Use the named built-in provider's own credential discovery when no key is configured. */
  auth?: 'ambient';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  reasoning?: SimpleStreamOptions['reasoning'];
}

export interface PiAiConfig {
  provider: string;
  routes: Record<string, PiAiRouteConfig>;
}

export interface PiAiResolvedRoute {
  provider: string;
  models: Model<Api>[];
  config: PiAiRouteConfig;
  builtin?: Provider;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`pi-ai ${name} must be a positive integer`);
  return value;
}

export function listPiAiCatalogProviders(): string[] {
  return builtinProviders().filter((provider) => provider.getModels().length > 0).map((provider) => provider.id);
}

export function resolvePiAiRoute(provider: string, config: PiAiRouteConfig): PiAiResolvedRoute {
  if (!provider.trim()) throw new Error('pi-ai provider must be non-empty');
  const builtin = builtinProviders().find((entry) => entry.id === provider);
  const defaults = builtin?.getModels() ?? [];
  const configured: PiAiModelConfig[] = config.models ?? defaults.map((model) => ({ id: model.id }));
  if (configured.length === 0) throw new Error(`pi-ai provider "${provider}" has no configured models or catalog`);
  if (config.auth === 'ambient' && (!builtin || config.api || config.baseURL)) {
    throw new Error(`pi-ai ambient authentication requires an unmodified built-in provider and endpoint`);
  }
  if (config.baseURL !== undefined) {
    let url: URL;
    try { url = new URL(config.baseURL); } catch { throw new Error(`pi-ai provider "${provider}" has an invalid baseURL`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`pi-ai provider "${provider}" baseURL must be HTTP(S) without credentials`);
    }
  }
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    try { new Headers([[name, value]]); } catch { throw new Error(`pi-ai provider "${provider}" has an invalid header`); }
  }
  const apis = new Set(defaults.map((model) => model.api));
  const sharedApi = apis.size === 1 ? [...apis][0] : undefined;
  const ids = new Set<string>();
  const models = configured.map((entry): Model<Api> => {
    if (!entry.id.trim() || ids.has(entry.id)) throw new Error(`pi-ai provider "${provider}" has an empty or duplicate model id`);
    ids.add(entry.id);
    const base = defaults.find((model) => model.id === entry.id);
    const api = config.api ?? base?.api ?? sharedApi;
    const baseUrl = config.baseURL ?? base?.baseUrl ?? builtin?.baseUrl;
    if (!api || !baseUrl) throw new Error(`pi-ai model "${entry.id}" needs an api and baseURL`);
    if (!builtin && !config.api) throw new Error(`pi-ai custom provider "${provider}" needs an api`);
    const input = entry.input ?? base?.input ?? ['text'];
    if (!input.length || input.some((modality) => modality !== 'text' && modality !== 'image')) {
      throw new Error(`pi-ai model "${entry.id}" has invalid input modalities`);
    }
    return {
      ...base,
      id: entry.id, name: entry.name ?? base?.name ?? entry.id, provider, api, baseUrl,
      input: [...input], reasoning: entry.reasoning ?? base?.reasoning ?? false,
      contextWindow: positive(entry.contextWindow ?? base?.contextWindow ?? 1_000_000, 'contextWindow'),
      maxTokens: positive(entry.maxTokens ?? base?.maxTokens ?? 128_000, 'maxTokens'),
      cost: base?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(config.api && base?.api !== config.api ? { compat: undefined } : {}),
    };
  });
  return {
    provider, models,
    config: { ...config, headers: config.headers && { ...config.headers }, models: config.models?.map((m) => ({ ...m, input: m.input && [...m.input] })) },
    ...(builtin ? { builtin } : {}),
  };
}
