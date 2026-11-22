import { type CSSProperties, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from '../../vendor/primitives/index.ts';
import type { ContextEstimate } from '../lib/wire.ts';
import { contextOccupancy, READING_SLOT, splitReadingSentence } from '../lib/context-reading.ts';
import { formatTokens } from '../lib/session-readings.ts';
import { translator, type Locale } from '../lib/i18n.ts';
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.tsx';
import css from '../styles/dsh/context-meter.module.css';

interface Props {
  workspaceId: string | null;
  /**
   * The reading the host published for this session: carried by the session
   * detail response and then by the turn stream (`run.context`). The meter never
   * asks for it, so nothing here polls or races a turn.
   */
  value: ContextEstimate | null;
  locale: Locale;
}

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The open panel: headline reading, the `~X / Y` figures, the breakdown, and the
 * note that names what `Y` is. Exported so the empty states can be rendered
 * directly — a portal only exists after a click, which server rendering has no
 * way to produce.
 */
export function ContextMeterPanel({ value, locale, panelRef, style }: {
  value: ContextEstimate | null;
  locale: Locale;
  panelRef?: MutableRefObject<HTMLDivElement | null>;
  style?: CSSProperties;
}): ReactNode {
  const t = translator(locale);
  const { percent, projection, capacity } = contextOccupancy(value);
  // The reading carries its own sign, so the sentence template never appends
  // one — otherwise the placeholder would render as `7%%`.
  const reading = `${percent}%`;
  const [headBefore, headAfter] = splitReadingSentence(
    t('{percent} of context used', { percent: READING_SLOT }),
  );
  const denominatorNote = t('The denominator is this session’s model window.');
  const rows = projection === undefined ? [] : [
    { key: 'system', label: t('System prompt'), tokens: projection.breakdown.systemTokens, color: css.colorSystem },
    { key: 'tools', label: t('Tool definitions'), tokens: projection.breakdown.toolsTokens, color: css.colorTools },
    { key: 'messages', label: t('Conversation messages'), tokens: projection.breakdown.messageTokens, color: css.colorMessages },
  ];
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  const segments = total > 0
    ? rows.map((row) => ({ key: row.key, color: row.color, width: percent * row.tokens / total }))
    : [{ key: 'total', color: '', width: percent }];

  return (
    <div ref={panelRef} className={css.panel} style={style ?? MEASURE_STYLE} role="dialog"
      aria-label={t('Context usage')}>
      <div className={css.header}>
        <span className={css.headline}>{headBefore}</span>
        <span className={css.percent}>{reading}</span>
        <span className={css.headline}>{headAfter}</span>
        {projection !== undefined && capacity !== undefined && (
          // `Y` is the window the compaction budget is taken from, not the
          // session's cumulative token spend shown by the pill next door.
          <span className={css.figures} title={denominatorNote} aria-label={denominatorNote}>
            {`~${formatTokens(projection.projectedTokens, t)} / ${formatTokens(capacity, t)}`}
          </span>
        )}
      </div>
      {projection === undefined && (
        <p className={css.hint}>{t('No reading yet.')}</p>
      )}
      {projection !== undefined && capacity === undefined && (
        <p className={css.hint}>{t('This model has no known context window.')}</p>
      )}
      {projection !== undefined && (
        <>
          <div className={css.bar}>
            {segments.filter((segment) => segment.width > 0).map((segment) => (
              <div key={segment.key} className={segment.color === '' ? css.segment : `${css.segment} ${segment.color}`}
                style={{ width: `${segment.width}%` }} />
            ))}
          </div>
          <dl className={css.rows}>
            {rows.map((row) => (
              <div key={row.key} className={css.row}>
                <dt><span className={`${css.swatch} ${row.color}`} aria-hidden />{row.label}</dt>
                <dd>{`~${formatTokens(row.tokens, t)}`}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {projection !== undefined && capacity !== undefined && (
        <p className={css.hint} role="note">{denominatorNote}</p>
      )}
    </div>
  );
}

/**
 * Composer context-occupancy meter: a ring and percentage below the card, with a
 * click-open panel breaking the projection into system prompt, tools and
 * conversation.
 *
 * The reading is bound to one session and arrives from the host: the session
 * detail response carries it on open, and a running turn pushes a `run.context`
 * frame at every step boundary — the boundary at which the next request's layout
 * changes. Nothing in this component requests, polls or retries; a turn owned by
 * another host simply pushes nothing, and the last settled reading stays.
 *
 * Every state has a visible value: a draft or a session whose first answer has
 * not arrived reads 0% with a "no reading yet" note rather than disappearing.
 *
 * The percentage is occupancy of **this session's model window**, not the
 * session's cumulative token spend; the panel says so, because the two numbers
 * sit next to each other in the composer and read alike.
 */
export function ContextMeter({ workspaceId, value, locale }: Props): ReactNode {
  const seat = useStatDialog();
  const t = translator(locale);
  // A workspace without a selected session (the new-session draft included)
  // still renders the ring at 0%, so nothing appears late and nothing jumps.
  if (workspaceId === null) return null;

  const { percent, settled } = contextOccupancy(value);
  const reading = `${percent}%`;
  const sentence = settled
    ? t('{percent} of context used', { percent: reading })
    : t('No reading yet.');

  return (
    <span ref={seat.rootRef} className={css.root}>
      <Tooltip label={sentence} side="top" delayMs={200} disabled={seat.open} portal>
        <button type="button" className={css.trigger} aria-label={sentence} aria-haspopup="dialog"
          aria-expanded={seat.open} onClick={() => { seat.setOpen(!seat.open); }}>
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={css.track} cx="7" cy="7" r={RADIUS} />
            <circle className={css.fill} cx="7" cy="7" r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />
          </svg>
          <span>{reading}</span>
        </button>
      </Tooltip>
      {seat.open && createPortal(
        <ContextMeterPanel value={value} locale={locale} panelRef={seat.panelRef} style={seat.pos ?? MEASURE_STYLE} />,
        document.body,
      )}
    </span>
  );
}
