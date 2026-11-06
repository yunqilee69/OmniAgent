import { z } from 'zod';
import type { SessionEvent } from './types';

export const GOAL_CHANGE_EVENT = 'goal/change';
export const GOAL_CHANGE_VERSION = 1;
export const GOAL_PHASES = ['active', 'paused', 'blocked', 'complete'] as const;
export type GoalPhase = (typeof GOAL_PHASES)[number];
export const GOAL_ACTIVATIONS = ['armed', 'disarmed'] as const;
export type GoalActivation = (typeof GOAL_ACTIVATIONS)[number];

export const GOAL_DEFAULT_MAX_ROUNDS = 256;
export const GOAL_DEFAULT_BLOCKED_AFTER = 3;

export interface GoalBlockReason {
  code: string;
  message: string;
}

export interface GoalRef {
  id: string;
  revision: number;
}

export type GoalSnapshot = GoalRef & {
  objective: string;
  phase: GoalPhase;
  maxGoalRounds: number;
  blockedReason?: GoalBlockReason;
};

export interface GoalView extends GoalSnapshot {
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
  activation: GoalActivation;
}

export interface GoalProjection {
  goal: GoalSnapshot;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalProjectionState {
  current: GoalProjection | null;
  seenGoalIds: readonly string[];
  failure: string | null;
}

export type GoalOperation = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear';

export interface GoalSnapshotChange {
  kind: typeof GOAL_CHANGE_EVENT;
  version: typeof GOAL_CHANGE_VERSION;
  operation: Exclude<GoalOperation, 'clear'>;
  goal: GoalSnapshot;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalClearChange {
  kind: typeof GOAL_CHANGE_EVENT;
  version: typeof GOAL_CHANGE_VERSION;
  operation: 'clear';
  cleared: GoalRef;
  clearedAt: number;
}

export type GoalChange = GoalSnapshotChange | GoalClearChange;

export interface GoalMessageSource {
  kind: 'goal';
  goalId: string;
  revision: number;
  round: number;
}

export type GoalErrorCode =
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION';

export class GoalError extends Error {
  constructor(message: string, readonly code: GoalErrorCode) {
    super(message);
    this.name = 'GoalError';
  }
}

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const normalizedText = z.string().min(1).refine(
  (value) => value === value.trim(),
  'must be normalized without leading or trailing whitespace',
);
const blockReasonCode = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

const activeSnapshot = z.object({
  id: z.string().min(1),
  revision: positiveSafeInteger,
  objective: normalizedText,
  phase: z.literal('active'),
  maxGoalRounds: positiveSafeInteger,
}).strict();
const pausedSnapshot = z.object({
  id: z.string().min(1),
  revision: positiveSafeInteger,
  objective: normalizedText,
  phase: z.literal('paused'),
  maxGoalRounds: positiveSafeInteger,
}).strict();
const completeSnapshot = z.object({
  id: z.string().min(1),
  revision: positiveSafeInteger,
  objective: normalizedText,
  phase: z.literal('complete'),
  maxGoalRounds: positiveSafeInteger,
}).strict();
const blockedSnapshot = z.object({
  id: z.string().min(1),
  revision: positiveSafeInteger,
  objective: normalizedText,
  phase: z.literal('blocked'),
  maxGoalRounds: positiveSafeInteger,
  blockedReason: z.object({
    code: blockReasonCode,
    message: normalizedText,
  }).strict(),
}).strict();

export const GoalSnapshotSchema = z.discriminatedUnion('phase', [
  activeSnapshot,
  pausedSnapshot,
  completeSnapshot,
  blockedSnapshot,
]);

export const GoalRefSchema = z.object({
  id: z.string().min(1),
  revision: positiveSafeInteger,
}).strict();

const snapshotChange = z.object({
  kind: z.literal(GOAL_CHANGE_EVENT),
  version: z.literal(GOAL_CHANGE_VERSION),
  operation: z.enum(['create', 'edit', 'pause', 'resume', 'complete', 'block']),
  goal: GoalSnapshotSchema,
  roundsStarted: nonNegativeSafeInteger,
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
}).strict().refine((value) => value.updatedAt >= value.createdAt, {
  message: 'updatedAt cannot precede createdAt',
  path: ['updatedAt'],
});

const clearChange = z.object({
  kind: z.literal(GOAL_CHANGE_EVENT),
  version: z.literal(GOAL_CHANGE_VERSION),
  operation: z.literal('clear'),
  cleared: GoalRefSchema,
  clearedAt: nonNegativeSafeInteger,
}).strict();

export const GoalChangeSchema = z.union([snapshotChange, clearChange]);

export function decodeGoalChange(value: unknown): GoalChange | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (value as Record<string, unknown>).kind !== GOAL_CHANGE_EVENT) {
    return undefined;
  }
  const parsed = GoalChangeSchema.safeParse(value);
  if (!parsed.success) {
    throw new GoalError(`invalid goal change: ${parsed.error.message}`, 'GOAL_INVALID_TRANSITION');
  }
  return parsed.data;
}

export function goalChangeRef(change: GoalChange): GoalRef {
  return change.operation === 'clear'
    ? change.cleared
    : { id: change.goal.id, revision: change.goal.revision };
}

export interface GoalFoldState {
  goal: GoalSnapshot | undefined;
  roundsStarted: number;
  createdAt: number | undefined;
  updatedAt: number | undefined;
  lastRef: GoalRef | undefined;
  seenGoalIds: Set<string>;
}

export function emptyGoalFoldState(): GoalFoldState {
  return {
    goal: undefined,
    roundsStarted: 0,
    createdAt: undefined,
    updatedAt: undefined,
    lastRef: undefined,
    seenGoalIds: new Set(),
  };
}

function sameReason(left: GoalBlockReason | undefined, right: GoalBlockReason | undefined): boolean {
  return left?.code === right?.code && left?.message === right?.message;
}

function requireSameDefinition(current: GoalSnapshot, next: GoalSnapshot, operation: GoalOperation): void {
  if (next.objective !== current.objective || next.maxGoalRounds !== current.maxGoalRounds) {
    throw new Error(`goal ${operation} cannot change objective or maxGoalRounds`);
  }
}

function requireNextRevision(current: GoalSnapshot, next: GoalRef, operation: GoalOperation): void {
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(`goal ${operation} must advance the current goal by one revision`);
  }
}

function validateSnapshotTransition(
  state: GoalFoldState,
  change: GoalSnapshotChange,
  current: GoalSnapshot,
): void {
  const next = change.goal;
  requireNextRevision(current, next, change.operation);
  if (state.updatedAt === undefined) throw new Error('current goal fold lacks updatedAt');
  if (change.createdAt !== state.createdAt
    || change.updatedAt < state.updatedAt
    || change.roundsStarted !== state.roundsStarted) {
    throw new Error(`goal ${change.operation} does not preserve the current counters and timestamps`);
  }
  switch (change.operation) {
    case 'edit':
      if (next.phase !== current.phase || !sameReason(next.blockedReason, current.blockedReason)) {
        throw new Error('goal edit cannot change phase or blocked reason');
      }
      break;
    case 'pause':
      requireSameDefinition(current, next, change.operation);
      if (current.phase !== 'active' || next.phase !== 'paused') {
        throw new Error('goal pause has an invalid phase transition');
      }
      break;
    case 'resume': {
      requireSameDefinition(current, next, change.operation);
      const resumable = current.phase === 'active' || current.phase === 'paused' || current.phase === 'blocked';
      if (!resumable || next.phase !== 'active' || state.roundsStarted >= next.maxGoalRounds) {
        throw new Error('goal resume has an invalid phase transition or exhausted round budget');
      }
      break;
    }
    case 'complete':
      requireSameDefinition(current, next, change.operation);
      if (current.phase === 'complete' || next.phase !== 'complete') {
        throw new Error('goal complete has an invalid phase transition');
      }
      break;
    case 'block':
      requireSameDefinition(current, next, change.operation);
      if (current.phase !== 'active' || next.phase !== 'blocked') {
        throw new Error('goal block has an invalid phase transition');
      }
      break;
    case 'create':
      throw new Error('goal create cannot be validated as a current-goal transition');
  }
}

export function applyGoalChange(state: GoalFoldState, change: GoalChange): void {
  const ref = goalChangeRef(change);
  if (change.operation === 'clear') {
    const current = state.goal;
    if (current === undefined) throw new Error('goal clear requires a current goal');
    requireNextRevision(current, change.cleared, change.operation);
    if (state.updatedAt === undefined) throw new Error('current goal fold lacks updatedAt');
    if (change.clearedAt < state.updatedAt) {
      throw new Error('goal clear timestamp cannot precede the current goal update');
    }
    state.goal = undefined;
    state.roundsStarted = 0;
    state.createdAt = undefined;
    state.updatedAt = undefined;
    state.lastRef = ref;
    return;
  }
  if (change.operation === 'create') {
    if (change.goal.revision !== 1
      || change.goal.phase !== 'active'
      || change.roundsStarted !== 0
      || (state.goal !== undefined && state.goal.phase !== 'complete')
      || state.seenGoalIds.has(change.goal.id)) {
      throw new Error('goal create requires a fresh active revision-one goal with zero rounds');
    }
    state.seenGoalIds.add(change.goal.id);
  } else {
    const current = state.goal;
    if (current === undefined) throw new Error(`goal ${change.operation} requires a current goal`);
    validateSnapshotTransition(state, change, current);
  }
  state.goal = change.goal;
  state.roundsStarted = change.roundsStarted;
  state.createdAt = change.createdAt;
  state.updatedAt = change.updatedAt;
  state.lastRef = ref;
}

const goalMessageSource = z.object({
  kind: z.literal('goal'),
  goalId: z.string().min(1),
  revision: positiveSafeInteger,
  round: positiveSafeInteger,
}).strict();

function goalSource(data: unknown): GoalMessageSource | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const source = (data as Record<string, unknown>).source;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return undefined;
  if ((source as Record<string, unknown>).kind !== 'goal') return undefined;
  const parsed = goalMessageSource.safeParse(source);
  if (!parsed.success) throw new Error('goal message source is invalid');
  return parsed.data;
}

export function applyGoalEvent(state: GoalFoldState, event: Pick<SessionEvent, 'seq' | 'type' | 'data'>): void {
  if (event.type === GOAL_CHANGE_EVENT) {
    const change = decodeGoalChange(event.data);
    if (change === undefined) throw new Error(`goal change at session event ${event.seq} has an invalid kind`);
    applyGoalChange(state, change);
    return;
  }
  if (event.type !== 'message/user' && event.type !== 'user/message') return;
  const source = goalSource(event.data);
  if (source === undefined) return;
  const current = state.goal;
  if (current === undefined
    || current.phase !== 'active'
    || source.goalId !== current.id
    || source.revision !== current.revision
    || source.round !== state.roundsStarted + 1
    || source.round > current.maxGoalRounds) {
    throw new Error(`goal round at session event ${event.seq} is not the next admitted round of the active goal`);
  }
  state.roundsStarted = source.round;
}

function advanceProjection(current: GoalProjection | null, roundsStarted: number): GoalProjection {
  if (current === null) throw new Error('goal fold advanced rounds without a current goal');
  return {
    goal: current.goal,
    roundsStarted,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  };
}

export function projectGoal(events: readonly Pick<SessionEvent, 'seq' | 'type' | 'data'>[]): GoalProjectionState {
  const state = emptyGoalFoldState();
  let current: GoalProjection | null = null;
  let failure: string | null = null;
  for (const event of events) {
    const before = state.goal;
    try {
      applyGoalEvent(state, event);
    } catch (error) {
      failure = `goal replay failed at session event ${event.seq}: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    if (state.goal !== before) {
      if (state.goal === undefined) {
        current = null;
      } else {
        if (state.createdAt === undefined || state.updatedAt === undefined) {
          throw new Error('goal fold has a current goal without timestamps');
        }
        current = {
          goal: { ...state.goal },
          roundsStarted: state.roundsStarted,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        };
      }
    } else if (state.goal !== undefined && (event.type === 'message/user' || event.type === 'user/message')) {
      current = advanceProjection(current, state.roundsStarted);
    }
  }
  return { current, seenGoalIds: [...state.seenGoalIds], failure };
}

export function resolveObjective(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal objective must be a non-empty string', 'GOAL_INVALID_OBJECTIVE');
  }
  return value.trim();
}

export function resolveMaxGoalRounds(value: unknown, fallback = GOAL_DEFAULT_MAX_ROUNDS): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 1) {
    throw new GoalError('maxGoalRounds must be a positive safe integer', 'GOAL_INVALID_MAX_ROUNDS');
  }
  return resolved;
}

export function resolveBlockReason(code: unknown, message: unknown): GoalBlockReason {
  if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
    || typeof message !== 'string' || message.trim().length === 0) {
    throw new GoalError(
      'goal block reason requires a lower-kebab-case code and a non-empty message',
      'GOAL_INVALID_BLOCK_REASON',
    );
  }
  return { code, message: message.trim() };
}

export function renderGoalRoundPrompt(goal: GoalView, round: number): string {
  return '<goal_round>\n'
    + `Objective: ${JSON.stringify(goal.objective)}\n`
    + `Round: ${round}/${goal.maxGoalRounds}\n\n`
    + 'Continue working toward the objective in this same session. Treat the current workspace, '
    + 'tool results, and durable session state as authoritative; inspect them instead of assuming '
    + 'earlier narration is still current. Make concrete progress and verify the result. Before '
    + 'claiming completion, gather evidence that the whole objective is achieved, read the current '
    + 'goal, and mark it complete. If work remains, leave the goal active for the next round. Follow '
    + 'the configured goal-tool policy before reporting a blocker.\n'
    + '</goal_round>';
}

const WRAPUP_GROUNDING =
  'Report only what earlier rounds and tool results in this session actually establish; '
  + 'when a detail is not in the session, say so instead of inventing it. ';

export function renderGoalWrapup(objective: string, blockedReason?: string): string {
  const heading = `Objective: ${JSON.stringify(objective)}\n`;
  if (blockedReason === undefined) {
    return '<goal_complete>\n'
      + heading
      + 'The goal is marked complete and this autonomous run is ending. Write the closing '
      + 'message to the user now: state the outcome, summarize what was done and how it was '
      + 'verified, and point to the concrete results (files, commits, or other artifacts). '
      + WRAPUP_GROUNDING
      + 'Note anything the user should review or do next. Address the user directly. Do not '
      + "call any more tools in this run; further work waits for the user's next instruction.\n"
      + '</goal_complete>';
  }
  return '<goal_blocked>\n'
    + heading
    + `Blocked: ${JSON.stringify(blockedReason)}\n`
    + 'The goal is marked blocked and this autonomous run is ending. Write the closing '
    + 'message to the user now: state what has been completed so far, describe the concrete '
    + 'blocking condition and what you tried, and say exactly what you need from the user to '
    + 'continue. '
    + WRAPUP_GROUNDING
    + 'Address the user directly. Do not call any more tools in this run; further work '
    + "waits for the user's next instruction.\n"
    + '</goal_blocked>';
}

export function renderGoalToolGuidance(blockedAfter = GOAL_DEFAULT_BLOCKED_AFTER): string {
  return 'create_goal may infer goal intent from a direct human request in any language. '
    + 'After session resume or fork, an active goal is disarmed: when '
    + 'a human asks to continue or resume in any wording or language, use update_goal action '
    + 'resume to rearm it. Mark complete only when the objective is actually achieved. Mark '
    + `blocked only after the same blocking condition persists for at least ${blockedAfter} `
    + 'consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, '
    + 'or useful remaining work is not blocked.';
}
