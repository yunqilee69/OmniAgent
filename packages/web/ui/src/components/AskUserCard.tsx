import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../vendor/primitives/index.ts';
import type { AskUserRequest } from '../lib/events.ts';
import { store, useApp } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import css from '../styles/ask-user.module.css';

/** Remaining whole seconds of a finite wait, or undefined when the wait does not expire. */
export function askUserRemainingSec(deadlineAt: number | undefined, now: number): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return Math.max(0, Math.ceil((deadlineAt - now) / 1000));
}

/**
 * Question card. One batch is answered together: each question can take a
 * choice, custom text, or be left blank to skip it. Skipping is not approval.
 */
export function AskUserCard({ request }: { request: AskUserRequest }): ReactNode {
  const t = translator(useApp().locale);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [seenRequest, setSeenRequest] = useState(request.requestId);
  const [now, setNow] = useState(() => Date.now());
  if (seenRequest !== request.requestId) {
    setSeenRequest(request.requestId);
    setSelected({});
    setCustom({});
    setNow(Date.now());
  }
  useEffect(() => {
    if (request.deadlineAt === undefined || request.continued === true) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.deadlineAt, request.continued, request.requestId]);
  const remaining = request.continued === true ? 0 : askUserRemainingSec(request.deadlineAt, now);
  const pending = request.pending === true;
  const toggle = (id: string, label: string, multi: boolean): void => {
    setSelected((current) => {
      const values = current[id] ?? [];
      const next = multi
        ? values.includes(label) ? values.filter((item) => item !== label) : [...values, label]
        : values[0] === label ? [] : [label];
      return { ...current, [id]: next };
    });
    if (!multi) setCustom((current) => ({ ...current, [id]: '' }));
  };
  const submit = (): void => {
    if (pending) return;
    const answers = request.questions.map((question) => {
      const choice = selected[question.id] ?? [];
      const text = (custom[question.id] ?? '').trim();
      return {
        id: question.id,
        selected: choice,
        ...(text === '' ? {} : { custom: text }),
      };
    });
    void store.resolveAskUser('answer', answers);
  };
  return (
    <section className={css.card} aria-label={t('Question')}>
      <div className={css.header}>
        <span className={css.heading}>
          <span className={css.title}>{t('Question')}</span>
          <span className={css.subtitle}>
            {request.continued === true
              ? t('The wait expired. An answer still continues the work; skipping is not permission.')
              : remaining === undefined
                ? t('The agent is waiting for an answer. Leave a question blank to skip it.')
                : t('Waiting {seconds}s. Leave a question blank to skip it.', { seconds: String(remaining) })}
          </span>
        </span>
      </div>
      {request.questions.map((question) => (
        <div key={question.id} className={css.question}>
          {question.header !== undefined && <p className={css.title}>{question.header}</p>}
          <p className={css.questionText}>{question.question}</p>
          {question.options?.map((option) => {
            const active = (selected[question.id] ?? []).includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                className={css.option}
                data-selected={active || undefined}
                aria-pressed={active}
                disabled={pending}
                onClick={() => toggle(question.id, option.label, question.multiSelect)}
              >
                {option.label}
                {option.description !== undefined && <span> — {option.description}</span>}
              </button>
            );
          })}
          <input
            className={css.custom}
            value={custom[question.id] ?? ''}
            disabled={pending}
            placeholder={t('Custom answer')}
            onChange={(event) => {
              const value = event.target.value;
              setCustom((current) => ({ ...current, [question.id]: value }));
              if (!question.multiSelect && value.trim() !== '') {
                setSelected((current) => ({ ...current, [question.id]: [] }));
              }
            }}
          />
        </div>
      ))}
      {request.error !== undefined && request.error !== '' && <p className={css.error} role="alert">{request.error}</p>}
      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => { void store.resolveAskUser('cancel'); }}>
          {t('Cancel')}
        </Button>
        <Button variant="primary" size="sm" disabled={pending} onClick={submit}>
          {pending ? t('Submitting…') : t('Submit answers')}
        </Button>
      </div>
    </section>
  );
}
