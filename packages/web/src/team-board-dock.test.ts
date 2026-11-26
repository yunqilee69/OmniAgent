import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TeamBoardPanel } from '../ui/src/components/TeamBoardPanel.tsx';
import { rightPanelReducer, seedLayout, teamBoardAction } from '../ui/src/lib/right-panel-tabs.ts';
import type { DevelopmentPlan, TeamBoard } from '../ui/src/lib/wire.ts';

const plans: DevelopmentPlan[] = [
  { id: 'plan-1', version: 2, title: '优惠券模板', body: '# 优惠券模板', confirmedAt: 1 },
];
const board: TeamBoard = {
  tasks: [
    { id: 'task-1', revision: 3, subject: '后端', description: '', status: 'review', ready: false, blockedBy: [], note: '接口已覆盖' },
    { id: 'task-2', revision: 1, subject: '前端', description: '', status: 'pending', ready: false, blockedBy: ['task-1'], planHeading: '前端' },
  ],
};

describe('team board side panel', () => {
  it('opens from the title trail and shows status without leaving the conversation', () => {
    expect(teamBoardAction([], { tasks: [] })).toBeNull();
    const action = teamBoardAction(plans, board);
    expect(action).not.toBeNull();
    const layout = rightPanelReducer(seedLayout(), action!);
    expect(layout.activeId).toBe('board');
    const refreshed = rightPanelReducer(layout, { type: 'set-board', plans, board: { tasks: board.tasks.slice(0, 1) } });
    expect(refreshed.tabs.find((tab) => tab.kind === 'board')).toMatchObject({ board: { tasks: [board.tasks[0]] } });
    expect(refreshed.activeId).toBe('board');

    const html = renderToStaticMarkup(createElement(TeamBoardPanel, { plans, board, locale: 'zh' }));
    expect(html).toContain('后端');
    expect(html).toContain('待验收');
    expect(html).toContain('未就绪');
    expect(html).toContain('开发计划');
    expect(html).toContain('v2');
  });
});
