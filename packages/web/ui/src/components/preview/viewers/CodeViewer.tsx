/**
 * Source preview: shiki tokens through the shared lazy highlighter, a numbered
 * gutter, soft wrap, and an optional line reveal for `path:line` references.
 * Very long files drop highlighting (not the text) so opening a 20k-line log
 * stays responsive.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { IconWrapLinesOutlineRegular } from '../../../../vendor/primitives/index.ts';
import { languageForPath, useCodeHighlighter } from '../../../../vendor/primitives/code-highlighting.ts';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { PreviewAction, PreviewBar, PreviewBarLabel, PreviewChip } from '../PreviewChrome.tsx';
import type { ViewerProps } from '../types.ts';
import { useWrapPreference } from './wrap.ts';
import css from '../../../styles/preview.module.css';

/** Past this many lines the gutter and text stay, the tokenizer stands down. */
const MAX_HIGHLIGHT_LINES = 3000;

export function CodeViewer({ path, text = '', line }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  const [wrap, toggleWrap] = useWrapPreference();
  const language = languageForPath(path);
  const highlight = useCodeHighlighter(language);
  const lines = useMemo(() => text.split('\n'), [text]);
  const tooLong = lines.length > MAX_HIGHLIGHT_LINES;
  const tokens = useMemo(() => (tooLong ? undefined : highlight(text)), [highlight, text, tooLong]);
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (line === undefined) return;
    activeRef.current?.scrollIntoView({ block: 'center' });
  }, [line, text]);

  return (
    <>
      <PreviewBar>
        <PreviewBarLabel>{t('{count} lines', { count: lines.length })}</PreviewBarLabel>
        <span className={css.toolbarSpacer} />
        {language !== undefined && <PreviewChip>{language}</PreviewChip>}
        <PreviewAction label={wrap ? t('Unwrap lines') : t('Wrap lines')} pressed={wrap} onClick={toggleWrap}>
          <IconWrapLinesOutlineRegular size={15} />
        </PreviewAction>
      </PreviewBar>
      {tooLong && <div className={css.notice}>{t('Highlighting disabled for large files')}</div>}
      <div className={css.code} data-wrap={wrap ? 'on' : 'off'}>
        {lines.map((content, index) => {
          const spans = tokens?.[index];
          const active = line !== undefined && index === line - 1;
          return (
            <div
              key={index}
              ref={active ? activeRef : undefined}
              className={`${css.codeLine} ${wrap ? css.codeLineWrap : ''}`}
              data-active={active || undefined}
            >
              <span className={css.lineNumber} aria-hidden>{index + 1}</span>
              <span className={css.codeText}>
                {spans === undefined
                  ? (content === '' ? '\u200b' : content)
                  : spans.map((span, spanIndex) => (
                    <span key={spanIndex} style={span.style}>{span.text}</span>
                  ))}
                {spans !== undefined && content === '' ? '\u200b' : null}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
