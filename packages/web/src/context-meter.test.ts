import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextMeter } from '../ui/src/components/ContextMeter.tsx';

const props = {
  workspaceId: null, sessionId: null, draft: false, busy: false, refreshing: false,
  revision: 0, modelSaving: false, modelKey: '', locale: 'en' as const,
};

describe('context meter', () => {
  it('exposes an accessible dialog trigger without a visible percentage', () => {
    const markup = renderToStaticMarkup(createElement(ContextMeter, props));
    expect(markup).toContain('aria-label="Context usage unknown"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('title=');
    expect(markup).not.toMatch(/>\s*\d+%\s*</);
  });

  it('uses an opaque surface and a circular hollow ring', () => {
    const css = readFileSync(new URL('../ui/src/styles/dsh/input-bar.module.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.contextPanel\s*\{[^}]*background:\s*var\(--dsw-alias-bg-layer-1\)/);
    expect(css).toMatch(/\.contextPanel\s*\{[^}]*width:\s*min\(300px,\s*calc\(100vw - 24px\)\)/);
    expect(css).toMatch(/\.contextMeter::before\s*\{[^}]*corner-shape:\s*round/);
    expect(css).toMatch(/\.contextMeter::before\s*\{[^}]*mask:\s*radial-gradient\(circle,\s*transparent/);
  });
});
