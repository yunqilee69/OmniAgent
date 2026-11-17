import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  IconArchiveOutlineRegular,
  IconChevronRightOutlineRegular,
  IconEllipsisOutlineRegular,
  IconFolderCloseRegular,
  IconSearchOutlineRegular,
  IconTrashOutlineRegular,
  Menu,
  Modal,
  Switch,
  type MenuEntry,
} from '../../../vendor/primitives/index.ts';
import { SelectMenu } from '../SelectMenu.tsx';
import { store, sessionKey, useApp } from '../../lib/store.ts';
import type { ArchivedSessionSummary } from '../../lib/wire.ts';
import { relativeDate } from '../../lib/trajectory.ts';
import { translator } from '../../lib/i18n.ts';
import css from '../../styles/app.module.css';

/** Retention choices offered once automatic archiving is on. Values are milliseconds. */
const RETENTION_OPTIONS = [
  { id: String(24 * 60 * 60 * 1000), label: 'Archive after 1 day' },
  { id: String(3 * 24 * 60 * 60 * 1000), label: 'Archive after 3 days' },
  { id: String(7 * 24 * 60 * 60 * 1000), label: 'Archive after 7 days' },
  { id: String(14 * 24 * 60 * 60 * 1000), label: 'Archive after 14 days' },
  { id: String(30 * 24 * 60 * 60 * 1000), label: 'Archive after 30 days' },
  { id: String(90 * 24 * 60 * 60 * 1000), label: 'Archive after 90 days' },
] as const;

const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

type ArchiveSort = 'updated' | 'created' | 'name';

interface ArchiveGroup {
  workspaceId: string;
  workspaceName: string;
  sessions: ArchivedSessionSummary[];
}

function sessionLabel(session: ArchivedSessionSummary, untitled: string): string {
  const description = session.description?.trim() ?? '';
  if (description !== '') return description;
  const title = session.title?.trim() ?? '';
  return title !== '' ? title : untitled;
}

function matchesQuery(session: ArchivedSessionSummary, query: string, untitled: string): boolean {
  if (query === '') return true;
  const haystack = [sessionLabel(session, untitled), session.workspaceName, session.id].join('\n').toLowerCase();
  return query.split(/\s+/u).filter(Boolean).every((term) => haystack.includes(term));
}

/**
 * Archive management: the automatic-archive switch, its retention window, and
 * every archived session grouped by the workspace it belongs to.
 *
 * Deleting is explicit. "Delete all" removes the rows currently listed, which
 * is the filtered set when a search is active, so a hidden row is never swept
 * up by a search the user cannot see.
 */
export function SettingsArchive(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const saved = app.archiveSettings;
  const enabled = saved?.enabled === true;
  const retentionMs = saved?.retentionMs ?? DEFAULT_RETENTION_MS;
  const [sessions, setSessions] = useState<ArchivedSessionSummary[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ArchiveSort>('updated');
  const [workspaceFilter, setWorkspaceFilter] = useState('all');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ArchivedSessionSummary[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = (): void => {
    void store.listArchivedSessions().then((items) => {
      setSessions(items);
      setError('');
    }).catch((cause: Error) => {
      setSessions([]);
      setError(t('Could not load archived sessions: {message}', { message: cause.message }));
    });
  };
  useEffect(() => { reload(); }, []);

  const retentionItems: MenuEntry[] = RETENTION_OPTIONS.map((option) => ({ id: option.id, label: t(option.label) }));
  const retentionKnown = RETENTION_OPTIONS.some((option) => option.id === String(retentionMs));
  const retentionLabel = retentionKnown
    ? t(RETENTION_OPTIONS.find((option) => option.id === String(retentionMs))!.label)
    : t('Custom retention');

  const workspaces = useMemo(() => {
    const names = new Map<string, string>();
    for (const session of sessions ?? []) names.set(session.workspaceId, session.workspaceName);
    return [...names.entries()].sort((left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]));
  }, [sessions]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (sessions ?? []).filter((session) =>
      (workspaceFilter === 'all' || session.workspaceId === workspaceFilter)
      && matchesQuery(session, needle, t('Untitled')));
  }, [sessions, query, workspaceFilter, t]);

  const groups = useMemo<ArchiveGroup[]>(() => {
    const byWorkspace = new Map<string, ArchiveGroup>();
    for (const session of visible) {
      const group = byWorkspace.get(session.workspaceId) ?? {
        workspaceId: session.workspaceId,
        workspaceName: session.workspaceName,
        sessions: [],
      };
      group.sessions.push(session);
      byWorkspace.set(session.workspaceId, group);
    }
    const sorted = [...byWorkspace.values()].sort((left, right) =>
      left.workspaceName.localeCompare(right.workspaceName) || left.workspaceId.localeCompare(right.workspaceId));
    for (const group of sorted) {
      group.sessions.sort((left, right) => compareSessions(left, right, sort, t('Untitled')));
    }
    return sorted;
  }, [visible, sort, t]);

  const save = (nextEnabled: boolean, nextRetention: number): void => {
    void store.saveArchiveSettings(nextEnabled, nextRetention);
  };

  const confirmDelete = (): void => {
    const targets = pendingDelete;
    if (targets === null || targets.length === 0 || deleting) return;
    setDeleting(true);
    void store.deleteArchivedSessions(targets.map((session) => ({ workspaceId: session.workspaceId, id: session.id })))
      .then((removed) => {
        const gone = new Set(removed.map((session) => sessionKey(session.workspaceId, session.id)));
        setSessions((current) => (current ?? []).filter((session) => !gone.has(sessionKey(session.workspaceId, session.id))));
        setPendingDelete(null);
      })
      .catch((cause: Error) => {
        store.showAlert(t('Could not delete archived sessions: {message}', { message: cause.message }));
      })
      .finally(() => { setDeleting(false); });
  };

  return (
    <section className={css.settingsSection}>
      <h3>{t('Archive')}</h3>
      <div className={css.archiveCard}>
        <div className={css.archiveCardRow}>
          <div>
            <span className={css.settingsLabel}>{t('Automatically archive idle sessions')}</span>
            <span className={css.settingsDescription}>
              {t('Scan on a schedule and archive sessions whose last activity is older than the retention period. Pinned and running sessions are left alone.')}
            </span>
          </div>
          <Switch
            checked={enabled}
            disabled={app.archiveSettingsSaving}
            label={t('Automatically archive idle sessions')}
            onChange={(next) => { save(next, retentionMs); }}
          />
        </div>
        <div className={css.archiveCardRow}>
          <div>
            <span className={css.settingsLabel}>{t('Archive retention')}</span>
            <span className={css.settingsDescription}>
              {t('A session becomes a candidate only after it has been idle for this long.')}
            </span>
          </div>
          <SelectMenu
            value={String(retentionMs)}
            items={retentionItems}
            onSelect={(id) => {
              const next = Number(id);
              if (!Number.isSafeInteger(next) || next === retentionMs) return;
              save(enabled, next);
            }}
            ariaLabel={t('Archive retention')}
            title={t('Archive retention')}
            disabled={!enabled || app.archiveSettingsSaving}
            align="end"
            listClassName={css.selectMenuList}
          >
            {retentionLabel}
          </SelectMenu>
        </div>
      </div>
      {saved?.requiresSelection === true && (
        <p className={css.settingsHint}>{t('The saved archive settings are invalid. Saving replaces them with the values shown here.')}</p>
      )}

      <div className={css.archiveHead}>
        <h3>{t('Archived sessions')}</h3>
        <Button
          variant="outline"
          size="sm"
          disabled={visible.length === 0 || deleting}
          onClick={() => { setPendingDelete(visible); }}
        >
          <IconTrashOutlineRegular size={14} />
          {t('Delete all')}
        </Button>
      </div>
      <div className={css.archiveTools}>
        <label className={css.archiveSearch}>
          <IconSearchOutlineRegular size={14} />
          <input
            value={query}
            placeholder={t('Search archived sessions')}
            aria-label={t('Search archived sessions')}
            onChange={(event) => { setQuery(event.target.value); }}
          />
        </label>
        <span className={css.archiveSortLabel}>{t('Sort by')}</span>
        <SelectMenu
          value={sort}
          items={[
            { id: 'updated', label: t('Last updated') },
            { id: 'created', label: t('Created') },
            { id: 'name', label: t('Name') },
          ]}
          onSelect={(id) => { if (id === 'updated' || id === 'created' || id === 'name') setSort(id); }}
          ariaLabel={t('Sort archived sessions')}
          listClassName={css.selectMenuList}
        >
          {sort === 'created' ? t('Created') : sort === 'name' ? t('Name') : t('Last updated')}
        </SelectMenu>
        <SelectMenu
          value={workspaceFilter}
          items={[
            { id: 'all', label: t('All projects') },
            ...workspaces.map(([id, name]) => ({ id, label: name })),
          ]}
          onSelect={setWorkspaceFilter}
          ariaLabel={t('Filter archived sessions by project')}
          align="end"
          listClassName={css.selectMenuList}
        >
          {workspaceFilter === 'all'
            ? t('All projects')
            : workspaces.find(([id]) => id === workspaceFilter)?.[1] ?? t('All projects')}
        </SelectMenu>
      </div>

      {sessions === null && <p className={css.archiveEmpty}>{t('Loading archived sessions…')}</p>}
      {error !== '' && <p className={css.archiveEmpty}>{error}</p>}
      {sessions !== null && error === '' && groups.length === 0 && (
        <p className={css.archiveEmpty}>
          {sessions.length === 0 ? t('No archived sessions.') : t('No archived sessions match this search.')}
        </p>
      )}
      <div className={css.archiveGroups}>
        {groups.map((group) => {
          const open = openGroups[group.workspaceId] === true;
          return (
            <div key={group.workspaceId}>
              <button
                type="button"
                className={css.archiveGroup}
                aria-expanded={open}
                onClick={() => { setOpenGroups((current) => ({ ...current, [group.workspaceId]: !open })); }}
              >
                <span className={open ? css.archiveChevronOpen : css.archiveChevron}>
                  <IconChevronRightOutlineRegular size={14} />
                </span>
                <IconFolderCloseRegular size={16} />
                <span className={css.archiveGroupName}>{group.workspaceName}</span>
                <span className={css.archiveGroupCount}>
                  {t('{count} archived sessions', { count: group.sessions.length })}
                </span>
              </button>
              {open && (
                <div className={css.archiveSessions} role="list">
                  {group.sessions.map((session) => {
                    const key = sessionKey(session.workspaceId, session.id);
                    const label = sessionLabel(session, t('Untitled'));
                    return (
                      <div key={key} className={css.archiveSession} role="listitem" title={session.id}>
                        <IconArchiveOutlineRegular size={14} />
                        <span className={css.archiveSessionTitle}>{label}</span>
                        <span className={css.archiveSessionTime}>
                          {relativeDate(sort === 'created' ? session.createdAt ?? session.updatedAt : session.updatedAt, app.locale)}
                        </span>
                        <Menu
                          open={menuFor === key}
                          items={[
                            { id: 'restore', label: t('Restore session'), icon: <IconArchiveOutlineRegular size={14} /> },
                            { type: 'separator', id: 'danger' },
                            { id: 'delete', label: t('Delete'), danger: true, icon: <IconTrashOutlineRegular size={14} /> },
                          ]}
                          onSelect={(action) => {
                            setMenuFor(null);
                            if (action === 'restore') {
                              void store.setSessionArchived(session.id, false, session.workspaceId).then((ok) => {
                                if (!ok) return;
                                setSessions((current) => (current ?? []).filter((item) =>
                                  sessionKey(item.workspaceId, item.id) !== key));
                              });
                            } else if (action === 'delete') {
                              setPendingDelete([session]);
                            }
                          }}
                          onClose={() => { setMenuFor(null); }}
                          align="end"
                          anchor={(
                            <button
                              type="button"
                              className={css.archiveIconButton}
                              aria-label={t('Session actions')}
                              aria-expanded={menuFor === key}
                              onClick={() => { setMenuFor((current) => current === key ? null : key); }}
                            >
                              <IconEllipsisOutlineRegular size={14} />
                            </button>
                          )}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Modal
        open={pendingDelete !== null}
        onClose={() => { if (!deleting) setPendingDelete(null); }}
        title={pendingDelete !== null && pendingDelete.length > 1 ? t('Delete archived sessions') : t('Delete session')}
        tone="warning"
        description={pendingDelete !== null && pendingDelete.length > 1
          ? t('Delete {count} archived sessions? Their transcripts are removed from this device and cannot be restored.', { count: pendingDelete.length })
          : t('Delete “{name}”? This removes the session transcript from this device and cannot be undone.', {
            name: pendingDelete?.[0] === undefined ? '' : sessionLabel(pendingDelete[0], t('Untitled')),
          })}
        closeLabel={t('Close')}
        footer={(
          <>
            <Button variant="outline" disabled={deleting} onClick={() => { setPendingDelete(null); }}>{t('Cancel')}</Button>
            <Button variant="primary" disabled={deleting} onClick={confirmDelete}>{t('Delete')}</Button>
          </>
        )}
      />
    </section>
  );
}

function compareSessions(left: ArchivedSessionSummary, right: ArchivedSessionSummary, sort: ArchiveSort, untitled: string): number {
  if (sort === 'name') {
    return sessionLabel(left, untitled).localeCompare(sessionLabel(right, untitled)) || left.id.localeCompare(right.id);
  }
  const leftTime = sort === 'created' ? left.createdAt ?? left.updatedAt : left.updatedAt;
  const rightTime = sort === 'created' ? right.createdAt ?? right.updatedAt : right.updatedAt;
  return rightTime - leftTime || left.id.localeCompare(right.id);
}
