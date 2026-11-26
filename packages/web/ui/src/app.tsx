import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { Button, FishLogo, IconCloseOutlineRegular, IconWarningOutlineRegular } from '../vendor/primitives/index.ts';
import { sessionKey, store, useApp, useSessionEntry } from './lib/store.ts';
import { translator } from './lib/i18n.ts';
import { Header } from './components/Header.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { ConversationView } from './components/ConversationView.tsx';
import { Composer } from './components/Composer.tsx';
import { ConversationWidth } from './components/ConversationWidth.tsx';
import { ApprovalView } from './components/ApprovalView.tsx';
import { AutomationPage } from './components/AutomationPage.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { NewSessionDialog } from './components/NewSessionDialog.tsx';
import { RightPanel } from './components/RightPanel.tsx';
import {
  activeTab,
  planPreviewAction,
  teamBoardAction,
  previewTabId,
  rightPanelReducer,
  seedLayout,
  type RightPanelAction,
  type RightPanelIntent,
  type RightPanelLayout,
} from './lib/right-panel-tabs.ts';
import type { PlanDocument } from './components/PlanReview.tsx';
import { WorkspaceFileTree } from './components/WorkspaceFileTree.tsx';
import type { FileMenuChange } from './components/FileTreeMenu.tsx';
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
  /** One dock layout per session, kept in memory only: a reload starts from the seed. */
  const layoutsRef = useRef<Map<string, RightPanelLayout>>(new Map());
  const [layout, setLayout] = useState<RightPanelLayout>(() => seedLayout());
  const [browseWorkspaceId, setBrowseWorkspaceId] = useState<string | null>(null);
  /** Bumped after a file operation so open folder listings and the file page refetch. */
  const [fileRefreshToken, setFileRefreshToken] = useState(0);
  const [planDoc, setPlanDoc] = useState<string | null>(null);
  const booted = useRef(false);
  const hasSession = app.sessionId !== null;
  const draft = entry?.draft === true;
  const layoutKey = !draft && app.workspaceId !== null && app.sessionId !== null
    ? sessionKey(app.workspaceId, app.sessionId)
    : `new:${app.workspaceId ?? ''}`;

  const dispatchLayout = useCallback((action: RightPanelAction): void => {
    setLayout((current) => {
      const next = rightPanelReducer(current, action);
      if (next === current) return current;
      layoutsRef.current.set(layoutKey, next);
      return next;
    });
  }, [layoutKey]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void store.bootstrap();
  }, []);

  useEffect(() => {
    if (mobile) setSidebarOpen(false);
  }, [mobile]);

  useEffect(() => {
    // Switching session or workspace restores that key's dock layout; a key seen
    // for the first time starts at the guide. Previews and plans are not reset —
    // they belong to the layout, which is already per session.
    const stored = layoutsRef.current.get(layoutKey);
    if (stored !== undefined) {
      setLayout(stored);
      return;
    }
    const seeded = seedLayout();
    layoutsRef.current.set(layoutKey, seeded);
    setLayout(seeded);
  }, [layoutKey]);

  useEffect(() => {
    if (!app.workspacesLoading && browseWorkspaceId !== null && !app.workspaces.some((workspace) => workspace.id === browseWorkspaceId)) {
      setBrowseWorkspaceId(null);
    }
  }, [app.workspaces, app.workspacesLoading, browseWorkspaceId]);

  // The plan snapshot only stands in for the settled review of *this* session.
  useEffect(() => {
    setPlanDoc(null);
  }, [app.workspaceId, app.sessionId]);

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
  /** The tree highlights the file whose preview tab is on screen, not the last one opened. */
  const dockTab = activeTab(layout);
  const activePreview = dockTab.kind === 'preview' ? dockTab.resource : null;

  /** Follow previewed files through a rename or move, and close them when deleted. */
  const followFileChange = (change: FileMenuChange): void => {
    setFileRefreshToken((value) => value + 1);
    if (app.workspaceId === null || app.workspaceId === undefined) return;
    if (change.to === undefined) {
      dispatchLayout({ type: 'remove-preview', workspaceId: app.workspaceId, path: change.from });
      return;
    }
    dispatchLayout({ type: 'rename-preview', workspaceId: app.workspaceId, from: change.from, to: change.to });
  };

  /** Open one file in a preview tab; absolute links are mapped onto the workspace root. */
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
    // The reducer owns de-duplication: the same file focuses its tab and merges the line.
    dispatchLayout({
      type: 'open',
      tab: {
        id: previewTabId(app.workspaceId, relative),
        kind: 'preview',
        resource: {
          workspaceId: app.workspaceId,
          workspaceName: activeWorkspaceName,
          path: relative,
          ...(options?.line === undefined ? {} : { line: options.line }),
        },
      },
    });
    setRightOpen(true);
    store.setTab('conversation');
  };
  const run = entry?.run;
  const planReview = run?.planReview;
  useEffect(() => {
    if (planReview !== undefined) setPlanDoc(planReview.plan);
  }, [planReview]);
  // Keep the last reviewed plan readable after the review settles: the live
  // request supplies status, the snapshot supplies the document.
  const planDocument = useMemo<PlanDocument | null>(() => {
    if (planReview === undefined && planDoc === null) return null;
    return {
      plan: planReview?.plan ?? planDoc ?? '',
      ...(planReview === undefined ? {} : {
        pending: planReview.pending === true,
        ...(planReview.error !== undefined && planReview.error !== '' ? { error: planReview.error } : {}),
      }),
    };
  }, [planReview, planDoc]);
  useEffect(() => {
    // A refreshed plan flows into an open plan tab; it never opens one by itself.
    if (planDocument !== null) dispatchLayout({ type: 'set-plan', plan: planDocument });
  }, [planDocument, dispatchLayout]);
  const boardPlans = entry?.plans ?? [];
  const board = entry?.teamBoard ?? { tasks: [] };
  useEffect(() => {
    dispatchLayout({ type: 'set-board', plans: boardPlans, board });
  }, [board, boardPlans, dispatchLayout]);
  const openTeamBoard = useCallback((): void => {
    const action = teamBoardAction(boardPlans, board);
    if (action === null) return;
    dispatchLayout(action);
    setRightOpen(true);
  }, [board, boardPlans, dispatchLayout]);
  const openPlanPreview = useCallback((): void => {
    // No plan in this session means nothing to preview; opening an empty tab would lie.
    const action = planPreviewAction(planDocument);
    if (action === null) return;
    // An existing plan tab is refocused and refreshed by the reducer, not duplicated.
    dispatchLayout(action);
    setRightOpen(true);
  }, [dispatchLayout, planDocument]);
  /** The panel asks; the App answers with the document it owns. */
  const handlePanelAction = useCallback((intent: RightPanelIntent): void => {
    if (intent.type === 'open-plan') {
      openPlanPreview();
      return;
    }
    dispatchLayout(intent);
  }, [dispatchLayout, openPlanPreview]);
  const drawer = mobile && sidebarOpen;
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
            selected={activePreview !== null && activePreview.workspaceId === browseWorkspace.id ? activePreview.path : null}
            refreshToken={fileRefreshToken}
            onChanged={followFileChange}
            onBack={() => { setBrowseWorkspaceId(null); }}
            onSelect={(path) => {
              dispatchLayout({
                type: 'open',
                tab: {
                  id: previewTabId(browseWorkspace.id, path),
                  kind: 'preview',
                  resource: { workspaceId: browseWorkspace.id, workspaceName: browseWorkspace.name || browseWorkspace.path, path },
                },
              });
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
          onToggleRight={() => { setRightOpen(true); }}
          onOpenBoard={boardPlans.length > 0 || board.tasks.length > 0 ? openTeamBoard : undefined}
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
                <ConversationWidth />
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
                <ConversationWidth />
                <ConversationView
                  key={app.sessionId ?? 'session'}
                  entry={entry}
                  processDisplay={app.processDisplay}
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
            layout={layout}
            hasPlan={planDocument !== null}
            onAction={handlePanelAction}
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
