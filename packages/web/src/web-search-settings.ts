import { resolveWebSearchSettings } from '@omniagent/core';
import type { WebSearchSettings } from '@omniagent/core';
import type { PermissionSettings } from './permissions';

export type { WebSearchSettings };
export class InvalidWebSearchSettings extends Error {}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

interface WebSearchUpdate {
  apiKey?: string;
  clearApiKey?: boolean;
  apiKeyEnv?: string;
  clearApiKeyEnv?: boolean;
  maxResults?: number;
}

function validateUpdate(value: unknown): WebSearchUpdate {
  const body = record(value);
  if (body === undefined) throw new InvalidWebSearchSettings();
  const allowed = new Set(['apiKey', 'clearApiKey', 'apiKeyEnv', 'clearApiKeyEnv', 'maxResults']);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new InvalidWebSearchSettings();
  const update: WebSearchUpdate = {};
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== 'string' || body.apiKey.trim() === '' || body.apiKey.length > 512) {
      throw new InvalidWebSearchSettings();
    }
    update.apiKey = body.apiKey.trim();
  }
  if (body.clearApiKey === true) update.clearApiKey = true;
  if (body.apiKeyEnv !== undefined) {
    if (typeof body.apiKeyEnv !== 'string' || !ENV_NAME.test(body.apiKeyEnv.trim())) throw new InvalidWebSearchSettings();
    update.apiKeyEnv = body.apiKeyEnv.trim();
  }
  if (body.clearApiKeyEnv === true) update.clearApiKeyEnv = true;
  if (body.maxResults !== undefined) {
    if (typeof body.maxResults !== 'number' || !Number.isInteger(body.maxResults) || body.maxResults < 1 || body.maxResults > 20) {
      throw new InvalidWebSearchSettings();
    }
    update.maxResults = body.maxResults;
  }
  if (Object.keys(update).length === 0) throw new InvalidWebSearchSettings();
  return update;
}

/**
 * Persist Tavily credentials in `config.json#webSearch` without returning the
 * key. A stored key wins over `apiKeyEnv`; either one enables `web_search`.
 */
export class WebSearchConfigSettings {
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly permissions: PermissionSettings,
    private value: WebSearchSettings,
  ) {}

  static async open(permissions: PermissionSettings): Promise<WebSearchConfigSettings> {
    return new WebSearchConfigSettings(permissions, resolveWebSearchSettings(permissions.configSnapshot()));
  }

  async read(): Promise<WebSearchSettings> {
    await this.pending;
    return { ...this.value };
  }

  async update(input: unknown): Promise<WebSearchSettings> {
    const update = validateUpdate(input);
    const operation = this.permissions.mutate(async (raw) => {
      const previous = record(raw.webSearch) ?? {};
      const tavily = { ...(record(previous.tavily) ?? {}) };
      if (update.clearApiKey === true) delete tavily.apiKey;
      if (update.apiKey !== undefined) tavily.apiKey = update.apiKey;
      if (update.clearApiKeyEnv === true) delete tavily.apiKeyEnv;
      if (update.apiKeyEnv !== undefined) tavily.apiKeyEnv = update.apiKeyEnv;
      if (update.maxResults !== undefined) tavily.maxResults = update.maxResults;
      const next = { ...raw, webSearch: { ...previous, tavily } };
      return { raw: next, result: resolveWebSearchSettings(next) };
    }).then((value) => {
      this.value = value;
      this.revision += 1;
      return { ...this.value };
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
