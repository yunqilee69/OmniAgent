import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Button,
  IconCheckOutlineRegular,
  IconPlanOutlineRegular,
  MarkdownText,
  StateDot,
} from '../../vendor/primitives/index.ts';
import type { PlanReviewRequest } from '../lib/events.ts';
import { markdownLabels } from '../lib/labels.ts';
import { store, useApp } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import assistantCss from '../styles/dsh/assistant-markdown.module.css';
import previewCss from '../styles/dsh/plan-preview.module.css';
import css from '../styles/plan-review.module.css';

/** The heading line of a submitted plan, without its Markdown marker. */
export function planTitle(plan: string): string {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+)$/u.exec(line.trim());
    if (match !== null) return match[1]!.trim();
  }
  return '';
}

/** Plan content shown in the right panel, optionally with its live review status. */
export interface PlanDocument {
  plan: string;
  /** Live review status; undefined once the review is no longer outstanding. */
  pending?: boolean;
  error?: string;
}

/** Inline card in the conversation that opens the full plan in the side panel. */
export function PlanReviewCard({ review, onOpen }: {
  review: PlanReviewRequest;
  onOpen: () => void;
}): ReactNode {
  const t = translator(useApp().locale);
  const heading = planTitle(review.plan);
  const pending = review.pending === true;
  return (
    <div className={previewCss.cards}>
      <button type="button" className={previewCss.card} onClick={onOpen}>
        <span className={previewCss.cardIcon} aria-hidden><IconPlanOutlineRegular size={20} /></span>
        <span className={previewCss.cardDetails}>
          <span className={previewCss.cardTitle}>{heading === '' ? t('Plan ready for review') : heading}</span>
          <span className={previewCss.cardDescription}>
            {pending ? t('Submitting…') : t('Review the plan, then approve or keep planning.')}
          </span>
        </span>
        <span className={previewCss.cardOpen}>{t('View plan')}</span>
      </button>
      {review.error !== undefined && review.error !== '' && (
        <p className={previewCss.cardError} role="alert">{review.error}</p>
      )}
    </div>
  );
}

/** Read-only plan document rendered in the right panel. */
export function PlanPreview({ plan }: { plan: PlanDocument | null }): ReactNode {
  const t = translator(useApp().locale);
  if (plan === null) return <div className={previewCss.message}>{t('No plan to preview.')}</div>;
  return (
    <div className={previewCss.preview}>
      {plan.pending !== undefined && (
        <div className={previewCss.status} data-pending={plan.pending || undefined}>
          <StateDot state={plan.pending ? 'ongoing' : 'warning'} size={plan.pending ? 12 : 8} />
          <span>{plan.pending ? t('Submitting…') : t('Waiting for your review')}</span>
        </div>
      )}
      {plan.error !== undefined && plan.error !== '' && (
        <p className={previewCss.error} role="alert">{plan.error}</p>
      )}
      <div className={previewCss.document}>
        <div className={assistantCss.root}>
          <div className={assistantCss.body}>
            <MarkdownText text={plan.plan} labels={markdownLabels(t)} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Review composer: the input box becomes a plan decision surface while the agent
 * waits. Approve starts the work; sending feedback keeps planning.
 */
export function PlanReviewComposer({ review, stopping, onOpenPreview }: {
  review: PlanReviewRequest;
  stopping: boolean;
  onOpenPreview: () => void;
}): ReactNode {
  const t = translator(useApp().locale);
  const [feedback, setFeedback] = useState(review.feedback ?? '');
  const [seen, setSeen] = useState(review.requestId);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  if (review.requestId !== seen) {
    setSeen(review.requestId);
    setFeedback(review.feedback ?? '');
  }
  useLayoutEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [feedback]);
  const pending = review.pending === true || stopping;
  const heading = planTitle(review.plan);
  const hasFeedback = feedback.trim() !== '';
  const keepPlanning = (): void => {
    if (!pending) void store.resolvePlanReview(false, feedback);
  };
  const approve = (): void => {
    if (!pending) void store.resolvePlanReview(true, feedback);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      approve();
      return;
    }
    // Enter with feedback is the "keep planning" action; an empty draft keeps
    // the default newline so Enter never submits an accidental empty review.
    if (!hasFeedback) return;
    event.preventDefault();
    keepPlanning();
  };
  return (
    <div className={css.card}>
      <div className={css.header}>
        <span className={css.icon} aria-hidden><IconPlanOutlineRegular size={16} /></span>
        <span className={css.heading}>
          <span className={css.title}>{t('Plan ready for review')}</span>
          {heading !== '' && <span className={css.subtitle} title={heading}>{heading}</span>}
        </span>
        <button type="button" className={css.open} onClick={onOpenPreview}>{t('View plan')}</button>
      </div>
      <textarea
        ref={textarea}
        className={css.feedback}
        value={feedback}
        maxLength={4000}
        rows={2}
        disabled={pending}
        onChange={(event) => { setFeedback(event.target.value); }}
        onKeyDown={onKeyDown}
        placeholder={t('Add feedback to keep planning…')}
        aria-label={t('Optional feedback for the agent')}
      />
      {review.error !== undefined && review.error !== '' && (
        <p className={css.error} role="alert">{review.error}</p>
      )}
      <div className={css.actions}>
        <span className={css.hint}>
          {pending ? t('Submitting…') : t('Approve to start, or send feedback to keep planning.')}
        </span>
        <Button variant="outline" size="sm" disabled={pending} onClick={keepPlanning}>
          {t('Keep planning')}
        </Button>
        <Button variant="primary" size="sm" disabled={pending} icon={<IconCheckOutlineRegular size={14} />} onClick={approve}>
          {t('Approve plan')}
        </Button>
      </div>
    </div>
  );
}
