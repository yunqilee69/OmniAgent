/**
 * Image and SVG preview. The browser loads the file straight from the raw
 * route, so a 20 MP photo costs no JavaScript heap; clicking opens the
 * vendored lightbox, and the toolbar toggles fit-width against actual size.
 */
import { useState, type ReactNode } from 'react';
import { IconSearchOutlineRegular } from '../../../../vendor/primitives/index.ts';
import { ImageLightbox } from '../../../../vendor/primitives/index.ts';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { PreviewAction, PreviewBar, PreviewBarLabel, PreviewChip } from '../PreviewChrome.tsx';
import { filenameOf } from '../path.ts';
import type { ViewerProps } from '../types.ts';
import css from '../../../styles/preview.module.css';

export function ImageViewer({ path, url }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  const [open, setOpen] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const [loaded, setLoaded] = useState<{ width: number; height: number } | undefined>(undefined);
  const name = filenameOf(path);
  if (url === undefined) return null;
  return (
    <>
      <PreviewBar>
        <PreviewBarLabel>{t('Image')}</PreviewBarLabel>
        {loaded !== undefined && (
          <PreviewChip>{`${loaded.width} × ${loaded.height}`}</PreviewChip>
        )}
        <span className={css.toolbarSpacer} />
        <PreviewAction
          label={actualSize ? t('Fit width') : t('Actual size')}
          pressed={actualSize}
          onClick={() => { setActualSize((value) => !value); }}
        >
          <IconSearchOutlineRegular size={15} />
        </PreviewAction>
      </PreviewBar>
      <div className={css.stage}>
        <button
          type="button"
          className={css.imageButton}
          title={t('Open original')}
          onClick={() => { setOpen(true); }}
        >
          <img
            className={css.image}
            src={url}
            alt={name}
            decoding="async"
            style={actualSize ? { maxWidth: 'none', maxHeight: 'none' } : undefined}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0) setLoaded({ width: naturalWidth, height: naturalHeight });
            }}
          />
        </button>
      </div>
      {open && (
        <ImageLightbox
          src={url}
          alt={name}
          labels={{ dialog: t('Image preview'), close: t('Close') }}
          onClose={() => { setOpen(false); }}
        />
      )}
    </>
  );
}
