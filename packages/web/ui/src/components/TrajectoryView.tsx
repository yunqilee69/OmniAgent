import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Input,
  SegmentedTabs,
  StateDot,
} from '../../vendor/primitives/index.ts';
import { useApp, useSessionEntry } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import { SelectMenu } from './SelectMenu.tsx';
import {
  eventCategory,
  eventSummary,
  formatDate,
  ledgerEvents,
  recordLabel,
  recordMetadata,
  trajectoryModel,
  type LedgerEvent,
  type TrajectorySpan,
} from '../lib/trajectory.ts';
import type { TrajectoryRecord } from '../lib/wire.ts';
import css from '../styles/trajectory.module.css';

type LedgerView = 'records' | 'events';

function metadataValue(label: string, value: string | number | boolean): string {
  if (label === 'Timestamp' || label.endsWith('recorded at')) return formatDate(value, true);
  return String(value);
}

export function TrajectoryView(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const entry = useSessionEntry();
  const [view, setView] = useState<LedgerView>('records');
  const [scale, setScale] = useState<'sequence' | 'time'>('sequence');
  const [filter, setFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);

  const model = useMemo(() => trajectoryModel(entry?.trajectory, scale), [entry?.trajectory, scale]);
  const events = useMemo(() => ledgerEvents(entry?.events ?? [], entry?.audit ?? []), [entry?.events, entry?.audit]);
  const needle = query.trim().toLowerCase();

  const visibleRecords = model.records.filter((record) => {
    if (view === 'events') return true;
    if (filter !== 'all' && (record.kind === 'tool' ? 'tools' : record.kind) !== filter) return false;
    return needle === '' || Object.values(recordMetadata(record)).join(' ').toLowerCase().includes(needle);
  });
  const visibleEvents = events.filter((item) => {
    if (filter !== 'all' && eventCategory(item.metadata) !== filter) return false;
    return needle === '' || (Object.values(item.metadata).join(' ') + ' ' + eventSummary(item.metadata) + ' ' + eventCategory(item.metadata)).toLowerCase().includes(needle);
  });

  if (app.workspaceId === null || app.sessionId === null) {
    return <div className={css.empty}><span aria-hidden>◈</span><strong>{t('No session selected')}</strong><p>{t('Select a session to inspect its trajectory.')}</p></div>;
  }
  if (entry === null || !entry.loaded) {
    return <div className={css.empty}><span aria-hidden>◌</span><strong>{entry?.error ? t('Session unavailable') : t('Loading session')}</strong><p>{entry?.error ?? t('Retrieving session history.')}</p></div>;
  }

  const visibleIds = new Set(visibleRecords.map((record) => record.id));
  const timelineSpans = model.spans.filter((span) => visibleIds.has(span.record.id));
  const start = timelineSpans.length === 0 ? 0 : Math.min(...timelineSpans.map((span) => span.start));
  const end = timelineSpans.length === 0 ? 1 : Math.max(...timelineSpans.map((span) => span.end));
  const width = Math.max(1, end - start);
  const selected = view === 'records'
    ? model.records.find((record) => record.id === selectedRecord)
    : events.find((item) => item.id === selectedEvent);
  const metadata = selected === undefined
    ? null
    : view === 'records' ? recordMetadata(selected as TrajectoryRecord) : (selected as LedgerEvent).metadata;
  const title = selected === undefined ? '' : view === 'records' ? recordLabel(selected as TrajectoryRecord) : String((selected as LedgerEvent).metadata.Type ?? '');

  const categoryOptions: Array<{ value: string; label: string }> = view === 'records'
    ? [{ value: 'all', label: t('All') }, { value: 'input', label: t('Input') }, { value: 'model', label: t('Model') }, { value: 'tools', label: t('Tools') }]
    : [{ value: 'all', label: t('All') }, { value: 'lifecycle', label: t('Lifecycle') }, { value: 'tools', label: t('Tools') }, { value: 'audit', label: t('Audit') }, { value: 'errors', label: t('Errors') }];

  return (
    <div className={css.root}>
      <div className={css.toolbar}>
        <SegmentedTabs
          items={[
            { value: 'records', label: t('Records'), id: 'trajectory-records', panelId: 'trajectory-records-panel' },
            { value: 'events', label: t('Events'), id: 'trajectory-events', panelId: 'trajectory-events-panel' },
          ]}
          value={view}
          onChange={(value) => { setView(value); setFilter('all'); setQuery(''); }}
          label={t('Trajectory view')}
          size="sm"
        />
        <SelectMenu
          value={filter}
          items={categoryOptions.map((option) => ({ id: option.value, label: option.label }))}
          onSelect={setFilter}
          ariaLabel={t('Filter')}
          triggerClassName={css.select}
          chevronClassName={css.selectChevron}
        >
          {categoryOptions.find((option) => option.value === filter)?.label ?? t('All')}
        </SelectMenu>
        <Input
          className={css.search}
          value={query}
          placeholder={view === 'records' ? t('Search records') : t('Search events')}
          onChange={(event) => { setQuery(event.target.value); }}
        />
        {view === 'records' && (
          <SegmentedTabs
            items={[
              { value: 'sequence', label: t('Sequence'), id: 'scale-sequence', panelId: 'scale-sequence-panel' },
              { value: 'time', label: t('Time'), id: 'scale-time', panelId: 'scale-time-panel' },
            ]}
            value={scale}
            onChange={(value) => { setScale(value); }}
            label={t('Timeline scale')}
            size="sm"
          />
        )}
        <span className={css.count}>
          {view === 'records'
            ? t('{shown} of {total} records', { shown: visibleRecords.length, total: model.records.length })
            : t('{shown} of {total} events', { shown: visibleEvents.length, total: events.length })}
        </span>
      </div>

      <div className={css.timelineCard}>
        <div className={css.timelineTrack}>
          {timelineSpans.length === 0 && (
            <span className={css.timelineEmpty}>{scale === 'time' ? t('No recorded timing') : t('No records')}</span>
          )}
          {timelineSpans.map((span: TrajectorySpan) => (
            <button
              key={`${span.record.id}-${span.lane}`}
              type="button"
              className={clsx(css.span, css[span.lane], view === 'records' && selectedRecord === span.record.id && css.spanSelected)}
              style={{ left: `${((span.start - start) / width) * 100}%`, width: `${Math.max(0.5, ((span.end - span.start) / width) * 100)}%` }}
              title={recordLabel(span.record)}
              aria-label={t('Inspect {label}', { label: recordLabel(span.record) })}
              onClick={() => { setView('records'); setSelectedRecord(span.record.id); }}
            />
          ))}
        </div>
        <div className={css.lanes}>
          {timelineSpans.length > 0 && (
            <>
              <span className={css.laneLine} data-lane="input" />
              <span className={css.laneLine} data-lane="model" />
              <span className={css.laneLine} data-lane="tools" />
            </>
          )}
        </div>
      </div>

      <div className={css.content}>
        <div className={css.tableCard}>
          <div className={css.tableHead}>
            <span>{view === 'records' ? t('Kind') : t('Event')}</span>
            <span>{t('Seq')}</span>
            <span>{view === 'records' ? t('Record') : t('Summary')}</span>
            <span>{t('Time')}</span>
          </div>
          <div className={css.rows}>
            {view === 'records' ? visibleRecords.map((record) => (
              <button
                key={record.id}
                type="button"
                className={clsx(css.row, selectedRecord === record.id && css.rowSelected)}
                aria-selected={selectedRecord === record.id}
                onClick={() => { setSelectedRecord(record.id); }}
              >
                <span className={clsx(css.kind, record.kind === 'input' ? css.kindInput : record.kind === 'model' ? css.kindModel : css.kindTool)}>{record.kind === 'tool' ? t('Tool') : record.kind === 'model' ? t('Model') : t('Input')}</span>
                <span className={css.mono}>{record.seq ?? '—'}</span>
                <span className={css.rowMain}>
                  <span className={css.rowTitle}>{recordLabel(record)}</span>
                  {record.kind === 'tool' && record.ok === false && <StateDot state="error" />}
                  {record.durationMs !== undefined && record.durationMs !== null && <span className={css.rowMeta}>{record.durationMs} ms</span>}
                </span>
                <span className={css.mono}>{formatDate(record.timestamp, false)}</span>
              </button>
            )) : visibleEvents.map((item) => {
              const category = eventCategory(item.metadata);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={clsx(css.row, selectedEvent === item.id && css.rowSelected)}
                  aria-selected={selectedEvent === item.id}
                  onClick={() => { setSelectedEvent(item.id); }}
                >
                  <span className={clsx(css.kind, category === 'audit' ? css.catAudit : category === 'errors' ? css.catErrors : category === 'tools' ? css.catTools : css.catLifecycle)}>{category === 'audit' ? t('Audit') : category === 'errors' ? t('Error') : category === 'tools' ? t('Tool') : t('Lifecycle')}</span>
                  <span className={css.mono}>{item.metadata.Sequence ?? '—'}</span>
                  <span className={css.rowMain}>
                    <span className={css.rowTitle}>{String(item.metadata.Type ?? '')}</span>
                    {eventSummary(item.metadata) !== '' && <span className={css.rowMeta}>{eventSummary(item.metadata)}</span>}
                  </span>
                  <span className={css.mono}>{formatDate(item.metadata.Timestamp, false)}</span>
                </button>
              );
            })}
            {(view === 'records' ? visibleRecords.length : visibleEvents.length) === 0 && (
              <div className={css.rowsEmpty}>
                {view === 'records'
                  ? !entry.trajectory ? t('Trajectory is not available for this session.') : t('No records match these filters.')
                  : events.length === 0 ? t('No events in this session.') : t('No events match these filters.')}
              </div>
            )}
          </div>
        </div>

        <aside className={css.inspector} aria-label={t('Trajectory inspector')}>
          <div className={css.inspectorHead}>
            <span>{view === 'records' ? t('Record inspector') : t('Event inspector')}</span>
          </div>
          {selected === undefined || metadata === null ? (
            <div className={css.inspectorEmpty}>
              {view === 'records'
                ? t('Select a record to inspect its metadata.')
                : t('Select an event to inspect its metadata.')}
            </div>
          ) : (
            <>
              <div className={css.inspectorTitle}>{title}</div>
              <dl className={css.metadata}>
                {Object.entries(metadata).map(([label, value]) => (
                  <div key={label} className={css.metadataRow}>
                    <dt>{t(label)}</dt>
                    <dd>{metadataValue(label, value)}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
