import { type ReactNode } from 'react';
import { IconDatabaseOutlineRegular, IconGaugeOutlineRegular } from '../../vendor/primitives/index.ts';
import { useApp } from '../lib/store.ts';
import type { SessionEntry } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import css from '../styles/dsh/session-stats.module.css';

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(value);
}

export function SessionStats({ entry }: { entry: SessionEntry | null }): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const stats = entry?.run?.metrics ?? entry?.metrics;
  if (stats == null || (stats.runs.started === 0 && stats.steps.started === 0)) return null;

  const rate = stats.throughput.count > 0 && stats.throughput.durationMs > 0
    ? (stats.throughput.outputTokens * 1000 / stats.throughput.durationMs).toFixed(1)
    : '—';
  const input = stats.usage.inputTokens === null ? '—' : compact(stats.usage.inputTokens);
  const output = stats.usage.outputTokens === null ? '—' : compact(stats.usage.outputTokens);
  const cache = stats.cache.count > 0 && stats.cache.inputTokens > 0
    ? `${(stats.cache.cachedInputTokens * 100 / stats.cache.inputTokens).toFixed(1)}%`
    : '—';
  return (
    <div className={css.root} data-composer-stats="">
      <span className={css.pill}>
        <IconGaugeOutlineRegular size={14} />
        <span>{t('{turns} turns {steps} steps', { turns: stats.runs.started, steps: stats.steps.started })}</span>
      </span>
      <span className={css.pill}>{rate} tok/s</span>
      <span className={css.pill}>
        <IconDatabaseOutlineRegular size={14} />
        <span>{t('Input {input} · Output {output} tokens · Cache {cache}', { input, output, cache })}</span>
      </span>
    </div>
  );
}
