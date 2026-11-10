/**
 * Right-click actions for one workspace entry: rename, move, copy relative or
 * absolute path, delete. Rename and move are the same server operation from two
 * angles, so both dialogs share one flow and report the new path upward.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  IconCopyOutlineRegular,
  IconEditOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Menu,
  Modal,
  type MenuEntry,
} from '../../vendor/primitives/index.ts';
import { translator } from '../lib/i18n.ts';
import { useApp } from '../lib/store.ts';
import {
  absoluteWorkspacePath, deleteWorkspaceFile, moveWorkspaceFile, renameWorkspaceFile,
} from '../lib/file-ops.ts';
import appCss from '../styles/app.module.css';

/** The entry a context menu was opened for, with the pointer it opened at. */
export interface FileMenuTarget {
  path: string;
  kind: 'file' | 'directory';
  x: number;
  y: number;
}

/** What changed, so the owner can refresh lists and follow a renamed preview. */
export interface FileMenuChange {
  kind: 'rename' | 'move' | 'delete';
  from: string;
  to?: string;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function RenameDialog({ workspaceId, path, onClose, onDone }: {
  workspaceId: string;
  path: string;
  onClose: () => void;
  onDone: (next: string) => void;
}): ReactNode {
  const t = translator(useApp().locale);
  const current = baseName(path);
  const [name, setName] = useState(current);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = (): void => {
    if (saving) return;
    const next = name.trim();
    if (next === '' || next.includes('/')) { setError('That name cannot be used.'); return; }
    if (next === current) { onClose(); return; }
    setSaving(true);
    void renameWorkspaceFile(workspaceId, path, next).then((result) => {
      setSaving(false);
      if (result.ok) onDone(result.path);
      else setError(result.message);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('Rename')}
      closeLabel={t('Close')}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={saving} onClick={submit}>{t('Save')}</Button>
        </>
      )}
    >
      <div className={appCss.dialogForm}>
        <label>
          <span>{t('New name')}</span>
          <Input
            data-modal-autofocus
            value={name}
            onChange={(event) => { setName(event.target.value); setError(''); }}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
        </label>
        {error !== '' && <p className={appCss.formError} role="alert">{t(error)}</p>}
      </div>
    </Modal>
  );
}

function MoveDialog({ workspaceId, path, onClose, onDone }: {
  workspaceId: string;
  path: string;
  onClose: () => void;
  onDone: (next: string) => void;
}): ReactNode {
  const t = translator(useApp().locale);
  const [directory, setDirectory] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = (): void => {
    if (saving) return;
    const target = directory.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    setSaving(true);
    void moveWorkspaceFile(workspaceId, path, target).then((result) => {
      setSaving(false);
      if (result.ok) onDone(result.path);
      else setError(result.message);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('Move to folder')}
      description={t('Moving {name} keeps its current name.', { name: baseName(path) })}
      closeLabel={t('Close')}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={saving} onClick={submit}>{t('Move')}</Button>
        </>
      )}
    >
      <div className={appCss.dialogForm}>
        <label>
          <span>{t('Target folder')}</span>
          <Input
            data-modal-autofocus
            value={directory}
            placeholder={t('Empty for the workspace root')}
            onChange={(event) => { setDirectory(event.target.value); setError(''); }}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
        </label>
        <p className={appCss.formHint}>{t('Folder path relative to the workspace root, such as docs/guides.')}</p>
        {error !== '' && <p className={appCss.formError} role="alert">{t(error)}</p>}
      </div>
    </Modal>
  );
}

function DeleteDialog({ workspaceId, target, onClose, onDone }: {
  workspaceId: string;
  target: FileMenuTarget;
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const t = translator(useApp().locale);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const name = baseName(target.path);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Delete')}
      tone="warning"
      description={target.kind === 'directory'
        ? t('Delete the folder “{name}” and everything inside it? This cannot be undone.', { name })
        : t('Delete “{name}”? This cannot be undone.', { name })}
      closeLabel={t('Close')}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void deleteWorkspaceFile(workspaceId, target.path).then((result) => {
                setSaving(false);
                if (result.ok) onDone();
                else setError(result.message);
              });
            }}
          >
            {t('Delete')}
          </Button>
        </>
      )}
    >
      {error !== '' && <p className={appCss.formError} role="alert">{t(error)}</p>}
    </Modal>
  );
}

/**
 * Context menu for one workspace entry.
 * @param props.workspaceId - registered workspace id.
 * @param props.workspacePath - absolute workspace root, used for the absolute-path copy.
 * @param props.target - entry and pointer position; null keeps the menu closed.
 * @param props.onClose - dismiss the menu or dialog.
 * @param props.onChanged - report a completed operation to the owner.
 */
export function FileTreeMenu({ workspaceId, workspacePath, target, onClose, onChanged }: {
  workspaceId: string;
  workspacePath: string;
  target: FileMenuTarget | null;
  onClose: () => void;
  onChanged: (change: FileMenuChange) => void;
}): ReactNode {
  const t = translator(useApp().locale);
  const [dialog, setDialog] = useState<'rename' | 'move' | 'delete' | null>(null);

  const items = useMemo<MenuEntry[]>(() => [
    { id: 'rename', label: t('Rename'), icon: <IconEditOutlineRegular size={16} /> },
    { id: 'move', label: t('Move to folder'), icon: <IconFolderOpenOutlineRegular size={16} /> },
    { type: 'separator', id: 'file-menu-paths' },
    { id: 'copy-relative', label: t('Copy relative path'), icon: <IconCopyOutlineRegular size={16} /> },
    { id: 'copy-absolute', label: t('Copy absolute path'), icon: <IconCopyOutlineRegular size={16} /> },
    { type: 'separator', id: 'file-menu-delete' },
    { id: 'delete', label: t('Delete'), icon: <IconTrashOutlineRegular size={16} />, danger: true },
  ], [t]);

  const closeAll = (): void => { setDialog(null); onClose(); };

  return (
    <>
      <Menu
        open={target !== null && dialog === null}
        contextual
        portal
        autoFocus
        anchor={<span />}
        getAnchorRect={() => (target === null ? null : new DOMRect(target.x, target.y, 0, 0))}
        returnFocus={() => (document.activeElement instanceof HTMLElement ? document.activeElement : null)}
        items={items}
        onSelect={(id) => {
          if (target === null) return;
          if (id === 'copy-relative') {
            void navigator.clipboard?.writeText(target.path).catch(() => undefined);
            closeAll();
            return;
          }
          if (id === 'copy-absolute') {
            void navigator.clipboard?.writeText(absoluteWorkspacePath(workspacePath, target.path)).catch(() => undefined);
            closeAll();
            return;
          }
          if (id === 'rename' || id === 'move' || id === 'delete') setDialog(id);
        }}
        onClose={onClose}
      />
      {target !== null && dialog === 'rename' && (
        <RenameDialog
          workspaceId={workspaceId}
          path={target.path}
          onClose={closeAll}
          onDone={(next) => { onChanged({ kind: 'rename', from: target.path, to: next }); closeAll(); }}
        />
      )}
      {target !== null && dialog === 'move' && (
        <MoveDialog
          workspaceId={workspaceId}
          path={target.path}
          onClose={closeAll}
          onDone={(next) => { onChanged({ kind: 'move', from: target.path, to: next }); closeAll(); }}
        />
      )}
      {target !== null && dialog === 'delete' && (
        <DeleteDialog
          workspaceId={workspaceId}
          target={target}
          onClose={closeAll}
          onDone={() => { onChanged({ kind: 'delete', from: target.path }); closeAll(); }}
        />
      )}
    </>
  );
}
