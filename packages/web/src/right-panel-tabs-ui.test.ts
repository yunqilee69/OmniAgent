import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RightPanel } from '../ui/src/components/RightPanel.tsx';
import { AppStore, store } from '../ui/src/lib/store.ts';
import {
  planPreviewAction,
  previewTabId,
  rightPanelReducer,
  seedLayout,
  type RightPanelLayout,
} from '../ui/src/lib/right-panel-tabs.ts';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});

afterEach(() => { vi.restoreAllMocks(); });

function englishStore(locale: 'en' | 'zh' = 'en'): void {
  vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...new AppStore(false).getSnapshot(), locale });
}

const guideFile = { workspaceId: 'ws-1', workspaceName: 'Demo workspace', path: 'docs/guide.md' };

function twoTabs(): RightPanelLayout {
  return rightPanelReducer(seedLayout(), {
    type: 'open',
    tab: { id: previewTabId(guideFile.workspaceId, guideFile.path), kind: 'preview', resource: guideFile },
  });
}

function renderPanel(layout: RightPanelLayout, hasPlan = false): string {
  return renderToStaticMarkup(createElement(RightPanel, {
    layout,
    hasPlan,
    onAction: () => {},
    fullscreen: false,
    onClose: () => {},
    onToggleFullscreen: () => {},
  }));
}

/** The opening tags of every `role="tabpanel"` page, so attributes can be asserted per page. */
function tabpanelTags(html: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const at = html.indexOf('role="tabpanel"', from);
    if (at === -1) return tags;
    const end = html.indexOf('>', at);
    tags.push(html.slice(at, end === -1 ? html.length : end));
    from = at + 1;
  }
}

/** The markup of each tab chip wrapper, up to its own closing `</div>`. */
function tabChips(html: string): string[] {
  return html.split('<div role="presentation"').slice(1).map((chunk) => chunk.split('</div>')[0] ?? '');
}

/**
 * Structural assertion instead of a looser regex: every `<button>` opens a frame
 * and every `</button>` closes one, so a stack deeper than one means buttons are
 * nested — which no markup assertion can rule out by pattern matching alone.
 */
function expectNoNestedButtons(html: string): void {
  const stack: number[] = [];
  for (const match of html.matchAll(/<button\b|<\/button>/g)) {
    if (match[0] === '</button>') {
      expect(stack.pop()).toBeDefined();
      continue;
    }
    stack.push(match.index ?? 0);
    expect(stack).toHaveLength(1);
  }
  expect(stack).toHaveLength(0);
}

describe('right panel tab strip', () => {
  it('renders a labelled tablist with one selected tab', () => {
    englishStore();
    const html = renderPanel(twoTabs());
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Panel tabs"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
  });

  it('wraps each tab in a presentation div holding the tab and its close button as siblings', () => {
    englishStore();
    const chips = tabChips(renderPanel(twoTabs()));
    expect(chips).toHaveLength(2);
    const guide = chips.find((chunk) => chunk.includes('data-tab-id="guide"')) ?? '';
    const preview = chips.find((chunk) => chunk.includes(`data-tab-id="${previewTabId('ws-1', 'docs/guide.md')}"`)) ?? '';
    // The guide is the panel's home: one button, no close control.
    expect(guide.match(/<button/g)).toHaveLength(1);
    expect(guide).not.toContain('Close tab');
    // A content tab has the tab button and a sibling close button.
    expect(preview.match(/<button/g)).toHaveLength(2);
    expect(preview.match(/role="tab"/g)).toHaveLength(1);
    expect(preview).toContain('aria-label="Close tab File preview｜guide.md"');
  });

  it('never nests a button inside another button', () => {
    englishStore();
    expectNoNestedButtons(renderPanel(twoTabs()));
  });

  it('keeps the inactive page mounted but hidden', () => {
    englishStore();
    const tags = tabpanelTags(renderPanel(twoTabs()));
    const guide = tags.find((tag) => tag.includes('aria-label="Start"')) ?? '';
    const preview = tags.find((tag) => tag.includes('aria-label="File preview｜guide.md"')) ?? '';
    expect(guide).toContain('data-active="false"');
    expect(guide).toContain('hidden=""');
    expect(preview).toContain('data-active="true"');
    expect(preview).not.toContain('hidden');
  });

  it('mounts the files page even while another tab is on screen', () => {
    englishStore();
    const layout = rightPanelReducer(seedLayout(), { type: 'open', tab: { id: 'files', kind: 'files' } });
    const html = renderPanel({ ...layout, activeId: 'guide' });
    expect(html).toContain('Search workspace files…');
    const files = tabpanelTags(html).find((tag) => tag.includes('aria-label="Workspace files"')) ?? '';
    expect(files).toContain('hidden=""');
  });

  it('translates the strip and close labels', () => {
    englishStore('zh');
    const html = renderPanel(twoTabs());
    expect(html).toContain('aria-label="面板标签页"');
    expect(html).toContain('aria-label="关闭标签页：文件预览｜guide.md"');
    expect(html).not.toContain('aria-label="关闭标签页：开始"');
  });
});

describe('guide plan review entry', () => {
  it('shows the plan review card when the session has a plan', () => {
    englishStore();
    const html = renderPanel(seedLayout(), true);
    expect(html).toContain('>Plan review</span>');
    expect(html).toContain('Open the last submitted plan.');
    expectNoNestedButtons(html);
  });

  it('hides the plan review card when the session has no plan', () => {
    englishStore();
    const html = renderPanel(seedLayout(), false);
    expect(html).not.toContain('Plan review');
    expect(html).not.toContain('Open the last submitted plan.');
  });

  it('keeps the card while the plan tab is already open', () => {
    englishStore();
    const withPlanTab = rightPanelReducer(seedLayout(), {
      type: 'open',
      tab: { id: 'plan', kind: 'plan', plan: { plan: '# First' } },
    });
    expect(renderPanel(withPlanTab, true)).toContain('>Plan review</span>');
  });

  it('turns the card request into an open action carrying the current plan', () => {
    // The panel holds no document: without one the App has nothing to open.
    expect(planPreviewAction(null)).toBeNull();
    const plan = { plan: '# Submitted' };
    const action = planPreviewAction(plan);
    if (action === null) throw new Error('open action missing');
    expect(action.type).toBe('open');

    // From the guide this opens the single plan tab and focuses it.
    const opened = rightPanelReducer(seedLayout(), action);
    const planTab = opened.tabs.find((tab) => tab.kind === 'plan');
    expect(planTab?.kind === 'plan' ? planTab.plan : null).toBe(plan);
    expect(opened.activeId).toBe('plan');
    expect(opened.tabs).toHaveLength(2);

    // With the tab already open it is refreshed and focused, never duplicated.
    const refreshed = rightPanelReducer(
      rightPanelReducer(opened, { type: 'activate', id: 'guide' }),
      action,
    );
    expect(refreshed.tabs.filter((tab) => tab.kind === 'plan')).toHaveLength(1);
    expect(refreshed.activeId).toBe('plan');
  });
});
