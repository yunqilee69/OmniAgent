/**
 * Word preview: the block model from `office/docx.ts` rendered with the app's
 * own typography. Structure (headings, lists, tables, alignment) is preserved;
 * page layout, floating shapes, and themes are not — this is a reading view,
 * and the download action is one click away for the real thing.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { PreviewBar, PreviewBarLabel, PreviewChip } from '../PreviewChrome.tsx';
import { readDocx, type DocxPreview } from '../office/docx.ts';
import { supportsZipPreview } from '../office/zip.ts';
import { filenameOf, formatBytes } from '../path.ts';
import type { ViewerProps } from '../types.ts';
import css from '../../../styles/preview.module.css';

type DocState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; doc: DocxPreview } | { status: 'error'; message: string };

const ALIGN: Readonly<Record<string, string>> = { center: 'center', right: 'right', end: 'right', justify: 'justify' };

export function DocxViewer({ path, bytes }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  const [state, setState] = useState<DocState>({ status: 'idle' });

  useEffect(() => {
    if (bytes === undefined) return;
    if (!supportsZipPreview()) {
      setState({ status: 'error', message: 'This browser cannot unpack Office files.' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    void readDocx(bytes)
      .then((doc) => { if (!cancelled) setState({ status: 'ready', doc }); })
      .catch((error: Error) => { if (!cancelled) setState({ status: 'error', message: error.message }); });
    return () => { cancelled = true; };
  }, [bytes]);

  return (
    <>
      <PreviewBar>
        <PreviewBarLabel>{t('Word document')}</PreviewBarLabel>
        {bytes !== undefined && <PreviewChip>{formatBytes(bytes.byteLength)}</PreviewChip>}
        <span className={css.toolbarSpacer} />
      </PreviewBar>
      {state.status === 'loading' && <div className={css.status} role="status">{t('Reading document…')}</div>}
      {state.status === 'error' && <div className={css.status} role="alert">{t(state.message)}</div>}
      {state.status === 'ready' && (
        <div className={css.document}>
          {state.doc.blocks.map((block, index) => {
            if (block.kind === 'heading') {
              const Tag = `h${Math.min(6, block.depth)}` as 'h1';
              return <Tag key={index} className={css.docHeading}>{block.text}</Tag>;
            }
            if (block.kind === 'table') {
              return (
                <table key={index} className={css.docTable}>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            }
            return (
              <p
                key={index}
                className={block.list ? css.docListItem : css.docParagraph}
                style={block.align === undefined ? undefined : { textAlign: (ALIGN[block.align] ?? 'left') as 'left' }}
              >
                {block.text}
              </p>
            );
          })}
          {(state.doc.truncated || state.doc.images > 0) && (
            <div className={css.notice}>
              {state.doc.truncated && <>{t('Showing the first part of this document.')} </>}
              {state.doc.images > 0 && t('{count} embedded images are not shown.', { count: state.doc.images })}
            </div>
          )}
        </div>
      )}
    </>
  );
}
