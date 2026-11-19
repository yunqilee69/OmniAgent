import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionSettings } from './permissions';
import { WebSearchConfigSettings } from './web-search-settings';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('web search settings', () => {
  it('stores a key without returning it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-web-search-'));
    roots.push(root);
    const path = join(root, 'config.json');
    const permissions = await PermissionSettings.open(path);
    const settings = await WebSearchConfigSettings.open(permissions);
    expect(await settings.read()).toMatchObject({ apiKeyConfigured: false, maxResults: 5 });
    const saved = await settings.update({ apiKey: 'tvly-test', apiKeyEnv: 'TAVILY_API_KEY', maxResults: 3 });
    expect(saved).toEqual({ apiKeyConfigured: true, apiKeyEnv: 'TAVILY_API_KEY', maxResults: 3, requiresRepair: false });
    expect(JSON.stringify(saved)).not.toContain('tvly-test');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      webSearch: { tavily: { apiKey: 'tvly-test', apiKeyEnv: 'TAVILY_API_KEY', maxResults: 3 } },
    });
    expect(await settings.update({ clearApiKey: true })).toMatchObject({ apiKeyConfigured: false });
  });
});
