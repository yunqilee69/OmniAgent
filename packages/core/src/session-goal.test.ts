import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Message } from './domain/message';
import type { AgentEvent } from './protocol/events';
import { createInitialDshPermissionEvent, projectDshPermissions, snapshotDshPermissions } from './permissions/dsh-permissions';
import type { ModelClient, ModelRequest, ModelResponse } from './providers/types';
import { textResponse, toolCallResponse } from './providers/fake';
import type { FakeStep } from './providers/fake';
import { Session } from './session';
import { GOAL_CHANGE_EVENT, projectGoal } from './session/goal';
import { SessionStore } from './session/store';

const permissions = snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent('read-only')]));

function response(step: FakeStep): ModelResponse {
  return {
    message: step.message,
    usage: step.usage ?? { inputTokens: 0, outputTokens: 0 },
    stopReason: step.stopReason ?? 'end_turn',
  };
}

function textOf(message: Message | undefined): string {
  if (message?.role !== 'user') return '';
  return message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function toolResultOf(message: Message | undefined): { name: string; ok: boolean; content: string } | undefined {
  if (message?.role !== 'tool') return undefined;
  const result = message.results.at(-1);
  return result === undefined ? undefined : { name: result.name, ok: result.ok, content: result.content };
}

function goalRefFrom(content: string): { id: string; revision: number } {
  const match = /"id":"(goal-[^"]+)","revision":(\d+)/.exec(content);
  if (!match) throw new Error(`goal result had no ref: ${content}`);
  return { id: match[1]!, revision: Number(match[2]) };
}

class GoalFlowModel implements ModelClient {
  readonly name = 'goal-flow';
  readonly requests: ModelRequest[] = [];

  constructor(private readonly mode: 'complete' | 'round-limit') {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const last = request.messages.at(-1);
    const text = textOf(last);
    if (text.includes('<goal_complete>') || text.includes('<goal_blocked>')) {
      return response(textResponse('finished'));
    }
    if (text.includes('<goal_round>')) {
      return response(toolCallResponse([{ id: 'read', name: 'get_goal', args: {} }]));
    }
    if (text === 'start goal') {
      return response(toolCallResponse([{
        id: 'create',
        name: 'create_goal',
        args: {
          objective: 'ship the feature',
          max_goal_rounds: this.mode === 'round-limit' ? 1 : 4,
        },
      }]));
    }
    const result = toolResultOf(last);
    if (result?.name === 'create_goal' && result.ok) {
      return response(textResponse('goal started'));
    }
    if (result?.name === 'get_goal' && result.ok) {
      const ref = goalRefFrom(result.content);
      return response(toolCallResponse([{
        id: 'update',
        name: 'update_goal',
        args: this.mode === 'complete'
          ? { goal_id: ref.id, revision: ref.revision, action: 'complete' }
          : {
            goal_id: ref.id,
            revision: ref.revision,
            action: 'blocked',
            blocked_reason: 'The dependency is still unavailable.',
          },
      }]));
    }
    if (result?.name === 'update_goal') {
      return response(textResponse('goal update handled'));
    }
    return response(textResponse('unexpected turn'));
  }
}

class SubagentGoalModel implements ModelClient {
  readonly name = 'subagent-goal';
  private calls = 0;

  async complete(): Promise<ModelResponse> {
    if (this.calls++ > 0) return response(textResponse('rejected'));
    return response(toolCallResponse([{
      id: 'create',
      name: 'create_goal',
      args: { objective: 'should be rejected' },
    }]));
  }
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'omniagent-goal-session-'));
}

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe('Session goals', () => {
  it('automatically continues an armed goal and stops after complete', async () => {
    const cwd = await root();
    try {
      const store = new SessionStore(join(cwd, 'sessions'));
      const handle = await store.create({ id: 'agent', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      const model = new GoalFlowModel('complete');
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model,
        modelId: 'goal-flow',
        session: handle,
      });

      const events = await collect(session.send('start goal'));
      const results = events.filter((event) => event.type === 'tool.result');
      expect(results).toEqual([
        expect.objectContaining({ result: expect.objectContaining({ name: 'create_goal', ok: true }) }),
        expect.objectContaining({ result: expect.objectContaining({ name: 'get_goal', ok: true }) }),
        expect.objectContaining({ result: expect.objectContaining({ name: 'update_goal', ok: true }) }),
      ]);
      const projected = projectGoal(handle.events);
      expect(projected.failure).toBeNull();
      expect(projected.current).toMatchObject({
        goal: { objective: 'ship the feature', phase: 'complete' },
        roundsStarted: 1,
      });
      expect(handle.events.filter((event) => event.type === GOAL_CHANGE_EVENT).map((event) =>
        (event.data as { operation: string }).operation)).toEqual(['create', 'complete']);
      expect(handle.events).toContainEqual(expect.objectContaining({
        type: 'message/user',
        data: expect.objectContaining({
          source: expect.objectContaining({ kind: 'goal', round: 1, revision: 1 }),
        }),
      }));
      expect(handle.events).toContainEqual(expect.objectContaining({
        type: 'message/notice',
        data: expect.objectContaining({ source: 'tool-goal' }),
      }));
      expect(session.goals.view()?.activation).toBe('disarmed');
      expect(model.requests.length).toBe(5);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects model-reported blockers before the minimum round and blocks at the round cap', async () => {
    const cwd = await root();
    try {
      const store = new SessionStore(join(cwd, 'sessions'));
      const handle = await store.create({ id: 'agent', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model: new GoalFlowModel('round-limit'),
        modelId: 'goal-flow',
        session: handle,
      });

      const events = await collect(session.send('start goal'));
      const blockedTool = events.find((event) =>
        event.type === 'tool.result'
        && event.result.name === 'update_goal'
        && event.result.ok === false);
      expect(blockedTool?.type === 'tool.result' ? blockedTool.result.content : '')
        .toContain('at least 3 consecutive goal rounds');
      const projected = projectGoal(handle.events);
      expect(projected.failure).toBeNull();
      expect(projected.current).toMatchObject({
        goal: { phase: 'blocked', blockedReason: { code: 'round-limit' } },
        roundsStarted: 1,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('denies create_goal from a subagent session', async () => {
    const cwd = await root();
    try {
      const store = new SessionStore(join(cwd, 'sessions'));
      const handle = await store.create({
        id: 'child',
        workspace: cwd,
        cwd,
        parentSessionId: 'parent',
        depth: 1,
      });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model: new SubagentGoalModel(),
        modelId: 'subagent-goal',
        session: handle,
      });

      const events = await collect(session.send('go'));
      const result = events.find((event) => event.type === 'tool.result');
      expect(result).toEqual(expect.objectContaining({
        result: expect.objectContaining({
          name: 'create_goal',
          ok: false,
          content: expect.stringContaining('direct human turn'),
        }),
      }));
      expect(session.goals.view()).toBeUndefined();
      expect(handle.events.some((event) => event.type === GOAL_CHANGE_EVENT)).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
