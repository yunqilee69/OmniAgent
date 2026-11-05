import { describe, expect, it } from 'vitest';
import { FakeModel } from './fake';
import { DshModelRegistry, createDshRegistry } from './dsh-registry';

describe('DSH model registry', () => {
  it('exposes official catalog and selects its default lazily', () => {
    const registry = createDshRegistry({ deepseek: { apiKey: 'fixture' } });
    expect(registry.list()).toEqual([{ id: 'deepseek-official', displayName: 'DeepSeek', protocol: 'deepseek-messages',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576, inputModalities: ['text', 'image'] },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1048576, inputModalities: ['text'] },
      ] }]);
    const selected = registry.select('deepseek-official', 'deepseek-flash');
    expect(selected.client.name).toBe('deepseek-official');
    expect(selected.model.id).toBe('deepseek-flash');
    expect(JSON.stringify(registry.list())).not.toContain('fixture');
  });
  it('supports configured OpenAI compatible routes and custom client factories', () => {
    const registry = createDshRegistry({ deepseek: false, routes: [{
      id: 'gateway', displayName: 'Gateway', protocol: 'openai-completions',
      models: [{ id: 'custom', name: 'Custom' }], options: { apiKey: 'fixture', baseURL: 'https://example.test/v1' },
    }] });
    expect(registry.select('gateway', 'custom').client.name).toBe('gateway');
    registry.register({ id: 'fake', displayName: 'Fake', protocol: 'custom', models: [{ id: 'test', name: 'Test' }], createClient: () => new FakeModel([]) });
    expect(registry.select('fake', 'test').client.name).toBe('fake');
    expect(() => registry.select('gateway', 'missing')).toThrow(/model/i);
    expect(() => registry.select('missing', 'custom')).toThrow(/provider/i);
  });
  it('rejects invalid or duplicate routes and model ids', () => {
    const registry = new DshModelRegistry();
    expect(() => registry.register({ id: '', displayName: 'X', protocol: 'custom', models: [], createClient: () => new FakeModel([]) })).toThrow();
    expect(() => registry.register({ id: 'x', displayName: 'X', protocol: 'custom',
      models: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }], createClient: () => new FakeModel([]) })).toThrow();
    registry.register({ id: 'x', displayName: 'X', protocol: 'custom', models: [], createClient: () => new FakeModel([]) });
    expect(() => registry.register({ id: 'x', displayName: 'X', protocol: 'custom', models: [], createClient: () => new FakeModel([]) })).toThrow();
  });
});
