import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  const [open, setOpen] = useState(false);
  const [panelPosition, setPanelPosition] = useState({ left: 12, bottom: 0, maxHeight: 0 });
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const key = JSON.stringify([workspaceId, sessionId, revision, modelKey]);
  useEffect(() => {
    setSnapshot(null);
    setOpen(false);
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

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const position = (): void => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(300, Math.max(0, window.innerWidth - 24));
      setPanelPosition({
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        bottom: window.innerHeight - rect.top + 8,
        maxHeight: Math.max(0, Math.min(window.innerHeight / 2, rect.top - 20)),
      });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open]);

  const t = translator(locale);
  const value = !draft && !busy && !refreshing && !modelSaving && snapshot?.key === key ? snapshot.value : null;
  const projection = value?.projection;
  const capacity = value?.modelWindow;
  const percent = projection && capacity ? Math.min(100, Math.round(projection.projectedTokens / capacity * 100)) : undefined;
  const reading = percent === undefined ? t('Context usage unknown') : t('{percent}% of context used', { percent });
  const rows = projection && [
    { label: t('System'), tokens: projection.breakdown.systemTokens, color: css.contextSystem },
    { label: t('Tools'), tokens: projection.breakdown.toolsTokens, color: css.contextTools },
    { label: t('Messages'), tokens: projection.breakdown.messageTokens, color: css.contextMessages },
  ];
  const total = rows?.reduce((sum, row) => sum + row.tokens, 0) ?? 0;
  const format = (count: number): string => count.toLocaleString(locale);
  return (
    <span ref={root} className={css.contextMeterRoot}>
      <button ref={trigger} type="button" className={css.contextMeterTrigger} aria-label={reading} aria-expanded={open}
        aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <span className={css.contextMeter} data-known={percent !== undefined}
          style={{ '--context-percent': `${percent ?? 0}%` } as CSSProperties} aria-hidden="true">
          <span className={css.contextMeterCenter}>{percent === undefined ? '?' : ''}</span>
        </span>
      </button>
      {open && <div className={css.contextPanel} role="dialog" aria-label={t('Context usage')}
        style={panelPosition}>
        <div className={css.contextHeader}><strong>{reading}</strong>
          {projection && capacity && <span>~{format(projection.projectedTokens)} / {format(capacity)}</span>}</div>
        {rows && <>
          <div className={css.contextBar} aria-hidden="true">
            {rows.map((row) => <span key={row.label} className={row.color}
              style={{ width: `${total ? (percent ?? 100) * row.tokens / total : 0}%` }} />)}
          </div>
          <dl className={css.contextRows}>{rows.map((row) => <div key={row.label}>
            <dt><span className={`${css.contextSwatch} ${row.color}`} />{row.label}</dt><dd>~{format(row.tokens)}</dd>
          </div>)}</dl>
          <p>{projection.source === 'usage'
            ? t('Projected from the last reported input ({count} tokens) plus estimated changes.', { count: format(projection.inputTokens ?? 0) })
            : t('Estimated from system, tools and messages; no compatible input usage is available.')}</p>
        </>}
        {!projection && <p>{t('Context projection unavailable until the session runtime is ready.')}</p>}
        {!capacity && <p>{t('Model context window is unknown.')}</p>}
        {value?.window?.source === 'config' && <p>{t('Compaction budget: {count} tokens ({source})', { count: format(value.window.tokens), source: t('configuration') })}</p>}
        <p>{t('Estimates use UTF-8 JSON bytes divided by four, exclude unsent input, and may miscount images. History after restart may differ from live compaction.')}</p>
      </div>}
    </span>
  );
}
