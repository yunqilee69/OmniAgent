import { useMemo, type ReactNode } from 'react';
import { IconDatabaseOutlineRegular, IconGaugeOutlineRegular } from '../../vendor/primitives/index.ts';
import { useApp } from '../lib/store.ts';
import type { SessionEntry } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import css from '../styles/dsh/session-stats.module.css';

interface Usage {
  input: number;
  output: number;
}

function usageOf(events: readonly unknown[]): Usage {
  const total: Usage = { input: 0, output: 0 };
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as { type?: unknown; data?: unknown; usage?: unknown };
    if (record.type !== 'message/assistant' && record.type !== 'assistant/message') continue;
    const data = typeof record.data === 'object' && record.data !== null
      ? record.data as { usage?: unknown }
      : undefined;
    const usage = typeof data?.usage === 'object' && data.usage !== null
      ? data.usage as { inputTokens?: unknown; outputTokens?: unknown }
      : typeof record.usage === 'object' && record.usage !== null
        ? record.usage as { inputTokens?: unknown; outputTokens?: unknown }
        : undefined;
    if (usage === undefined) continue;
    if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) total.input += Math.max(0, usage.inputTokens);
    if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) total.output += Math.max(0, usage.outputTokens);
  }
  return total;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(value);
}

/** Composer statistics row: turn/step counts and whole-session token volume. */
export function SessionStats({ entry }: { entry: SessionEntry | null }): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const stats = useMemo(() => {
    if (entry === null) return null;
    const source = entry.run ?? entry;
    const transcript = source.transcript;
    const assistantSteps = transcript.filter((item) => item.kind === 'assistant').length;
    const eventSteps = entry.events.filter((event) => {
      if (typeof event !== 'object' || event === null) return false;
      const type = (event as { type?: unknown }).type;
      return type === 'message/assistant' || type === 'assistant/message';
    }).length;
    const steps = Math.max(assistantSteps, eventSteps);
    const turns = source.turns.length > 0
      ? source.turns.length
      : transcript.filter((item) => item.kind === 'user').length;
    const usage = usageOf(entry.events);
    return { turns, steps, tokens: usage.input + usage.output };
  }, [entry]);

  if (stats === null || (stats.turns === 0 && stats.steps === 0)) return null;

  return (
    <div className={css.root} data-composer-stats="">
      <span className={css.pill}>
        <IconGaugeOutlineRegular size={14} />
        <span>{t('{turns} turns {steps} steps', { turns: stats.turns, steps: stats.steps })}</span>
      </span>
      {stats.tokens > 0 && (
        <span className={css.pill}>
          <IconDatabaseOutlineRegular size={14} />
          <span>{t('{count} tokens', { count: compact(stats.tokens) })}</span>
        </span>
      )}
      <span className={css.hint} aria-hidden="true">
        <kbd>Enter</kbd>
        <span>{t('Send')}</span>
        <span className={css.sep}>·</span>
        <kbd>Shift+Enter</kbd>
        <span>{t('New line')}</span>
      </span>
    </div>
  );
}
