/** Shared chrome for every file viewer: toolbars and settled states. */
import type { ReactNode } from 'react';
import { FileTypeIcon, IconDownloadOutlineRegular, IconRefreshOutlineRegular, IconRightUpOutlineRegular, Tooltip } from '../../../vendor/primitives/index.ts';
import { translator } from '../../lib/i18n.ts';
import { useApp } from '../../lib/store.ts';
import css from '../../styles/preview.module.css';

/** One icon action in a viewer toolbar. */
export function PreviewAction({ label, onClick, pressed, disabled, children }: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <Tooltip label={label} side="bottom" delayMs={400} disabled={disabled === true}>
      <button
        type="button"
        className={css.iconButton}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Viewer toolbar row; viewers render their own controls inside it. */
export function PreviewBar({ children }: { children: ReactNode }): ReactNode {
  return <div className={css.toolbar} role="toolbar">{children}</div>;
}

/** Static label inside a viewer toolbar. */
export function PreviewBarLabel({ children }: { children: ReactNode }): ReactNode {
  return <span className={css.toolbarLabel}>{children}</span>;
}

/** Small pill for counts and sizes. */
export function PreviewChip({ children }: { children: ReactNode }): ReactNode {
  return <span className={css.chip}>{children}</span>;
}

/** Loading placeholder; three bars keep the panel from jumping when the body lands. */
export function PreviewSkeleton(): ReactNode {
  const t = translator(useApp().locale);
  return (
    <div className={css.skeleton} role="status" aria-busy="true" aria-label={t('Loading file…')}>
      <span className={`${css.bar} ${css.barWide}`} />
      <span className={`${css.bar} ${css.barMedium}`} />
      <span className={`${css.bar} ${css.barNarrow}`} />
    </div>
  );
}

/** Failure state with one retry affordance. */
export function PreviewFailure({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  const t = translator(useApp().locale);
  return (
    <div className={css.status} role="alert">
      <span>{t(message)}</span>
      <span className={css.statusActions}>
        <button type="button" className={css.textButton} onClick={onRetry}>
          <IconRefreshOutlineRegular size={13} /> {t('Retry')}
        </button>
      </span>
    </div>
  );
}

/**
 * Settled state for a file this client cannot render: name the type, say why,
 * and offer the two exits that always work (download, open in a new tab).
 */
export function PreviewUnsupported({ path, reason, size, onDownload, onOpen }: {
  path: string;
  reason: string;
  size?: string;
  onDownload: () => void;
  onOpen: () => void;
}): ReactNode {
  const t = translator(useApp().locale);
  return (
    <div className={css.empty}>
      <FileTypeIcon path={path} size={40} />
      <span className={css.emptyTitle}>{t('Cannot preview this file type')}</span>
      <span className={css.emptyBody}>
        {t(reason)}
        {size !== undefined && <> · {size}</>}
      </span>
      <span className={css.statusActions}>
        <button type="button" className={css.textButton} onClick={onDownload}>
          <IconDownloadOutlineRegular size={13} /> {t('Download')}
        </button>
        <button type="button" className={css.textButton} onClick={onOpen}>
          <IconRightUpOutlineRegular size={13} /> {t('Open in new tab')}
        </button>
      </span>
    </div>
  );
}
