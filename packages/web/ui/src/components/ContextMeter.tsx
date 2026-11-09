import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { authFetch } from '../lib/auth.ts';
import { sessionApiPath, validateContextEstimate, type ContextEstimate } from '../lib/wire.ts';
import { translator, type Locale } from '../lib/i18n.ts';
import css from '../styles/dsh/input-bar.module.css';

interface Props {
  workspaceId: string | null;
  sessionId: string | null;
  draft: boolean;
  busy: boolean;
  refreshing: boolean;
  revision: number;
  modelSaving: boolean;
  modelKey: string;
  locale: Locale;
}

export function ContextMeter({ workspaceId, sessionId, draft, busy, refreshing, revision, modelSaving, modelKey, locale }: Props): ReactNode {
  const [snapshot, setSnapshot] = useState<{ key: string; value: ContextEstimate } | null>(null);
  const key = JSON.stringify([workspaceId, sessionId, revision, modelKey]);
  useEffect(() => {
    setSnapshot(null);
    if (workspaceId === null || sessionId === null || draft || busy || refreshing || modelSaving) return;
    let current = true;
    let controller: AbortController | undefined;
    const load = (): void => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      void authFetch(sessionApiPath(workspaceId, sessionId, 'context'), { signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('Context request failed');
          return validateContextEstimate(await response.json());
        })
        .then((value) => { if (current && !signal.aborted) setSnapshot({ key, value }); })
        .catch(() => { if (current && !signal.aborted) setSnapshot(null); });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { current = false; controller?.abort(); window.clearInterval(timer); };
  }, [workspaceId, sessionId, key, draft, busy, refreshing, revision, modelSaving]);

  const t = translator(locale);
  const value = !draft && !busy && !refreshing && !modelSaving && snapshot?.key === key ? snapshot.value : null;
  const estimate = value?.estimatedMessageTokens;
  const windowSize = value?.window;
  const percent = estimate !== undefined && windowSize !== undefined
    ? Math.min(100, Math.round(estimate / windowSize.tokens * 100)) : undefined;
  const details = [
    estimate === undefined ? t('Message history estimate: unknown')
      : t('Message history estimate: ~{count} tokens', { count: estimate.toLocaleString(locale) }),
    windowSize === undefined ? t('Compaction budget: unknown')
      : t('Compaction budget: {count} tokens ({source})', {
        count: windowSize.tokens.toLocaleString(locale),
        source: windowSize.source === 'config' ? t('configuration') : t('model'),
      }),
    t('Estimated from message JSON bytes divided by 4; not total context or an exact token count. Excludes system prompt, tools and unsent input. Images may be overestimated.'),
    t('History is unavailable during a turn; replay after restart may differ from prior compaction.'),
  ].join('\n');
  return (
    <span className={css.contextMeter} role="img" tabIndex={0} aria-label={details} title={details}
      data-known={percent !== undefined} style={{ '--context-percent': `${percent ?? 0}%` } as CSSProperties}>
      <span className={css.contextMeterCenter} aria-hidden="true">{percent === undefined ? '?' : ''}</span>
    </span>
  );
}
