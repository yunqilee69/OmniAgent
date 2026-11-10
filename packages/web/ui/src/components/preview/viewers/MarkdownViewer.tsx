/**
 * Markdown preview over the same renderer the transcript uses, so a README
 * looks identical to an assistant reply. Relative image destinations resolve
 * through the raw route, and the rendered headings feed a table of contents.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MarkdownText } from '../../../../vendor/primitives/index.ts';
import { markdownLabels } from '../../../lib/labels.ts';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { absoluteUrl, rawFileUrl } from '../resource.ts';
import { directoryOf, resolveRelativePath } from '../path.ts';
import type { ViewerProps } from '../types.ts';
import css from '../../../styles/preview.module.css';

interface Heading { id: string; depth: number; text: string }

/** Heading ids must exist before the first paint on the client, but not during a server render. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function MarkdownViewer({ workspaceId, path, text = '' }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  const labels = useMemo(() => markdownLabels(t), [t]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const directory = directoryOf(path);

  const pathImages = useMemo(() => ({
    resolve: (destination: string) => {
      const joined = resolveRelativePath(directory, destination);
      return joined === undefined ? undefined : absoluteUrl(rawFileUrl(workspaceId, joined));
    },
  }), [directory, workspaceId]);

  useIsomorphicLayoutEffect(() => {
    const root = bodyRef.current;
    if (root === null) { setHeadings([]); return; }
    const nodes = root.querySelectorAll<HTMLElement>('h1, h2, h3');
    const next: Heading[] = [];
    nodes.forEach((node, index) => {
      const id = `preview-heading-${index}`;
      node.id = id;
      const text = (node.textContent ?? '').trim();
      if (text !== '') next.push({ id, depth: Number(node.tagName.slice(1)), text });
    });
    setHeadings(next);
  }, [text]);

  const jump = useCallback((id: string) => {
    bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <div className={css.markdownWrap}>
      <div className={css.markdownBody} ref={bodyRef}>
        <MarkdownText text={text} labels={labels} pathImages={pathImages} omitHtml />
      </div>
      {headings.length > 1 && (
        <nav className={css.toc} aria-label={t('Table of contents')}>
          <div className={css.tocTitle}>{t('Table of contents')}</div>
          {headings.map((heading) => (
            <button
              key={heading.id}
              type="button"
              className={css.tocLink}
              data-depth={heading.depth}
              title={heading.text}
              onClick={() => { jump(heading.id); }}
            >
              {heading.text}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
