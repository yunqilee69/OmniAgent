import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  GuideArtworkFiles,
  IconChevronLeftOutlineRegular,
  IconCompareSplitOutlineRegular,
  IconDatabaseOutlineRegular,
  IconDownloadOutlineRegular,
  IconFolderCloseRegular,
  IconFullscreenOutlineRegular,
  IconLightOutlineRegular,
  IconPaperclipOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineRegular,
  Menu,
  PluginArtworkTerminal,
  Tooltip,
  type MenuEntry,
} from '../../vendor/primitives/index.ts';
import { store, useApp } from '../lib/store.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { workspaceApiPath, type WorkspaceFileEntry } from '../lib/wire.ts';
import css from '../styles/dsh/right-panel.module.css';

type RightView = 'guide' | 'files' | 'terminal';

function CompassGlyph({ size = 16, className }: { size?: number; className?: string }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z" stroke="currentColor" />
      <path d="M10.6101 5.39014L8.99014 8.99014L5.39014 10.6101L7.01014 7.01014L10.6101 5.39014Z" fill="currentColor" />
    </svg>
  );
}

/** Four-tile artwork used only by the guide's More tools card. */
function MoreToolsGlyph(): ReactNode {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.38181">
      <path d="M5.45873 5.04102H7.90157C8.57615 5.04102 9.123 5.58787 9.123 6.26244V8.70528C9.123 9.37986 8.57615 9.92671 7.90157 9.92671H5.45873C4.78415 9.92671 4.2373 9.37986 4.2373 8.70528V6.26244C4.2373 5.58787 4.78415 5.04102 5.45873 5.04102Z" />
      <path d="M5.45873 12.9805H7.90157C8.57615 12.9805 9.123 13.5273 9.123 14.2019V16.6447C9.123 17.3193 8.57615 17.8662 7.90157 17.8662H5.45873C4.78415 17.8662 4.2373 17.3193 4.2373 16.6447V14.2019C4.2373 13.5273 4.78415 12.9805 5.45873 12.9805Z" />
      <path d="M13.3992 12.9805H15.842C16.5166 12.9805 17.0634 13.5273 17.0634 14.2019V16.6447C17.0634 17.3193 16.5166 17.8662 15.842 17.8662H13.3992C12.7246 17.8662 12.1777 17.3193 12.1777 16.6447V14.2019C12.1777 13.5273 12.7246 12.9805 13.3992 12.9805Z" />
      <path d="M15.0692 3.86523V6.91879M15.0692 6.91879V9.97235M15.0692 6.91879H12.0156M15.0692 6.91879H18.1227" />
    </svg>
  );
}

function viewTitle(view: RightView, t: Translate): string {
  if (view === 'files') return t('Workspace files');
  if (view === 'terminal') return t('Terminal');
  return t('Start');
}

interface EntryCardProps {
  icon: ReactNode;
  title: string;
  description?: string;
  onClick: () => void;
}

function EntryCard({ icon, title, description, onClick }: EntryCardProps): ReactNode {
  return (
    <div className={css.entryCell}>
      <button type="button" className={css.entry} onClick={onClick}>
        <span className={css.entryIcon}>{icon}</span>
        <span className={css.entryText}>
          <span className={css.entryTitle}>{title}</span>
          {description !== undefined && <span className={css.entryDescription}>{description}</span>}
        </span>
      </button>
    </div>
  );
}

export function RightPanel({ fullscreen, onClose, onToggleFullscreen }: {
  fullscreen: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
}): ReactNode {
  const app = useApp();
  const t = useMemo(() => translator(app.locale), [app.locale]);
  const [view, setView] = useState<RightView>('guide');
  const [directory, setDirectory] = useState('');
  const [search, setSearch] = useState('');
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState('');
  const [copied, setCopied] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const moreAnchor = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setView('guide');
    setDirectory('');
    setSearch('');
    setCopied('');
  }, [app.workspaceId, app.sessionId]);

  useEffect(() => {
    if (view !== 'files' || app.workspaceId === null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setFilesLoading(true);
      setFilesError('');
      const query = `${directory}${search}`;
      const params = new URLSearchParams({ query, limit: '50' });
      void fetch(workspaceApiPath(app.workspaceId!, `files?${params.toString()}`), { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(t('Request failed ({status}).', { status: response.status }));
          return await response.json() as { entries?: unknown };
        })
        .then((body) => {
          if (controller.signal.aborted) return;
          setFiles(Array.isArray(body.entries)
            ? body.entries.filter((item): item is WorkspaceFileEntry =>
              typeof item === 'object' && item !== null
              && typeof (item as WorkspaceFileEntry).path === 'string'
              && typeof (item as WorkspaceFileEntry).name === 'string'
              && ((item as WorkspaceFileEntry).kind === 'file' || (item as WorkspaceFileEntry).kind === 'directory'))
            : []);
          setFilesLoading(false);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setFiles([]);
          setFilesLoading(false);
          setFilesError(t('Failed to load workspace files: {message}', { message: (error as Error).message }));
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [view, app.workspaceId, directory, search, t]);

  const openDirectory = (entry: WorkspaceFileEntry): void => {
    setDirectory(`${entry.path}/`);
    setSearch('');
    setCopied('');
  };

  const copyPath = (entry: WorkspaceFileEntry): void => {
    void navigator.clipboard?.writeText(entry.path).catch(() => undefined);
    setCopied(entry.path);
  };

  const moreItems = useMemo<MenuEntry[]>(() => [
    { id: 'settings', label: t('Settings'), icon: <IconSettingsOutlineRegular /> },
    { id: 'export', label: t('Export session'), icon: <IconDownloadOutlineRegular /> },
    { type: 'separator', id: 'theme-separator' },
    { id: 'theme', label: app.theme === 'dark' ? t('Light theme') : t('Dark theme'), icon: <IconLightOutlineRegular /> },
  ], [app.theme, t]);

  const crumb = directory === '' ? t('Workspace') : directory.replace(/\/$/, '');

  return (
    <aside className={clsx(css.root, fullscreen && css.fullscreen)} aria-label={t('Start')} data-right-panel="">
      <div className={css.tabStrip}>
        <div className={css.stripTabs}>
          <button type="button" className={css.tab} onClick={() => { setView('guide'); }}>
            <CompassGlyph size={14} className={css.tabIcon} />
            <span className={css.tabLabel}>{viewTitle(view, t)}</span>
          </button>
        </div>
        <div className={css.stripChrome}>
          <Tooltip label={t('Open guide')} side="bottom" delayMs={400}>
            <button type="button" className={css.iconButton} aria-label={t('Open guide')} onClick={() => { setView('guide'); }}>
              <IconCompareSplitOutlineRegular size={14} />
            </button>
          </Tooltip>
          <Tooltip label={fullscreen ? t('Exit fullscreen') : t('Enter fullscreen')} side="bottom" delayMs={400}>
            <button type="button" className={css.iconButton} aria-label={fullscreen ? t('Exit fullscreen') : t('Enter fullscreen')} onClick={onToggleFullscreen}>
              <IconFullscreenOutlineRegular size={16} />
            </button>
          </Tooltip>
          <Tooltip label={t('Collapse panel')} side="bottom" delayMs={400}>
            <button type="button" className={css.iconButton} aria-label={t('Collapse panel')} onClick={onClose}>
              <IconPanelLeftOutlineRegular size={16} className={css.collapseGlyph} />
            </button>
          </Tooltip>
        </div>
      </div>

      {view === 'guide' && (
        <div className={css.guide}>
          <span className={css.guideHero} aria-hidden="true"><CompassGlyph size={56} /></span>
          <EntryCard
            icon={<GuideArtworkFiles size={26} />}
            title={t('Workspace files')}
            description={t('Browse and reference files in this workspace.')}
            onClick={() => { setView('files'); }}
          />
          <EntryCard
            icon={<PluginArtworkTerminal size={26} />}
            title={t('New terminal')}
            description={t('Open a terminal in this workspace.')}
            onClick={() => { setView('terminal'); }}
          />
          <div className={css.entryCell}>
            <Menu
              open={moreOpen}
              onClose={() => { setMoreOpen(false); }}
              items={moreItems}
              align="end"
              minWidthFromAnchor
              anchor={(
                <button
                  ref={moreAnchor}
                  type="button"
                  className={css.entry}
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => { setMoreOpen((value) => !value); }}
                >
                  <span className={css.entryIcon}><MoreToolsGlyph /></span>
                  <span className={css.entryText}>
                    <span className={css.entryTitle}>{t('More tools')}</span>
                  </span>
                </button>
              )}
              onSelect={(id) => {
                setMoreOpen(false);
                if (id === 'settings') store.openSettings();
                else if (id === 'export') void store.exportSession('markdown');
                else if (id === 'theme') store.toggleTheme();
              }}
            />
          </div>
        </div>
      )}

      {view === 'files' && (
        <div className={css.files}>
          <div className={css.filesToolbar}>
            {directory !== '' && (
              <Tooltip label={t('Workspace')} side="bottom" delayMs={400}>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('Workspace')}
                  onClick={() => { setDirectory(''); setSearch(''); setCopied(''); }}
                >
                  <IconChevronLeftOutlineRegular size={14} />
                </button>
              </Tooltip>
            )}
            <span className={css.crumb} title={crumb}>{crumb}</span>
            <div className={css.fileSearch}>
              <IconSearchOutlineRegular size={13} />
              <input
                type="text"
                value={search}
                placeholder={t('Search workspace files…')}
                aria-label={t('Search workspace files…')}
                onChange={(event) => { setSearch(event.target.value); }}
              />
            </div>
          </div>
          <div className={css.fileList} role="list">
            {filesLoading && <div className={css.fileStatus}>{t('Loading files…')}</div>}
            {!filesLoading && filesError !== '' && <div className={css.fileError}>{filesError}</div>}
            {!filesLoading && filesError === '' && files.length === 0 && <div className={css.fileStatus}>{t('No files found.')}</div>}
            {!filesLoading && files.map((entry) => (
              <button
                key={`${entry.kind}:${entry.path}`}
                type="button"
                role="listitem"
                className={css.fileRow}
                title={entry.kind === 'directory' ? t('Open folder') : t('Copy file path')}
                onClick={() => { if (entry.kind === 'directory') openDirectory(entry); else copyPath(entry); }}
              >
                <span className={css.fileGlyph} aria-hidden>
                  {entry.kind === 'directory' ? <IconFolderCloseRegular size={16} /> : <IconPaperclipOutlineRegular size={16} />}
                </span>
                <span className={css.fileText}>
                  <span className={css.fileName}>{entry.name}</span>
                  <span className={css.filePath}>{entry.path}</span>
                </span>
                {entry.kind === 'directory' && <span className={css.fileMeta}>{t('Open folder')}</span>}
              </button>
            ))}
          </div>
          {copied !== '' && (
            <div className={css.copyStatus} role="status">
              <IconDatabaseOutlineRegular size={13} />
              <span>{t('Copied')}</span>
              <code>{copied}</code>
            </div>
          )}
        </div>
      )}

      {view === 'terminal' && (
        <div className={css.terminal}>
          <div className={css.terminalBar}>
            <span className={css.terminalDot} aria-hidden />
            <span>{t('Terminal')}</span>
            <button type="button" className={css.terminalBack} onClick={() => { setView('guide'); }}>
              {t('Return to Start')}
            </button>
          </div>
          <div className={css.terminalBody}>
            <div className={css.terminalPrompt}>
              <span aria-hidden>~/workspace $</span>
              <span className={css.terminalCaret} aria-hidden />
            </div>
            <p>{t('The terminal is not available in the web client.')}</p>
          </div>
        </div>
      )}
    </aside>
  );
}
