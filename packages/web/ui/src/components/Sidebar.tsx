import { useEffect, useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Button,
  FishLogo,
  IconAlarmClockOutlineRegular,
  IconBranchOutlineRegular,
  IconCloseOutlineRegular,
  IconCopyOutlineRegular,
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconFolderOpenRegular,
  IconNewChatOutlineMedium,
  IconPanelLeftOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
  IconProjectAddOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Menu,
  Modal,
  StateDot,
  Toast,
  Tooltip,
  type MenuEntry,
} from '../../vendor/primitives/index.ts';
import { DirectoryPicker } from './DirectoryPicker.tsx';
import { store, sessionKey, useApp } from '../lib/store.ts';
import { relativeDate } from '../lib/trajectory.ts';
import { translator } from '../lib/i18n.ts';
import pickerCss from '../styles/directory-picker.module.css';
import sidebarCss from '../styles/dsh/sidebar.module.css';
import browserCss from '../styles/dsh/sidebar-browser.module.css';
import appCss from '../styles/app.module.css';

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? '';
}

function WorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const t = translator(useApp().locale);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  if (!open) return null;
  const suggested = baseName(path);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Add workspace')}
      description={t('Pick a folder on this computer. Its sessions run inside that directory.')}
      closeLabel={t('Close')}
      className={pickerCss.dialog}
      contentClassName={pickerCss.scrollContent}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            disabled={saving || path === ''}
            onClick={() => {
              setSaving(true);
              void store.addWorkspace(path, name.trim()).then((ok) => {
                setSaving(false);
                if (ok) {
                  setPath('');
                  setName('');
                  setError('');
                  onClose();
                } else {
                  setError(t('Could not add this workspace. Check the path and try again.'));
                }
              });
            }}
          >
            {saving ? t('Adding…') : t('Add this folder')}
          </Button>
        </>
      )}
    >
      <div className={appCss.dialogForm}>
        <div className={appCss.dialogField}>
          <span>{t('Folder')}</span>
          <DirectoryPicker onPathChange={(next) => { setPath(next); setError(''); }} disabled={saving} t={t} />
        </div>
        <label>
          <span>{t('Display name')}</span>
          <Input
            value={name}
            placeholder={suggested === '' ? t('Optional') : suggested}
            disabled={saving}
            onChange={(event) => { setName(event.target.value); }}
          />
        </label>
        {error !== '' && <p className={appCss.formError}>{error}</p>}
      </div>
    </Modal>
  );
}

function RemoveWorkspaceDialog({ id, name, onClose }: { id: string | null; name: string; onClose: () => void }): ReactNode {
  const t = translator(useApp().locale);
  const [saving, setSaving] = useState(false);
  if (id === null) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Remove workspace')}
      tone="warning"
      description={t('Remove “{name}” from OmniAgent? The directory itself is not deleted.', { name })}
      closeLabel={t('Close')}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void store.removeWorkspace(id).then((ok) => {
                setSaving(false);
                if (ok) onClose();
              });
            }}
          >
            {t('Remove')}
          </Button>
        </>
      )}
    />
  );
}

function RenameSessionDialog({ workspaceId, id, initialTitle, onClose }: { workspaceId: string; id: string; initialTitle: string; onClose: () => void }): ReactNode {
  const t = translator(useApp().locale);
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = (): void => {
    if (saving) return;
    const trimmed = title.trim();
    if (trimmed === '') {
      setError(t('Enter a session name.'));
      return;
    }
    setSaving(true);
    void store.renameSession(id, trimmed, workspaceId).then((ok) => {
      setSaving(false);
      if (ok) {
        onClose();
      } else {
        setError(t('The session could not be renamed.'));
      }
    });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Rename session')}
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
          <span>{t('Session name')}</span>
          <Input
            data-modal-autofocus
            value={title}
            maxLength={200}
            onChange={(event) => { setTitle(event.target.value); setError(''); }}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
        </label>
        {error !== '' && <p className={appCss.formError}>{error}</p>}
      </div>
    </Modal>
  );
}

function DeleteSessionDialog({ workspaceId, id, name, onClose }: { workspaceId: string; id: string; name: string; onClose: () => void }): ReactNode {
  const t = translator(useApp().locale);
  const [saving, setSaving] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Delete session')}
      tone="warning"
      description={t('Delete “{name}”? This removes the session transcript from this device and cannot be undone.', { name })}
      closeLabel={t('Close')}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void store.deleteSession(id, workspaceId).then((ok) => {
                setSaving(false);
                if (ok) onClose();
              });
            }}
          >
            {t('Delete')}
          </Button>
        </>
      )}
    />
  );
}

function NavRow({ icon, label, active, onClick }: { icon: ReactNode; label: string; active?: boolean; onClick: () => void }): ReactNode {
  return (
    <div className={clsx(sidebarCss.panelEntry, sidebarCss.panelEntryWide, active && sidebarCss.panelEntryActive)}>
      <button type="button" className={sidebarCss.panelRow} aria-current={active === true ? 'page' : undefined} onClick={onClick}>
        <span className={sidebarCss.panelGlyph} aria-hidden="true">{icon}</span>
        <span className={sidebarCss.panelTitle}>{label}</span>
      </button>
    </div>
  );
}

export function Sidebar({ drawer, onClose, onBrowseWorkspace }: { drawer: boolean; onClose: () => void; onBrowseWorkspace?: (workspaceId: string) => void }): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState<string | null>(null);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ workspaceId: string; id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ workspaceId: string; id: string; name: string } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (app.workspaceId === null) return;
    const workspaceId = app.workspaceId;
    setExpandedOverrides((value) => value[workspaceId] === undefined ? { ...value, [workspaceId]: true } : value);
  }, [app.workspaceId]);
  const workspace = app.workspaces.find((item) => item.id === app.workspaceId);
  const defaultWorkspace = app.workspaces.find((item) => item.isDefault === true);
  const defaultList = defaultWorkspace === undefined ? undefined : app.sessionsByWorkspace[defaultWorkspace.id];
  useEffect(() => {
    if (defaultWorkspace === undefined || app.workspaceId === null || app.workspaceId === defaultWorkspace.id) return;
    if (defaultList?.loaded || defaultList?.loading || defaultList?.error) return;
    void store.loadSessions(defaultWorkspace.id, false);
  }, [defaultWorkspace?.id, app.workspaceId, defaultList?.loaded, defaultList?.loading, defaultList?.error]);
  const select = (workspaceId: string, id: string): void => {
    store.selectSession(id, workspaceId);
    if (drawer) onClose();
  };

  const workspaceMenuItems = useMemo<MenuEntry[]>(() => [
    { type: 'label', id: 'workspaces', text: t('Workspaces') },
    ...app.workspaces.filter((item) => item.isDefault !== true).map((item) => ({
      id: `workspace:${item.id}`,
      label: item.name || item.path || item.id,
      icon: <IconFolderOpenRegular size={14} />,
    })),
    { type: 'separator', id: 'workspace-actions' },
    { id: 'add-workspace', label: t('Add workspace'), icon: <IconProjectAddOutlineRegular size={14} /> },
    ...(workspace !== undefined && workspace.isDefault !== true
      ? [{ id: 'remove-workspace', label: t('Remove workspace'), danger: true }]
      : []),
  ], [app.workspaces, workspace, t]);

  return (
    <aside className={clsx(sidebarCss.root, appCss.sidebar, drawer && appCss.sidebarDrawer)} aria-label={t('Workspace navigation')}>
      <div className={sidebarCss.logoRow}>
        <button
          type="button"
          className={sidebarCss.brand}
          onClick={() => { void store.startDraftSession(); }}
          disabled={app.workspaceId === null || app.sessionsLoading || app.creatingSession}
          title={t('New session')}
        >
          <span className={sidebarCss.brandIdentity}>
            <span className={sidebarCss.brandMark}><FishLogo size={24} /></span>
            <span className={sidebarCss.brandName}>OmniAgent</span>
          </span>
        </button>
        <Tooltip label={drawer ? t('Close sidebar') : t('Hide sidebar')} delayMs={400}>
          <button type="button" className={sidebarCss.iconButton} aria-label={drawer ? t('Close sidebar') : t('Hide sidebar')} onClick={onClose}>
            {drawer ? <IconCloseOutlineRegular /> : <IconPanelLeftOutlineRegular />}
          </button>
        </Tooltip>
      </div>

      <button
        type="button"
        className={sidebarCss.newSession}
        disabled={app.workspaceId === null || app.sessionsLoading || app.creatingSession}
        onClick={() => { void store.startDraftSession(); if (drawer) onClose(); }}
      >
        <span className={sidebarCss.newSessionLabelMask}>
          <span className={sidebarCss.newSessionContent}>
            <IconNewChatOutlineMedium size={14} />
            <span className={sidebarCss.newSessionLabel}>{app.creatingSession ? t('Creating…') : t('New session')}</span>
          </span>
        </span>
      </button>

      <div className={sidebarCss.scrollRegion}>
        <div className={sidebarCss.scrollArea}>
          <nav className={sidebarCss.panelList} aria-label={t('Workspace navigation')}>
            <NavRow
              icon={<IconAlarmClockOutlineRegular size={16} />}
              label={t('Automations')}
              active={app.tab === 'automation'}
              onClick={() => { store.setTab('automation'); if (drawer) onClose(); }}
            />
            <NavRow
              icon={<IconSettingsOutlineRegular size={16} />}
              label={t('Settings')}
              active={app.tab === 'settings'}
              onClick={() => { store.openSettings(); if (drawer) onClose(); }}
            />
          </nav>

          <div className={sidebarCss.regionArea}>
            <div className={browserCss.root}>
              <div className={browserCss.sectionHeader}>
                {searchOpen ? (
                  <div className={browserCss.search}>
                    <IconSearchOutlineRegular size={13} />
                    <input
                      autoFocus
                      type="text"
                      value={query}
                      placeholder={t('Search sessions')}
                      aria-label={t('Search sessions')}
                      onChange={(event) => { setQuery(event.target.value); }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return;
                        setQuery('');
                        setSearchOpen(false);
                      }}
                    />
                    <button
                      type="button"
                      className={browserCss.clearButton}
                      aria-label={t('Close')}
                      onClick={() => { setQuery(''); setSearchOpen(false); }}
                    >
                      <IconCloseOutlineRegular size={12} />
                    </button>
                  </div>
                ) : (
                  <>
                    <span className={browserCss.sectionLabel}>{t('Workspace')}</span>
                    <div className={browserCss.headerActions}>
                      <Tooltip label={t('Search sessions')} delayMs={400}>
                        <button type="button" className={browserCss.iconButton} aria-label={t('Search sessions')} onClick={() => { setSearchOpen(true); }}>
                          <IconSearchOutlineRegular size={14} />
                        </button>
                      </Tooltip>
                      <Menu
                        open={workspaceSettingsOpen}
                        onClose={() => { setWorkspaceSettingsOpen(false); }}
                        items={workspaceMenuItems}
                        selectedIds={app.workspaceId === null ? [] : [`workspace:${app.workspaceId}`]}
                        portal
                        minWidthFromAnchor
                        align="end"
                        anchor={(
                          <Tooltip label={t('Workspace settings')} delayMs={400}>
                            <button
                              type="button"
                              className={browserCss.iconButton}
                              aria-label={t('Workspace settings')}
                              aria-haspopup="menu"
                              aria-expanded={workspaceSettingsOpen}
                              onClick={() => { setWorkspaceSettingsOpen((value) => !value); }}
                            >
                              <IconSlidersTwoOutlineRegular size={14} />
                            </button>
                          </Tooltip>
                        )}
                        onSelect={(id) => {
                          setWorkspaceSettingsOpen(false);
                          if (id.startsWith('workspace:')) { const workspaceId = id.slice('workspace:'.length); setExpandedOverrides((value) => ({ ...value, [workspaceId]: true })); void store.selectWorkspace(workspaceId); }
                          else if (id === 'add-workspace') setAddOpen(true);
                          else if (id === 'remove-workspace' && workspace !== undefined && workspace.isDefault !== true) {
                            setRemoveTarget({ id: workspace.id, name: workspace.name || workspace.path || workspace.id });
                          }
                        }}
                      />
                      <Tooltip label={t('Add workspace')} delayMs={400}>
                        <button type="button" className={browserCss.iconButton} aria-label={t('Add workspace')} onClick={() => { setAddOpen(true); }}>
                          <IconProjectAddOutlineRegular size={16} />
                        </button>
                      </Tooltip>
                    </div>
                  </>
                )}
              </div>

              <div className={browserCss.listArea} role="tree" aria-label={t('Sessions')}>
                {app.workspacesLoading && app.workspaces.length === 0 && (
                  <div className={browserCss.empty}>{t('Loading workspaces…')}</div>
                )}
                {app.workspaceError !== '' && (
                  <div className={browserCss.empty}>
                    {app.workspaceError}
                    <button type="button" className={browserCss.retry} onClick={() => { void store.loadWorkspaces(); }}>{t('Retry')}</button>
                  </div>
                )}
                {!app.workspacesLoading && app.workspaceError === '' && app.workspaces.length === 0 && (
                  <div className={browserCss.empty}>{t('No workspace selected.')}</div>
                )}
                {[...app.workspaces.filter((item) => item.isDefault !== true), ...app.workspaces.filter((item) => item.isDefault === true)].map((item) => {
                  const active = item.id === app.workspaceId;
                  const expanded = item.isDefault === true || (expandedOverrides[item.id] ?? active);
                  const list = app.sessionsByWorkspace[item.id] ?? (active
                    ? { sessions: app.sessions, loading: app.sessionsLoading, error: app.sessionError, loaded: true }
                    : { sessions: [], loading: false, error: '', loaded: false });
                  const needle = query.trim().toLowerCase();
                  // Child sessions are reached from the header team card, not
                  // from the task list: one row per conversation the user started.
                  const roots = list.sessions.filter((session) => String(session.parentSessionId ?? '') === '');
                  const sessions = needle === '' ? roots : roots.filter((session) =>
                    [session.id, session.title, session.agent, session.agentId, session.cwd, session.description]
                      .some((value) => String(value ?? '').toLowerCase().includes(needle)));
                  const menuOpen = workspaceMenuOpen === item.id;
                  const workspaceLabel = item.name || item.path || item.id;
                  const rowMenuItems: MenuEntry[] = [
                    { id: 'browse-workspace', label: app.locale === 'zh' ? '查看文件列表' : 'View file list', icon: <IconFolderOpenRegular size={14} /> },
                    { id: 'remove-workspace', label: t('Remove'), icon: <IconTrashOutlineRegular size={14} />, danger: true },
                  ];
                  const activate = (): void => {
                    const next = !expanded;
                    setExpandedOverrides((value) => ({ ...value, [item.id]: next }));
                    if (next && !list.loaded && !list.loading) void store.loadSessions(item.id, false);
                  };
                  return (
                  <div className={browserCss.groupSection} key={item.id}>
                    {item.isDefault === true ? (
                      <div className={browserCss.sectionHeader}><span className={browserCss.sectionLabel}>{t('Tasks')}</span></div>
                    ) : (
                    <div
                      className={clsx(browserCss.workspaceRow, menuOpen && browserCss.rowMenuOpen)}
                      role="treeitem"
                      aria-expanded={expanded}
                      tabIndex={0}
                      onClick={activate}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        activate();
                      }}
                    >
                      <span className={browserCss.folder} aria-hidden="true">
                        <IconFolderOpenRegular size={16} />
                      </span>
                      <span className={browserCss.chevron} aria-hidden="true">
                        <svg width="10" height="10" viewBox="0 0 10 10" className={expanded ? browserCss.chevronOpen : undefined}>
                          <path d="M3 1.5L7 5L3 8.5Z" fill="currentColor" />
                        </svg>
                      </span>
                      <span className={browserCss.workspaceTitle} title={item.path}>{workspaceLabel}</span>
                      <span className={browserCss.rowActions} onClick={(event) => { event.stopPropagation(); }}>
                        <Menu
                          open={menuOpen}
                          onClose={() => { setWorkspaceMenuOpen(null); }}
                          items={rowMenuItems}
                          portal
                          minWidthFromAnchor
                          align="end"
                          anchor={(
                            <button
                              type="button"
                              className={browserCss.rowIcon}
                              aria-label={t('Workspace actions')}
                              aria-haspopup="menu"
                              aria-expanded={menuOpen}
                              onClick={() => { setWorkspaceMenuOpen((value) => value === item.id ? null : item.id); }}
                            >
                              <IconEllipsisOutlineRegular size={14} />
                            </button>
                          )}
                          onSelect={(id) => {
                            setWorkspaceMenuOpen(null);
                            if (id === 'browse-workspace') { onBrowseWorkspace?.(item.id); if (drawer) onClose(); }
                            else if (id === 'remove-workspace') setRemoveTarget({ id: item.id, name: workspaceLabel });
                          }}
                        />
                        <Tooltip label={t('New session in {name}', { name: workspaceLabel })} delayMs={400}>
                          <button
                            type="button"
                            className={browserCss.rowIcon}
                            aria-label={t('New session in {name}', { name: workspaceLabel })}
                            onClick={() => {
                              setExpandedOverrides((value) => ({ ...value, [item.id]: true }));
                              void store.startDraftSession({ workspaceId: item.id });
                              if (drawer) onClose();
                            }}
                          >
                            <IconNewChatOutlineMedium size={14} />
                          </button>
                        </Tooltip>
                      </span>
                    </div>
                    )}

                    {expanded && list.loading && <div className={browserCss.emptyRow}>{t('Loading sessions…')}</div>}
                    {expanded && !list.loading && list.error !== '' && (
                      <div className={browserCss.emptyRow}>
                        {list.error}
                        <button type="button" className={browserCss.retry} onClick={() => { void store.loadSessions(item.id, active); }}>{t('Retry')}</button>
                      </div>
                    )}
                    {expanded && !list.loading && list.error === '' && sessions.length === 0 && (
                      <div className={browserCss.emptyRow}>
                        {query.trim() === '' ? t('No sessions yet.') : t('No matching sessions.')}
                      </div>
                    )}
                    {expanded && !list.loading && list.error === '' && sessions.map((session) => {
                      const description = typeof session.description === 'string' ? session.description.trim() : '';
                      const title = typeof session.title === 'string' ? session.title.trim() : '';
                      const name = description !== ''
                        ? description
                        : title !== ''
                          ? title
                          : session.blank === true ? t('New Session') : t('Untitled');
                      const selected = active && session.id === app.sessionId;
                      const pinned = session.pinned === true;
                      const entry = app.entries[sessionKey(item.id, session.id)];
                      const running = entry?.run !== undefined;
                      const menuKey = sessionKey(item.id, session.id);
                      const menuOpen = sessionMenu === menuKey;
                      return (
                        <div
                          key={session.id}
                          className={clsx(
                            browserCss.sessionRow,
                            selected && browserCss.selected,
                            menuOpen && browserCss.rowMenuOpen,
                          )}
                          role="treeitem"
                          aria-selected={selected}
                          tabIndex={0}
                          title={session.id}
                          onClick={() => { select(item.id, session.id); }}
                          onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) return;
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            select(item.id, session.id);
                          }}
                        >
                          <span className={browserCss.sessionSlot} aria-hidden="true">
                            {running
                              ? <StateDot state="ongoing" />
                              : pinned ? <IconPinFillRegular size={12} /> : null}
                          </span>
                          <span className={browserCss.sessionTitle}>{name}</span>
                          <span className={browserCss.rowResting}>
                            <span className={browserCss.time}>
                              {relativeDate(session.updatedAt ?? session.createdAt, app.locale)}
                            </span>
                          </span>
                          <span className={browserCss.rowActions} onClick={(event) => { event.stopPropagation(); }}>
                            <Menu
                              open={menuOpen}
                              onClose={() => { setSessionMenu(null); }}
                              items={[
                                {
                                  id: 'pin',
                                  label: pinned ? t('Unpin session') : t('Pin session'),
                                  icon: pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />,
                                },
                                { id: 'rename', label: t('Rename session'), icon: <IconEditOutlineRegular size={14} /> },
                                { id: 'fork', label: t('Fork session'), icon: <IconBranchOutlineRegular size={14} /> },
                                { type: 'separator', id: 'session-actions' },
                                { id: 'copy-id', label: t('Copy session ID'), icon: <IconCopyOutlineRegular size={14} /> },
                                { type: 'separator', id: 'session-danger' },
                                {
                                  id: 'delete',
                                  label: t('Delete session'),
                                  icon: <IconTrashOutlineRegular size={14} />,
                                  danger: true,
                                },
                              ]}
                              portal
                              minWidthFromAnchor
                              align="end"
                              anchor={(
                                <button
                                  type="button"
                                  className={browserCss.rowIcon}
                                  aria-label={t('Session actions')}
                                  aria-haspopup="menu"
                                  aria-expanded={menuOpen}
                                  onClick={() => { setSessionMenu((current) => current === menuKey ? null : menuKey); }}
                                >
                                  <IconEllipsisOutlineRegular size={14} />
                                </button>
                              )}
                              onSelect={(action) => {
                                setSessionMenu(null);
                                if (action === 'pin') {
                                  void store.setSessionPinned(session.id, !pinned, item.id);
                                } else if (action === 'rename') {
                                  setRenameTarget({ workspaceId: item.id, id: session.id, name: title !== '' ? title : description });
                                } else if (action === 'fork') {
                                  void store.forkSession(session.id, item.id);
                                } else if (action === 'copy-id') {
                                  const clipboard = navigator.clipboard;
                                  if (clipboard?.writeText === undefined) {
                                    store.showAlert(t('Clipboard access is unavailable.'));
                                    return;
                                  }
                                  void clipboard.writeText(session.id).then(
                                    () => { setCopied(Date.now()); },
                                    () => { store.showAlert(t('Clipboard access is unavailable.')); },
                                  );
                                } else if (action === 'delete') {
                                  setDeleteTarget({ workspaceId: item.id, id: session.id, name });
                                }
                              }}
                            />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <WorkspaceDialog open={addOpen} onClose={() => { setAddOpen(false); }} />
      <RemoveWorkspaceDialog
        id={removeTarget?.id ?? null}
        name={removeTarget?.name ?? ''}
        onClose={() => { setRemoveTarget(null); }}
      />
      {renameTarget !== null && (
        <RenameSessionDialog
          key={`rename:${renameTarget.workspaceId}:${renameTarget.id}`}
          workspaceId={renameTarget.workspaceId}
          id={renameTarget.id}
          initialTitle={renameTarget.name}
          onClose={() => { setRenameTarget(null); }}
        />
      )}
      {deleteTarget !== null && (
        <DeleteSessionDialog
          key={`delete:${deleteTarget.workspaceId}:${deleteTarget.id}`}
          workspaceId={deleteTarget.workspaceId}
          id={deleteTarget.id}
          name={deleteTarget.name}
          onClose={() => { setDeleteTarget(null); }}
        />
      )}
      {copied !== null && (
        <Toast
          key={copied}
          text={t('Session ID copied')}
          tone="success"
          onDone={() => { setCopied(null); }}
        />
      )}
    </aside>
  );
}
