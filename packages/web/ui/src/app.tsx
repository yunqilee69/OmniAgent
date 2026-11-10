import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { Button, FishLogo, IconCloseOutlineRegular, IconWarningOutlineRegular } from '../vendor/primitives/index.ts';
import { store, useApp, useSessionEntry } from './lib/store.ts';
import { translator } from './lib/i18n.ts';
import { Header } from './components/Header.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { ConversationView } from './components/ConversationView.tsx';
import { Composer } from './components/Composer.tsx';
import { ApprovalView } from './components/ApprovalView.tsx';
import { AutomationPage } from './components/AutomationPage.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { NewSessionDialog } from './components/NewSessionDialog.tsx';
import { RightPanel, type RightView } from './components/RightPanel.tsx';
import type { PlanDocument } from './components/PlanReview.tsx';
import { WorkspaceFileTree } from './components/WorkspaceFileTree.tsx';
import type { FileMenuChange } from './components/FileTreeMenu.tsx';
import type { FileSelection } from './components/WorkspaceFilePreview.tsx';
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
  const rightOverlay = viewportWidth < 1000;
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia('(max-width: 900px)').matches);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightFullscreen, setRightFullscreen] = useState(false);
  const [rightWidth, setRightWidth] = useState<number | null>(null);
  const [rightView, setRightView] = useState<RightView>('guide');
  const [browseWorkspaceId, setBrowseWorkspaceId] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileSelection | null>(null);
  /** Bumped after a file operation so open folder listings and the file page refetch. */
  const [fileRefreshToken, setFileRefreshToken] = useState(0);
  const [planDoc, setPlanDoc] = useState<string | null>(null);
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
    setPreview(null);
    setPlanDoc(null);
    setRightView((view) => view === 'preview' || view === 'plan' ? 'guide' : view);
  }, [app.workspaceId, app.sessionId]);

  useEffect(() => {
    if (!app.workspacesLoading && browseWorkspaceId !== null && !app.workspaces.some((workspace) => workspace.id === browseWorkspaceId)) {
      setBrowseWorkspaceId(null);
    }
  }, [app.workspaces, app.workspacesLoading, browseWorkspaceId]);

  useEffect(() => {
    if (!rightOpen || !rightOverlay) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setRightOpen(false); setRightFullscreen(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [rightOpen, rightOverlay]);

  useEffect(() => {
    if (!mobile || !sidebarOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [mobile, sidebarOpen]);

  const browseWorkspace = app.workspaces.find((workspace) => workspace.id === browseWorkspaceId);
  const activeWorkspace = app.workspaces.find((workspace) => workspace.id === app.workspaceId);
  const activeWorkspaceName = activeWorkspace?.name || activeWorkspace?.path || '';

  /** Follow a previewed file through a rename or move, and close it when it is deleted. */
  const followFileChange = (change: FileMenuChange): void => {
    setFileRefreshToken((value) => value + 1);
    setPreview((current) => {
      if (current === null) return current;
      const inside = current.path === change.from || current.path.startsWith(`${change.from}/`);
      if (!inside) return current;
      if (change.to === undefined) return null;
      return { ...current, path: `${change.to}${current.path.slice(change.from.length)}` };
    });
  };

  /** Open one file in the preview page; absolute links are mapped onto the workspace root. */
  const openFile = (path: string, options?: { line?: number }): void => {
    if (app.workspaceId === null || app.workspaceId === undefined || path === '') return;
    const root = activeWorkspace?.path ?? '';
    let relative = path;
    if (root !== '' && (path === root || path.startsWith(`${root}/`))) {
      relative = path === root ? '' : path.slice(root.length + 1);
    } else if (path.startsWith('/')) {
      // An absolute path outside this workspace is not previewable from here.
      return;
    }
    if (relative === '') return;
    setPreview({
      workspaceId: app.workspaceId,
      workspaceName: activeWorkspaceName,
      path: relative,
      ...(options?.line === undefined ? {} : { line: options.line }),
    });
    setRightView('preview');
    setRightOpen(true);
    store.setTab('conversation');
  };
  const run = entry?.run;
  const planReview = run?.planReview;
  useEffect(() => {
    if (planReview !== undefined) setPlanDoc(planReview.plan);
  }, [planReview]);
  const openPlanPreview = (): void => {
    setRightView('plan');
    setRightOpen(true);
  };
  // Keep the last reviewed plan readable after the review settles: the live
  // request supplies status, the snapshot supplies the document.
  const planDocument: PlanDocument | null = planReview === undefined && planDoc === null ? null : {
    plan: planReview?.plan ?? planDoc ?? '',
    ...(planReview === undefined ? {} : {
      pending: planReview.pending === true,
      ...(planReview.error !== undefined && planReview.error !== '' ? { error: planReview.error } : {}),
    }),
  };
  const drawer = mobile && sidebarOpen;
  const hasSession = app.sessionId !== null;
  const draft = entry?.draft === true;
  const sessionBlocked = entry?.error !== undefined && entry.error !== '' && entry?.loaded !== true;
  const rightActive = rightOpen && app.tab !== 'automation' && app.tab !== 'settings';
  const maxRightWidth = Math.max(300, viewportWidth - (sidebarOpen && !mobile ? 280 : 0) - 400);
  const effectiveRightWidth = rightActive && !rightOverlay && !rightFullscreen
    ? Math.max(300, Math.min(rightWidth ?? Math.round(viewportWidth * 0.45), maxRightWidth))
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
      setRightWidth(Math.max(300, Math.min(maxRightWidth, next)));
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
      data-right-fullscreen={rightActive && rightFullscreen || undefined}
      data-right-overlay={rightActive && rightOverlay || undefined}
      data-mobile={mobile || undefined}
      style={shellStyle}
    >
      <div className={css.sidebarCol}>
        {browseWorkspace ? (
          <WorkspaceFileTree
            key={browseWorkspace.id}
            workspaceId={browseWorkspace.id}
            workspacePath={browseWorkspace.path}
            name={browseWorkspace.name || browseWorkspace.path}
            selected={preview?.workspaceId === browseWorkspace.id ? preview.path : null}
            refreshToken={fileRefreshToken}
            onChanged={followFileChange}
            onBack={() => { setBrowseWorkspaceId(null); }}
            onSelect={(path) => {
              setPreview({ workspaceId: browseWorkspace.id, workspaceName: browseWorkspace.name || browseWorkspace.path, path });
              setRightView('preview');
              setRightOpen(true);
              store.setTab('conversation');
              if (mobile) setSidebarOpen(false);
            }}
          />
        ) : <Sidebar drawer={mobile} onClose={() => { setSidebarOpen(false); }} onBrowseWorkspace={(workspaceId) => { setBrowseWorkspaceId(workspaceId); }} />}
      </div>
      {drawer && <div className={css.drawerMask} onClick={() => { setSidebarOpen(false); }} />}

      <div className={css.main}>
        <Header
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => { setSidebarOpen((value) => !value); }}
          rightOpen={rightActive}
          onToggleRight={() => { setRightView('guide'); setRightOpen(true); }}
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
        ) : (
          <div className={css.conversationArea}>
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
                <ConversationView
                  entry={entry}
                  processDisplay={app.processDisplay}
                  onOpenPlan={openPlanPreview}
                  onOpenFile={openFile}
                />
                {run?.approval !== undefined && run.stopping !== true && run.finishing !== true && (
                  <ApprovalView
                    approval={run.approval}
                    stopping={Boolean(run.stopping || run.finishing)}
                    onResolve={(decision) => { void store.resolveApproval(decision); }}
                  />
                )}
                <div className={css.composerArea}>
                  <Composer onOpenPlanPreview={openPlanPreview} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {rightActive && rightOverlay && !rightFullscreen && (
        <div className={css.rightMask} onClick={() => { setRightOpen(false); }} />
      )}
      {rightActive && (
        <div className={css.rightCol}>
          {!rightFullscreen && !rightOverlay && (
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
            view={rightView}
            preview={preview}
            plan={planDocument}
            onViewChange={setRightView}
            onClose={() => { setRightOpen(false); setRightFullscreen(false); }}
            onToggleFullscreen={() => { setRightFullscreen((value) => !value); }}
            onOpenFile={(path) => { openFile(path); }}
            refreshToken={fileRefreshToken}
            onFilesChanged={followFileChange}
          />
        </div>
      )}

      <NewSessionDialog />
    </div>
  );
}
