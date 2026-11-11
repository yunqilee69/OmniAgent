import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from '../../vendor/primitives/index.ts';
import { authFetch } from '../lib/auth.ts';
import { sessionApiPath, validateContextEstimate, type ContextEstimate } from '../lib/wire.ts';
import { formatTokens } from '../lib/session-readings.ts';
import { translator, type Locale } from '../lib/i18n.ts';
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.tsx';
import css from '../styles/dsh/context-meter.module.css';

interface Props {
  workspaceId: string | null;
  sessionId: string | null;
  draft: boolean;
  /** Turns and model edits only re-trigger the poll; they never unmount the ring. */
  busy: boolean;
  modelSaving: boolean;
  modelKey: string;
  locale: Locale;
}

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Poll cadence for a live session; the projection moves only when a turn settles. */
const POLL_MS = 5000;

/**
 * Marker the localized occupancy sentence is split on, so the panel headline
 * keeps the reading in its own tone while each locale still owns the word order
 * (`45% of context used` / `上下文已用 45%`).
 */
const READING_SLOT = '\0';

/**
 * Composer context-occupancy meter: a ring and percentage below the card, with a
 * click-open panel breaking the projection into system prompt, tools and
 * conversation.
 *
 * The reading is bound to one scope (workspace + session + model source) and is
 * only dropped when that scope changes. A new turn, a poll, or a failed request
 * updates the numbers in place; blanking the meter on those transients made the
 * ring disappear and remount between turns.
 */
export function ContextMeter({ workspaceId, sessionId, draft, busy, modelSaving, modelKey, locale }: Props): ReactNode {
  const [snapshot, setSnapshot] = useState<{ scope: string; value: ContextEstimate } | null>(null);
  const seat = useStatDialog();
  const scope = JSON.stringify([workspaceId, sessionId, modelKey]);
  const previousScope = useRef(scope);

  // A different session or model source invalidates the reading; everything
  // else keeps the last numbers on screen until a fresher projection lands.
  useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    setSnapshot(null);
    seat.setOpen(false);
  }, [scope, seat.setOpen]);

  const pollable = workspaceId !== null && sessionId !== null && !draft && !modelSaving;
  useEffect(() => {
    if (!pollable || workspaceId === null || sessionId === null) return;
    let current = true;
    let loaded = false;
    let controller: AbortController | null = null;
    const load = (): void => {
      // One reading per effect run is enough while a turn is streaming: the
      // occupancy cannot settle mid-turn, and re-estimating a long history
      // every five seconds would cost more than it tells.
      if (busy && loaded) return;
      loaded = true;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      void authFetch(sessionApiPath(workspaceId, sessionId, 'context'), { signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('Context request failed');
          return validateContextEstimate(await response.json());
        })
        .then((value) => { if (current && !signal.aborted) setSnapshot({ scope, value }); })
        // A failed or aborted poll leaves the previous reading in place.
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => { current = false; controller?.abort(); window.clearInterval(timer); };
  }, [pollable, workspaceId, sessionId, scope, busy, modelSaving]);

  const t = translator(locale);
  const value = snapshot !== null && snapshot.scope === scope ? snapshot.value : null;
  const projection = value?.projection;
  const capacity = value?.modelWindow;
  const usedTokens = projection?.projectedTokens;
  if (projection === undefined || capacity === undefined || usedTokens === undefined || capacity <= 0) return null;

  const percent = Math.min(100, Math.round(usedTokens / capacity * 100));
  const reading = `${percent}%`;
  const sentence = t('{percent}% of context used', { percent: reading });
  const [headBefore = '', headAfter = ''] = t('{percent}% of context used', { percent: READING_SLOT })
    .split(READING_SLOT).map((part) => part.trim());
  const rows = [
    { key: 'system', label: t('System prompt'), tokens: projection.breakdown.systemTokens, color: css.colorSystem },
    { key: 'tools', label: t('Tool definitions'), tokens: projection.breakdown.toolsTokens, color: css.colorTools },
    { key: 'messages', label: t('Conversation messages'), tokens: projection.breakdown.messageTokens, color: css.colorMessages },
  ];
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  const segments = total > 0
    ? rows.map((row) => ({ key: row.key, color: row.color, width: percent * row.tokens / total }))
    : [{ key: 'total', color: '', width: percent }];

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
        <div ref={seat.panelRef} className={css.panel} style={seat.pos ?? MEASURE_STYLE} role="dialog"
          aria-label={t('Context usage')}>
          <div className={css.header}>
            <span className={css.headline}>{headBefore}</span>
            <span className={css.percent}>{reading}</span>
            <span className={css.headline}>{headAfter}</span>
            <span className={css.figures}>
              {`~${formatTokens(usedTokens, t)} / ${formatTokens(capacity, t)}`}
            </span>
          </div>
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
        </div>,
        document.body,
      )}
    </span>
  );
}
