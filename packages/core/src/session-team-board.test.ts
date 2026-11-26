import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './protocol/events';
import { FakeModel, textResponse, toolCallResponse } from './providers/fake';
import { Session } from './session';
import { projectPlanDocuments } from './session/development-plan';
import { PLAN_MODE_EVENT } from './session/plan';
import type { TeamMemberSnapshot } from './session/mode-selection';
import { projectTeamBoard } from './session/team-board';
import { SessionStore } from './session/store';
import {
  createInitialDshPermissionEvent,
  projectDshPermissions,
  snapshotDshPermissions,
} from './permissions/dsh-permissions';

const permissions = snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent('read-only')]));
const members: TeamMemberSnapshot[] = [{
  id: 'builder',
  name: 'Builder',
  agent: 'explorer',
  model: { version: 2, kind: 'agent' },
  prompt: 'Build the cited slice.',
  tools: '*',
  skills: '*',
}];

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe('team plan and board', () => {
  it('stores the confirmed plan and keeps the coordinator going while a task is open', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omniagent-team-board-'));
    try {
      const store = new SessionStore(join(cwd, 'sessions'));
      const handle = await store.create({ id: 'root', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      await handle.append({ type: PLAN_MODE_EVENT, data: { active: true } });
      const plan = '# 优惠券模板\n\n## 交付切片\n### 后端\n实现模板聚合。\n';
      const model = new FakeModel([
        toolCallResponse([{ id: 'exit', name: 'exit_plan_mode', args: { plan } }]),
        toolCallResponse([{
          id: 'create',
          name: 'team_task_create',
          args: { subject: '后端', description: '实现模板聚合', plan_id: 'plan-1', plan_version: 1, plan_heading: '后端' },
        }]),
        textResponse('已切片'),
        textResponse('收尾'),
      ]);
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model,
        modelId: 'fake',
        reviewPlan: vi.fn(async () => ({ approved: true })),
        session: handle,
        subagents: {
          async start() { return { id: 'child', status: 'running' as const }; },
          async send() { return { messageId: 'm' }; },
          async list() { return []; },
          async wait() { return { id: 'child', status: 'completed' as const }; },
          async waitForStartedChildren() { return []; },
          trackChild() {},
          async interrupt() { return true; },
          canStart() { return true; },
        },
        teamMembers: members,
      });

      await collect(session.send('确认后开始'));

      expect(projectPlanDocuments(handle.events)).toEqual([
        expect.objectContaining({ id: 'plan-1', version: 1, title: '优惠券模板' }),
      ]);
      expect(projectTeamBoard(handle.events).tasks).toEqual([
        expect.objectContaining({ id: 'task-1', subject: '后端', status: 'pending', ready: true, planHeading: '后端' }),
      ]);
      const boardRounds = model.requests.filter((request) => {
        const message = request.messages.at(-1);
        return message?.role === 'user'
          && message.content.some((part) => part.type === 'text' && part.text.includes('<team_board>'));
      });
      expect(boardRounds).toHaveLength(1);
      const boardIndex = model.requests.findIndex((request) => request === boardRounds[0]);
      expect(boardIndex).toBeGreaterThan(0);
      expect(model.requests.slice(boardIndex + 1)).toHaveLength(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
