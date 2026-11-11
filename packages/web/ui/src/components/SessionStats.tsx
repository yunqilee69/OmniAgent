import { memo, type ReactNode } from 'react';
import {
  IconDatabaseOutlineRegular,
  IconGaugeOutlineRegular,
  Tooltip,
} from '../../vendor/primitives/index.ts';
import { useApp } from '../lib/store.ts';
import type { SessionEntry } from '../lib/store.ts';
import type { SessionMetrics } from '../lib/session-metrics.ts';
import { translator, type Locale, type Translate } from '../lib/i18n.ts';
import {
  formatCacheHitPercent, formatDuration, formatExactTokens, formatTokens, formatTokensPerSecond,
} from '../lib/session-readings.ts';
import { StatDialogChrome, useStatDialog } from './stat-dialog.tsx';
import css from '../styles/dsh/stats-pills.module.css';
import dialogCss from '../styles/dsh/stat-dialog.module.css';

/** The full reading above a pill, only while an ellipsis cuts its label. */
const FULL_READING_TOOLTIP = {
  side: 'top',
  portal: true,
  delayMs: 200,
  onlyWhenClipped: true,
} as const;

/** One or two reading segments, visually joined by a separator glyph. */
function reading(first: string, second: string | null): { label: ReactNode; text: string } {
  if (second === null) return { label: first, text: first };
  return {
    label: (
      <>
        {first}
        <span className={css.sep} aria-hidden>·</span>
        {second}
      </>
    ),
    text: `${first} · ${second}`,
  };
}

/** A static reading: used when the pill has no dialog rows. */
function PlainPill({ stat, icon, label, text }: {
  stat: string; icon: ReactNode; label: ReactNode; text: string;
}): ReactNode {
  return (
    <span className={css.anchor} data-composer-stat={stat}>
      <Tooltip label={text} {...FULL_READING_TOOLTIP} openOnClick>
        <span className={css.pill}>{icon}<span className={css.label}>{label}</span></span>
      </Tooltip>
    </span>
  );
}

/**
 * A pill button opening its own portaled dialog. Each pill owns its open state,
 * so at most one reading dialog is open across the dock.
 */
function DialogPill({ stat, icon, label, text, title, titleValue, details }: {
  stat: string; icon: ReactNode; label: ReactNode; text: string;
  title: string; titleValue: string; details: ReactNode;
}): ReactNode {
  const seat = useStatDialog();
  return (
    <span ref={seat.rootRef} className={css.anchor} data-composer-stat={stat}>
      <Tooltip label={text} {...FULL_READING_TOOLTIP} disabled={seat.open}>
        <button type="button" className={css.pill} aria-haspopup="dialog" aria-expanded={seat.open}
          aria-label={text} onClick={() => { seat.setOpen(!seat.open); }}>
          {icon}
          <span className={css.label}>{label}</span>
        </button>
      </Tooltip>
      {seat.open && (
        <StatDialogChrome seat={seat} label={title} title={title} titleValue={titleValue} icon={icon}>
          {details}
        </StatDialogChrome>
      )}
    </span>
  );
}

/** Turn and step counts with whole-session speed, opening the timing dialog. */
const ActivityPill = memo(function ActivityPill({ stats, t }: { stats: SessionMetrics; t: Translate }): ReactNode {
  const counts = t('{turns} turns {steps} steps', { turns: stats.runs.started, steps: stats.steps.started });
  const speed = stats.throughput.durationMs > 0
    ? formatTokensPerSecond(stats.throughput.outputTokens * 1000 / stats.throughput.durationMs)
    : null;
  const speedText = speed === null ? null : t('{tps} tok/s', { tps: speed });
  const icon = <IconGaugeOutlineRegular />;
  if (stats.steps.started === 0) return null;
  const content = { stat: 'activity', icon, ...reading(counts, speedText) };
  const llmMs = stats.requests.durationMs ?? 0;
  if (llmMs <= 0 && stats.tools.durationMs <= 0 && stats.ttft.count === 0 && speedText === null) {
    return <PlainPill {...content} />;
  }
  return (
    <DialogPill {...content} title={t('Session statistics')} titleValue={counts}
      details={(
        <dl className={dialogCss.details} data-session-stats-details>
          {llmMs > 0 && <><dt>{t('LLM time')}</dt><dd>{formatDuration(llmMs, t)}</dd></>}
          {stats.tools.durationMs > 0 && <><dt>{t('Tool time')}</dt><dd>{formatDuration(stats.tools.durationMs, t)}</dd></>}
          {stats.ttft.count > 0 && (
            <>
              <dt>{t('Avg time to first token (TTFT)')}</dt>
              <dd>{formatDuration(stats.ttft.durationMs / stats.ttft.count, t)}</dd>
            </>
          )}
          {speedText !== null && <><dt>{t('Tokens per second (TPS)')}</dt><dd>{speedText}</dd></>}
        </dl>
      )} />
  );
});

/** Whole-log token total and cache hit, opening the accounting dialog. */
const UsagePill = memo(function UsagePill({ stats, locale, t }: {
  stats: SessionMetrics; locale: Locale; t: Translate;
}): ReactNode {
  const prompt = stats.usage.inputTokens;
  const output = stats.usage.outputTokens;
  if (prompt === null && (output === null || output === 0)) return null;
  const promptTokens = prompt ?? 0;
  const outputTokens = output ?? 0;
  const cachedInput = stats.cache.count > 0 ? stats.cache.cachedInputTokens : null;
  const uncachedInput = cachedInput === null ? null : Math.max(0, promptTokens - cachedInput);
  const total = promptTokens + outputTokens;
  const cacheHit = cachedInput === null ? null : formatCacheHitPercent(cachedInput, promptTokens);
  const cacheHitText = cacheHit === null ? null : t('Cache hit {percent}%', { percent: cacheHit });
  const icon = <IconDatabaseOutlineRegular />;
  return (
    <DialogPill stat="usage" icon={icon}
      {...reading(t('{count} tok', { count: formatTokens(total, t) }), cacheHitText)}
      title={t('Token usage')} titleValue={t('{count} tok', { count: formatExactTokens(total, locale) })}
      details={(
        <dl className={dialogCss.details} data-session-stats-usage>
          {cacheHit !== null && <><dt>{t('Cache hit')}</dt><dd>{cacheHit}%</dd></>}
          {uncachedInput !== null && (
            <><dt>{t('Uncached input')}</dt><dd>{t('{count} tok', { count: formatExactTokens(uncachedInput, locale) })}</dd></>
          )}
          {cachedInput !== null && (
            <><dt>{t('Cached input')}</dt><dd>{t('{count} tok', { count: formatExactTokens(cachedInput, locale) })}</dd></>
          )}
          {output !== null && (
            <><dt>{t('Output')}</dt><dd>{t('{count} tok', { count: formatExactTokens(output, locale) })}</dd></>
          )}
        </dl>
      )} />
  );
});

/**
 * Composer readings below the input card: what the session spent (tokens and
 * cache), and how long it took (model, tools, first token, decode speed).
 */
export function SessionStats({ entry }: { entry: SessionEntry | null }): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const stats = entry?.run?.metrics ?? entry?.metrics ?? null;
  if (stats === null) return null;
  return (
    <>
      <ActivityPill stats={stats} t={t} />
      <UsagePill stats={stats} locale={app.locale} t={t} />
    </>
  );
}
