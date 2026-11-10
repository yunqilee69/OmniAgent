import { useEffect, useState, type ReactNode } from 'react';
import { IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconFolderCloseRegular, IconPaperclipOutlineRegular } from '../../vendor/primitives/index.ts';
import { authFetch } from '../lib/auth.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { useApp } from '../lib/store.ts';
import { workspaceApiPath, type WorkspaceFileEntry } from '../lib/wire.ts';
import { FileTreeMenu, type FileMenuChange, type FileMenuTarget } from './FileTreeMenu.tsx';
import css from '../styles/workspace-files.module.css';

function Directory({ workspaceId, path, depth, selected, refreshToken, onSelect, onContextMenu, t }: {
  workspaceId: string; path: string; depth: number; selected: string | null; refreshToken: number;
  onSelect: (path: string) => void; onContextMenu: (target: FileMenuTarget) => void; t: Translate;
}): ReactNode {
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [truncated, setTruncated] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    const query = new URLSearchParams({ path });
    void authFetch(workspaceApiPath(workspaceId, `files/tree?${query}`), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Request failed');
        return await response.json() as { entries: WorkspaceFileEntry[]; truncated: boolean };
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        setEntries(body.entries); setTruncated(body.truncated); setStatus('ready');
      })
      .catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => { controller.abort(); };
  }, [workspaceId, path, attempt, refreshToken]);
  return (
    <div>
      {status === 'loading' && <div className={css.status}>{t('Loading files…')}</div>}
      {status === 'error' && <div className={css.status} role="alert">{t('Could not load files.')} <button type="button" onClick={() => { setAttempt((value) => value + 1); }}>{t('Retry')}</button></div>}
      {status === 'ready' && entries.length === 0 && <div className={css.status}>{t('No files found.')}</div>}
      {status === 'ready' && entries.map((entry) => {
        const isOpen = expanded.has(entry.path);
        return <div key={entry.path}>
          <button type="button" className={css.row} style={{ paddingLeft: 12 + depth * 16 }}
            aria-expanded={entry.kind === 'directory' ? isOpen : undefined}
            aria-current={entry.kind === 'file' && selected === entry.path ? 'true' : undefined}
            title={entry.path} onClick={() => {
              if (entry.kind === 'file') onSelect(entry.path);
              else setExpanded((previous) => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              onContextMenu({ path: entry.path, kind: entry.kind, x: event.clientX, y: event.clientY });
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              onContextMenu({ path: entry.path, kind: entry.kind, x: rect.left + 12, y: rect.bottom - 4 });
            }}>
            {entry.kind === 'directory' ? (isOpen ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />) : <span className={css.spacer} />}
            {entry.kind === 'directory' ? <IconFolderCloseRegular size={15} /> : <IconPaperclipOutlineRegular size={15} />}
            <span className={css.name}>{entry.name}</span>
          </button>
          {entry.kind === 'directory' && isOpen && (
            <Directory
              workspaceId={workspaceId}
              path={entry.path}
              depth={depth + 1}
              selected={selected}
              refreshToken={refreshToken}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              t={t}
            />
          )}
        </div>;
      })}
      {status === 'ready' && truncated && <div className={css.status}>{t('Directory listing truncated.')}</div>}
    </div>
  );
}

export function WorkspaceFileTree({ workspaceId, workspacePath, name, selected, refreshToken, onBack, onSelect, onChanged }: {
  workspaceId: string;
  /** Absolute root of the browsed workspace, for the absolute-path copy action. */
  workspacePath: string;
  name: string;
  selected: string | null;
  /** Bumped by the owner after a file operation so every open folder refetches. */
  refreshToken: number;
  onBack: () => void;
  onSelect: (path: string) => void;
  onChanged: (change: FileMenuChange) => void;
}): ReactNode {
  const t = translator(useApp().locale);
  const [menu, setMenu] = useState<FileMenuTarget | null>(null);
  return <aside className={css.tree} aria-label={t('Workspace files')}>
    <div className={css.treeHeader}>
      <button type="button" className={css.iconButton} onClick={onBack} aria-label={t('Back to workspaces')} title={t('Back to workspaces')}><IconChevronLeftOutlineRegular size={16} /></button>
      <strong className={css.name} title={name}>{name}</strong>
    </div>
    <div className={css.treeBody}>
      <Directory
        key={workspaceId}
        workspaceId={workspaceId}
        path=""
        depth={0}
        selected={selected}
        refreshToken={refreshToken}
        onSelect={onSelect}
        onContextMenu={setMenu}
        t={t}
      />
    </div>
    <FileTreeMenu
      workspaceId={workspaceId}
      workspacePath={workspacePath}
      target={menu}
      onClose={() => { setMenu(null); }}
      onChanged={(change) => { onChanged(change); }}
    />
  </aside>;
}
