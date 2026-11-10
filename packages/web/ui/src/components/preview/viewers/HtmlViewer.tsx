/**
 * HTML preview with two modes: the highlighted source, and a rendered view
 * through `html/sanitize.ts`. There is no sandboxed iframe here on purpose —
 * `srcdoc` and `blob:` frames inherit this document's CSP, so they would render
 * unstyled and scriptless anyway; sanitizing into our own tree keeps the type
 * scale and the theme while staying inert.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { PreviewBar, PreviewBarLabel, PreviewChip } from '../PreviewChrome.tsx';
import { sanitizeHtml } from '../html/sanitize.ts';
import { directoryOf, filenameOf, resolveRelativePath } from '../path.ts';
import { absoluteUrl, rawFileUrl } from '../resource.ts';
import type { ViewerProps } from '../types.ts';
import { CodeViewer } from './CodeViewer.tsx';
import css from '../../../styles/preview.module.css';

export function HtmlViewer({ workspaceId, path, text = '' }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  const [rendered, setRendered] = useState(false);
  const directory = directoryOf(path);
  const sanitized = useMemo(() => {
    if (!rendered || typeof DOMParser === 'undefined') return undefined;
    return sanitizeHtml(text, {
      resolveImage: (source) => {
        if (/^(?:https?:|data:|blob:)/i.test(source)) return source;
        const joined = resolveRelativePath(directory, source);
        return joined === undefined ? undefined : absoluteUrl(rawFileUrl(workspaceId, joined));
      },
    });
  }, [rendered, text, directory, workspaceId]);

  return (
    <>
      <PreviewBar>
        <PreviewBarLabel>{t('HTML')}</PreviewBarLabel>
        {rendered && <PreviewChip>{t('Sanitized preview')}</PreviewChip>}
        <span className={css.toolbarSpacer} />
        <button type="button" className={css.textButton} aria-pressed={rendered} onClick={() => { setRendered((value) => !value); }}>
          {rendered ? t('Source') : t('Rendered')}
        </button>
      </PreviewBar>
      {rendered
        ? (
          <div
            className={css.htmlRender}
            title={filenameOf(path)}
            // Sanitized above: only allowlisted tags and attributes survive, and CSP still blocks scripts.
            dangerouslySetInnerHTML={{ __html: sanitized ?? '' }}
          />
        )
        : <CodeViewer workspaceId={workspaceId} path={path} text={text} />}
    </>
  );
}
