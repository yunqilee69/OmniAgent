/**
 * PDF preview through the browser's own viewer.
 *
 * Shipping pdf.js would buy a canvas and a custom toolbar, at the cost of a
 * ~130 kB chunk, a worker, and CJK font maps. A same-origin frame keeps text
 * selection, search, printing, and fill-in forms for free, and costs the app
 * one CSP directive (`frame-src 'self'`). The trade is deliberate: the page
 * chrome belongs to the browser, everything around it belongs to this panel.
 */
import type { ReactNode } from 'react';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { PreviewBar, PreviewBarLabel, PreviewChip } from '../PreviewChrome.tsx';
import { filenameOf } from '../path.ts';
import type { ViewerProps } from '../types.ts';
import css from '../../../styles/preview.module.css';

export function PdfViewer({ path, url }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  const name = filenameOf(path);
  if (url === undefined) return null;
  return (
    <div className={css.fill}>
      <PreviewBar>
        <PreviewBarLabel>{t('PDF')}</PreviewBarLabel>
        <span className={css.toolbarSpacer} />
        <PreviewChip>{t('Rendered by your browser')}</PreviewChip>
      </PreviewBar>
      <iframe
        className={css.frame}
        src={`${url}#view=FitH`}
        title={t('Preview of {name}', { name })}
      />
    </div>
  );
}
