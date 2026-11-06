import { randomUUID } from 'node:crypto';
import type { SessionEvent, SessionEventInput } from './types';
import {
  GOAL_CHANGE_EVENT,
  GOAL_CHANGE_VERSION,
  GOAL_DEFAULT_MAX_ROUNDS,
  GoalError,
  applyGoalChange,
  emptyGoalFoldState,
  projectGoal,
  resolveBlockReason,
  resolveMaxGoalRounds,
  resolveObjective,
} from './goal';
import type {
  GoalActivation,
  GoalBlockReason,
  GoalChange,
  GoalFoldState,
  GoalPhase,
  GoalProjection,
  GoalRef,
  GoalSnapshot,
  GoalSnapshotChange,
  GoalView,
} from './goal';

export interface GoalControllerOptions {
  events?: readonly SessionEvent[];
  append?: (event: SessionEventInput) => Promise<unknown>;
  now?: () => number;
  createId?: () => string;
  defaultMaxGoalRounds?: number;
}

export interface CreateGoalRequest {
  objective: string;
  maxGoalRounds?: number;
}

export interface EditGoalRequest {
  objective?: string;
  maxGoalRounds?: number;
}

/**
 * Event-sourced goal state for one session. Every mutation appends one
 * `goal/change` full snapshot before the in-memory projection advances.
 * Activation is process-local and starts disarmed after a session reload.
 */
export class GoalController {
  private readonly append?: (event: SessionEventInput) => Promise<unknown>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly defaultMaxGoalRounds: number;
  private readonly fold: GoalFoldState;
  private current: GoalProjection | null;
  private goalFailure: string | null;
  private runtimeActivation: GoalActivation = 'disarmed';

  constructor(options: GoalControllerOptions = {}) {
    const projection = projectGoal(options.events ?? []);
    this.append = options.append;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `goal-${randomUUID()}`);
    this.defaultMaxGoalRounds = options.defaultMaxGoalRounds ?? GOAL_DEFAULT_MAX_ROUNDS;
    this.current = projection.current;
    this.goalFailure = projection.failure;
    this.fold = emptyGoalFoldState();
    this.fold.goal = this.current?.goal;
    this.fold.roundsStarted = this.current?.roundsStarted ?? 0;
    this.fold.createdAt = this.current?.createdAt;
    this.fold.updatedAt = this.current?.updatedAt;
    for (const id of projection.seenGoalIds) this.fold.seenGoalIds.add(id);
  }

  get failure(): string | null {
    return this.goalFailure;
  }

  get activation(): GoalActivation {
    return this.runtimeActivation;
  }

  view(): GoalView | undefined {
    if (this.goalFailure !== null) throw new Error(this.goalFailure);
    if (this.current === null) return undefined;
    return {
      ...this.current.goal,
      roundsStarted: this.current.roundsStarted,
      createdAt: this.current.createdAt,
      updatedAt: this.current.updatedAt,
      activation: this.runtimeActivation,
    };
  }

  disarm(): void {
    this.runtimeActivation = 'disarmed';
  }

  async create(request: CreateGoalRequest): Promise<GoalView> {
    const current = this.expectLiveCurrent();
    if (current !== null && current.goal.phase !== 'complete') {
      throw new GoalError(
        `goal "${current.goal.id}" already exists with phase "${current.goal.phase}"`,
        'GOAL_ALREADY_EXISTS',
      );
    }
    const objective = resolveObjective(request.objective);
    const maxGoalRounds = resolveMaxGoalRounds(request.maxGoalRounds, this.defaultMaxGoalRounds);
    let id: string;
    do {
      id = this.createId();
      if (id.length === 0) throw new GoalError('goal id must be a non-empty string', 'GOAL_INVALID_TRANSITION');
    } while (this.fold.seenGoalIds.has(id));
    const now = this.now();
    const goal: GoalSnapshot = {
      id,
      revision: 1,
      objective,
      phase: 'active',
      maxGoalRounds,
    };
    return this.commitSnapshot('create', goal, 0, now, now, 'armed');
  }

  async edit(ref: GoalRef, request: EditGoalRequest): Promise<GoalView> {
    const current = this.expectRef(ref);
    if (request.objective === undefined && request.maxGoalRounds === undefined) {
      throw new GoalError('goal edit requires objective and/or maxGoalRounds', 'GOAL_INVALID_EDIT');
    }
    const goal: GoalSnapshot = {
      ...current.goal,
      revision: current.goal.revision + 1,
      ...(request.objective === undefined ? {} : { objective: resolveObjective(request.objective) }),
      ...(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds) }),
    };
    return this.commitSnapshot(
      'edit',
      goal,
      current.roundsStarted,
      current.createdAt,
      this.nextMutationTime(current),
      this.runtimeActivation,
    );
  }

  async pause(ref: GoalRef): Promise<GoalView> {
    return this.transition(ref, 'pause', ['active'], 'paused', 'disarmed');
  }

  async resume(ref: GoalRef): Promise<GoalView> {
    const current = this.expectRef(ref);
    const resumable: readonly GoalPhase[] = ['active', 'paused', 'blocked'];
    if (!resumable.includes(current.goal.phase)) {
      throw this.transitionError(current.goal, 'resume', resumable);
    }
    if (current.goal.phase === 'active' && this.runtimeActivation === 'armed') {
      throw new GoalError(
        `goal "${current.goal.id}" is already active and armed`,
        'GOAL_INVALID_TRANSITION',
      );
    }
    if (current.roundsStarted >= current.goal.maxGoalRounds) {
      throw new GoalError(
        `goal "${current.goal.id}" exhausted ${current.goal.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
        'GOAL_INVALID_TRANSITION',
      );
    }
    return this.commitSnapshot(
      'resume',
      this.withPhase(current.goal, 'active'),
      current.roundsStarted,
      current.createdAt,
      this.nextMutationTime(current),
      'armed',
    );
  }

  async complete(ref: GoalRef): Promise<GoalView> {
    return this.transition(ref, 'complete', ['active', 'paused', 'blocked'], 'complete', 'disarmed');
  }

  async block(ref: GoalRef, reason: GoalBlockReason): Promise<GoalView> {
    const current = this.expectRef(ref);
    if (current.goal.phase !== 'active') {
      throw this.transitionError(current.goal, 'block', ['active']);
    }
    const resolved = resolveBlockReason(reason.code, reason.message);
    return this.commitSnapshot(
      'block',
      { ...this.withPhase(current.goal, 'blocked'), blockedReason: resolved },
      current.roundsStarted,
      current.createdAt,
      this.nextMutationTime(current),
      'disarmed',
    );
  }

  /** Record a persisted admitted goal-round message. */
  recordRound(round: number): void {
    const current = this.expectLiveCurrent();
    if (current === null
      || current.goal.phase !== 'active'
      || round !== current.roundsStarted + 1
      || round > current.goal.maxGoalRounds) {
      throw new GoalError('goal round is not the next admitted round of the active goal', 'GOAL_INVALID_TRANSITION');
    }
    this.fold.roundsStarted = round;
    this.current = { ...current, roundsStarted: round };
  }

  private expectLiveCurrent(): GoalProjection | null {
    if (this.goalFailure !== null) throw new Error(this.goalFailure);
    return this.current;
  }

  private expectRef(ref: GoalRef): GoalProjection {
    const current = this.expectLiveCurrent();
    if (current === null) throw new GoalError('no current goal', 'GOAL_NOT_FOUND');
    if (ref.id !== current.goal.id || ref.revision !== current.goal.revision) {
      throw new GoalError(
        `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.goal.id}" revision ${current.goal.revision}`,
        'GOAL_STALE_REVISION',
      );
    }
    return current;
  }

  private withPhase(current: GoalSnapshot, phase: GoalPhase): GoalSnapshot {
    return {
      id: current.id,
      revision: current.revision + 1,
      objective: current.objective,
      phase,
      maxGoalRounds: current.maxGoalRounds,
    };
  }

  private async transition(
    ref: GoalRef,
    operation: Exclude<GoalSnapshotChange['operation'], 'create' | 'edit'>,
    allowed: readonly GoalPhase[],
    phase: GoalPhase,
    activation: GoalActivation,
  ): Promise<GoalView> {
    const current = this.expectRef(ref);
    if (!allowed.includes(current.goal.phase)) {
      throw this.transitionError(current.goal, operation, allowed);
    }
    return this.commitSnapshot(
      operation,
      this.withPhase(current.goal, phase),
      current.roundsStarted,
      current.createdAt,
      this.nextMutationTime(current),
      activation,
    );
  }

  private transitionError(
    current: GoalSnapshot,
    operation: GoalChange['operation'],
    allowed: readonly GoalPhase[],
  ): GoalError {
    return new GoalError(
      `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'GOAL_INVALID_TRANSITION',
    );
  }

  private nextMutationTime(current: GoalProjection): number {
    return Math.max(this.now(), current.updatedAt);
  }

  private async commitSnapshot(
    operation: GoalSnapshotChange['operation'],
    goal: GoalSnapshot,
    roundsStarted: number,
    createdAt: number,
    updatedAt: number,
    activation: GoalActivation,
  ): Promise<GoalView> {
    const change: GoalSnapshotChange = {
      kind: GOAL_CHANGE_EVENT,
      version: GOAL_CHANGE_VERSION,
      operation,
      goal,
      roundsStarted,
      createdAt,
      updatedAt,
    };
    await this.commit(change, activation);
    const current = this.expectLiveCurrent();
    if (current === null) throw new GoalError('goal mutation did not leave a current goal', 'GOAL_INVALID_TRANSITION');
    return {
      ...current.goal,
      roundsStarted: current.roundsStarted,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      activation: this.runtimeActivation,
    };
  }

  private async commit(change: GoalChange, activation: GoalActivation): Promise<void> {
    if (this.append) await this.append({ type: GOAL_CHANGE_EVENT, data: change });
    applyGoalChange(this.fold, change);
    const goal = this.fold.goal;
    if (goal === undefined) {
      this.current = null;
    } else {
      if (this.fold.createdAt === undefined || this.fold.updatedAt === undefined) {
        throw new Error('goal mutation left a current goal without timestamps');
      }
      this.current = {
        goal: { ...goal },
        roundsStarted: this.fold.roundsStarted,
        createdAt: this.fold.createdAt,
        updatedAt: this.fold.updatedAt,
      };
    }
    this.runtimeActivation = activation;
  }
}

export function goalRefOf(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision };
}
