import { useState, useSyncExternalStore, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  IconAgentPresetOutlineRegular,
  IconCopyOutlineRegular,
  IconDownloadOutlineRegular,
  IconEllipsisOutlineRegular,
  IconPanelLeftOutlineRegular,
  Menu,
  Tooltip,
} from '../../vendor/primitives/index.ts';
import { auth } from '../lib/auth.ts';
import { store, useApp, useSessionEntry } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import css from '../styles/app.module.css';

export function Header({ sidebarOpen, onToggleSidebar, rightOpen, onToggleRight }: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  rightOpen: boolean;
  onToggleRight: () => void;
}): ReactNode {
  const app = useApp();
  const authState = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
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
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false); }}
            align="end"
            items={[
              { id: 'markdown', label: t('Copy as Markdown'), icon: <IconCopyOutlineRegular />, disabled: !hasSession },
              { id: 'json', label: t('Download JSON'), icon: <IconDownloadOutlineRegular />, disabled: !hasSession },
              ...(authState.phase === 'ready' && authState.enabled ? [{ id: 'logout', label: t('Sign out') }] : []),
            ]}
            onSelect={(id) => {
              setMenuOpen(false);
              if (id === 'logout') void auth.logout();
              else void store.exportSession(id === 'markdown' ? 'markdown' : 'json');
            }}
            anchor={(
              <Tooltip label={t('Export session')} delayMs={400}>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('Export session')}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  disabled={(app.sessionId === null || entry?.draft === true) && !(authState.phase === 'ready' && authState.enabled)}
                  onClick={() => { setMenuOpen((value) => !value); }}
                >
                  <IconEllipsisOutlineRegular />
                </button>
              </Tooltip>
            )}
          />
        </div>
        {!rightOpen && !onAutomation && !onSettings && (
          <div className={css.headerCorner}>
            <Tooltip label={t('Expand panel')} delayMs={400}>
              <button type="button" className={css.iconButton} aria-label={t('Expand panel')} onClick={onToggleRight}>
                <IconPanelLeftOutlineRegular className={css.flipGlyph} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
    </header>
  );
}
