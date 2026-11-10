import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ModelSummary, ResolvedModel } from '../ui/src/lib/wire.ts';

const pane = vi.hoisted(() => ({ value: 'model' }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (initial === false) return [true, () => {}];
      if (initial === 'root') return [pane.value, () => {}];
      return actual.useState(initial);
    },
  };
});
vi.mock('../ui/vendor/primitives/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/vendor/primitives/index.ts')>();
  return {
    ...actual,
    MenuSurface: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
    useAnchoredPosition: () => null,
    useDismissOnOutsidePointer: () => {},
  };
});
import { concreteModelBinding, ModelPicker } from '../ui/src/components/ModelPicker.tsx';

const model: ModelSummary = {
  provider: 'provider-a', model: 'model-1', name: 'Model One',
  capabilities: { imageInput: false }, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low',
};
const resolved: ResolvedModel = { provider: 'provider-a', model: 'model-1', name: 'Model One', reasoningEffort: 'high' };
const binding = { version: 2 as const, kind: 'agent' as const };

function render(concreteOnly: boolean, selectedPane: string): string {
  pane.value = selectedPane;
  const selectedBinding = !concreteOnly && selectedPane === 'effort'
    ? { version: 2 as const, kind: 'model' as const, provider: model.provider, model: model.model }
    : binding;
  return renderToStaticMarkup(createElement(ModelPicker, {
    binding: selectedBinding, resolved, models: [model], roles: [], concreteOnly,
    ariaLabel: 'model', onSelect: () => {},
  }));
}

describe('composer model picker', () => {
  it('selects the resolved model without a follow-agent item', () => {
    const markup = render(true, 'model');
    expect(markup).toContain('Model One · high');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).not.toContain('跟随智能体');
  });

  it('selects the resolved effort without a model-default item', () => {
    const markup = render(true, 'effort');
    expect(markup).not.toContain('模型默认值');
    expect(markup).toMatch(/aria-checked="true"[^>]*>[^]*?high/);
    expect(markup).toMatch(/aria-checked="false"[^>]*>[^]*?low/);
  });

  it('retains configuration-only choices for settings', () => {
    expect(render(false, 'model')).toContain('跟随智能体');
    expect(render(false, 'effort')).toContain('模型默认值');
  });

  it('persists the effective effort for the current model and the default for a different model', () => {
    expect(concreteModelBinding(model, resolved)).toEqual({
      version: 2, kind: 'model', provider: 'provider-a', model: 'model-1', reasoningEffort: 'high',
    });
    expect(concreteModelBinding({ ...model, model: 'model-2' }, resolved)).toEqual({
      version: 2, kind: 'model', provider: 'provider-a', model: 'model-2', reasoningEffort: 'low',
    });
  });
});
