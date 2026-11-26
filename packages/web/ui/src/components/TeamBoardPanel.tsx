import { useState, type ReactNode } from 'react';
import { StateDot } from '../../vendor/primitives/index.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import type { DevelopmentPlan, TeamBoard, TeamBoardTask } from '../lib/wire.ts';
import css from '../styles/dsh/team-board.module.css';

const STATUS_LABEL = {
  pending: 'Pending',
  in_progress: 'In progress',
  review: 'In review',
  completed: 'Done',
} as const;

/**
 * Read-only team board for the side panel. The coordinator and its members
 * change status through tools; this view only shows the current record.
 */
export function TeamBoardPanel({
  plans,
  board,
  locale,
}: {
  plans: readonly DevelopmentPlan[];
  board: TeamBoard;
  locale: 'zh' | 'en';
}): ReactNode {
  const t = translator(locale);
  const plan = plans[0] ?? null;
  const [openPlan, setOpenPlan] = useState(false);
  return (
    <div className={css.root}>
      {board.failure !== undefined && <p className={css.failure}>{board.failure}</p>}
      {board.tasks.length === 0 ? (
        <p className={css.empty}>{t('No tasks on the board yet.')}</p>
      ) : (
        <ol className={css.list}>
          {board.tasks.map((task) => <TaskRow key={task.id} task={task} t={t} />)}
        </ol>
      )}
      {plan !== null && (
        <section className={css.plan}>
          <button type="button" className={css.planToggle} aria-expanded={openPlan} onClick={() => { setOpenPlan((value) => !value); }}>
            <span>{t('Development plan')}</span>
            <span className={css.meta}>{`${plan.title} · v${plan.version}`}</span>
          </button>
          {openPlan && <pre className={css.planBody}>{plan.body}</pre>}
        </section>
      )}
    </div>
  );
}

function TaskRow({ task, t }: { task: TeamBoardTask; t: Translate }): ReactNode {
  const label = STATUS_LABEL[task.status as keyof typeof STATUS_LABEL];
  return (
    <li className={css.task} data-status={task.status}>
      <span className={css.glyph} aria-hidden>
        <StateDot state={task.status === 'completed' ? 'done' : task.status === 'pending' ? 'idle' : 'ongoing'} />
      </span>
      <div className={css.body}>
        <div className={css.line}>
          <span className={css.subject}>{task.subject}</span>
          <span className={css.status}>{label === undefined ? task.status : t(label)}</span>
        </div>
        <p className={css.detail}>
          {task.status === 'pending' && !task.ready ? `${t('Blocked')} · ` : ''}
          {task.planHeading !== undefined ? `${task.planHeading}` : task.id}
          {task.blockedBy.length > 0 ? ` · ${task.blockedBy.join(', ')}` : ''}
        </p>
        {task.note !== undefined && task.note !== '' && <p className={css.note}>{task.note}</p>}
        {task.acceptance !== undefined && task.acceptance !== '' && <p className={css.acceptance}>{task.acceptance}</p>}
      </div>
    </li>
  );
}
