import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextMeter } from '../ui/src/components/ContextMeter.tsx';
import { carryProjection, contextCapacity, contextOccupancy } from '../ui/src/lib/context-reading.ts';
import type { ContextEstimate } from '../ui/src/lib/wire.ts';

const props = {
  workspaceId: null, sessionId: null, draft: false, busy: false,
  modelSaving: false, modelKey: '', locale: 'en' as const,
};

const settled: ContextEstimate = {
  modelWindow: 200_000,
  projection: {
    projectedTokens: 50_000, source: 'usage', inputTokens: 42_000,
    breakdown: { systemTokens: 4_000, toolsTokens: 6_000, messageTokens: 40_000 },
  },
};

describe('context meter', () => {
  it('renders nothing until the session reports occupancy and a model window', () => {
    expect(renderToStaticMarkup(createElement(ContextMeter, props))).toBe('');
  });

  it('shows a ring at zero for a live session that has not settled a turn yet', () => {
    const markup = renderToStaticMarkup(createElement(ContextMeter, { ...props, workspaceId: 'w', sessionId: 's', busy: true }));
    expect(markup).toContain('0%');
    expect(markup).toContain('aria-haspopup="dialog"');
  });

  it('draws a ring with the percentage beside it in a quiet pill', () => {
    const css = readFileSync(new URL('../ui/src/styles/dsh/context-meter.module.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.track\s*\{[^}]*stroke:\s*var\(--dsw-alias-border-l3\)/);
    expect(css).toMatch(/\.fill\s*\{[^}]*stroke:\s*var\(--dsw-alias-label-tertiary\)/);
    expect(css).toMatch(/\.trigger\s*\{[^}]*padding:\s*1px 8px/);
    expect(css).toMatch(/\.panel\s*\{[^}]*width:\s*min\(264px, 100vw - 24px\)/);
    expect(css).toMatch(/\.segment\s*\{[^}]*background:\s*var\(--meter-tint/);
  });

  it('tints each breakdown row from the shared meter palette', () => {
    const css = readFileSync(new URL('../ui/src/styles/dsh/context-meter.module.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.colorSystem\s*\{\s*--meter-tint:\s*var\(--dsw-static-neutral-bluish-400\)/);
    expect(css).toMatch(/\.colorTools\s*\{\s*--meter-tint:\s*#a78bfa/);
    expect(css).toMatch(/\.colorMessages\s*\{\s*--meter-tint:\s*var\(--dsw-static-blue-450\)/);
  });
});

describe('context reading', () => {
  it('keeps the last settled projection when a mid-turn poll answers without one', () => {
    const midTurn: ContextEstimate = { modelWindow: 200_000 };
    const reading = carryProjection(settled, midTurn);
    expect(reading.projection).toEqual(settled.projection);
    expect(reading.modelWindow).toBe(200_000);
  });

  it('adopts a fresher window and budget even when it falls back to the held projection', () => {
    const midTurn: ContextEstimate = { modelWindow: 128_000, window: { tokens: 128_000, source: 'config' } };
    expect(carryProjection(settled, midTurn)).toMatchObject({
      modelWindow: 128_000, window: { tokens: 128_000 }, projection: settled.projection,
    });
  });

  it('takes the new projection whenever the answer carries one', () => {
    const fresher: ContextEstimate = {
      modelWindow: 200_000,
      projection: { projectedTokens: 80_000, source: 'estimate', breakdown: { systemTokens: 1, toolsTokens: 1, messageTokens: 1 } },
    };
    expect(carryProjection(settled, fresher)).toBe(fresher);
  });

  it('has nothing to hold before the first settled answer', () => {
    expect(carryProjection(undefined, { modelWindow: 200_000 })).toEqual({ modelWindow: 200_000 });
  });

  it('measures against the resolved budget and falls back to the model window', () => {
    expect(contextCapacity({ window: { tokens: 1234, source: 'config' } })).toBe(1234);
    expect(contextCapacity({ modelWindow: 200_000, window: { tokens: 1234, source: 'config' } })).toBe(1234);
    expect(contextCapacity({ modelWindow: 200_000 })).toBe(200_000);
    expect(contextCapacity({})).toBeUndefined();
    expect(contextCapacity({ modelWindow: 0 })).toBeUndefined();
  });

  it('reads 0 percent until a settled projection arrives', () => {
    expect(contextOccupancy(null)).toEqual({ percent: 0, settled: false });
    expect(contextOccupancy({ modelWindow: 200_000 })).toEqual({ percent: 0, settled: false, capacity: 200_000 });
    expect(contextOccupancy(settled)).toEqual({ percent: 25, settled: true, capacity: 200_000, projection: settled.projection });
  });

  it('lists the breakdown at 0 percent when the budget is still unknown', () => {
    const occupancy = contextOccupancy({ projection: settled.projection });
    expect(occupancy).toEqual({ percent: 0, settled: true, projection: settled.projection });
  });

  it('never draws past a full ring', () => {
    const over: ContextEstimate = { modelWindow: 100, projection: { projectedTokens: 400, source: 'estimate',
      breakdown: { systemTokens: 1, toolsTokens: 1, messageTokens: 1 } } };
    expect(contextOccupancy(over).percent).toBe(100);
  });
});
