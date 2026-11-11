import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  IconChevronDownOutlineRegular,
  Menu,
  StateDot,
  type StateDotState,
} from '../../vendor/primitives/index.ts';
import { store, useApp } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import {
  formatSubagentDuration,
  formatTokens,
  subagentStatusLabel,
  type SubagentRow,
} from '../lib/subagents.ts';
import css from '../styles/dsh/subagent-team.module.css';

function dotState(status: SubagentRow['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing';
    case 'completed': return 'done';
    case 'failed': return 'error';
    case 'interrupted': return 'warning';
    default: return 'idle';
  }
}

/**
 * Header entry point for one root session's subagents.
 *
 * The trigger carries the state the reader needs before opening: on a root
 * session it is the team size, and on a child session it is the child's own
 * name — the name the reader would otherwise click to get here. Rows carry the
 * status, token total and run length, and picking a row opens that child.
 * Reopening the card reloads the workspace session list, which is where the
 * statuses come from, so a finished child does not stay "running" on screen.
 * @param props.rows - children of the root session, oldest first.
 * @param props.currentId - the session currently on screen, highlighted in the card.
 * @param props.workspaceId - workspace the session list belongs to.
 * @param props.label - trigger text for `crumb`: the current child's name.
 * @param props.variant - `count` shows the team size; `crumb` borrows the title slot.
 */
export function SubagentTeam({ rows, currentId, workspaceId, label = '', variant = 'count' }: {
  rows: readonly SubagentRow[];
  currentId: string | null;
  workspaceId: string | null;
  label?: string;
  variant?: 'count' | 'crumb';
}): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [open, setOpen] = useState(false);
  const running = rows.filter((row) => row.running).length;
  const crumb = variant === 'crumb';

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false); }}
      align="start"
      portal
      listClassName={css.card}
      anchor={(
        <button
          type="button"
          className={crumb ? css.crumbTrigger : css.trigger}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={crumb ? undefined : t('Subagent team')}
          title={crumb ? t('Subagent team') : undefined}
          onClick={() => {
            if (!open && workspaceId !== null) void store.loadSessions(workspaceId, false);
            setOpen((value) => !value);
          }}
        >
          {running > 0 && <StateDot state="ongoing" size={10} />}
          <span className={css.triggerLabel}>
            {crumb ? label : t('{count} subagents', { count: rows.length })}
          </span>
          <IconChevronDownOutlineRegular size={12} className={css.triggerChevron} />
        </button>
      )}
    >
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          role="menuitem"
          className={clsx(css.row, row.id === currentId && css.rowCurrent)}
          aria-current={row.id === currentId ? 'true' : undefined}
          title={row.detail}
          onClick={() => {
            setOpen(false);
            if (workspaceId !== null) store.selectSession(row.id, workspaceId);
          }}
        >
          <span className={css.rowDot} aria-hidden="true">
            <StateDot state={dotState(row.status)} size={10} />
          </span>
          <span className={css.rowMain}>
            <span className={css.rowTitle}>{row.name === '' ? t('Untitled') : row.name}</span>
            <span className={css.rowMeta}>
              {[
                row.detail,
                row.resumable ? t('Resumable') : '',
                subagentStatusLabel(row.status, t),
                formatSubagentDuration(row.durationMs, app.locale),
              ].filter((part) => part !== '').join(' · ')}
            </span>
          </span>
          <span className={css.rowTokens}>
            {row.totalTokens === null ? '' : t('{count} tokens', { count: formatTokens(row.totalTokens) })}
          </span>
        </button>
      ))}
    </Menu>
  );
}
