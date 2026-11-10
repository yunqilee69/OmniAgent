/** JSON preview: the vendored inspector tree, with a raw-source fallback for invalid JSON. */
import { useMemo, type ReactNode } from 'react';
import { JsonTree } from '../../../../vendor/primitives/index.ts';
import { jsonTreeLabels } from '../../../lib/labels.ts';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { PreviewBar, PreviewBarLabel, PreviewChip } from '../PreviewChrome.tsx';
import { filenameOf } from '../path.ts';
import type { ViewerProps } from '../types.ts';
import css from '../../../styles/preview.module.css';

export function JsonViewer({ path, text = '' }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  const labels = useMemo(() => jsonTreeLabels(t), [t]);
  const parsed = useMemo<{ value: object | unknown[] } | { error: true }>(() => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null ? { value: value as object | unknown[] } : { error: true };
    } catch {
      return { error: true };
    }
  }, [text]);
  return (
    <>
      <PreviewBar>
        <PreviewBarLabel>{t('JSON')}</PreviewBarLabel>
        <span className={css.toolbarSpacer} />
        {'error' in parsed ? <PreviewChip>{t('Invalid JSON')}</PreviewChip> : <PreviewChip>JSON</PreviewChip>}
      </PreviewBar>
      {'error' in parsed
        ? <pre className={css.plainText}>{text}</pre>
        : <div className={css.jsonWrap}><JsonTree data={parsed.value} label={filenameOf(path)} labels={labels} /></div>}
    </>
  );
}
