import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../config/load';
import { buildConfigCatalog } from '../config/models';
import {
  createModelSelectionEvent,
  createModelSwitch,
  defaultModelBinding,
  projectModelSelection,
  resolveModelBinding,
} from './model-binding';

const catalog = buildConfigCatalog(ConfigSchema.parse({
  model: 'deepseek-flash',
  provider: 'deepseek-official',
  reasoningEffort: 'low',
  providers: { 'deepseek-official': { apiKey: 'SECRET' } },
  roles: {
    quick: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
    noEffort: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  },
}));

describe('model bindings', () => {
  it('resolves agent, role, and explicit model bindings with effort precedence', () => {
    expect(resolveModelBinding(catalog, 'default', defaultModelBinding())).toMatchObject({
      model: { id: 'deepseek-flash' },
      role: { id: 'default' },
      reasoningEffort: 'low',
    });
    expect(resolveModelBinding(catalog, 'default', { version: 2, kind: 'role', role: 'quick' })).toMatchObject({
      model: { id: 'deepseek-v4-pro' },
      reasoningEffort: 'max',
    });
    expect(resolveModelBinding(catalog, 'default', {
      version: 2,
      kind: 'model',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })).toMatchObject({ reasoningEffort: 'high' });

    // Model defaults apply when neither the binding nor a role selects an effort.
    expect(resolveModelBinding(catalog, 'noEffort', defaultModelBinding())).toMatchObject({
      reasoningEffort: 'high',
    });
  });

  it('resolves to no model when nothing configures the default role', () => {
    const empty = buildConfigCatalog(ConfigSchema.parse({}));
    expect(resolveModelBinding(empty, 'default', defaultModelBinding())).toEqual({ binding: defaultModelBinding() });
    // An explicit role reference stays strict even in an unconfigured install.
    expect(() => resolveModelBinding(empty, 'default', { version: 2, kind: 'role', role: 'default' }))
      .toThrow(/unknown role/i);
  });

  it('rejects unknown agents/roles/models and unsupported efforts', () => {
    expect(() => resolveModelBinding(catalog, 'missing', defaultModelBinding())).toThrow(/unknown role/i);
    expect(() => resolveModelBinding(catalog, 'default', { version: 2, kind: 'role', role: 'missing' })).toThrow(/unknown role/i);
    expect(() => resolveModelBinding(catalog, 'default', {
      version: 2, kind: 'model', provider: 'deepseek-official', model: 'missing',
    })).toThrow(/unknown model/i);
    expect(() => resolveModelBinding(catalog, 'default', {
      version: 2, kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'minimal',
    })).toThrow(/does not support reasoning effort/i);
  });

  it('rejects v1 model events instead of migrating them', () => {
    const legacy = [{ type: 'model/selected', data: { version: 1, provider: 'deepseek-official', model: 'deepseek-flash' } }];
    expect(projectModelSelection(legacy)).toEqual({ status: 'invalid', binding: null });
    expect(projectModelSelection([])).toEqual({ status: 'legacy', binding: null });
  });

  it('persists and switches only when the binding actually changes', () => {
    const binding = { version: 2 as const, kind: 'role' as const, role: 'quick' };
    const event = createModelSelectionEvent(binding);
    expect(projectModelSelection([event])).toEqual({ status: 'selected', binding });
    expect(createModelSwitch(projectModelSelection([event]), binding)).toBeUndefined();
    expect(createModelSwitch(projectModelSelection([event]), defaultModelBinding())).toMatchObject({
      type: 'model/selected',
      data: { version: 2, kind: 'agent' },
    });
  });
});
