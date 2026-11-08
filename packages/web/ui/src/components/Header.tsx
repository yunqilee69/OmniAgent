import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  IconAgentPresetOutlineRegular,
  IconCopyOutlineRegular,
  IconDownloadOutlineRegular,
  IconEllipsisOutlineRegular,
  IconPanelLeftOutlineRegular,
  Menu,
  StateDot,
  Tooltip,
} from '../../vendor/primitives/index.ts';
import { store, useApp, useSessionEntry } from '../lib/store.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import css from '../styles/app.module.css';

function statusOf(app: ReturnType<typeof useApp>, entry: ReturnType<typeof useSessionEntry>, t: Translate): { label: string; tone: 'idle' | 'running' | 'error' | 'warning' } {
  const run = entry?.run;
  if (run !== undefined) {
    if (run.stopping === true) return { label: t('Stopping'), tone: 'warning' };
    if (run.finishing === true) return { label: t('Finishing'), tone: 'running' };
    if (run.planReview !== undefined) return { label: t('Plan review'), tone: 'warning' };
    if (run.approval !== undefined) return { label: t('Approval needed'), tone: 'warning' };
    return { label: t('Running'), tone: 'running' };
  }
  if (entry?.error !== undefined && entry.error !== '') return { label: t('Error'), tone: 'error' };
  if (entry?.outcome === 'error') return { label: t('Error'), tone: 'error' };
  if (entry?.outcome === 'interrupted') return { label: t('Interrupted'), tone: 'warning' };
  if (entry?.loading === true || app.sessionsLoading || app.workspacesLoading) return { label: t('Loading'), tone: 'idle' };
  if (entry?.plan.active === true) return { label: t('Plan mode'), tone: 'idle' };
  return { label: t('Ready'), tone: 'idle' };
}

export function Header({ sidebarOpen, onToggleSidebar, rightOpen, rightAvailable, onToggleRight }: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  rightOpen: boolean;
  rightAvailable: boolean;
  onToggleRight: () => void;
}): ReactNode {
  const app = useApp();
  const entry = useSessionEntry();
  const t = translator(app.locale);
  const [menuOpen, setMenuOpen] = useState(false);
  const onAutomation = app.tab === 'automation';
  const onSettings = app.tab === 'settings';
  const header = entry?.header ?? null;
  const description = typeof header?.description === 'string' ? header.description.trim() : '';
  const entryTitle = entry?.title?.trim() ?? '';
  const sessionTitle = app.sessionId === null || onAutomation || onSettings
    ? onSettings ? t('Settings') : onAutomation ? t('Automation tasks') : t('No session selected')
    : description !== ''
      ? description
      : entryTitle !== ''
        ? entryTitle
        : entry?.blank === true
          ? t('New Session')
          : t('Untitled');
  const status = statusOf(app, entry, t);
  const hasSession = app.sessionId !== null && entry?.draft !== true && !onAutomation && !onSettings;
  const draftSession = app.sessionId !== null && entry?.draft === true && !onAutomation && !onSettings;
  const agentName = entry?.agent?.name?.trim();
  const sessionMode = entry?.mode ?? null;
  const modeName = sessionMode === null
    ? ''
    : app.modes.find((mode) => mode.id === sessionMode.mode)?.name ?? sessionMode.mode;
  const modeLabel = modeName !== ''
    ? modeName
    : agentName !== undefined && agentName !== '' && agentName !== 'Default'
      ? agentName
      : t('Standard mode');
  const modeTitle = modeName !== ''
    ? t('Mode for this session: {mode}. Modes are fixed when the session is created.', { mode: modeName })
    : entry?.agent?.role ?? t('Standard mode');

  return (
    <header className={clsx(css.header, !hasSession && css.headerBlank)}>
      <div className={css.headerLeading}>
        {!sidebarOpen && (
          <Tooltip label={t('Show sidebar')} delayMs={400}>
            <button type="button" className={css.iconButton} aria-label={t('Show sidebar')} onClick={onToggleSidebar}>
              <IconPanelLeftOutlineRegular />
            </button>
          </Tooltip>
        )}
      </div>
      <div className={css.titleRow}>
        <div className={css.titleCluster}>
          <nav className={css.crumbs} aria-label={t('Session view')}>
            {hasSession ? (
              <span className={clsx(css.crumb, css.crumbCurrent)} title={sessionTitle}>{sessionTitle}</span>
            ) : (
              <span className={css.crumbCurrent}>
                {draftSession ? t('New Session') : onSettings ? t('Settings') : onAutomation ? t('Automation tasks') : t('No session selected')}
              </span>
            )}
          </nav>
          {hasSession && (
            <span className={css.modeLabel} title={modeTitle}>
              <IconAgentPresetOutlineRegular size={14} />
              <span>{modeLabel}</span>
            </span>
          )}
        </div>
        <div className={css.headerUtilities}>
          {hasSession && (
            <span className={css.status} data-tone={status.tone} title={status.label} aria-label={status.label}>
              <StateDot state={status.tone === 'error' ? 'error' : status.tone === 'warning' ? 'warning' : status.tone === 'running' ? 'ongoing' : 'idle'} />
              {status.tone !== 'idle' && <span>{status.label}</span>}
            </span>
          )}
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false); }}
            align="end"
            items={[
              { id: 'markdown', label: t('Copy as Markdown'), icon: <IconCopyOutlineRegular /> },
              { id: 'json', label: t('Download JSON'), icon: <IconDownloadOutlineRegular /> },
            ]}
            onSelect={(id) => {
              setMenuOpen(false);
              void store.exportSession(id === 'markdown' ? 'markdown' : 'json');
            }}
            anchor={(
              <Tooltip label={t('Export session')} delayMs={400}>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('Export session')}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  disabled={app.sessionId === null || entry?.draft === true}
                  onClick={() => { setMenuOpen((value) => !value); }}
                >
                  <IconEllipsisOutlineRegular />
                </button>
              </Tooltip>
            )}
          />
        </div>
        {!rightOpen && rightAvailable && !onAutomation && !onSettings && (
          <div className={css.headerCorner}>
            <Tooltip label={t('Expand panel')} delayMs={400}>
              <button type="button" className={css.iconButton} aria-label={t('Expand panel')} onClick={onToggleRight}>
                <IconPanelLeftOutlineRegular className={css.flipGlyph} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      {hasSession && (
        <div className={css.tabs}>
          <div className={css.viewTabs} role="tablist" aria-label={t('Session view')}>
            <button
              type="button"
              role="tab"
              id="tab-conversation"
              aria-selected={app.tab === 'conversation'}
              aria-controls="panel-conversation"
              className={clsx(css.tab, app.tab === 'conversation' && css.tabActive)}
              onClick={() => { store.setTab('conversation'); }}
            >
              {t('Conversation')}
            </button>
            <button
              type="button"
              role="tab"
              id="tab-observe"
              aria-selected={app.tab === 'observe'}
              aria-controls="panel-observe"
              className={clsx(css.tab, app.tab === 'observe' && css.tabActive)}
              onClick={() => { store.setTab('observe'); }}
            >
              {t('Observe')}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
