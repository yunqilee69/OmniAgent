import { describe, expect, it } from 'vitest';
import {
  activeTab,
  previewTabId,
  rightPanelReducer,
  seedLayout,
  type PreviewResource,
  type RightPanelAction,
  type RightPanelLayout,
  type RightTab,
} from '../ui/src/lib/right-panel-tabs.ts';

const ws = 'ws-1';

function openFiles(): RightPanelAction {
  return { type: 'open', tab: { id: 'files', kind: 'files' } };
}

function openSingleton(kind: 'observe' | 'terminal'): RightPanelAction {
  const tab: RightTab = kind === 'observe'
    ? { id: 'observe', kind: 'observe' }
    : { id: 'terminal', kind: 'terminal' };
  return { type: 'open', tab };
}

function openPreview(path: string, line?: number, workspaceId = ws): RightPanelAction {
  const resource: PreviewResource = { workspaceId, workspaceName: 'Demo workspace', path };
  if (line !== undefined) resource.line = line;
  return { type: 'open', tab: { id: previewTabId(workspaceId, path), kind: 'preview', resource } };
}

function run(layout: RightPanelLayout, ...actions: RightPanelAction[]): RightPanelLayout {
  return actions.reduce(rightPanelReducer, layout);
}

function ids(layout: RightPanelLayout): string[] {
  return layout.tabs.map((tab) => tab.id);
}

function previewOf(layout: RightPanelLayout, path: string, workspaceId = ws): RightTab | undefined {
  return layout.tabs.find((tab) => tab.id === previewTabId(workspaceId, path));
}

describe('right panel tabs', () => {
  it('seeds a single guide tab that is always first', () => {
    const layout = seedLayout();
    expect(ids(layout)).toEqual(['guide']);
    expect(layout.activeId).toBe('guide');
    expect(activeTab(layout)).toEqual({ id: 'guide', kind: 'guide' });
    expect(ids(run(layout, openFiles(), openPreview('docs/a.md')))[0]).toBe('guide');
  });

  it('refuses to close the guide', () => {
    const layout = run(seedLayout(), openFiles(), openPreview('docs/a.md'));
    expect(rightPanelReducer(layout, { type: 'close', id: 'guide' })).toBe(layout);
  });

  it('ignores an activate for a tab that is not open', () => {
    const layout = run(seedLayout(), openFiles());
    expect(rightPanelReducer(layout, { type: 'activate', id: 'missing' })).toBe(layout);
    expect(rightPanelReducer(layout, { type: 'activate', id: 'files' })).toBe(layout);
    expect(rightPanelReducer(layout, { type: 'activate', id: 'guide' }).activeId).toBe('guide');
  });

  it('opens each singleton once and only moves focus afterwards', () => {
    expect(ids(run(seedLayout(), openFiles(), openFiles()))).toEqual(['guide', 'files']);
    const layout = run(seedLayout(), openFiles(), openSingleton('observe'), openFiles());
    expect(ids(layout)).toEqual(['guide', 'files', 'observe']);
    expect(layout.activeId).toBe('files');
  });

  it('replaces the payload when the plan tab is reopened', () => {
    const first = run(seedLayout(), { type: 'open', tab: { id: 'plan', kind: 'plan', plan: { plan: '# First' } } });
    const second = run(first, { type: 'open', tab: { id: 'plan', kind: 'plan', plan: { plan: '# Second', pending: true } } });
    expect(ids(second)).toEqual(['guide', 'plan']);
    const plan = second.tabs.find((tab) => tab.kind === 'plan');
    expect(plan?.kind === 'plan' ? plan.plan.plan : '').toBe('# Second');
    expect(plan?.kind === 'plan' ? plan.plan.pending : undefined).toBe(true);
  });

  it('identifies a preview by workspace and path, so the line only moves the caret', () => {
    expect(previewTabId(ws, 'docs/guide.md')).toBe('preview:ws-1:docs%2Fguide.md');
    const layout = run(seedLayout(), openPreview('docs/guide.md', 12), openPreview('docs/guide.md', 40));
    expect(ids(layout)).toEqual(['guide', previewTabId(ws, 'docs/guide.md')]);
    expect(layout.activeId).toBe(previewTabId(ws, 'docs/guide.md'));
    const tab = previewOf(layout, 'docs/guide.md');
    expect(tab?.kind === 'preview' ? tab.resource.line : undefined).toBe(40);
    // Re-opening without a line keeps the line the tab already had.
    const again = run(layout, openPreview('docs/guide.md'));
    const merged = previewOf(again, 'docs/guide.md');
    expect(merged?.kind === 'preview' ? merged.resource.line : undefined).toBe(40);
    // The same path in another workspace is a different file.
    expect(ids(run(again, openPreview('docs/guide.md', undefined, 'ws-2')))).toEqual([
      'guide', previewTabId(ws, 'docs/guide.md'), previewTabId('ws-2', 'docs/guide.md'),
    ]);
  });

  it('closes the active tab onto its left neighbour and back to the guide at the first slot', () => {
    const layout = run(seedLayout(), openFiles(), openSingleton('observe'), openSingleton('terminal'));
    const afterTerminal = rightPanelReducer(layout, { type: 'close', id: 'terminal' });
    expect(afterTerminal.activeId).toBe('observe');
    const afterObserve = rightPanelReducer(afterTerminal, { type: 'close', id: 'observe' });
    expect(afterObserve.activeId).toBe('files');
    // The files tab sits right next to the guide: closing it returns to the guide.
    const afterFiles = rightPanelReducer(afterObserve, { type: 'close', id: 'files' });
    expect(ids(afterFiles)).toEqual(['guide']);
    expect(afterFiles.activeId).toBe('guide');
  });

  it('keeps the selected tab when a different tab is closed', () => {
    const layout = run(seedLayout(), openFiles(), openPreview('docs/a.md'), openSingleton('observe'));
    const next = rightPanelReducer(layout, { type: 'close', id: 'files' });
    expect(next.activeId).toBe('observe');
    expect(ids(next)).toEqual(['guide', previewTabId(ws, 'docs/a.md'), 'observe']);
    const unknown = rightPanelReducer(next, { type: 'close', id: 'missing' });
    expect(unknown).toBe(next);
  });

  it('follows a renamed folder into every preview beneath it', () => {
    const layout = run(seedLayout(), openPreview('docs/a.md', 7), openPreview('docs/sub/b.md'));
    const next = rightPanelReducer(layout, { type: 'rename-preview', workspaceId: ws, from: 'docs', to: 'guides' });
    expect(ids(next)).toEqual(['guide', previewTabId(ws, 'guides/a.md'), previewTabId(ws, 'guides/sub/b.md')]);
    expect(next.activeId).toBe(previewTabId(ws, 'guides/sub/b.md'));
    const renamed = previewOf(next, 'guides/a.md');
    expect(renamed?.kind === 'preview' ? renamed.resource.line : undefined).toBe(7);
    expect(renamed?.kind === 'preview' ? renamed.resource.workspaceName : '').toBe('Demo workspace');
  });

  it('leaves previews that only share a name prefix alone', () => {
    const layout = run(seedLayout(), openPreview('docs/a.md'), openPreview('docset/b.md'));
    const next = rightPanelReducer(layout, { type: 'rename-preview', workspaceId: ws, from: 'docs', to: 'guides' });
    expect(ids(next)).toEqual(['guide', previewTabId(ws, 'guides/a.md'), previewTabId(ws, 'docset/b.md')]);
    // Another workspace's identical path is untouched.
    const other = run(seedLayout(), openPreview('docs/a.md'), openPreview('docs/a.md', undefined, 'ws-2'));
    const renamed = rightPanelReducer(other, { type: 'rename-preview', workspaceId: ws, from: 'docs', to: 'guides' });
    expect(ids(renamed)).toEqual(['guide', previewTabId(ws, 'guides/a.md'), previewTabId('ws-2', 'docs/a.md')]);
  });

  it('keeps the earlier tab when a rename collides with an open preview', () => {
    const layout = run(seedLayout(), openPreview('a.md'), openPreview('b.md'));
    const next = rightPanelReducer(layout, { type: 'rename-preview', workspaceId: ws, from: 'b.md', to: 'a.md' });
    expect(ids(next)).toEqual(['guide', previewTabId(ws, 'a.md')]);
    // The dropped tab was active, so focus lands on its left neighbour.
    expect(next.activeId).toBe(previewTabId(ws, 'a.md'));
    // Same rule in the other direction: the earlier (renamed) tab keeps the id.
    const back = rightPanelReducer(layout, { type: 'rename-preview', workspaceId: ws, from: 'a.md', to: 'b.md' });
    expect(ids(back)).toEqual(['guide', previewTabId(ws, 'b.md')]);
  });

  it('closes every preview under a removed folder', () => {
    const layout = run(seedLayout(), openPreview('docs/a.md'), openPreview('docs/sub/b.md'), openPreview('docset/c.md'));
    const next = rightPanelReducer(layout, { type: 'remove-preview', workspaceId: ws, path: 'docs' });
    expect(ids(next)).toEqual(['guide', previewTabId(ws, 'docset/c.md')]);
    expect(next.activeId).toBe(previewTabId(ws, 'docset/c.md'));
    const removedActive = rightPanelReducer(
      run(seedLayout(), openPreview('docs/a.md'), openPreview('docs/sub/b.md')),
      { type: 'remove-preview', workspaceId: ws, path: 'docs' },
    );
    expect(ids(removedActive)).toEqual(['guide']);
    expect(removedActive.activeId).toBe('guide');
  });

  it('closes one removed file without touching its siblings', () => {
    const layout = run(seedLayout(), openPreview('docs/a.md'), openPreview('docs/b.md'));
    const next = rightPanelReducer(layout, { type: 'remove-preview', workspaceId: ws, path: 'docs/a.md' });
    expect(ids(next)).toEqual(['guide', previewTabId(ws, 'docs/b.md')]);
  });

  it('feeds a new plan only into a plan tab that is already open', () => {
    const withoutPlan = run(seedLayout(), openFiles());
    expect(rightPanelReducer(withoutPlan, { type: 'set-plan', plan: { plan: '# Later' } })).toBe(withoutPlan);
    const withPlan = run(
      withoutPlan,
      { type: 'open', tab: { id: 'plan', kind: 'plan', plan: { plan: '# First' } } },
      openFiles(),
    );
    const next = rightPanelReducer(withPlan, { type: 'set-plan', plan: { plan: '# Second', pending: true } });
    const plan = next.tabs.find((tab) => tab.kind === 'plan');
    expect(plan?.kind === 'plan' ? plan.plan.plan : '').toBe('# Second');
    // Refreshing the document never steals focus or opens a tab.
    expect(next.activeId).toBe('files');
    expect(ids(next)).toEqual(['guide', 'files', 'plan']);
    // An unchanged document is not a new layout.
    const same = next.tabs.find((tab) => tab.kind === 'plan');
    if (same?.kind !== 'plan') throw new Error('plan tab missing');
    expect(rightPanelReducer(next, { type: 'set-plan', plan: same.plan })).toBe(next);
  });

  it('renames the workspace shown on its preview tabs', () => {
    const layout = run(seedLayout(), openPreview('docs/a.md'), openPreview('docs/a.md', undefined, 'ws-2'));
    const next = rightPanelReducer(layout, { type: 'set-workspace-name', workspaceId: ws, workspaceName: 'Renamed' });
    const mine = previewOf(next, 'docs/a.md');
    const other = previewOf(next, 'docs/a.md', 'ws-2');
    expect(mine?.kind === 'preview' ? mine.resource.workspaceName : '').toBe('Renamed');
    expect(other?.kind === 'preview' ? other.resource.workspaceName : '').toBe('Demo workspace');
    expect(ids(next)).toEqual(ids(layout));
  });

  it('falls back to the guide when a layout has no tabs to focus', () => {
    expect(activeTab({ tabs: [], activeId: 'preview:ws-1:a.md' })).toEqual({ id: 'guide', kind: 'guide' });
  });
});
