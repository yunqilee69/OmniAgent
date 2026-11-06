import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './load';
import { buildConfigCatalog, findCatalogModel, listCatalogModels, supportedReasoningEfforts } from './models';

function dshConfig(extra: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    providers: { 'deepseek-official': { apiKey: 'SECRET_KEY' } },
    ...extra,
  });
}

describe('config catalog', () => {
  it('synthesizes the default role from the top-level model settings', () => {
    const catalog = buildConfigCatalog(dshConfig({ reasoningEffort: 'low' }));
    expect(catalog.roles.get('default')).toEqual({
      id: 'default',
      name: 'Default',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'low',
    });
    expect(findCatalogModel(catalog, 'deepseek-official', 'deepseek-flash')).toMatchObject({
      id: 'deepseek-flash',
      capabilities: { imageInput: true },
      reasoning: {
        efforts: { off: null, low: 'low', high: 'high', max: 'max' },
        default: 'high',
      },
    });
  });

  it('lets an explicit roles.default override the top-level default', () => {
    const catalog = buildConfigCatalog(dshConfig({
      model: 'missing-model',
      roles: {
        default: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
      },
    }));
    expect(catalog.roles.get('default')).toMatchObject({ model: 'deepseek-v4-pro', reasoningEffort: 'max' });
    expect(catalog.roleErrors.size).toBe(0);
  });

  it('validates custom roles and keeps invalid roles out of the selectable catalog', () => {
    const catalog = buildConfigCatalog(dshConfig({
      roles: {
        quick: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low' },
        badProvider: { provider: 'missing', model: 'x' },
        badModel: { provider: 'deepseek-official', model: 'missing' },
        badEffort: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'minimal' },
      },
    }));
    expect(catalog.roles.get('quick')).toMatchObject({ id: 'quick', model: 'deepseek-v4-pro' });
    expect([...catalog.roles.keys()].sort()).toEqual(['default', 'quick']);
    expect(catalog.roleErrors.get('badProvider')).toMatch(/unknown provider/i);
    expect(catalog.roleErrors.get('badModel')).toMatch(/unknown model/i);
    expect(catalog.roleErrors.get('badEffort')).toMatch(/does not support/i);
  });

  it('honors explicit model capabilities and reasoning mappings', () => {
    const catalog = buildConfigCatalog(dshConfig({
      providers: {
        'deepseek-official': {
          apiKey: 'SECRET_KEY',
          models: [{
            id: 'deepseek-flash',
            name: 'Flash',
            contextWindow: 1024,
            maxTokens: 64,
            input: ['text'],
            capabilities: { imageInput: true },
            reasoning: {
              efforts: { low: 'l', high: 'h' },
              budgets: { high: 4096 },
              default: 'low',
              wire: { effortField: 'generation.effort', budgetField: 'generation.budget' },
            },
          }],
        },
      },
    }));
    const model = catalog.roles.get('default') && findCatalogModel(catalog, 'deepseek-official', 'deepseek-flash');
    expect(model).toMatchObject({
      name: 'Flash',
      contextWindow: 1024,
      maxTokens: 64,
      capabilities: { imageInput: true },
      reasoning: {
        efforts: { low: 'l', high: 'h' },
        budgets: { high: 4096 },
        default: 'low',
        wire: { effortField: 'generation.effort', budgetField: 'generation.budget' },
      },
    });
    expect(supportedReasoningEfforts(model!)).toEqual(['low', 'high']);
  });

  it('never includes route credentials in model descriptors', () => {
    const catalog = buildConfigCatalog(dshConfig());
    expect(JSON.stringify(listCatalogModels(catalog))).not.toContain('SECRET_KEY');
  });

  it('uses the built-in unrestricted profile only when agentProfiles is omitted', () => {
    const implicit = buildConfigCatalog(dshConfig());
    expect(implicit.profiles.get('default')).toEqual({ id: 'default', tools: '*', skills: '*' });

    const explicit = buildConfigCatalog(dshConfig({
      agentProfiles: { coding: { tools: ['read_file'], skills: ['x'] } },
    }));
    expect(explicit.profiles.has('default')).toBe(false);
    expect(explicit.profiles.get('coding')).toEqual({ id: 'coding', tools: ['read_file'], skills: ['x'] });
  });

  it('rejects unsafe reasoning wire paths at configuration load', () => {
    for (const field of ['__proto__.x', 'constructor', 'prototype.x', 'model', 'messages', 'stream', 'tools.x', 'a..b']) {
      expect(() => dshConfig({
        providers: {
          'deepseek-official': {
            apiKey: 'SECRET_KEY',
            models: [{ id: 'deepseek-flash', reasoning: { efforts: { low: 'l' }, wire: { effortField: field } } }],
          },
        },
      })).toThrow();
    }
  });

  it('rejects a default reasoning effort that is not in the effort map', () => {
    expect(() => dshConfig({
      providers: {
        'deepseek-official': {
          apiKey: 'SECRET_KEY',
          models: [{ id: 'deepseek-flash', reasoning: { efforts: { low: 'l' }, default: 'high' } }],
        },
      },
    })).toThrow(/default reasoning effort/i);
  });
});
