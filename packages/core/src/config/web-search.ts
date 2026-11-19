/**
 * Resolve Tavily settings without treating a malformed section as a missing key.
 * A missing section means search is not configured; an invalid section stays
 * visible so the settings page can repair it.
 */

export interface WebSearchSettings {
  apiKeyConfigured: boolean;
  apiKeyEnv?: string;
  maxResults: number;
  requiresRepair: boolean;
}

export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function resolveWebSearchSettings(config: { webSearch?: unknown }): WebSearchSettings {
  const section = record(config.webSearch);
  if (section === undefined) {
    return { apiKeyConfigured: false, maxResults: WEB_SEARCH_DEFAULT_MAX_RESULTS, requiresRepair: config.webSearch !== undefined };
  }
  const tavily = record(section.tavily);
  const apiKey = typeof tavily?.apiKey === 'string' && tavily.apiKey.trim() !== '';
  const apiKeyEnv = typeof tavily?.apiKeyEnv === 'string' && ENV_NAME.test(tavily.apiKeyEnv)
    ? tavily.apiKeyEnv
    : undefined;
  const maxResults = typeof tavily?.maxResults === 'number'
    && Number.isInteger(tavily.maxResults)
    && tavily.maxResults >= 1
    && tavily.maxResults <= 20
    ? tavily.maxResults
    : WEB_SEARCH_DEFAULT_MAX_RESULTS;
  return {
    apiKeyConfigured: apiKey || (apiKeyEnv !== undefined && (process.env[apiKeyEnv] ?? '').trim() !== ''),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    maxResults,
    requiresRepair: tavily === undefined,
  };
}

/** Resolve the secret for tool execution. Never return this value over HTTP. */
export function resolveTavilyApiKey(config: { webSearch?: unknown }): { apiKey?: string; maxResults: number } {
  const section = record(config.webSearch);
  const tavily = record(section?.tavily);
  const stored = typeof tavily?.apiKey === 'string' ? tavily.apiKey.trim() : '';
  const envName = typeof tavily?.apiKeyEnv === 'string' ? tavily.apiKeyEnv : '';
  const fromEnv = ENV_NAME.test(envName) ? (process.env[envName] ?? '').trim() : '';
  const settings = resolveWebSearchSettings(config);
  return {
    ...(stored !== '' ? { apiKey: stored } : fromEnv !== '' ? { apiKey: fromEnv } : {}),
    maxResults: settings.maxResults,
  };
}
