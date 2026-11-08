import { useState, type ReactNode } from 'react';
import { Button, Modal, StateDot } from '../../vendor/primitives/index.ts';
import type { ApprovalRequest, PlanReviewRequest } from '../lib/events.ts';
import { useApp } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import css from '../styles/dsh/approval-panel.module.css';
import planCss from '../styles/dsh/plan-preview.module.css';
import appCss from '../styles/app.module.css';
import modalCss from '../styles/plan-review.module.css';

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[Unable to display value]';
  }
}

export function ApprovalView({ approval, stopping, onResolve }: {
  approval: ApprovalRequest;
  stopping: boolean;
  onResolve: (decision: 'allow' | 'deny') => void;
}): ReactNode {
  const t = translator(useApp().locale);
  const [answered, setAnswered] = useState(false);
  const pending = approval.pending === true || answered;
  const submit = (decision: 'allow' | 'deny'): void => {
    setAnswered(true);
    onResolve(decision);
  };
  return (
    <div className={css.root}>
      <div className={css.card}>
        <div className={css.strip}><StateDot state={pending ? 'ongoing' : 'warning'} />{t('Waiting for approval')}</div>
        <div className={css.body} tabIndex={0} role="group" aria-label={t('Tool approval detail')}>
          <div className={css.headline}>
            {t('Allow {tool}?', { tool: typeof approval.call.name === 'string' ? approval.call.name : 'tool' })}
          </div>
          {approval.reason !== '' && <p className={css.description}>{approval.reason}</p>}
          <pre className={appCss.approvalArguments}>{stringify(approval.call.arguments)}</pre>
          {approval.error !== undefined && approval.error !== '' && (
            <p className={appCss.formError}>{approval.error}</p>
          )}
        </div>
        <div className={css.actionRow}>
          <Button variant="outline" disabled={pending || stopping} onClick={() => { submit('deny'); }}>
            {t('Deny')}
          </Button>
          <Button variant="primary" disabled={pending || stopping} onClick={() => { submit('allow'); }}>
            {t('Allow once')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PlanReviewDialog({ review, stopping, onResolve }: {
  review: PlanReviewRequest | undefined;
  stopping: boolean;
  onResolve: (approved: boolean, feedback: string) => void;
}): ReactNode {
  const t = translator(useApp().locale);
  const [feedback, setFeedback] = useState('');
  const [seen, setSeen] = useState<string | undefined>(review?.requestId);
  if (review !== undefined && review.requestId !== seen) {
    setSeen(review.requestId);
    setFeedback(review.feedback ?? '');
  }
  if (review === undefined) return null;
  const pending = review.pending === true || stopping;
  return (
    <Modal
      open
      onClose={() => {}}
      title={t('Plan review')}
      closeLabel={t('Close plan review')}
      className={modalCss.dialog}
      contentClassName={modalCss.content}
      footer={(
        <div className={modalCss.actions}>
          <Button variant="outline" disabled={pending} onClick={() => { onResolve(false, feedback); }}>
            {t('Keep planning')}
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => { onResolve(true, feedback); }}>
            {t('Approve plan')}
          </Button>
        </div>
      )}
    >
      <div className={planCss.preview}>
        <div className={planCss.document}>
          <pre className={modalCss.plan}>{review.plan}</pre>
          <textarea
            className={modalCss.feedback}
            value={feedback}
            maxLength={4000}
            onChange={(event) => { setFeedback(event.target.value); }}
            placeholder={t('Optional feedback for the agent')}
          />
        </div>
      </div>
      {review.error !== undefined && review.error !== '' && <p className={appCss.formError}>{review.error}</p>}
    </Modal>
  );
}
