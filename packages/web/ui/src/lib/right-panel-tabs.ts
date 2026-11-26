/**
 * Right-panel dock layout as a pure reducer: no React, no store, no browser
 * storage. `App` keeps one layout per session in memory and the panel renders
 * whatever this reducer produces, so the tab rules stay unit-testable.
 */
import type { PlanDocument } from '../components/PlanReview.tsx';
import type { DevelopmentPlan, TeamBoard } from './wire.ts';

export type TabKind = 'guide' | 'files' | 'terminal' | 'observe' | 'plan' | 'preview' | 'board';

export interface PreviewResource {
  workspaceId: string;
  workspaceName: string;
  path: string;
  line?: number;
}

export type RightTab =
  | { id: 'guide'; kind: 'guide' }
  | { id: 'files'; kind: 'files' }
  | { id: 'terminal'; kind: 'terminal' }
  | { id: 'observe'; kind: 'observe' }
  | { id: 'plan'; kind: 'plan'; plan: PlanDocument }
  | { id: 'board'; kind: 'board'; plans: DevelopmentPlan[]; board: TeamBoard }
  | { id: `preview:${string}`; kind: 'preview'; resource: PreviewResource };

export interface RightPanelLayout {
  /** Invariant: `tabs[0]` is always the guide tab, and it cannot be closed. */
  tabs: RightTab[];
  activeId: string;
}

export type RightPanelAction =
  | { type: 'open'; tab: RightTab }
  | { type: 'activate'; id: string }
  | { type: 'close'; id: string }
  | { type: 'rename-preview'; workspaceId: string; from: string; to: string }
  | { type: 'remove-preview'; workspaceId: string; path: string }
  | { type: 'set-plan'; plan: PlanDocument }
  | { type: 'set-board'; plans: DevelopmentPlan[]; board: TeamBoard }
  | { type: 'set-workspace-name'; workspaceId: string; workspaceName: string };

/**
 * What the panel can ask for. `open-plan` carries no document: the panel only
 * knows whether a plan exists, and the caller (which owns the plan body) turns
 * the request into an `open` action, so the reducer never gains a second source
 * of plan documents.
 */
export type RightPanelIntent = RightPanelAction | { type: 'open-plan' };

const GUIDE_ID = 'guide';

const GUIDE_TAB: RightTab = { id: 'guide', kind: 'guide' };

/**
 * A preview tab is identified by workspace and path; the reveal line is state
 * on that tab, not part of its identity, so re-opening the same file moves the
 * caret instead of adding a second tab.
 */
export function previewTabId(workspaceId: string, path: string): `preview:${string}` {
  return `preview:${workspaceId}:${encodeURIComponent(path)}`;
}

export function seedLayout(): RightPanelLayout {
  return { tabs: [GUIDE_TAB], activeId: GUIDE_ID };
}

/**
 * The action behind the guide's "Plan review" card and the composer's preview
 * link, or `null` when this session has no plan to show. The caller owns the
 * document, so it decides there is something to open; the reducer then opens or
 * refocuses the (single) plan tab with that document.
 */
export function planPreviewAction(plan: PlanDocument | null): RightPanelAction | null {
  return plan === null ? null : { type: 'open', tab: { id: 'plan', kind: 'plan', plan } };
}

/** Open the shared team board, or null when this session has neither tasks nor a plan. */
export function teamBoardAction(plans: readonly DevelopmentPlan[], board: TeamBoard): RightPanelAction | null {
  if (plans.length === 0 && board.tasks.length === 0) return null;
  return { type: 'open', tab: { id: 'board', kind: 'board', plans: [...plans], board } };
}

type PreviewTab = Extract<RightTab, { kind: 'preview' }>;

function previewTab(resource: PreviewResource): PreviewTab {
  return { id: previewTabId(resource.workspaceId, resource.path), kind: 'preview', resource };
}

function withLine(resource: PreviewResource, line: number | undefined): PreviewResource {
  if (line === undefined) return resource;
  return { ...resource, line };
}

/**
 * Drop the flagged tabs. A dropped active tab selects its nearest surviving left
 * neighbour — the guide when it sat right next to it — never the tab to its right.
 * `activeIndex` is the active tab's slot in `layout.tabs`, which a rename may have
 * re-identified before calling in.
 */
function dropFlagged(
  layout: RightPanelLayout, flagged: readonly boolean[], activeIndex: number,
): RightPanelLayout {
  if (!flagged.some(Boolean)) return layout;
  const remaining = layout.tabs.filter((_tab, index) => flagged[index] !== true);
  if (activeIndex === -1 || flagged[activeIndex] !== true) {
    return { tabs: remaining, activeId: layout.activeId };
  }
  // Same rule as closing one tab: the nearest surviving tab to the left, which is
  // the guide whenever the closed tab sat right next to it.
  let activeId = GUIDE_ID;
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    if (flagged[index] !== true) {
      activeId = layout.tabs[index]?.id ?? GUIDE_ID;
      break;
    }
  }
  return { tabs: remaining, activeId };
}

function openTab(layout: RightPanelLayout, incoming: RightTab): RightPanelLayout {
  if (incoming.kind === 'preview') {
    const tab = previewTab(incoming.resource);
    const index = layout.tabs.findIndex((item) => item.id === tab.id);
    if (index === -1) return { tabs: [...layout.tabs, tab], activeId: tab.id };
    const current = layout.tabs[index];
    const resource = current?.kind === 'preview'
      ? withLine(tab.resource, tab.resource.line ?? current.resource.line)
      : tab.resource;
    const tabs = [...layout.tabs];
    tabs[index] = previewTab(resource);
    return { tabs, activeId: tab.id };
  }
  const index = layout.tabs.findIndex((item) => item.kind === incoming.kind);
  if (index === -1) return { tabs: [...layout.tabs, incoming], activeId: incoming.id };
  const current = layout.tabs[index];
  // Re-opening a singleton refreshes its payload (the plan document) and focus.
  if (current?.kind === 'plan' && incoming.kind === 'plan'
    && current.plan === incoming.plan && layout.activeId === incoming.id) {
    return layout;
  }
  const tabs = [...layout.tabs];
  tabs[index] = incoming;
  return { tabs, activeId: incoming.id };
}

function renamePreviews(
  layout: RightPanelLayout, workspaceId: string, from: string, to: string,
): RightPanelLayout {
  const prefix = `${from}/`;
  const renamed = layout.tabs.map((tab): RightTab => {
    if (tab.kind !== 'preview' || tab.resource.workspaceId !== workspaceId) return tab;
    const path = tab.resource.path;
    if (path !== from && !path.startsWith(prefix)) return tab;
    return previewTab({ ...tab.resource, path: `${to}${path.slice(from.length)}` });
  });
  if (renamed.every((tab, index) => tab === layout.tabs[index])) return layout;
  // A rename can land on an id another tab already owns: the earlier tab in the
  // array keeps it, and the loser is closed like any other closed tab.
  const seen = new Set<string>();
  const flagged = renamed.map((tab) => {
    if (seen.has(tab.id)) return true;
    seen.add(tab.id);
    return false;
  });
  // The active tab keeps its slot but may have a new id after the rename.
  const activeIndex = layout.tabs.findIndex((tab) => tab.id === layout.activeId);
  const activeId = activeIndex === -1 ? layout.activeId : renamed[activeIndex]?.id ?? layout.activeId;
  return dropFlagged({ tabs: renamed, activeId }, flagged, activeIndex);
}

function removePreviews(layout: RightPanelLayout, workspaceId: string, path: string): RightPanelLayout {
  const prefix = `${path}/`;
  const flagged = layout.tabs.map((tab) => tab.kind === 'preview'
    && tab.resource.workspaceId === workspaceId
    && (tab.resource.path === path || tab.resource.path.startsWith(prefix)));
  return dropFlagged(layout, flagged, layout.tabs.findIndex((tab) => tab.id === layout.activeId));
}

export function rightPanelReducer(layout: RightPanelLayout, action: RightPanelAction): RightPanelLayout {
  switch (action.type) {
    case 'open':
      return openTab(layout, action.tab);
    case 'activate':
      if (layout.activeId === action.id) return layout;
      return layout.tabs.some((tab) => tab.id === action.id)
        ? { tabs: layout.tabs, activeId: action.id }
        : layout;
    case 'close':
      // The guide is the panel's home: it is always first and never closable.
      if (action.id === GUIDE_ID) return layout;
      return dropFlagged(
        layout,
        layout.tabs.map((tab) => tab.id === action.id),
        layout.tabs.findIndex((tab) => tab.id === layout.activeId),
      );
    case 'rename-preview':
      return renamePreviews(layout, action.workspaceId, action.from, action.to);
    case 'remove-preview':
      return removePreviews(layout, action.workspaceId, action.path);
    case 'set-plan': {
      // A new plan only flows into a plan tab that is already open; it never
      // opens one, because that would move the panel under the user.
      const index = layout.tabs.findIndex((tab) => tab.kind === 'plan');
      const current = index === -1 ? undefined : layout.tabs[index];
      if (current?.kind !== 'plan' || current.plan === action.plan) return layout;
      const tabs = [...layout.tabs];
      tabs[index] = { id: 'plan', kind: 'plan', plan: action.plan };
      return { tabs, activeId: layout.activeId };
    }
    case 'set-board': {
      const index = layout.tabs.findIndex((tab) => tab.kind === 'board');
      const current = index === -1 ? undefined : layout.tabs[index];
      if (current?.kind !== 'board') return layout;
      if (current.plans === action.plans && current.board === action.board) return layout;
      const tabs = [...layout.tabs];
      tabs[index] = { id: 'board', kind: 'board', plans: action.plans, board: action.board };
      return { tabs, activeId: layout.activeId };
    }
    case 'set-workspace-name': {
      let changed = false;
      const tabs = layout.tabs.map((tab): RightTab => {
        if (tab.kind !== 'preview' || tab.resource.workspaceId !== action.workspaceId
          || tab.resource.workspaceName === action.workspaceName) return tab;
        changed = true;
        return { ...tab, resource: { ...tab.resource, workspaceName: action.workspaceName } };
      });
      return changed ? { tabs, activeId: layout.activeId } : layout;
    }
    default:
      return layout;
  }
}

export function activeTab(layout: RightPanelLayout): RightTab {
  return layout.tabs.find((tab) => tab.id === layout.activeId) ?? layout.tabs[0] ?? GUIDE_TAB;
}
