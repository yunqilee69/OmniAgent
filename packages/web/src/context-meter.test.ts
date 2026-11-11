import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextMeter } from '../ui/src/components/ContextMeter.tsx';

const props = {
  workspaceId: null, sessionId: null, draft: false, busy: false,
  modelSaving: false, modelKey: '', locale: 'en' as const,
};

describe('context meter', () => {
  it('renders nothing until the session reports occupancy and a model window', () => {
    expect(renderToStaticMarkup(createElement(ContextMeter, props))).toBe('');
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
