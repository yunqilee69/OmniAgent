/** Plain-text preview: monospace body with a shared wrap preference. */
import type { ReactNode } from 'react';
import { IconWrapLinesOutlineRegular } from '../../../../vendor/primitives/index.ts';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { PreviewAction, PreviewBar, PreviewBarLabel, PreviewChip } from '../PreviewChrome.tsx';
import type { ViewerProps } from '../types.ts';
import { useWrapPreference } from './wrap.ts';
import css from '../../../styles/preview.module.css';

/** Line count shown as a chip; the body itself is never truncated. */
function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

export function TextViewer({ text = '' }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  const [wrap, toggleWrap] = useWrapPreference();
  return (
    <>
      <PreviewBar>
        <PreviewBarLabel>{t('{count} lines', { count: countLines(text) })}</PreviewBarLabel>
        <span className={css.toolbarSpacer} />
        <PreviewChip>{t('Text')}</PreviewChip>
        <PreviewAction label={wrap ? t('Unwrap lines') : t('Wrap lines')} pressed={wrap} onClick={toggleWrap}>
          <IconWrapLinesOutlineRegular size={15} />
        </PreviewAction>
      </PreviewBar>
      <pre className={css.plainText} data-wrap={wrap ? 'on' : 'off'} style={wrap ? undefined : { whiteSpace: 'pre' }}>
        {text}
      </pre>
    </>
  );
}
