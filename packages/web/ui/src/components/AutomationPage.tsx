/**
 * Automation tasks page: a searchable list beside one task's rule editor and
 * saved delivery records. Ported from DSH's TaskManagerPage with the same
 * layout and stylesheet, wired to OmniAgent's `/api/schedules` surface.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Button,
  IconClockOutlineRegular,
  IconCloseOutlineRegular,
  IconEllipsisOutlineRegular,
  IconPauseOutlineRegular,
  IconPlayOutlineRegular,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Menu,
  Modal,
} from '../../vendor/primitives/index.ts';
import { store, useApp } from '../lib/store.ts';
import { translator, type Locale, type Translate } from '../lib/i18n.ts';
import { shortId } from '../lib/trajectory.ts';
import {
  draftTarget,
  newScheduleDraft,
  scheduleDraft,
  scheduleDraftIssue,
  systemTimeZone,
  timingFromDraft,
  type FrequencyPreset,
  type ScheduleDraft,
} from '../lib/schedule-draft.ts';
import type {
  ScheduleCatalogEntry,
  SchedulePatch,
  ScheduleStatus,
} from '../lib/wire.ts';
import css from '../styles/schedule.module.css';

type StatusFilter = 'all' | ScheduleStatus;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const FREQUENCIES: ReadonlyArray<{ id: FrequencyPreset; label: string }> = [
  { id: 'once', label: 'Once' },
  { id: 'minutely', label: 'Every N minutes' },
  { id: 'hourly', label: 'Every N hours' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'advanced', label: 'Advanced' },
];

function taskName(entry: ScheduleCatalogEntry): string {
  return entry.title.trim() === '' ? entry.id : entry.title;
}

function formatAbsolute(value: string, locale: Locale): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(time);
}

function formatRelative(value: string, t: Translate): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.round((time - Date.now()) / 60_000);
  if (minutes <= 0) return t('due now');
  if (minutes < 60) return t('in {minutes}m', { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t('in {hours}h', { hours });
  return t('in {days}d', { days: Math.floor(hours / 24) });
}

function formatFrequency(entry: ScheduleCatalogEntry, t: Translate): string {
  switch (entry.kind) {
    case 'after':
    case 'at': return t('Once · {time}', { time: formatAbsolute(entry.scheduledAt, 'en') });
    case 'every': {
      const seconds = entry.everySeconds ?? 60;
      return seconds % 3_600 === 0
        ? t('Every {count} hours', { count: seconds / 3_600 })
        : t('Every {count} minutes', { count: seconds / 60 });
    }
    case 'daily': return t('Daily · {time}', { time: (entry.time ?? '').slice(0, 5) });
    case 'weekly': return t('Weekly · {days}', { days: (entry.weekdays ?? []).map((day) => WEEKDAYS[day - 1] ?? day).join(', ') });
    case 'cron': return `Cron · ${entry.expression ?? ''}`;
    case 'rrule': {
      const rule = (entry.rrule ?? '').split('\n').find((line) => line.startsWith('RRULE:'))?.slice(6) ?? '';
      const fields = new Map<string, string>();
      for (const part of rule.split(';')) {
        const [key, value] = part.split('=');
        if (key !== undefined && value !== undefined) fields.set(key, value);
      }
      const freq = fields.get('FREQ');
      if (freq === 'DAILY' && fields.get('COUNT') === '1') {
        return t('Once · {time}', { time: formatAbsolute(entry.scheduledAt, 'en') });
      }
      if (freq === 'DAILY') return t('Daily · {time}', { time: `${(fields.get('BYHOUR') ?? '09').padStart(2, '0')}:${(fields.get('BYMINUTE') ?? '00').padStart(2, '0')}` });
      if (freq === 'WEEKLY') return t('Weekly · {days}', { days: fields.get('BYDAY') ?? '' });
      if (freq === 'HOURLY' || freq === 'MINUTELY') {
        return t(freq === 'HOURLY' ? 'Every {count} hours' : 'Every {count} minutes', { count: fields.get('INTERVAL') ?? '1' });
      }
      return `RRULE · ${rule}`;
    }
    default: return entry.kind;
  }
}

function buildPatch(draft: ScheduleDraft, original: ScheduleCatalogEntry): SchedulePatch {
  const seeded = scheduleDraft(original);
  const timingChanged = JSON.stringify(timingFromDraft(draft)) !== JSON.stringify(timingFromDraft(seeded));
  const targetChanged = draft.target !== seeded.target || draft.sessionId !== seeded.sessionId || draft.cwd !== seeded.cwd;
  return {
    ...(draft.title.trim() === seeded.title.trim() ? {} : { title: draft.title.trim() }),
    ...(draft.prompt.trim() === seeded.prompt.trim() ? {} : { prompt: draft.prompt.trim() }),
    ...(timingChanged ? { timing: timingFromDraft(draft, true) } : {}),
    ...(targetChanged ? { target: draftTarget(draft, original) } : {}),
  };
}

function emptyPatch(patch: SchedulePatch): boolean {
  return Object.keys(patch).length === 0;
}

/** Automation task management page. */
export function AutomationPage(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const selected = app.schedules.find((entry) => entry.id === selectedId);

  useEffect(() => {
    if (selectedId !== null && selected === undefined && !creating) setSelectedId(null);
  }, [selectedId, selected, creating]);

  useEffect(() => {
    if (app.tab !== 'automation') return;
    const interval = window.setInterval(() => { void store.loadSchedules(true); }, 15_000);
    return () => { window.clearInterval(interval); };
  }, [app.tab]);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return app.schedules
      .filter((entry) => (statusFilter === 'all' || entry.status === statusFilter)
        && (query === ''
          || entry.title.toLowerCase().includes(query)
          || entry.prompt.toLowerCase().includes(query)
          || (entry.target.kind === 'session' ? entry.target.sessionId : entry.target.create.cwd ?? '').toLowerCase().includes(query)))
      .slice()
      .sort((left, right) => {
        const status = Number(left.status !== 'active') - Number(right.status !== 'active');
        return status !== 0 ? status : Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt);
      });
  }, [app.schedules, search, statusFilter]);

  const endedCount = app.schedules.filter((entry) => entry.status === 'ended').length;
  const emptyTitle = search.trim() !== ''
    ? t('No matching tasks')
    : statusFilter === 'paused' ? t('No paused tasks')
      : statusFilter === 'ended' ? t('No ended tasks')
        : statusFilter === 'active' ? t('No active tasks') : t('No automation tasks');

  const closeDetails = (): void => { setSelectedId(null); setCreating(false); };
  const startCreate = (): void => {
    setSelectedId(null);
    setCreating(true);
  };

  return (
    <section className={clsx(css.page, (selected !== undefined || creating) && css.hasDetails)} aria-label={t('Automation tasks')}>
      <div className={css.listPane}>
        <div className={css.pageScroll}>
          <div className={css.pageContent}>
            <div className={css.pageHeading}>
              <h1>{t('Automation tasks')}</h1>
              <div className={css.creationActions}>
                <Button variant="primary" size="sm" className={css.headerAction} icon={<IconPlusOutlineRegular size={13} />} onClick={startCreate}>
                  {t('New task')}
                </Button>
              </div>
            </div>
            <div className={css.filters}>
              <div className={css.filterTabs} role="group" aria-label={t('Status filter')}>
                {(['active', 'paused', 'ended', 'all'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={clsx(css.filterTab, statusFilter === value && css.filterTabActive)}
                    aria-pressed={statusFilter === value}
                    onClick={() => { setStatusFilter(value); }}
                  >
                    {t(value === 'all' ? 'All' : value === 'active' ? 'Active' : value === 'paused' ? 'Paused' : 'Ended')}
                  </button>
                ))}
              </div>
            </div>
            <div className={css.searchTools}>
              <div className={css.searchField}>
                <Input
                  type="search"
                  icon={<IconSearchOutlineRegular />}
                  aria-label={t('Search tasks')}
                  placeholder={t('Search tasks')}
                  value={search}
                  onChange={(event) => { setSearch(event.target.value); }}
                />
                {search !== '' && (
                  <Button size="sm" className={css.searchClear} aria-label={t('Clear search')} onClick={() => { setSearch(''); }}>
                    <IconCloseOutlineRegular />
                  </Button>
                )}
              </div>
              {endedCount > 0 && statusFilter !== 'active' && (
                <Button variant="outline" className={css.catalogMore} onClick={() => { setClearConfirm(true); }}>
                  {t('Clear ended')}
                </Button>
              )}
            </div>
            <div className={css.list}>
              {app.schedulesError !== '' && (
                <div className={css.notice} role="status">
                  <p>{app.schedulesError}</p>
                  <Button variant="outline" size="sm" onClick={() => { void store.loadSchedules(); }}>{t('Retry')}</Button>
                </div>
              )}
              {rows.length === 0 && !app.schedulesLoading ? (
                <div className={css.empty} role="status">
                  <IconClockOutlineRegular className={css.emptyGlyph} size={40} />
                  <h2>{emptyTitle}</h2>
                  <Button variant="outline" className={css.emptyAction} onClick={startCreate}>{t('Create a task')}</Button>
                </div>
              ) : (
                <ul className={css.listRows} aria-label={t('Task list')} aria-busy={app.schedulesLoading}>
                  {rows.map((entry) => (
                    <li key={entry.id}>
                      <Button
                        className={clsx(css.row, selectedId === entry.id && css.selectedRow, entry.status !== 'active' && css.endedRow)}
                        aria-label={taskName(entry)}
                        aria-expanded={selectedId === entry.id}
                        onClick={() => { setCreating(false); setSelectedId(entry.id); }}
                      >
                        <IconClockOutlineRegular className={css.rowGlyph} />
                        <span className={css.rowContent}>
                          <span className={css.rowTitle}>{taskName(entry)}</span>
                          <span className={css.rowSummary}>
                            {entry.status !== 'active' && (
                              <span className={css.metadata}>
                                {t(entry.status === 'paused' ? 'Paused' : 'Ended')}
                              </span>
                            )}
                            <span className={css.metadata}>{formatFrequency(entry, t)}</span>
                            {entry.status === 'active' && (
                              <span className={css.metadata}>
                                {t('Next at')}{' '}
                                <time dateTime={entry.scheduledAt}>{formatAbsolute(entry.scheduledAt, app.locale)}</time>{' '}
                                <span className={css.nextRunRelative}>{formatRelative(entry.scheduledAt, t)}</span>
                              </span>
                            )}
                          </span>
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>

      {creating ? (
        <TaskEditor
          key="new"
          creating
          onClose={closeDetails}
          onCreated={(entry) => { setCreating(false); setSelectedId(entry.id); }}
        />
      ) : selected !== undefined ? (
        <TaskEditor
          key={selected.id}
          entry={selected}
          onClose={closeDetails}
          onDeleted={closeDetails}
        />
      ) : null}

      <Modal
        open={confirmDelete}
        title={t('Delete this task?')}
        description={t('The task and its saved delivery records are removed. The target conversation is not deleted.')}
        closeLabel={t('Close')}
        onClose={() => { setConfirmDelete(false); }}
        footer={(
          <div className={css.confirmActions}>
            <Button variant="outline" onClick={() => { setConfirmDelete(false); }}>{t('Cancel')}</Button>
            <Button
              variant="outline"
              className={css.deleteButton}
              disabled={app.scheduleSaving}
              onClick={() => {
                if (selected === undefined) return;
                setConfirmDelete(false);
                void store.deleteSchedule(selected.id, selected.updatedAt ?? null).then((ok) => { if (ok) closeDetails(); });
              }}
            >
              {t('Delete')}
            </Button>
          </div>
        )}
      >
        <p className={css.confirmPrompt}>{selected?.prompt}</p>
      </Modal>

      <Modal
        open={clearConfirm}
        title={t('Delete all ended tasks?')}
        description={t('This removes every ended task. Active and paused tasks stay unchanged.')}
        closeLabel={t('Close')}
        onClose={() => { if (!clearing) setClearConfirm(false); }}
        footer={(
          <div className={css.confirmActions}>
            <Button variant="outline" disabled={clearing} onClick={() => { setClearConfirm(false); }}>{t('Cancel')}</Button>
            <Button
              variant="outline"
              className={css.deleteButton}
              disabled={clearing}
              onClick={() => {
                setClearing(true);
                void store.clearEndedSchedules().finally(() => { setClearing(false); setClearConfirm(false); });
              }}
            >
              {clearing ? t('Clearing…') : t('Clear ended')}
            </Button>
          </div>
        )}
      />
    </section>
  );
}

/** One task's rule editor or saved delivery records. */
function TaskEditor({ entry, creating = false, onClose, onCreated, onDeleted }: {
  entry?: ScheduleCatalogEntry;
  creating?: boolean;
  onClose: () => void;
  onCreated?: (entry: ScheduleCatalogEntry) => void;
  onDeleted?: () => void;
}): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const defaultWorkspace = app.workspaces.find((workspace) => workspace.id === app.workspaceId) ?? app.workspaces[0];
  const initial = useMemo(
    () => entry === undefined ? newScheduleDraft(defaultWorkspace?.path ?? '') : scheduleDraft(entry),
    [entry?.id, entry?.updatedAt, defaultWorkspace?.path],
  );
  const [draft, setDraft] = useState<ScheduleDraft>(initial);
  const [tab, setTab] = useState<'rule' | 'records'>('rule');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(initial); }, [initial]);

  const patch = entry === undefined ? undefined : buildPatch(draft, entry);
  const dirty = entry === undefined
    ? JSON.stringify(draft) !== JSON.stringify(initial)
    : patch !== undefined && !emptyPatch(patch);
  const issue = dirty ? scheduleDraftIssue(draft) : undefined;
  const valid = issue === undefined;
  const busy = saving || app.scheduleSaving;
  const runBlocked = entry === undefined || entry.executionActive === true || busy
    || (entry.deliveryFloorEndsAt !== undefined && Date.parse(entry.deliveryFloorEndsAt) > Date.now());

  useEffect(() => {
    if (tab !== 'records' || entry === undefined) return;
    void store.loadScheduleHistory(entry.id);
  }, [tab, entry?.id]);

  const save = async (): Promise<void> => {
    if (!valid || !dirty) return;
    setSaving(true);
    try {
      if (creating) {
        const created = await store.createSchedule({
          title: draft.title.trim(),
          prompt: draft.prompt.trim(),
          timing: timingFromDraft(draft, true),
          target: draftTarget(draft),
        });
        if (created !== null) onCreated?.(created);
      } else if (entry !== undefined && patch !== undefined) {
        await store.editSchedule(entry.id, patch, entry.updatedAt ?? null);
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (): Promise<void> => {
    if (entry === undefined || busy || dirty) return;
    await store.editSchedule(entry.id, { active: entry.status !== 'active' }, entry.updatedAt ?? null);
  };

  const history = entry === undefined ? undefined : app.scheduleHistory[entry.id];
  const change = (values: Partial<ScheduleDraft>): void => { setDraft({ ...draft, ...values }); };
  const timeZone = draft.timeZone || systemTimeZone();
  const clock = draft.frequency === 'daily' ? `${draft.dailyTime}:00` : draft.start.slice(11);

  return (
    <>
      <aside className={css.detail} aria-label={creating ? t('New task') : t('Task detail')} aria-busy={busy}>
        <div className={css.detailTabsBar}>
          {creating ? (
            <h2 className={css.createTitle}>{t('New task')}</h2>
          ) : (
            <div className={css.detailTabs} role="tablist" aria-label={t('Task detail')}>
              {(['rule', 'records'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  className={css.detailTab}
                  onClick={() => { setTab(value); }}
                >
                  {t(value === 'rule' ? 'Rule' : 'Records')}
                </button>
              ))}
            </div>
          )}
          <div className={css.detailActions}>
            {entry !== undefined && (
              <>
                <Button
                  size="sm"
                  className={css.detailIconButton}
                  disabled={busy || dirty || entry.executionActive === true}
                  aria-label={t(entry.status === 'active' ? 'Pause' : 'Resume')}
                  onClick={() => { void toggleActive(); }}
                >
                  {entry.status === 'active' ? <IconPauseOutlineRegular /> : <IconPlayOutlineRegular />}
                </Button>
                <Menu
                  open={menuOpen}
                  onClose={() => { setMenuOpen(false); }}
                  align="end"
                  items={[
                    { id: 'run', label: t('Run now'), icon: <IconPlayOutlineRegular />, disabled: runBlocked },
                    { id: 'delete', label: t('Delete'), icon: <IconTrashOutlineRegular />, danger: true, disabled: busy || dirty },
                  ]}
                  onSelect={(id) => {
                    setMenuOpen(false);
                    if (id === 'run') void store.runSchedule(entry.id);
                    else setConfirmDelete(true);
                  }}
                  anchor={(
                    <Button
                      size="sm"
                      className={css.detailIconButton}
                      aria-label={t('More')}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      onClick={() => { setMenuOpen((value) => !value); }}
                    >
                      <IconEllipsisOutlineRegular />
                    </Button>
                  )}
                />
              </>
            )}
            <Button size="sm" className={css.detailIconButton} aria-label={t('Close')} disabled={saving} onClick={onClose}>
              <IconCloseOutlineRegular />
            </Button>
          </div>
        </div>

        <div className={clsx(css.detailScroll, tab === 'records' && css.detailRecords)}>
          {tab === 'records' && entry !== undefined ? (
            <div className={css.deliveryHistory}>
              {history === undefined && <p className={css.detailNotice}>{t('Loading delivery records…')}</p>}
              {history !== undefined && history.records.length === 0 && (
                <p className={css.detailNotice}>{t('No deliveries yet.')}</p>
              )}
              {history?.records.map((record) => (
                <article key={`${record.messageId}-${record.deliveredAt}`} className={css.delivery}>
                  <IconClockOutlineRegular className={css.deliveryGlyph} size={16} />
                  <div className={css.deliveryBody}>
                    <div className={css.deliveryHead}>
                      <time className={css.deliveryTime} dateTime={record.deliveredAt}>{formatAbsolute(record.deliveredAt, app.locale)}</time>
                      <span className={css.metadata}>{t('Session {id}', { id: shortId(record.targetSessionId) })}</span>
                    </div>
                    {record.prompt !== undefined && <p className={css.savedPrompt}>{record.prompt}</p>}
                  </div>
                </article>
              ))}
              {history?.nextBefore !== undefined && (
                <Button variant="outline" size="sm" onClick={() => { if (entry !== undefined) void store.loadScheduleHistory(entry.id, 20, history.nextBefore); }}>
                  {t('Load earlier records')}
                </Button>
              )}
            </div>
          ) : (
            <>
              {entry !== undefined && (
                <>
                  <header className={css.detailHeader}>
                    <h2 className={css.readonlyName}>{entry.title}</h2>
                  </header>
                  <div className={css.nextRun}>
                    <p>
                      {entry.status === 'active' ? (
                        <>
                          {t('Next run')}{' '}
                          <time dateTime={entry.scheduledAt}>{formatAbsolute(entry.scheduledAt, app.locale)}</time>{' '}
                          <span className={css.nextRunRelative}>{formatRelative(entry.scheduledAt, t)}</span>
                        </>
                      ) : t(entry.status === 'paused' ? 'Paused' : 'Ended')}
                    </p>
                  </div>
                  {entry.executionActive === true && <p className={css.detailNotice} role="status">{t('This task is running now.')}</p>}
                </>
              )}
              <fieldset className={css.taskEditor} disabled={busy}>
                <label className={css.editorField}>
                  {t('Name')}
                  <Input
                    value={draft.title}
                    maxLength={120}
                    aria-required
                    placeholder={t('Name this task')}
                    onChange={(event) => { change({ title: event.target.value }); }}
                  />
                </label>
                <label className={css.editorField}>
                  {t('Instruction')}
                  <textarea
                    className={css.instruction}
                    aria-required
                    placeholder={t('What should the agent do when this task runs?')}
                    value={draft.prompt}
                    onChange={(event) => { change({ prompt: event.target.value }); }}
                  />
                </label>
                <div className={css.ruleRows}>
                  <div className={css.ruleRow}>
                    <span className={css.ruleLabel}>{t('Destination')}</span>
                    <select
                      className={css.ruleInput}
                      value={draft.target}
                      onChange={(event) => {
                        const target = event.target.value as ScheduleDraft['target'];
                        change({
                          target,
                          cwd: target === 'session' ? '' : draft.cwd || defaultWorkspace?.path || '',
                          sessionId: target === 'session'
                            ? (entry?.target.kind === 'session' ? entry.target.sessionId : draft.sessionId)
                            : draft.sessionId,
                        });
                      }}
                    >
                      {entry?.target.kind === 'session' && (
                        <option value="session">{t('Current conversation')}</option>
                      )}
                      <option value="new_once">{t('New conversation (first run)')}</option>
                      <option value="new">{t('New conversation (every run)')}</option>
                    </select>
                  </div>
                  {draft.target !== 'session' && app.workspaces.length > 0 && (
                    <div className={css.ruleRow}>
                      <span className={css.ruleLabel}>{t('Project')}</span>
                      <select
                        className={css.ruleInput}
                        value={draft.cwd}
                        onChange={(event) => { change({ cwd: event.target.value }); }}
                      >
                        {app.workspaces.map((workspace) => (
                          <option key={workspace.id} value={workspace.path}>{workspace.name || workspace.path}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className={css.ruleRow}>
                    <span className={css.ruleLabel}>{t('Repeat')}</span>
                    <select
                      className={css.ruleInput}
                      value={draft.frequency}
                      onChange={(event) => {
                        const frequency = event.target.value as FrequencyPreset;
                        change({ frequency });
                      }}
                    >
                      {FREQUENCIES.map((frequency) => (
                        <option key={frequency.id} value={frequency.id}>{t(frequency.label)}</option>
                      ))}
                    </select>
                  </div>
                  {draft.frequency !== 'once' && draft.frequency !== 'advanced' && (
                    <div className={css.ruleRow}>
                      <span className={css.ruleLabel}>{t('Interval')}</span>
                      <input
                        className={css.ruleInput}
                        type="number"
                        min={1}
                        value={draft.interval}
                        onChange={(event) => { change({ interval: event.target.value }); }}
                      />
                    </div>
                  )}
                  {draft.frequency === 'weekly' && (
                    <div className={css.ruleRow}>
                      <span className={css.ruleLabel}>{t('Weekdays')}</span>
                      <div className={css.ruleWeekdays}>
                        {WEEKDAYS.map((day, index) => {
                          const value = index + 1;
                          const selected = draft.weekdays.includes(value);
                          return (
                            <button
                              key={day}
                              type="button"
                              className={clsx(css.filterTab, selected && css.filterTabActive)}
                              aria-pressed={selected}
                              onClick={() => {
                                change({
                                  weekdays: selected
                                    ? draft.weekdays.filter((item) => item !== value)
                                    : [...draft.weekdays, value].sort(),
                                });
                              }}
                            >
                              {t(day.slice(0, 3))}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {draft.frequency === 'monthly' && (
                    <div className={css.ruleRow}>
                      <span className={css.ruleLabel}>{t('Day of month')}</span>
                      <input
                        className={css.ruleInput}
                        type="number"
                        min={1}
                        max={31}
                        value={draft.monthDay}
                        onChange={(event) => { change({ monthDay: Number(event.target.value) }); }}
                      />
                    </div>
                  )}
                  {draft.frequency === 'once' && (
                    <div className={css.ruleRow}>
                      <span className={css.ruleLabel}>{t('Date')}</span>
                      <input
                        className={css.ruleInput}
                        type="date"
                        value={draft.start.slice(0, 10)}
                        onChange={(event) => { change({ start: `${event.target.value}T${clock}` }); }}
                      />
                    </div>
                  )}
                  {draft.frequency !== 'advanced' && draft.frequency !== 'minutely' && draft.frequency !== 'hourly' && (
                    <div className={css.ruleRow}>
                      <span className={css.ruleLabel}>{t('Time')}</span>
                      <input
                        className={css.ruleInput}
                        type="time"
                        step={draft.frequency === 'daily' ? 60 : 1}
                        value={clock.slice(0, 8)}
                        onChange={(event) => {
                          const value = event.target.value.length === 5 ? `${event.target.value}:00` : event.target.value;
                          change(draft.frequency === 'daily'
                            ? { dailyTime: value.slice(0, 5) }
                            : { start: `${draft.start.slice(0, 10)}T${value}` });
                        }}
                      />
                    </div>
                  )}
                  <div className={css.ruleRow}>
                    <span className={css.ruleLabel}>{t('Time zone')}</span>
                    <input
                      className={css.ruleInput}
                      value={timeZone}
                      onChange={(event) => { change({ timeZone: event.target.value }); }}
                    />
                  </div>
                </div>
                {draft.frequency === 'advanced' && (
                  <label className={css.editorField}>
                    {t('Custom rule')}
                    <textarea
                      className={css.instruction}
                      placeholder={'*/5 * * * *\n\n— or —\n\nDTSTART;TZID=Asia/Shanghai:20260101T090000\nRRULE:FREQ=DAILY'}
                      value={draft.rrule}
                      onChange={(event) => { change({ rrule: event.target.value }); }}
                    />
                  </label>
                )}
                {issue !== undefined && issue !== 'incomplete' && <p className={css.saveFailure} role="status">{t(issue)}</p>}
              </fieldset>
            </>
          )}
        </div>

        {(tab === 'rule' || dirty) && (
          <footer className={css.saveFooter}>
            <span className={css.saveNotice}>{dirty ? t('Unsaved changes') : ''}</span>
            <Button
              disabled={busy || (entry !== undefined && !dirty)}
              onClick={() => { setDraft(initial); if (creating) onClose(); }}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !dirty || !valid || (entry !== undefined && entry.executionActive === true)}
              onClick={() => { void save(); }}
            >
              {saving ? t(creating ? 'Creating…' : 'Saving…') : t(creating ? 'Create task' : 'Save')}
            </Button>
          </footer>
        )}
      </aside>

      <Modal
        open={confirmDelete}
        title={t('Delete this task?')}
        description={t('The task and its saved delivery records are removed. The target conversation is not deleted.')}
        closeLabel={t('Close')}
        onClose={() => { setConfirmDelete(false); }}
        footer={(
          <div className={css.confirmActions}>
            <Button variant="outline" onClick={() => { setConfirmDelete(false); }}>{t('Cancel')}</Button>
            <Button
              variant="outline"
              className={css.deleteButton}
              disabled={busy}
              onClick={() => {
                if (entry === undefined) return;
                setConfirmDelete(false);
                void store.deleteSchedule(entry.id, entry.updatedAt ?? null).then((ok) => { if (ok) onDeleted?.(); });
              }}
            >
              {t('Delete')}
            </Button>
          </div>
        )}
      >
        <p className={css.confirmPrompt}>{entry?.prompt}</p>
      </Modal>
    </>
  );
}
