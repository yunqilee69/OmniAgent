import { useEffect, useState, type ReactNode } from 'react';
import { Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular } from '../../vendor/primitives/index.ts';
import type { AskUserQuestionView, AskUserRequest } from '../lib/events.ts';
import { store, useApp } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import css from '../styles/ask-user.module.css';

/** Remaining whole seconds of a finite wait, or undefined when the wait does not expire. */
export function askUserRemainingSec(deadlineAt: number | undefined, now: number): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return Math.max(0, Math.ceil((deadlineAt - now) / 1000));
}

interface AnswerDraft {
  selected: string[];
  custom: string;
}

/** Split a trailing recommendation marker off a label without changing the submitted value. */
function recommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false };
}

/**
 * Question card. One batch is still answered together, but only the current
 * question is shown: a single choice advances, and the last question submits.
 * Leaving a question blank skips it. Skipping is not approval.
 */
export function AskUserCard({ request }: { request: AskUserRequest }): ReactNode {
  const t = translator(useApp().locale);
  const questions = request.questions;
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [seenRequest, setSeenRequest] = useState(request.requestId);
  const [now, setNow] = useState(() => Date.now());
  if (seenRequest !== request.requestId) {
    setSeenRequest(request.requestId);
    setSelected({});
    setCustom({});
    setIndex(0);
    setNow(Date.now());
  }
  const current = Math.min(index, Math.max(0, questions.length - 1));
  useEffect(() => {
    if (request.deadlineAt === undefined || request.continued === true) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.deadlineAt, request.continued, request.requestId]);
  const remaining = request.continued === true ? 0 : askUserRemainingSec(request.deadlineAt, now);
  const pending = request.pending === true;
  const question = questions[current];
  const draftOf = (item: AskUserQuestionView): AnswerDraft => ({
    selected: selected[item.id] ?? [],
    custom: custom[item.id] ?? '',
  });

  const writeDraft = (id: string, draft: AnswerDraft): void => {
    setSelected((currentSelected) => ({ ...currentSelected, [id]: draft.selected }));
    setCustom((currentCustom) => ({ ...currentCustom, [id]: draft.custom }));
  };

  const submit = (nextSelected = selected, nextCustom = custom): void => {
    if (pending) return;
    const answers = questions.map((item) => {
      const choice = nextSelected[item.id] ?? [];
      const text = (nextCustom[item.id] ?? '').trim();
      return {
        id: item.id,
        selected: choice,
        ...(text === '' ? {} : { custom: text }),
      };
    });
    void store.resolveAskUser('answer', answers);
  };

  const goTo = (next: number): void => {
    setIndex(Math.max(0, Math.min(questions.length - 1, next)));
  };

  const choose = (label: string): void => {
    if (question === undefined || pending) return;
    const draft = draftOf(question);
    if (question.multiSelect) {
      const values = draft.selected.includes(label)
        ? draft.selected.filter((item) => item !== label)
        : [...draft.selected, label];
      writeDraft(question.id, { ...draft, selected: values });
      return;
    }
    const nextSelected = { ...selected, [question.id]: [label] };
    const nextCustom = { ...custom, [question.id]: '' };
    setSelected(nextSelected);
    setCustom(nextCustom);
    if (current < questions.length - 1) goTo(current + 1);
    else submit(nextSelected, nextCustom);
  };

  const continueFlow = (): void => {
    if (question === undefined || pending) return;
    if (current < questions.length - 1) {
      goTo(current + 1);
      return;
    }
    submit();
  };

  if (question === undefined) return null;
  const draft = draftOf(question);
  const last = current === questions.length - 1;
  const multiple = questions.length > 1;
  return (
    <section className={css.card} aria-label={t('Question')}>
      <div className={css.header}>
        <span className={css.heading}>
          <span className={css.title}>{question.header ?? t('Question')}</span>
          <span className={css.subtitle}>
            {request.continued === true
              ? t('The wait expired. An answer still continues the work; skipping is not permission.')
              : remaining === undefined
                ? t('The agent is waiting for an answer. Leave a question blank to skip it.')
                : t('Waiting {seconds}s. Leave a question blank to skip it.', { seconds: String(remaining) })}
          </span>
        </span>
        {multiple && (
          <div className={css.pager}>
            <button type="button" className={css.pagerButton} aria-label={t('Previous question')} disabled={pending || current === 0} onClick={() => goTo(current - 1)}>
              <IconChevronLeftOutlineRegular />
            </button>
            <span className={css.progress}>{current + 1} / {questions.length}</span>
            <button type="button" className={css.pagerButton} aria-label={t('Next question')} disabled={pending || last} onClick={() => goTo(current + 1)}>
              <IconChevronRightOutlineRegular />
            </button>
          </div>
        )}
      </div>
      <div className={css.question}>
        <p className={css.questionText}>{question.question}</p>
        <div className={css.options} role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
          {question.options?.map((option, optionIndex) => {
            const active = draft.selected.includes(option.label);
            const display = recommendedLabel(option.label);
            return (
              <button
                key={option.label}
                type="button"
                className={css.option}
                data-selected={active || undefined}
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={active}
                disabled={pending}
                onClick={() => choose(option.label)}
              >
                <span className={css.marker} aria-hidden="true">{optionIndex + 1}</span>
                <span className={css.optionCopy}>
                  <span className={css.optionLabel}>
                    {display.label}
                    {display.recommended && <span className={css.badge}>{t('Recommended')}</span>}
                  </span>
                  {option.description !== undefined && option.description !== '' && (
                    <span className={css.optionDescription}>{option.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <input
          className={css.custom}
          value={draft.custom}
          disabled={pending}
          placeholder={t('Custom answer')}
          onChange={(event) => {
            const value = event.target.value;
            writeDraft(question.id, {
              selected: question.multiSelect || value.trim() === '' ? draft.selected : [],
              custom: value,
            });
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            continueFlow();
          }}
        />
      </div>
      {request.error !== undefined && request.error !== '' && <p className={css.error} role="alert">{request.error}</p>}
      <div className={css.actions}>
        <div className={css.actionButtons}>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => { void store.resolveAskUser('cancel'); }}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={pending} onClick={continueFlow}>
            {pending ? t('Submitting…') : last ? t('Submit answers') : t('Next question')}
          </Button>
        </div>
      </div>
    </section>
  );
}
