import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../config/load';
import {
  createModelSelectionEvent,
  createModelSwitch,
  createSelectedModel,
  defaultModelSelection,
  listConfiguredModels,
  projectModelSelection,
  resolveContextWindowTokens,
} from './model-selection';

function deepseek() {
  return ConfigSchema.parse({
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    providers: { 'deepseek-official': { apiKey: 'test-key' } },
  });
}

describe('session model selection', () => {
  it('lists DeepSeek registry models without exposing credentials', () => {
    const choices = listConfiguredModels(deepseek());
    expect(choices).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576 },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_048_576 },
    ]);
    expect(JSON.stringify(choices)).not.toContain('test-key');
  });

  it('lists a configured pi-ai route and a legacy OpenAI model', () => {
    const pi = ConfigSchema.parse({
      model: 'fixture',
      provider: 'gateway',
      providers: {
        gateway: {
          api: 'openai-completions', baseURL: 'https://example.invalid/v1', apiKey: 'pi-key',
          models: [{ id: 'fixture', name: 'Fixture', contextWindow: 8192, reasoning: true }],
        },
      },
    });
    expect(listConfiguredModels(pi)).toEqual([
      { provider: 'gateway', model: 'fixture', name: 'Fixture', contextWindow: 8192, reasoning: true },
    ]);
    const legacy = ConfigSchema.parse({ model: 'gpt-test', provider: { apiKey: 'legacy-key' } });
    expect(listConfiguredModels(legacy)).toEqual([{ provider: 'openai', model: 'gpt-test', name: 'gpt-test' }]);
  });

  it('returns no choices for the unconfigured FakeModel path', () => {
    const config = ConfigSchema.parse({});
    expect(listConfiguredModels(config)).toEqual([]);
    expect(defaultModelSelection(config)).toBeUndefined();
  });

  it('persists and projects a strict, credential-free selection', () => {
    const config = deepseek();
    const selection = defaultModelSelection(config);
    expect(selection).toEqual({ version: 1, provider: 'deepseek-official', model: 'deepseek-flash' });
    const event = createModelSelectionEvent(selection);
    expect(projectModelSelection([event])).toEqual({ status: 'selected', selection });
    expect(projectModelSelection([])).toEqual({ status: 'legacy', selection: null });
    expect(projectModelSelection([{ type: 'model/selected', data: { ...selection, apiKey: 'leak' } }]))
      .toEqual({ status: 'invalid', selection: null });
    expect(JSON.stringify(event)).not.toContain('test-key');
  });

  it('only emits a switch when the selection actually changes', () => {
    const selection = defaultModelSelection(deepseek())!;
    const projection = projectModelSelection([createModelSelectionEvent(selection)]);
    expect(createModelSwitch(projection, selection)).toBeUndefined();
    const next = { ...selection, model: 'deepseek-v4-pro' };
    expect(createModelSwitch(projection, next)).toMatchObject({ type: 'model/selected', data: next });
  });

  it('constructs the selected route and rejects a provider/legacy mismatch', () => {
    expect(createSelectedModel(deepseek(), defaultModelSelection(deepseek())!).name).toMatch(/deepseek/i);
    const legacy = ConfigSchema.parse({ model: 'gpt-test', provider: { apiKey: 'legacy-key' } });
    expect(createSelectedModel(legacy, { version: 1, provider: 'openai', model: 'gpt-test' })).toBeDefined();
    expect(() => createSelectedModel(legacy, { version: 1, provider: 'deepseek-official', model: 'x' })).toThrow(/provider/i);
    expect(() => createSelectedModel(legacy, { version: 1, provider: 'openai', model: 'gpt-test', reasoningEffort: 'high' }))
      .toThrow(/reasoning/i);
  });

  it('prefers an explicit context cap and otherwise uses catalog metadata', () => {
    const config = deepseek();
    expect(resolveContextWindowTokens(config, defaultModelSelection(config))).toBe(1_048_576);
    const capped = ConfigSchema.parse({ ...config, contextWindowTokens: 4096 });
    expect(resolveContextWindowTokens(capped, defaultModelSelection(capped))).toBe(4096);
    expect(resolveContextWindowTokens(ConfigSchema.parse({}), undefined)).toBeUndefined();
  });
});
