import { describe, expect, it } from 'vitest';
import { GoalController, goalRefOf } from './goal-controller';
import { GOAL_CHANGE_EVENT, GoalSnapshotSchema, projectGoal } from './goal';
import type { GoalChange } from './goal';
import type { SessionEvent } from './types';

function eventLog(): { events: SessionEvent[]; append: (input: { type: string; data: unknown }) => Promise<void> } {
  const events: SessionEvent[] = [];
  return {
    events,
    append: async (input) => {
      events.push({ seq: events.length, ts: events.length + 1, type: input.type, data: input.data });
    },
  };
}

describe('goal domain', () => {
  it('creates, edits, pauses, resumes, counts rounds, and completes with CAS', async () => {
    const log = eventLog();
    let clock = 100;
    const controller = new GoalController({
      events: log.events,
      append: log.append,
      now: () => ++clock,
      createId: () => 'goal-1',
    });

    const created = await controller.create({ objective: '  Ship the release  ', maxGoalRounds: 4 });
    expect(created).toMatchObject({
      id: 'goal-1',
      revision: 1,
      objective: 'Ship the release',
      phase: 'active',
      roundsStarted: 0,
      maxGoalRounds: 4,
      activation: 'armed',
    });
    await expect(controller.create({ objective: 'again' })).rejects.toThrow(/already exists/);
    await expect(controller.edit({ id: 'goal-1', revision: 99 }, { objective: 'x' }))
      .rejects.toThrow(/stale goal ref/);
    await expect(controller.edit(goalRefOf(created), { objective: '   ' }))
      .rejects.toThrow(/non-empty/);
    await expect(controller.edit(goalRefOf(created), { maxGoalRounds: 0 }))
      .rejects.toThrow(/positive safe integer/);

    const edited = await controller.edit(goalRefOf(created), {
      objective: 'Ship the release safely',
      maxGoalRounds: 5,
    });
    expect(edited).toMatchObject({ revision: 2, objective: 'Ship the release safely', maxGoalRounds: 5 });
    const paused = await controller.pause(goalRefOf(edited));
    expect(paused).toMatchObject({ revision: 3, phase: 'paused', activation: 'disarmed' });
    const resumed = await controller.resume(goalRefOf(paused));
    expect(resumed).toMatchObject({ revision: 4, phase: 'active', activation: 'armed' });
    log.events.push({
      seq: log.events.length,
      ts: 50,
      type: 'message/user',
      data: {
        text: 'round 1',
        source: { kind: 'goal', goalId: resumed.id, revision: resumed.revision, round: 1 },
      },
    });
    controller.recordRound(1);
    expect(controller.view()).toMatchObject({ roundsStarted: 1, activation: 'armed' });
    const completed = await controller.complete({ id: resumed.id, revision: resumed.revision });
    expect(completed).toMatchObject({ revision: 5, phase: 'complete', activation: 'disarmed' });

    const projected = projectGoal(log.events);
    expect(projected.failure).toBeNull();
    expect(projected.current).toMatchObject({
      goal: { id: 'goal-1', revision: 5, objective: 'Ship the release safely', phase: 'complete' },
      roundsStarted: 1,
    });
    expect(log.events.filter((event) => event.type === GOAL_CHANGE_EVENT)).toHaveLength(5);
  });

  it('rejects invalid phase transitions and invalid snapshots during replay', async () => {
    const log = eventLog();
    const controller = new GoalController({ events: log.events, append: log.append, createId: () => 'goal-1' });
    const created = await controller.create({ objective: 'work' });
    await expect(controller.resume(goalRefOf(created))).rejects.toThrow(/already active and armed/);
    await expect(controller.complete({ id: 'goal-1', revision: 0 }))
      .rejects.toThrow(/revision 0/);

    const bad: SessionEvent[] = [{
      seq: 0,
      ts: 1,
      type: GOAL_CHANGE_EVENT,
      data: {
        kind: GOAL_CHANGE_EVENT,
        version: 1,
        operation: 'create',
        goal: { id: 'goal-x', revision: 2, objective: 'work', phase: 'active', maxGoalRounds: 2 },
        roundsStarted: 0,
        createdAt: 1,
        updatedAt: 1,
      } satisfies GoalChange,
    }];
    expect(projectGoal(bad).failure).toMatch(/goal replay failed/);
    expect(GoalSnapshotSchema.safeParse({
      id: 'goal-x', revision: 1, objective: ' work ', phase: 'active', maxGoalRounds: 2,
    }).success).toBe(false);
  });

  it('admits only the next round of the exact active revision', async () => {
    const log = eventLog();
    const controller = new GoalController({ events: log.events, append: log.append, createId: () => 'goal-1' });
    const created = await controller.create({ objective: 'work' });
    const revision = created.revision;
    const roundEvent = (round: number): SessionEvent => ({
      seq: log.events.length,
      ts: 10 + round,
      type: 'message/user',
      data: {
        text: `round ${round}`,
        source: { kind: 'goal', goalId: 'goal-1', revision, round },
      },
    });
    log.events.push(roundEvent(1));
    controller.recordRound(1);
    expect(projectGoal(log.events).current?.roundsStarted).toBe(1);

    log.events.push(roundEvent(3));
    expect(projectGoal(log.events).failure).toMatch(/not the next admitted round/);
  });
});
