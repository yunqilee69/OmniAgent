/** Audio and video preview: native players on the ranged raw route. */
import type { ReactNode } from 'react';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { PreviewBar, PreviewBarLabel, PreviewChip } from '../PreviewChrome.tsx';
import { filenameOf, previewKindFor } from '../path.ts';
import type { ViewerProps } from '../types.ts';
import css from '../../../styles/preview.module.css';

export function MediaViewer({ path, url }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  const name = filenameOf(path);
  const video = previewKindFor(path) === 'video';
  if (url === undefined) return null;
  return (
    <>
      <PreviewBar>
        <PreviewBarLabel>{video ? t('Video') : t('Audio')}</PreviewBarLabel>
        <span className={css.toolbarSpacer} />
        <PreviewChip>{video ? 'video' : 'audio'}</PreviewChip>
      </PreviewBar>
      <div className={css.stagePlain}>
        <div className={css.media}>
          {video
            ? <video src={url} controls playsInline preload="metadata" aria-label={name} />
            : <audio src={url} controls preload="metadata" aria-label={name} />}
        </div>
      </div>
    </>
  );
}
