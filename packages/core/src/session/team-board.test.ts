import { describe, expect, it } from 'vitest';
import { planSection, projectPlanDocuments } from './development-plan';
import {
  TEAM_TASK_EVENT,
  applyTeamTaskUpdate,
  boardHasOpenWork,
  createTeamTaskSnapshot,
  projectTeamBoard,
} from './team-board';

const PLAN = `# 优惠券模板

## 目标
商家可以创建模板。

## 设计
### 后端
模板聚合负责创建与停用。

### 前端
表单只提交模板字段。
`;

function eventsFrom(tasks: readonly { id: string }[]) {
  return tasks.map((task) => ({ type: TEAM_TASK_EVENT, data: { version: 1, task } }));
}

describe('development plan sections', () => {
  it('returns one heading without its children of a higher level', () => {
    expect(planSection(PLAN, '后端')).toBe('模板聚合负责创建与停用。');
    expect(planSection(PLAN, '设计')).toContain('### 后端');
    expect(planSection(PLAN, '不存在')).toBeUndefined();
  });

  it('keeps only versions that follow each other', () => {
    const events = [
      { type: 'plan/document', data: { id: 'plan-1', version: 1, title: '优惠券模板', body: PLAN, confirmedAt: 1 } },
      { type: 'plan/document', data: { id: 'plan-1', version: 3, title: '跳版', body: PLAN, confirmedAt: 2 } },
    ];
    expect(projectPlanDocuments(events)).toEqual([
      expect.objectContaining({ id: 'plan-1', version: 1 }),
    ]);
  });
});

describe('team board', () => {
  it('creates a pending task and refuses a second claim', () => {
    const created = createTeamTaskSnapshot([], {
      subject: '后端',
      description: '实现模板聚合',
      planId: 'plan-1',
      planVersion: 1,
      planHeading: '后端',
      acceptance: '创建与停用通过测试',
    });
    expect(created).toMatchObject({ id: 'task-1', revision: 1, status: 'pending' });
    expect('ready' in created).toBe(false);
    const events = eventsFrom([created]);
    const claimed = applyTeamTaskUpdate(events, {
      taskId: 'task-1', expectedRevision: 1, action: 'claim',
    }, { sessionId: 'dev', lead: false });
    expect(claimed).toMatchObject({ status: 'in_progress', ownerSessionId: 'dev', revision: 2 });
    expect(() => applyTeamTaskUpdate(eventsFrom([created, claimed]), {
      taskId: 'task-1', expectedRevision: 2, action: 'claim',
    }, { sessionId: 'other', lead: false })).toThrow(/in_progress/);
  });

  it('requires a different session to accept a review and a note to return it', () => {
    const created = createTeamTaskSnapshot([], { subject: '后端', description: '实现' });
    const claimed = applyTeamTaskUpdate(eventsFrom([created]), {
      taskId: 'task-1', expectedRevision: 1, action: 'claim',
    }, { sessionId: 'dev', lead: false });
    const submitted = applyTeamTaskUpdate(eventsFrom([created, claimed]), {
      taskId: 'task-1', expectedRevision: 2, action: 'submit', note: '接口已覆盖',
    }, { sessionId: 'dev', lead: false });
    expect(submitted.status).toBe('review');
    expect(() => applyTeamTaskUpdate(eventsFrom([created, claimed, submitted]), {
      taskId: 'task-1', expectedRevision: 3, action: 'accept',
    }, { sessionId: 'dev', lead: true })).toThrow(/other than its owner/);
    expect(() => applyTeamTaskUpdate(eventsFrom([created, claimed, submitted]), {
      taskId: 'task-1', expectedRevision: 3, action: 'return',
    }, { sessionId: 'reviewer', lead: false })).toThrow(/note/);
    const returned = applyTeamTaskUpdate(eventsFrom([created, claimed, submitted]), {
      taskId: 'task-1', expectedRevision: 3, action: 'return', note: '停用没有测试',
    }, { sessionId: 'reviewer', lead: false });
    expect(returned).toMatchObject({ status: 'in_progress', ownerSessionId: 'dev', note: '停用没有测试' });
    const again = applyTeamTaskUpdate(eventsFrom([created, claimed, submitted, returned]), {
      taskId: 'task-1', expectedRevision: 4, action: 'submit',
    }, { sessionId: 'dev', lead: false });
    const accepted = applyTeamTaskUpdate(eventsFrom([created, claimed, submitted, returned, again]), {
      taskId: 'task-1', expectedRevision: 5, action: 'accept',
    }, { sessionId: 'reviewer', lead: false });
    expect(accepted.status).toBe('completed');
    expect(boardHasOpenWork(eventsFrom([created, claimed, submitted, returned, again, accepted]))).toBe(false);
  });

  it('blocks a claim until the dependency is completed and rejects a stale revision', () => {
    const backend = createTeamTaskSnapshot([], { subject: '后端', description: '实现' });
    const frontend = createTeamTaskSnapshot(eventsFrom([backend]), {
      subject: '前端', description: '表单', blockedBy: ['task-1'],
    });
    const board = projectTeamBoard(eventsFrom([backend, frontend]));
    expect(board.tasks.find((task) => task.id === 'task-2')).toMatchObject({ ready: false });
    expect(() => applyTeamTaskUpdate(eventsFrom([backend, frontend]), {
      taskId: 'task-2', expectedRevision: 1, action: 'claim',
    }, { sessionId: 'dev', lead: false })).toThrow(/blocked/);
    expect(() => applyTeamTaskUpdate(eventsFrom([backend, frontend]), {
      taskId: 'task-1', expectedRevision: 4, action: 'claim',
    }, { sessionId: 'dev', lead: false })).toThrow(/revision/);
  });

  it('lets only the coordinator edit, and refuses to delete a task something still needs', () => {
    const backend = createTeamTaskSnapshot([], { subject: '后端', description: '实现' });
    const frontend = createTeamTaskSnapshot(eventsFrom([backend]), {
      subject: '前端', description: '表单', blockedBy: ['task-1'],
    });
    expect(() => applyTeamTaskUpdate(eventsFrom([backend, frontend]), {
      taskId: 'task-1', expectedRevision: 1, action: 'edit', subject: '后端接口',
    }, { sessionId: 'dev', lead: false })).toThrow(/coordinator/);
    expect(() => applyTeamTaskUpdate(eventsFrom([backend, frontend]), {
      taskId: 'task-1', expectedRevision: 1, action: 'delete',
    }, { sessionId: 'lead', lead: true })).toThrow(/depends/);
    const edited = applyTeamTaskUpdate(eventsFrom([backend, frontend]), {
      taskId: 'task-2', expectedRevision: 1, action: 'edit', subject: '前端表单', note: '按新计划收窄',
    }, { sessionId: 'lead', lead: true });
    expect(edited.subject).toBe('前端表单');
    expect(projectTeamBoard(eventsFrom([backend, frontend, edited])).tasks).toHaveLength(2);
  });
});
