import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  IconChevronUpOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconRefreshOutlineRegular,
  Input,
} from '../../vendor/primitives/index.ts';
import { translate, translator, type Locale, type Translate } from '../lib/i18n.ts';
import { useApp } from '../lib/store.ts';
import { fetchDirectoryListing, type DirectoryListing, type DirectoryRoot } from '../lib/wire.ts';
import css from '../styles/directory-picker.module.css';

/**
 * Folder chooser for the "add workspace" flow.
 *
 * The web UI cannot read absolute paths on its own, so the host lists one level
 * at a time (`/api/fs/directories`). The user walks down by activating a row,
 * returns with the `..` row at the top of the list, short-cuts to a well-known
 * folder, or jumps straight to a typed path.
 */

type Status = 'loading' | 'ready' | 'error';

const ROOT_LABELS: Record<DirectoryRoot['id'], string> = {
  home: 'Home',
  desktop: 'Desktop',
  documents: 'Documents',
  downloads: 'Downloads',
  root: 'Filesystem root',
};

/** String-level parent, used when the host could not list the level at all. */
function parentOf(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? null : trimmed.slice(0, index);
}

function useDirectories(path: string | null, locale: Locale): {
  status: Status; listing: DirectoryListing | null; error: string; reload: () => void;
} {
  const [status, setStatus] = useState<Status>('loading');
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setError('');
    void fetchDirectoryListing(path, controller.signal)
      .then((body) => {
        if (controller.signal.aborted) return;
        setListing(body);
        setStatus('ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // Never keep a stale level on screen: an unreadable path must look empty,
        // not like a folder whose contents are simply out of date.
        setListing(null);
        setStatus('error');
        setError(translate(locale, 'Could not list this folder.'));
      });
    return () => { controller.abort(); };
    // A translator is a fresh closure per render, so the locale is the stable dependency.
  }, [path, attempt, locale]);
  const reload = useCallback(() => { setAttempt((value) => value + 1); }, []);
  return { status, listing, error, reload };
}

/**
 * Walk the filesystem and report the folder the user is standing in.
 * Navigation state lives here; the owner only observes `onPathChange`, which
 * keeps the selected folder in one place instead of two competing sources.
 * @param props.initialPath - absolute folder to open first; omitted starts at home.
 * @param props.onPathChange - receives the canonical path of every level reached.
 * @param props.disabled - blocks navigation while the owner is saving.
 * @param props.t - locale translator; defaults to the app locale.
 */
export function DirectoryPicker({ initialPath, onPathChange, disabled = false, t: tProp }: {
  initialPath?: string | undefined;
  onPathChange?: ((path: string) => void) | undefined;
  disabled?: boolean;
  t?: Translate;
}): ReactNode {
  const app = useApp();
  const t = tProp ?? translator(app.locale);
  const [path, setPath] = useState<string | null>(initialPath ?? null);
  const [draft, setDraft] = useState(initialPath ?? '');
  const [showHidden, setShowHidden] = useState(false);
  const { status, listing, error, reload } = useDirectories(path, app.locale);

  // Report the level actually reached, including the canonical path the host
  // resolved for the first (pathless) listing.
  const report = useRef(onPathChange);
  report.current = onPathChange;
  const resolved = listing?.path;
  useEffect(() => {
    if (resolved === undefined) return;
    setDraft(resolved);
    report.current?.(resolved);
  }, [resolved]);

  const navigate = useCallback((next: string | null) => {
    setPath(next);
    if (next !== null) setDraft(next);
  }, []);

  const entries = listing?.entries ?? [];
  const visible = useMemo(() => entries.filter((entry) => showHidden || !entry.hidden), [entries, showHidden]);
  const hiddenCount = useMemo(() => entries.filter((entry) => entry.hidden).length, [entries]);

  const submitDraft = (): void => {
    const trimmed = draft.trim();
    if (trimmed === '') return;
    if (trimmed === (listing?.path ?? '')) { reload(); return; }
    navigate(trimmed);
  };

  // While a level loads there is nothing to go up *from* yet; when it failed to
  // load, `..` still escapes the unreadable path instead of trapping the user.
  const parent = status === 'loading' ? null : listing?.parent ?? (path === null ? null : parentOf(path));
  return (
    <div className={css.root}>
      <div className={css.shortcuts} role="group" aria-label={t('Quick locations')}>
        {(listing?.roots ?? []).map((root) => (
          <button
            key={root.id}
            type="button"
            className={clsx(css.shortcut, listing?.path === root.path && css.shortcutActive)}
            title={root.path}
            disabled={disabled}
            onClick={() => { navigate(root.path); }}
          >
            <IconFolderOpenRegular size={14} />
            <span>{t(ROOT_LABELS[root.id])}</span>
          </button>
        ))}
      </div>

      <div className={css.pathBar}>
        <Input
          className={css.pathInput}
          data-modal-autofocus
          value={draft}
          spellCheck={false}
          aria-label={t('Folder path')}
          placeholder={t('Folder path')}
          disabled={disabled}
          onChange={(event) => { setDraft(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submitDraft();
          }}
        />
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('Refresh')}
          title={t('Refresh')}
          disabled={disabled}
          onClick={reload}
        >
          <IconRefreshOutlineRegular size={16} />
        </button>
      </div>

      {/* Buttons in a group rather than listbox options: rows navigate, they
          never hold a selection, so the listbox role would misdescribe them. */}
      <div className={css.list} role="group" aria-label={t('Folders')}>
        <button
          type="button"
          aria-label={t('Up one level')}
          className={clsx(css.row, css.parentRow)}
          title={parent ?? undefined}
          disabled={disabled || parent === null}
          onClick={() => { if (parent !== null) navigate(parent); }}
        >
          <IconChevronUpOutlineRegular size={15} />
          <span className={css.rowName}>..</span>
        </button>

        {status === 'loading' && <div className={css.note} role="status">{t('Loading folders…')}</div>}
        {status === 'error' && (
          <div className={css.note} role="alert">
            {error}
            <button type="button" className={css.retry} onClick={reload}>{t('Retry')}</button>
          </div>
        )}
        {status === 'ready' && visible.length === 0 && <div className={css.note}>{t('No subfolders here.')}</div>}
        {status === 'ready' && visible.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={css.row}
            title={entry.path}
            disabled={disabled}
            onClick={() => { navigate(entry.path); }}
          >
            <IconFolderCloseRegular size={15} />
            <span className={css.rowName}>{entry.name}</span>
          </button>
        ))}
      </div>

      <div className={css.footer}>
        {hiddenCount > 0 && (
          <button
            type="button"
            className={css.toggle}
            disabled={disabled}
            onClick={() => { setShowHidden((value) => !value); }}
          >
            {showHidden ? t('Hide hidden folders') : t('Show hidden folders')}
          </button>
        )}
        {listing?.truncated === true && <span className={css.note}>{t('Directory listing truncated.')}</span>}
      </div>
    </div>
  );
}
