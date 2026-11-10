/**
 * Conservative HTML sanitizer for the rendered preview of `.html` files.
 *
 * The workspace document is untrusted input, so this keeps a reading-oriented
 * tag set, drops every script, frame, form, and event handler, and rewrites
 * relative images to the raw route. `all: initial` on the container plus this
 * allowlist means a hostile file can at worst look wrong — it cannot execute,
 * navigate the app, or reposition chrome.
 */

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'center',
  'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li',
  'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strike',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u',
  'ul', 'var', 'wbr',
]);

const ALLOWED_ATTRIBUTES = new Set([
  'alt', 'colspan', 'height', 'href', 'rowspan', 'span', 'src', 'start', 'style', 'title', 'width',
]);

/** Elements whose whole subtree is dropped, including their text. */
const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input',
  'button', 'select', 'option', 'textarea', 'link', 'meta', 'base', 'noscript', 'template', 'svg', 'math',
]);

function safeUrl(value: string, kind: 'link' | 'image'): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  // Control characters are how `java\nscript:` slips past a naive prefix check.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  if (/^(?:https?:|mailto:|data:image\/|blob:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return undefined;
  if (kind === 'link') return trimmed;
  return trimmed;
}

function sanitizeStyle(value: string): string | undefined {
  const kept = value
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== '' && !/^(?:position|z-index|inset|top|left|right|bottom)\s*:/i.test(declaration))
    .filter((declaration) => !/expression\s*\(|javascript:/i.test(declaration));
  return kept.length === 0 ? undefined : kept.join('; ');
}

export interface SanitizeOptions {
  /** Rewrite one authored image source; returns undefined to drop the image. */
  resolveImage?: (source: string) => string | undefined;
  /** Rewrite one authored link target; returns undefined to leave it as plain text. */
  resolveLink?: (href: string) => string | undefined;
}

/**
 * Sanitize one HTML document body.
 * @param source - the authored file body.
 * @param options - resolvers for relative image sources and links.
 * @returns a sanitized fragment, or undefined when the body cannot be parsed.
 */
export function sanitizeHtml(source: string, options: SanitizeOptions = {}): string | undefined {
  const document = new DOMParser().parseFromString(source, 'text/html');
  if (document.body === null) return undefined;
  const target = document.implementation.createHTMLDocument('preview');
  const container = target.createElement('div');

  const copy = (node: Node, into: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        into.appendChild(target.createTextNode(child.textContent ?? ''));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      const name = element.tagName.toLowerCase();
      if (DROPPED_TAGS.has(name)) continue;
      if (!ALLOWED_TAGS.has(name)) {
        // Unknown wrappers keep their text but lose their markup.
        copy(element, into);
        continue;
      }
      const created = target.createElement(name);
      for (const attribute of Array.from(element.attributes)) {
        const key = attribute.name.toLowerCase();
        if (!ALLOWED_ATTRIBUTES.has(key)) continue;
        if (key === 'href') {
          const href = safeUrl(attribute.value, 'link');
          const rewritten = href === undefined ? undefined : (options.resolveLink?.(href) ?? href);
          if (rewritten !== undefined) created.setAttribute('href', rewritten);
          continue;
        }
        if (key === 'src') {
          const src = safeUrl(attribute.value, 'image');
          const rewritten = src === undefined ? undefined : options.resolveImage?.(src);
          if (rewritten !== undefined) created.setAttribute('src', rewritten);
          continue;
        }
        if (key === 'style') {
          const style = sanitizeStyle(attribute.value);
          if (style !== undefined) created.setAttribute('style', style);
          continue;
        }
        created.setAttribute(key, attribute.value);
      }
      into.appendChild(created);
      copy(element, created);
    }
  };

  copy(document.body, container);
  return container.innerHTML;
}
