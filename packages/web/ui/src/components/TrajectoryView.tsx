import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  Input,
  SegmentedTabs,
  StateDot,
  useClipboardCopy,
} from '../../vendor/primitives/index.ts';
import { useApp, useSessionEntry } from '../lib/store.ts';
import type { SessionEntry } from '../lib/store.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { SelectMenu } from './SelectMenu.tsx';
import {
  eventCategory,
  eventSummary,
  formatDate,
  ledgerEvents,
  recordLabel,
  recordMetadata,
  recordPreview,
  recordSearchText,
  recordSections,
  trajectoryModel,
  type LedgerEvent,
  type RecordSection,
  type TrajectorySpan,
} from '../lib/trajectory.ts';
import type { TrajectoryRecord } from '../lib/wire.ts';
import css from '../styles/trajectory.module.css';

type LedgerView = 'records' | 'events';

function metadataValue(label: string, value: string | number | boolean, t: Translate): string {
  if (label === 'Timestamp' || label.endsWith('recorded at')) return formatDate(value, true);
  if (typeof value === 'boolean') return value ? t('Yes') : t('No');
  return String(value);
}

function ContentSection({ section, t }: { section: RecordSection; t: Translate }): ReactNode {
  const { copied, failed, onCopy } = useClipboardCopy(section.value);
  const label = copied ? t('Copied') : failed ? t('Could not copy') : t('Copy');
  return (
    <section className={css.section}>
      <header className={css.sectionHead}>
        <span className={clsx(css.sectionLabel, section.tone === 'error' && css.sectionLabelError)}>{t(section.label)}</span>
        <button type="button" className={css.sectionCopy} aria-label={label} title={label} onClick={onCopy}>
          {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
        </button>
      </header>
      <pre className={clsx(css.sectionBody, section.mono && css.sectionBodyMono, section.tone === 'error' && css.sectionBodyError)}>{section.value}</pre>
    </section>
  );
}

export function TrajectoryView(): ReactNode {
  const app = useApp();
  const entry = useSessionEntry();
  return (
    <TrajectoryPanel
      entry={entry}
      t={translator(app.locale)}
      hasSession={app.workspaceId !== null && app.sessionId !== null}
    />
  );
}

export interface TrajectoryPanelProps {
  entry: SessionEntry | null;
  t: Translate;
  hasSession: boolean;
}

export function TrajectoryPanel({ entry, t, hasSession }: TrajectoryPanelProps): ReactNode {
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
    return needle === '' || recordSearchText(record).includes(needle);
  });
  const visibleEvents = events.filter((item) => {
    if (filter !== 'all' && eventCategory(item.metadata) !== filter) return false;
    return needle === '' || (Object.values(item.metadata).join(' ') + ' ' + eventSummary(item.metadata) + ' ' + eventCategory(item.metadata)).toLowerCase().includes(needle);
  });

  if (!hasSession) {
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
  // Land on the first record so content is readable without a click.
  const activeRecordId = selectedRecord ?? visibleRecords[0]?.id ?? model.records[0]?.id ?? null;
  const activeEventId = selectedEvent ?? visibleEvents[0]?.id ?? null;
  const record = view === 'records' ? model.records.find((item) => item.id === activeRecordId) : undefined;
  const event = view === 'events' ? events.find((item) => item.id === activeEventId) : undefined;
  const sections = record !== undefined
    ? recordSections(record)
    : event?.metadata.Message === undefined
      ? []
      : [{ label: 'Error message', value: String(event.metadata.Message), tone: 'error' as const, mono: false }];
  const metadata = record !== undefined
    ? recordMetadata(record)
    : event === undefined ? null : event.metadata;
  const title = record !== undefined ? recordLabel(record) : event === undefined ? '' : String(event.metadata.Type ?? '');

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
              className={clsx(css.span, css[span.lane], view === 'records' && activeRecordId === span.record.id && css.spanSelected)}
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
            {view === 'records' ? visibleRecords.map((record) => {
              const preview = recordPreview(record);
              return (
                <button
                  key={record.id}
                  type="button"
                  className={clsx(css.row, activeRecordId === record.id && css.rowSelected)}
                  aria-selected={activeRecordId === record.id}
                  onClick={() => { setSelectedRecord(record.id); }}
                >
                  <span className={clsx(css.kind, record.kind === 'input' ? css.kindInput : record.kind === 'model' ? css.kindModel : css.kindTool)}>{record.kind === 'tool' ? t('Tool') : record.kind === 'model' ? t('Model') : t('Input')}</span>
                  <span className={css.mono}>{record.seq ?? '—'}</span>
                  <span className={css.rowMain}>
                    <span className={css.rowHead}>
                      <span className={css.rowTitle}>{recordLabel(record)}</span>
                      {record.kind === 'tool' && record.ok === false && <StateDot state="error" />}
                      {record.durationMs !== undefined && record.durationMs !== null && <span className={css.rowMeta}>{record.durationMs} ms</span>}
                    </span>
                    {preview !== '' && <span className={clsx(css.rowPreview, record.kind === 'tool' && record.ok === false && css.rowPreviewError)}>{preview}</span>}
                  </span>
                  <span className={css.mono}>{formatDate(record.timestamp, false)}</span>
                </button>
              );
            }) : visibleEvents.map((item) => {
              const category = eventCategory(item.metadata);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={clsx(css.row, activeEventId === item.id && css.rowSelected)}
                  aria-selected={activeEventId === item.id}
                  onClick={() => { setSelectedEvent(item.id); }}
                >
                  <span className={clsx(css.kind, category === 'audit' ? css.catAudit : category === 'errors' ? css.catErrors : category === 'tools' ? css.catTools : css.catLifecycle)}>{category === 'audit' ? t('Audit') : category === 'errors' ? t('Error') : category === 'tools' ? t('Tool') : t('Lifecycle')}</span>
                  <span className={css.mono}>{item.metadata.Sequence ?? '—'}</span>
                  <span className={css.rowMain}>
                    <span className={css.rowHead}>
                      <span className={css.rowTitle}>{String(item.metadata.Type ?? '')}</span>
                    </span>
                    {eventSummary(item.metadata) !== '' && <span className={css.rowPreview}>{eventSummary(item.metadata)}</span>}
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
          {metadata === null ? (
            <div className={css.inspectorEmpty}>
              {view === 'records'
                ? t('Select a record to inspect its content and metadata.')
                : t('Select an event to inspect its metadata.')}
            </div>
          ) : (
            <>
              <div className={css.inspectorTitle}>{title}</div>
              <div className={css.inspectorBody}>
                {view === 'records' && sections.length === 0 && (
                  <p className={css.sectionEmpty}>{t('No content recorded for this record.')}</p>
                )}
                {sections.map((section) => <ContentSection key={section.label} section={section} t={t} />)}
                {record?.clipped === true && (
                  <p className={css.sectionNote}>{t('Long content is clipped to the first {limit} characters.', { limit: '8,000' })}</p>
                )}
                <dl className={css.metadata}>
                  {Object.entries(metadata).map(([label, value]) => (
                    <div key={label} className={css.metadataRow}>
                      <dt>{t(label)}</dt>
                      <dd>{metadataValue(label, value, t)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
