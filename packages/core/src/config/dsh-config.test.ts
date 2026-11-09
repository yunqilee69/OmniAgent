import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, loadConfig } from './load';
import { createConfiguredModel } from '../providers/create';
import { DeepSeekMessagesModel } from '../providers/dsh-deepseek';
import { OpenAIModel } from '../providers/openai';
import { PiAiModel, resolvePiAiRoute } from '../providers/pi-model';
import type { ModelRequest } from '../providers/types';

const request: ModelRequest = {
  model: 'deepseek-flash', system: 'System',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], tools: [],
};

const deepseekEvents = [
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

function deepseekResponse(): Response {
  return new Response(deepseekEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DSH configuration', () => {
  it('preserves provider routes, unrelated provider fields, and the DSH permission namespace', () => {
    const input = {
      model: 'fixture-model', provider: 'gateway', reasoningEffort: 'high', maxTokens: 512,
      providers: {
        gateway: {
          api: 'openai-completions', baseURL: 'https://example.test/v1', apiKeyEnv: 'GATEWAY_API_KEY',
          models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 1024, vendorMetadata: 'keep' }],
          headers: { 'x-provider': 'value' }, customOption: { retained: true },
        },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', displayName: 'Other route' },
      },
      dsh: { permission: { defaultPreset: 'read-only', extra: 'keep' }, other: { retained: true } },
      other: { retained: true },
    };
    expect(ConfigSchema.parse(input)).toMatchObject(input);
  });

  it('does not add permission settings to defaults', () => {
    const config = ConfigSchema.parse({});
    expect(config).not.toHaveProperty('mode');
    expect(config).not.toHaveProperty('permissions');
  });

  it('loads DSH settings from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-dsh-config-'));
    const path = join(dir, 'config.json');
    const input = { model: 'deepseek-flash', provider: 'deepseek-official',
      dsh: { permission: { defaultPreset: 'workspace-write' } } };
    try {
      await writeFile(path, JSON.stringify(input));
      const loaded = await loadConfig(path);
      expect(loaded.config).toMatchObject(input);
      expect(loaded).not.toHaveProperty('rules');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(input);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sends DeepSeek Messages with the selected route environment key and DSH generation settings', async () => {
    vi.stubEnv('OMNI_DSH_KEY', 'selected-secret');
    vi.stubEnv('DEEPSEEK_API_KEY', 'other-secret');
    vi.stubEnv('OPENAI_API_KEY', 'legacy-secret');
    const fetcher = vi.fn<typeof fetch>(async () => deepseekResponse());
    vi.stubGlobal('fetch', fetcher);
    const config = ConfigSchema.parse({
      model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'low', maxTokens: 321,
      providers: { 'deepseek-official': { baseURL: 'https://messages.example/anthropic', apiKeyEnv: 'OMNI_DSH_KEY' } },
    });
    const model = createConfiguredModel(config);
    expect(model).toBeInstanceOf(DeepSeekMessagesModel);
    const response = await model!.complete(request);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://messages.example/anthropic/v1/messages');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('selected-secret');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'deepseek-flash', max_tokens: 321, thinking: { type: 'enabled' }, output_config: { effort: 'low' },
    });
    expect(JSON.stringify(response)).not.toMatch(/selected-secret|other-secret|legacy-secret/);
  });

  it('uses the trusted default DeepSeek environment key when no route key is configured', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'deepseek-secret');
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://env.example/anthropic');
    const fetcher = vi.fn<typeof fetch>(async () => deepseekResponse());
    vi.stubGlobal('fetch', fetcher);
    const model = createConfiguredModel(ConfigSchema.parse({ model: 'deepseek-flash', provider: 'deepseek-official' }));
    await model!.complete(request);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://env.example/anthropic/v1/messages');
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('x-api-key')).toBe('deepseek-secret');
  });

  it('does not borrow a different environment credential when the selected route key is missing', () => {
    vi.stubEnv('OMNI_MISSING_DSH_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', 'other-secret');
    vi.stubEnv('OPENAI_API_KEY', 'legacy-secret');
    const config = ConfigSchema.parse({ model: 'deepseek-flash', provider: 'deepseek-official',
      providers: { 'deepseek-official': { apiKeyEnv: 'OMNI_MISSING_DSH_KEY' } } });
    expect(() => createConfiguredModel(config)).toThrow(/OMNI_MISSING_DSH_KEY/);
  });

  it('applies a selected DeepSeek model output cap over the provider default', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'deepseek-secret');
    const fetcher = vi.fn<typeof fetch>(async () => deepseekResponse());
    vi.stubGlobal('fetch', fetcher);
    const config = ConfigSchema.parse({ model: 'deepseek-flash', provider: 'deepseek-official',
      providers: { 'deepseek-official': { maxTokens: 800, models: [
        { id: 'deepseek-flash', maxTokens: 128 },
      ] } } });
    await createConfiguredModel(config)!.complete(request);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).max_tokens).toBe(128);
  });

  it('rejects duplicate DeepSeek model ids instead of choosing an ambiguous model', () => {
    const config = ConfigSchema.parse({ model: 'deepseek-flash', provider: 'deepseek-official',
      providers: { 'deepseek-official': { models: [
        { id: 'deepseek-flash', maxTokens: 128 }, { id: 'deepseek-flash', maxTokens: 256 },
      ] } } });
    expect(() => createConfiguredModel(config)).toThrow(/duplicate/i);
  });

  it('rejects an explicit pi route type that does not match its protocol', () => {
    const config = ConfigSchema.parse({ model: 'fixture-model', provider: 'gateway',
      providers: { gateway: { type: 'openai', api: 'openai-completions',
        baseURL: 'https://gateway.example/v1', models: [{ id: 'fixture-model' }] } } });
    expect(() => createConfiguredModel(config)).toThrow(/type|route/i);
  });

  it('uses an explicit pi-ai custom route and rejects unknown models on it', async () => {
    const config = ConfigSchema.parse({ model: 'fixture-model', provider: 'gateway',
      providers: { gateway: {
        api: 'openai-completions', baseURL: 'https://gateway.example/v1', apiKeyEnv: 'OMNI_PI_KEY',
        models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 1024 }],
      } } });
    const model = createConfiguredModel(config);
    expect(model).toBeInstanceOf(PiAiModel);
    expect(model?.name).toBe('gateway');
    await expect(model!.complete({ ...request, model: 'unknown' })).rejects.toThrow(/model/i);
    expect(() => createConfiguredModel(ConfigSchema.parse({ ...config, model: 'unknown' }))).toThrow(/model/i);
  });

  it('passes the selected pi route credential, model and reasoning effort to the provider', async () => {
    vi.stubEnv('OMNI_PI_KEY', 'selected-pi-secret');
    vi.stubEnv('OPENAI_API_KEY', 'other-secret');
    const fetcher = vi.fn<typeof fetch>(async () => new Response([
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":0,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n',
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":0,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetcher);
    const config = ConfigSchema.parse({ model: 'fixture-model', provider: 'gateway', reasoningEffort: 'high',
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gateway.example/v1',
        apiKeyEnv: 'OMNI_PI_KEY', models: [{ id: 'fixture-model', reasoning: true }] } } });
    const response = await createConfiguredModel(config)!.complete({ ...request, model: 'fixture-model' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://gateway.example/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-pi-secret');
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'fixture-model', reasoning_effort: 'high' });
    expect(JSON.stringify(response)).not.toMatch(/selected-pi-secret|other-secret/);
  });

  it('does not borrow credentials from other routes for a pi provider', async () => {
    vi.stubEnv('OMNI_PI_MISSING_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'other-secret');
    vi.stubEnv('DEEPSEEK_API_KEY', 'deepseek-secret');
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const config = ConfigSchema.parse({ model: 'fixture-model', provider: 'gateway',
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gateway.example/v1',
        apiKeyEnv: 'OMNI_PI_MISSING_KEY', models: [{ id: 'fixture-model' }] },
      other: { apiKey: 'other-route-secret' } } });
    await expect(createConfiguredModel(config)!.complete({ ...request, model: 'fixture-model' }))
      .rejects.toThrow(/OMNI_PI_MISSING_KEY/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects pi reasoning off when the adapter cannot represent it', () => {
    const config = ConfigSchema.parse({ model: 'fixture-model', provider: 'gateway', reasoningEffort: 'off',
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gateway.example/v1',
        apiKeyEnv: 'OMNI_PI_KEY', models: [{ id: 'fixture-model' }] } } });
    expect(() => createConfiguredModel(config)).toThrow(/reasoning.*off/i);
  });

  it('supports an explicitly selected pi-ai catalog provider', () => {
    const model = resolvePiAiRoute('anthropic', {}).models[0];
    expect(model).toBeDefined();
    const config = ConfigSchema.parse({ model: model!.id, provider: 'anthropic',
      providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } });
    expect(createConfiguredModel(config)).toBeInstanceOf(PiAiModel);
  });

  it('does not silently ignore an output cap on a pi route without adapter support', () => {
    const config = ConfigSchema.parse({ model: 'fixture-model', provider: 'gateway', maxTokens: 100,
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gateway.example/v1',
        models: [{ id: 'fixture-model' }], apiKeyEnv: 'OMNI_PI_KEY' } } });
    expect(() => createConfiguredModel(config)).toThrow(/maxTokens|output cap/i);
  });

  it.each([
    { model: 'example', provider: 'unknown-provider' },
    { model: 'fixture', provider: 'gateway', providers: { gateway: { api: 'unknown', models: [{ id: 'fixture' }] } } },
    { model: 'fixture', provider: 'gateway', providers: { gateway: { api: 'openai-completions', models: [{ id: 'fixture' }] } } },
    { model: 'deepseek-flash', provider: 'deepseek-official', reasoningEffort: 'unsupported' },
    { model: 'deepseek-flash', provider: 'deepseek-official', maxTokens: 0 },
    { model: 'deepseek-flash', provider: 'deepseek-official', maxTokens: 1.5 },
  ])('fails closed for invalid route or generation configuration %#', (input) => {
    expect(() => createConfiguredModel(ConfigSchema.parse(input))).toThrow();
  });

  it('preserves the legacy OpenAI shape and does not repoint its endpoint or credentials', async () => {
    vi.stubEnv('OMNI_LEGACY_KEY', 'legacy-key');
    vi.stubEnv('DEEPSEEK_API_KEY', 'deepseek-key');
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'response', object: 'chat.completion', created: 0, model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const provider = { type: 'openai', baseURL: 'https://legacy.example/v1', apiKeyEnv: 'OMNI_LEGACY_KEY',
      headers: { 'x-legacy': 'keep' }, timeoutMs: 3000, maxRetries: 0, customOption: 'keep' };
    const config = ConfigSchema.parse({ model: 'deepseek-chat', provider });
    expect(config.provider).toMatchObject(provider);
    const model = createConfiguredModel(config);
    expect(model).toBeInstanceOf(OpenAIModel);
    await model!.complete({ ...request, model: 'deepseek-chat' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://legacy.example/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer legacy-key');
    expect(new Headers(init?.headers).get('x-legacy')).toBe('keep');
  });

  it('leaves fake model fallback to the caller when no provider is selected', () => {
    expect(createConfiguredModel(ConfigSchema.parse({}))).toBeUndefined();
  });
});
