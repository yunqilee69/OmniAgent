import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidModelSettings, ModelSettings } from './model-settings';

const roots: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

const baseConfig = {
  provider: 'gateway',
  model: 'model-a',
  providers: {
    gateway: {
      displayName: 'Gateway',
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'GATEWAY_KEY',
      headers: { 'x-gateway': 'kept' },
      timeoutMs: 10_000,
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          contextWindow: 128_000,
          maxTokens: 8_192,
          input: ['text', 'image'],
          reasoning: {
            efforts: { off: null, low: 'low', high: 'high' },
            default: 'high',
          },
        },
        { id: 'model-b', name: 'Model B' },
      ],
    },
    alternate: {
      displayName: 'Alternate',
      api: 'openai-responses',
      baseURL: 'https://alternate.example/v1',
      models: [{ id: 'model-c' }],
    },
  },
  roles: {
    default: { name: 'Default', provider: 'gateway', model: 'model-a' },
    alt: { name: 'Alt', provider: 'alternate', model: 'model-c' },
  },
};

async function fixture(config: Record<string, unknown> = baseConfig) {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-model-settings-'));
  roots.push(root);
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(config));
  return { root, path, settings: await ModelSettings.open(path) };
}

async function readJSON(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function mockEndpoint(handler: (request: { url?: string; headers: Record<string, string | string[] | undefined> }) => {
  status?: number;
  body: unknown;
}): Promise<string> {
  const server = createServer((request, response) => {
    const result = handler({ url: request.url, headers: request.headers });
    response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  servers.push({
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('ModelSettings', () => {
  it('lists routes with effective models and never returns a stored key', async () => {
    const { settings } = await fixture({
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        gateway: { ...baseConfig.providers.gateway, apiKey: 'sk-stored' },
      },
    });
    const list = await settings.list();
    expect(list.defaultSource).toBe('gateway');
    expect(list.defaultModel).toBe('model-a');
    expect(list.sources.map((source) => source.id)).toEqual(['gateway', 'alternate']);
    const gateway = list.sources[0]!;
    expect(gateway).toMatchObject({
      name: 'Gateway', api: 'openai-completions', baseURL: 'https://gateway.example/v1',
      apiKeyConfigured: true, active: true, builtIn: false, legacy: false, valid: true,
    });
    expect(gateway).not.toHaveProperty('apiKey');
    expect(gateway.models.map((model) => model.id)).toEqual(['model-a', 'model-b']);
    expect(gateway.models[0]).toMatchObject({
      name: 'Model A', contextWindow: 128_000, maxTokens: 8_192,
      input: ['text', 'image'], inherited: false,
      reasoning: { efforts: { off: null, low: 'low', high: 'high' }, default: 'high' },
    });
    expect(list.protocols).toEqual([
      'deepseek-messages', 'openai-completions', 'openai-responses', 'anthropic-messages',
    ]);
    expect(list.catalogProviders).toContain('deepseek');
  });

  it('saves a source, preserves unedited route fields and keeps the key write-only', async () => {
    const { path, settings } = await fixture();
    const saved = await settings.save('gateway', {
      name: 'Gateway Renamed',
      apiKey: 'sk-new-secret',
      models: [
        { id: 'model-b', name: 'Renamed B', maxTokens: 4_096 },
        { id: 'model-a', input: ['text'], reasoning: false },
      ],
    });
    expect(saved).toMatchObject({
      id: 'gateway', name: 'Gateway Renamed', apiKeyConfigured: true, active: true, valid: true,
    });
    expect(saved).not.toHaveProperty('apiKey');
    expect(saved.models.map((model) => model.id)).toEqual(['model-b', 'model-a']);

    const config = await readJSON(path);
    const route = (config.providers as Record<string, Record<string, unknown>>).gateway!;
    expect(route).toMatchObject({
      displayName: 'Gateway Renamed',
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'GATEWAY_KEY',
      apiKey: 'sk-new-secret',
      headers: { 'x-gateway': 'kept' },
      timeoutMs: 10_000,
    });
    expect((route.models as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'model-b', name: 'Renamed B', maxTokens: 4_096,
    });
    expect((route.models as Array<Record<string, unknown>>)[1]).toMatchObject({
      id: 'model-a', input: ['text'], reasoning: false,
    });
    // The other route and every role survive the edit.
    expect((config.providers as Record<string, unknown>).alternate).toBeDefined();
    expect(config.roles).toEqual(baseConfig.roles);
  });

  it('creates a custom source, clears optional fields explicitly and retains its name on partial writes', async () => {
    const { path, settings } = await fixture();
    await settings.save('custom', {
      name: 'Custom',
      api: 'anthropic-messages',
      baseURL: 'https://custom.example/v1',
      apiKey: 'sk-custom',
      apiKeyEnv: 'CUSTOM_KEY',
      models: [{ id: 'custom-model', name: 'Custom Model', input: ['text'] }],
    });
    let config = await readJSON(path);
    expect((config.providers as Record<string, Record<string, unknown>>).custom).toMatchObject({
      displayName: 'Custom', api: 'anthropic-messages', baseURL: 'https://custom.example/v1',
      apiKey: 'sk-custom', apiKeyEnv: 'CUSTOM_KEY',
    });

    await settings.save('custom', {
      clearApiKey: true,
      clearApiKeyEnv: true,
      models: [{ id: 'custom-model' }],
    });
    config = await readJSON(path);
    const route = (config.providers as Record<string, Record<string, unknown>>).custom!;
    expect(route.displayName).toBe('Custom');
    expect(route.api).toBe('anthropic-messages');
    expect(route).not.toHaveProperty('apiKey');
    expect(route).not.toHaveProperty('apiKeyEnv');
    expect(route.baseURL).toBe('https://custom.example/v1');
    expect((await settings.list()).sources.find((source) => source.id === 'custom')).toMatchObject({
      name: 'Custom', apiKeyConfigured: false,
    });
  });

  it('clears a built-in route endpoint so its catalog endpoint applies again', async () => {
    const { path, settings } = await fixture();
    await settings.save('anthropic', {
      name: 'Anthropic Proxy',
      api: 'anthropic-messages',
      baseURL: 'https://proxy.example/v1',
      models: [{ id: 'claude-proxy' }],
    });
    expect((await settings.list()).sources.find((source) => source.id === 'anthropic')).toMatchObject({
      name: 'Anthropic Proxy',
      baseURL: 'https://proxy.example/v1',
      builtIn: true,
      valid: true,
    });

    const saved = await settings.save('anthropic', {
      clearBaseURL: true,
      models: [{ id: 'claude-proxy' }],
    });
    expect(saved.baseURL).toBeUndefined();
    expect(saved.valid).toBe(true);
    const route = (await readJSON(path)).providers as Record<string, Record<string, unknown>>;
    expect(route.anthropic).not.toHaveProperty('baseURL');
    expect(route.anthropic).toMatchObject({ api: 'anthropic-messages', models: [{ id: 'claude-proxy' }] });
  });

  it('honours an explicit reasoning: false over the official model default levels', async () => {
    const { settings } = await fixture({
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        'deepseek-official': {
          api: 'deepseek-messages',
          models: [{ id: 'deepseek-v4-pro', reasoning: false }],
        },
      },
    });
    const source = (await settings.list()).sources.find((entry) => entry.id === 'deepseek-official')!;
    expect(source.valid).toBe(true);
    expect(source.models.find((model) => model.id === 'deepseek-v4-pro')).not.toHaveProperty('reasoning');
  });

  it('migrates the legacy top-level provider into providers without changing the model or role', async () => {
    const legacy = {
      provider: {
        type: 'openai',
        baseURL: 'https://legacy.example/v1',
        apiKey: 'sk-legacy',
        apiKeyEnv: 'LEGACY_KEY',
      },
      model: 'legacy-model',
      contextWindowTokens: 64_000,
      maxTokens: 4_096,
      roles: { default: { name: 'Default', provider: 'openai', model: 'legacy-model' } },
    };
    const { path, settings } = await fixture(legacy);
    const before = await settings.list();
    expect(before.sources).toHaveLength(1);
    expect(before.sources[0]).toMatchObject({
      id: 'openai', name: 'OpenAI', api: 'openai-completions', legacy: true, active: true,
    });
    expect(before.sources[0]?.models[0]).toMatchObject({
      id: 'legacy-model', contextWindow: 64_000, maxTokens: 4_096,
    });

    await settings.save('openai', {
      name: 'Migrated OpenAI',
      models: [{ id: 'legacy-model', contextWindow: 64_000, maxTokens: 4_096 }],
    });
    const config = await readJSON(path);
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('legacy-model');
    expect((config.providers as Record<string, Record<string, unknown>>).openai).toMatchObject({
      displayName: 'Migrated OpenAI',
      api: 'openai-completions',
      baseURL: 'https://legacy.example/v1',
      apiKey: 'sk-legacy',
      apiKeyEnv: 'LEGACY_KEY',
    });
    expect((await settings.list()).sources).toHaveLength(1);
    expect((await settings.list()).sources[0]).toMatchObject({
      id: 'openai', legacy: false, active: true,
    });
  });

  it('refuses to leave a valid role pointing at a missing model or source', async () => {
    const { path, settings } = await fixture();
    const before = await readFile(path, 'utf8');
    await expect(settings.save('gateway', {
      models: [{ id: 'model-b' }],
    })).rejects.toThrow(/Role "default"/);
    expect(await readFile(path, 'utf8')).toBe(before);

    await expect(settings.remove('alternate')).rejects.toThrow(/Role "alt"/);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('refuses to remove the active or built-in source and removes an unused custom source', async () => {
    const { path, settings } = await fixture({
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        'deepseek-official': {
          displayName: 'DeepSeek', api: 'deepseek-messages', models: [{ id: 'deepseek-flash' }],
        },
        spare: {
          displayName: 'Spare', api: 'openai-completions',
          baseURL: 'https://spare.example/v1', models: [{ id: 'spare-model' }],
        },
      },
    });
    await expect(settings.remove('gateway')).rejects.toThrow(/default model source/);
    await expect(settings.remove('deepseek-official')).rejects.toThrow(/Built-in/);
    expect(await settings.remove('spare')).toBe(true);
    const config = await readJSON(path);
    expect((config.providers as Record<string, unknown>).spare).toBeUndefined();
    expect((config.providers as Record<string, unknown>).gateway).toBeDefined();
  });

  it('rejects invalid writes before touching config.json', async () => {
    const { path, settings } = await fixture();
    const before = await readFile(path, 'utf8');
    const attempts: Array<[string, unknown]> = [
      ['Bad Id', { models: [{ id: 'x' }] }],
      ['custom', { models: [{ id: 'x' }] }],
      ['custom', { api: 'openai-completions', models: [] }],
      ['custom', { api: 'openai-completions', models: [{ id: 'x' }, { id: 'x' }] }],
      ['custom', { api: 'openai-completions', models: [{ id: 'x' }], baseURL: 'file:///tmp/models' }],
      ['custom', { api: 'openai-completions', models: [{ id: 'x', input: [] }] }],
      ['custom', { api: 'deepseek-messages', models: [{ id: 'x' }] }],
      ['gateway', { unknown: true }],
    ];
    for (const [id, input] of attempts) {
      await expect(settings.save(id, input)).rejects.toBeInstanceOf(InvalidModelSettings);
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  });

  it('discovers OpenAI-compatible models with metadata and the saved key', async () => {
    let authorization = '';
    const baseURL = await mockEndpoint((request) => {
      authorization = String(request.headers.authorization ?? '');
      return {
        body: {
          object: 'list',
          data: [
            {
              id: 'remote-large',
              name: 'Remote Large',
              context_window: 256_000,
              max_output_tokens: 16_384,
              architecture: { input_modalities: ['text', 'image'] },
            },
            { id: 'remote-small' },
          ],
        },
      };
    });
    const { path, settings } = await fixture({
      provider: 'gateway',
      model: 'model-a',
      providers: {
        gateway: {
          api: 'openai-completions',
          baseURL: `${baseURL}/v1`,
          apiKey: 'sk-endpoint',
          models: [{ id: 'model-a' }],
        },
      },
    });
    const result = await settings.discover({ provider: 'gateway' });
    expect(authorization).toBe('Bearer sk-endpoint');
    expect(result.models).toEqual([
      {
        id: 'remote-large', name: 'Remote Large', contextWindow: 256_000,
        maxTokens: 16_384, input: ['text', 'image'],
      },
      { id: 'remote-small' },
    ]);
    expect((await readJSON(path)).providers).toBeDefined();
  });

  it('discovers Anthropic models through the versioned endpoint', async () => {
    let pathSeen = '';
    let apiKey = '';
    const baseURL = await mockEndpoint((request) => {
      pathSeen = request.url ?? '';
      apiKey = String(request.headers['x-api-key'] ?? '');
      return { body: { data: [{ id: 'claude-test', display_name: 'Claude Test' }] } };
    });
    const { settings } = await fixture({
      provider: 'gateway',
      model: 'model-a',
      providers: {
        gateway: {
          api: 'openai-completions',
          baseURL: 'https://gateway.example/v1',
          models: [{ id: 'model-a' }],
        },
      },
    });
    const result = await settings.discover({
      api: 'anthropic-messages',
      baseURL,
      apiKey: 'sk-anthropic',
    });
    expect(pathSeen).toBe('/v1/models');
    expect(apiKey).toBe('sk-anthropic');
    expect(result.models[0]).toEqual({ id: 'claude-test', name: 'Claude Test' });
  });

  it('surfaces endpoint errors and refuses protocols without a model list', async () => {
    const baseURL = await mockEndpoint(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
    const { settings } = await fixture();
    await expect(settings.discover({ baseURL })).rejects.toThrow(/HTTP 401: bad key/);
    await expect(settings.discover({ api: 'deepseek-messages', baseURL }))
      .rejects.toThrow(/does not expose a model list/);
    await expect(settings.discover({})).rejects.toThrow(/base URL is required/);
  });

  it('refuses a configuration path outside the trusted home and a symlinked config', async () => {
    const { root, path } = await fixture();
    await expect(ModelSettings.open(path, { trustedHome: join(root, 'elsewhere') }))
      .rejects.toThrow(/inside the trusted home/);

    const target = join(root, 'target.json');
    await writeFile(target, JSON.stringify(baseConfig));
    const link = join(root, 'linked.json');
    await symlink(target, link);
    await expect(ModelSettings.open(link)).rejects.toThrow();
  });
});
