import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ICON_SYMBOLS, type IconSymbolId } from '../vendor/primitives/icons/artwork.ts';
import { App } from './app.tsx';
import './styles/global.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DROPPED_ATTRIBUTES = new Set(['width', 'height', 'xmlns', 'class', 'aria-hidden']);

/** Mount the copied DSH product-icon sprite once for the whole document. */
function mountIconSprite(): void {
  const sprite = document.createElementNS(SVG_NS, 'svg');
  sprite.setAttribute('aria-hidden', 'true');
  sprite.setAttribute('data-dsh-icon-sprite', '');
  sprite.classList.add('dsh-icon-sprite');
  for (const [id, markup] of Object.entries(ICON_SYMBOLS) as [IconSymbolId, string][]) {
    const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    const symbol = document.createElementNS(SVG_NS, 'symbol');
    for (const { name, value } of root.attributes) {
      if (!DROPPED_ATTRIBUTES.has(name)) symbol.setAttribute(name, value);
    }
    symbol.id = id;
    symbol.append(...[...root.childNodes].map((node) => document.importNode(node, true)));
    sprite.append(symbol);
  }
  document.body.prepend(sprite);
}

function applyInitialTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('omniagent.theme');
  } catch {
    // Storage can be unavailable in private contexts; fall back to the OS.
  }
  const dark = stored === 'dark' || (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.toggleAttribute('data-ds-dark-theme', dark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

applyInitialTheme();
try {
  document.documentElement.lang = localStorage.getItem('omniagent.locale') === 'en' ? 'en' : 'zh-CN';
} catch {
  document.documentElement.lang = 'zh-CN';
}
mountIconSprite();
createRoot(document.getElementById('root')!).render(createElement(App));
