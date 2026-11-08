import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { Button, FishLogo, IconCloseOutlineRegular, IconWarningOutlineRegular } from '../vendor/primitives/index.ts';
import { store, useApp, useSessionEntry } from './lib/store.ts';
import { translator } from './lib/i18n.ts';
import { Header } from './components/Header.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { ConversationView } from './components/ConversationView.tsx';
import { Composer } from './components/Composer.tsx';
import { ApprovalView, PlanReviewDialog } from './components/ApprovalView.tsx';
import { TrajectoryView } from './components/TrajectoryView.tsx';
import { AutomationPage } from './components/AutomationPage.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { NewSessionDialog } from './components/NewSessionDialog.tsx';
import { RightPanel } from './components/RightPanel.tsx';
import css from './styles/app.module.css';
import heroCss from './styles/dsh/hero-shell.module.css';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const listener = (): void => { setMatches(media.matches); };
    media.addEventListener('change', listener);
    setMatches(media.matches);
    return () => { media.removeEventListener('change', listener); };
  }, [query]);
  return matches;
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => { setWidth(window.innerWidth); };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); };
  }, []);
  return width;
}

function Hero({ notice }: { notice?: string }): ReactNode {
  const t = translator(useApp().locale);
  return (
    <div className={clsx(heroCss.root, css.heroHeading)}>
      <div className={heroCss.stack}>
        <div className={heroCss.headline}>
          <span className={heroCss.fishHitbox}><FishLogo size={30} className={heroCss.fish} /></span>
          <span className={heroCss.titleGroup}>OmniAgent</span>
        </div>
        <p className={css.heroSubtitle}>
          {notice ?? t('Work inside a local workspace with a sandboxed agent that reasons, edits, and runs tools.')}
        </p>
      </div>
    </div>
  );
}

function SessionPlaceholder({ children }: { children: ReactNode }): ReactNode {
  return <div className={css.sessionPlaceholder}>{children}</div>;
}

export function App(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const entry = useSessionEntry();
  const mobile = useMediaQuery('(max-width: 900px)');
  const viewportWidth = useViewportWidth();
  const rightAvailable = viewportWidth >= 1000;
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia('(max-width: 900px)').matches);
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth >= 1180);
  const [rightFullscreen, setRightFullscreen] = useState(false);
  const [rightWidth, setRightWidth] = useState<number | null>(null);
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void store.bootstrap();
  }, []);

  useEffect(() => {
    if (mobile) setSidebarOpen(false);
  }, [mobile]);

  useEffect(() => {
    if (rightAvailable) return;
    setRightOpen(false);
    setRightFullscreen(false);
  }, [rightAvailable]);

  useEffect(() => {
    if (!mobile || !sidebarOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [mobile, sidebarOpen]);

  const run = entry?.run;
  const drawer = mobile && sidebarOpen;
  const showConversation = app.tab === 'conversation';
  const hasSession = app.sessionId !== null;
  const draft = entry?.draft === true;
  const sessionBlocked = entry?.error !== undefined && entry.error !== '' && entry?.loaded !== true;
  const rightActive = rightOpen && rightAvailable && app.tab !== 'automation' && app.tab !== 'settings' && !draft;
  const effectiveRightWidth = rightActive
    ? rightWidth ?? Math.max(300, Math.min(Math.round(viewportWidth * 0.45), viewportWidth - 680))
    : 0;

  const shellStyle = {
    '--dsh-sidebar-track': sidebarOpen ? '280px' : '0px',
    '--dsh-rightbar-width': `${effectiveRightWidth}px`,
  } as CSSProperties;

  const startRightResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = effectiveRightWidth;
    const move = (moveEvent: PointerEvent): void => {
      const next = startWidth + startX - moveEvent.clientX;
      setRightWidth(Math.max(300, Math.min(Math.round(viewportWidth * 0.7), next)));
    };
    const stop = (): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
  };

  return (
    <div
      className={css.app}
      data-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-right={rightActive ? 'open' : 'closed'}
      data-right-fullscreen={rightFullscreen || undefined}
      data-mobile={mobile || undefined}
      style={shellStyle}
    >
      <div className={css.sidebarCol}>
        <Sidebar drawer={mobile} onClose={() => { setSidebarOpen(false); }} />
      </div>
      {drawer && <div className={css.drawerMask} onClick={() => { setSidebarOpen(false); }} />}

      <div className={css.main}>
        <Header
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
          rightOpen={rightActive}
          rightAvailable={rightAvailable}
          onToggleRight={() => { setRightOpen(true); }}
        />

        {app.alert !== '' && (
          <div className={css.alert} role="alert">
            <IconWarningOutlineRegular />
            <span>{app.alert}</span>
            <button type="button" className={css.alertClose} aria-label={t('Dismiss')} onClick={() => { store.dismissAlert(); }}>
              <IconCloseOutlineRegular />
            </button>
          </div>
        )}

        {app.tab === 'automation' ? (
          <div className={css.automationArea} id="panel-automation" role="tabpanel" aria-label={t('Automations')}>
            <AutomationPage />
          </div>
        ) : app.tab === 'settings' ? (
          <div className={css.settingsArea} id="panel-settings" role="tabpanel" aria-label={t('Settings')}>
            <SettingsPage />
          </div>
        ) : showConversation ? (
          <div className={css.conversationArea} id="panel-conversation" role="tabpanel" aria-labelledby="tab-conversation">
            {!hasSession || draft ? (
              <div className={css.heroArea}>
                {app.workspacesLoading ? (
                  <SessionPlaceholder>{t('Loading workspaces…')}</SessionPlaceholder>
                ) : app.workspaceError !== '' ? (
                  <SessionPlaceholder>
                    <strong>{t('Workspaces unavailable')}</strong>
                    <p>{app.workspaceError}</p>
                    <Button variant="outline" onClick={() => { void store.loadWorkspaces(); }}>{t('Retry')}</Button>
                  </SessionPlaceholder>
                ) : app.workspaceId === null ? (
                  <SessionPlaceholder>
                    <strong>{t('No workspace selected')}</strong>
                    <p>{t('Add a local directory to get started.')}</p>
                  </SessionPlaceholder>
                ) : (
                  <>
                    <Hero notice={!draft && app.sessions.length === 0 ? t('Create a session in this workspace to begin.') : undefined} />
                    <div className={css.heroComposer}>
                      <Composer hero />
                    </div>
                  </>
                )}
              </div>
            ) : app.sessionsLoading && entry?.loaded !== true ? (
              <SessionPlaceholder>{t('Loading session…')}</SessionPlaceholder>
            ) : entry === null ? (
              <SessionPlaceholder>{t('Loading session…')}</SessionPlaceholder>
            ) : sessionBlocked ? (
              <SessionPlaceholder>
                <strong>{t('Session unavailable')}</strong>
                <p>{entry.error}</p>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (app.workspaceId !== null && app.sessionId !== null) void store.loadDetail(app.workspaceId, app.sessionId);
                  }}
                >
                  {t('Retry')}
                </Button>
              </SessionPlaceholder>
            ) : (
              <div className={css.chatArea}>
                <ConversationView entry={entry} processDisplay={app.processDisplay} />
                {run?.approval !== undefined && run.stopping !== true && run.finishing !== true && (
                  <ApprovalView
                    approval={run.approval}
                    stopping={Boolean(run.stopping || run.finishing)}
                    onResolve={(decision) => { void store.resolveApproval(decision); }}
                  />
                )}
                <div className={css.composerArea}>
                  <Composer />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className={css.observeArea} id="panel-observe" role="tabpanel" aria-labelledby="tab-observe">
            <TrajectoryView />
          </div>
        )}
      </div>

      {rightActive && (
        <div className={css.rightCol}>
          {!rightFullscreen && (
            <div
              className={css.rightResize}
              role="separator"
              aria-label={t('Resize panel')}
              aria-orientation="vertical"
              onPointerDown={startRightResize}
            />
          )}
          <RightPanel
            fullscreen={rightFullscreen}
            onClose={() => { setRightOpen(false); setRightFullscreen(false); }}
            onToggleFullscreen={() => { setRightFullscreen((value) => !value); }}
          />
        </div>
      )}

      <PlanReviewDialog
        review={run?.planReview}
        stopping={run?.stopping === true || run?.finishing === true}
        onResolve={(approved, feedback) => { void store.resolvePlanReview(approved, feedback); }}
      />
      <NewSessionDialog />
    </div>
  );
}
