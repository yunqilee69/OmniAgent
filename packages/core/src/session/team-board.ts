import { z } from 'zod';

/**
 * Shared task board for one team, stored only on the root session log.
 *
 * Every mutation appends a whole snapshot and must name the revision it read.
 * Status is the lifecycle of a delivery slice. The plan document stays the
 * specification; this record only says who is doing the slice and how far it is.
 *
 * `ready` is not stored. A pending task is ready when every blocker is completed.
 */

export const TEAM_TASK_EVENT = 'team/task';

export const TEAM_TASK_SUBJECT_MAX = 200;
export const TEAM_TASK_DESCRIPTION_MAX = 16_384;
export const TEAM_TASK_NOTE_MAX = 4_000;
export const TEAM_TASK_HEADING_MAX = 200;
export const TEAM_TASK_PATH_MAX = 300;
export const TEAM_BOARD_MAX_TASKS = 256;

export const TEAM_TASK_STATUSES = ['pending', 'in_progress', 'review', 'completed', 'deleted'] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

export const TEAM_TASK_ACTIONS = [
  'claim', 'release', 'edit', 'set_dependencies', 'submit', 'accept', 'return', 'reopen', 'reassign', 'delete',
] as const;
export type TeamTaskAction = (typeof TEAM_TASK_ACTIONS)[number];

const TaskIdSchema = z.string().regex(/^task-\d+$/u);
const PlanIdSchema = z.string().regex(/^plan-\d+$/u);

export const TeamTaskSnapshotSchema = z.object({
  id: TaskIdSchema,
  revision: z.number().int().positive(),
  subject: z.string().trim().min(1).max(TEAM_TASK_SUBJECT_MAX),
  description: z.string().max(TEAM_TASK_DESCRIPTION_MAX),
  status: z.enum(TEAM_TASK_STATUSES),
  ownerSessionId: z.string().min(1).max(256).optional(),
  blockedBy: z.array(TaskIdSchema).max(64),
  planId: PlanIdSchema.optional(),
  planVersion: z.number().int().positive().optional(),
  planHeading: z.string().trim().min(1).max(TEAM_TASK_HEADING_MAX).optional(),
  acceptance: z.string().max(TEAM_TASK_DESCRIPTION_MAX).optional(),
  paths: z.array(z.string().trim().min(1).max(TEAM_TASK_PATH_MAX)).max(64).optional(),
  note: z.string().max(TEAM_TASK_NOTE_MAX).optional(),
}).strict();
export type TeamTaskSnapshot = z.infer<typeof TeamTaskSnapshotSchema>;

export interface TeamTaskView extends TeamTaskSnapshot {
  /** Pending, and every blocker is completed. Derived, never stored. */
  ready: boolean;
}

export interface TeamBoardView {
  tasks: TeamTaskView[];
  /** Set when a later record was rejected; the board stays at the last valid fold. */
  failure?: string;
}

export interface CreateTeamTaskInput {
  subject: string;
  description: string;
  blockedBy?: readonly string[];
  planId?: string;
  planVersion?: number;
  planHeading?: string;
  acceptance?: string;
  paths?: readonly string[];
}

export interface UpdateTeamTaskInput {
  taskId: string;
  expectedRevision: number;
  action: TeamTaskAction;
  subject?: string;
  description?: string;
  blockedBy?: readonly string[];
  planId?: string;
  planVersion?: number;
  planHeading?: string;
  acceptance?: string;
  paths?: readonly string[];
  ownerSessionId?: string;
  note?: string;
}

interface BoardFold {
  tasks: Map<string, TeamTaskSnapshot>;
  nextNumber: number;
  failure?: string;
}

export class TeamBoardError extends Error {
  constructor(message: string, readonly code: TeamBoardErrorCode) {
    super(message);
    this.name = 'TeamBoardError';
  }
}

export type TeamBoardErrorCode =
  | 'TEAM_TASK_NOT_FOUND'
  | 'TEAM_TASK_STALE_REVISION'
  | 'TEAM_TASK_ALREADY_CLAIMED'
  | 'TEAM_TASK_BLOCKED'
  | 'TEAM_TASK_STATUS'
  | 'TEAM_TASK_FORBIDDEN'
  | 'TEAM_TASK_DEPENDENCY'
  | 'TEAM_TASK_LIMIT'
  | 'TEAM_LEAD_REQUIRED'
  | 'TEAM_REVIEWER_REQUIRED';

/**
 * Fold task snapshots. A record that breaks the revision chain, names a dead
 * blocker, or cycles the graph freezes the board: later records are ignored
 * and `failure` explains the first rejection.
 */
export function projectTeamBoard(events: readonly { type: string; data: unknown }[]): TeamBoardView {
  const fold = foldBoard(events);
  return {
    tasks: visibleTasks(fold),
    ...(fold.failure === undefined ? {} : { failure: fold.failure }),
  };
}

/** The last accepted snapshot, including a deleted tombstone. Absent when the id was never valid. */
export function projectTeamTask(
  events: readonly { type: string; data: unknown }[],
  taskId: string,
): TeamTaskView | undefined {
  const fold = foldBoard(events);
  const task = fold.tasks.get(taskId);
  return task === undefined ? undefined : enrich(task, fold.tasks);
}

/** Tasks still needing a developer or a reviewer. Deleted tasks are not open. */
export function boardHasOpenWork(events: readonly { type: string; data: unknown }[]): boolean {
  return projectTeamBoard(events).tasks.some((task) => task.status !== 'completed');
}

export function createTeamTaskSnapshot(
  events: readonly { type: string; data: unknown }[],
  input: CreateTeamTaskInput,
): TeamTaskSnapshot {
  const fold = requireHealthy(events);
  const live = [...fold.tasks.values()].filter((task) => task.status !== 'deleted');
  if (live.length >= TEAM_BOARD_MAX_TASKS) {
    throw new TeamBoardError(`team board already has ${TEAM_BOARD_MAX_TASKS} tasks`, 'TEAM_TASK_LIMIT');
  }
  const blockedBy = normalizeIds(input.blockedBy ?? []);
  assertBlockers(fold.tasks, blockedBy);
  return TeamTaskSnapshotSchema.parse({
    id: `task-${fold.nextNumber}`,
    revision: 1,
    subject: input.subject,
    description: input.description,
    status: 'pending',
    blockedBy,
    ...planFields(input),
  });
}

/**
 * Apply one compare-and-set action.
 *
 * The lead may edit, reassign, and delete. A member claims and submits its own
 * task. Accepting a review requires a session other than the owner, so the
 * developer who did the work cannot mark it done.
 */
export function applyTeamTaskUpdate(
  events: readonly { type: string; data: unknown }[],
  input: UpdateTeamTaskInput,
  actor: { sessionId: string; lead: boolean },
): TeamTaskSnapshot {
  const fold = requireHealthy(events);
  const current = fold.tasks.get(input.taskId);
  if (current === undefined) throw new TeamBoardError(`unknown task ${input.taskId}`, 'TEAM_TASK_NOT_FOUND');
  if (current.revision !== input.expectedRevision) {
    throw new TeamBoardError(
      `task ${current.id} is at revision ${current.revision}, not ${input.expectedRevision}`,
      'TEAM_TASK_STALE_REVISION',
    );
  }
  const next = mutate(current, input, actor, fold.tasks);
  assertAcyclic(fold.tasks, next);
  return TeamTaskSnapshotSchema.parse(next);
}

function mutate(
  current: TeamTaskSnapshot,
  input: UpdateTeamTaskInput,
  actor: { sessionId: string; lead: boolean },
  tasks: ReadonlyMap<string, TeamTaskSnapshot>,
): TeamTaskSnapshot {
  const owner = actor.lead || current.ownerSessionId === actor.sessionId;
  switch (input.action) {
    case 'claim':
      return claim(current, actor, tasks);
    case 'release':
      requireOwnerOrLead(owner, 'release');
      requireStatus(current, ['in_progress', 'review']);
      return clearOwner({ ...current, status: 'pending' }, input.note);
    case 'edit':
      requireLead(actor, 'edit');
      if (current.status === 'deleted' || current.status === 'completed') {
        throw new TeamBoardError(`task ${current.id} can no longer be edited`, 'TEAM_TASK_STATUS');
      }
      return {
        ...current,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.blockedBy === undefined ? {} : { blockedBy: checkedBlockers(tasks, current.id, input.blockedBy) }),
        ...planFields(input, current),
        ...(input.note === undefined ? {} : { note: input.note }),
        revision: current.revision + 1,
      };
    case 'set_dependencies':
      requireOwnerOrLead(owner, 'set_dependencies');
      requireStatus(current, ['pending', 'in_progress', 'review']);
      return {
        ...current,
        blockedBy: checkedBlockers(tasks, current.id, input.blockedBy ?? []),
        revision: current.revision + 1,
      };
    case 'submit':
      requireOwner(current, actor, 'submit');
      requireStatus(current, ['in_progress']);
      return { ...current, status: 'review', ...(input.note === undefined ? {} : { note: input.note }), revision: current.revision + 1 };
    case 'accept':
      return review(current, actor, 'completed', input.note);
    case 'return':
      return review(current, actor, 'in_progress', input.note, true);
    case 'reopen':
      requireLead(actor, 'reopen');
      requireStatus(current, ['completed']);
      return clearOwner({ ...current, status: 'pending' }, input.note);
    case 'reassign':
      requireLead(actor, 'reassign');
      requireStatus(current, ['pending', 'in_progress', 'review']);
      if (input.ownerSessionId === undefined || input.ownerSessionId === '') {
        return clearOwner({ ...current, status: 'pending' }, input.note);
      }
      if (current.status === 'pending' && !isReady(current, tasks)) {
        throw new TeamBoardError(`task ${current.id} is blocked`, 'TEAM_TASK_BLOCKED');
      }
      return {
        ...current,
        status: current.status === 'review' ? 'review' : 'in_progress',
        ownerSessionId: input.ownerSessionId,
        ...(input.note === undefined ? {} : { note: input.note }),
        revision: current.revision + 1,
      };
    case 'delete':
      requireOwnerOrLead(owner, 'delete');
      if (current.status === 'completed') {
        throw new TeamBoardError(`completed task ${current.id} cannot be deleted`, 'TEAM_TASK_STATUS');
      }
      if (current.status === 'deleted') {
        throw new TeamBoardError(`task ${current.id} is already deleted`, 'TEAM_TASK_STATUS');
      }
      for (const task of tasks.values()) {
        if (task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id)) {
          throw new TeamBoardError(`task ${task.id} still depends on ${current.id}`, 'TEAM_TASK_DEPENDENCY');
        }
      }
      return { ...current, status: 'deleted', revision: current.revision + 1 };
    default: {
      const unexpected: never = input.action;
      throw new TeamBoardError(`unknown action ${String(unexpected)}`, 'TEAM_TASK_STATUS');
    }
  }
}

function claim(
  current: TeamTaskSnapshot,
  actor: { sessionId: string; lead: boolean },
  tasks: ReadonlyMap<string, TeamTaskSnapshot>,
): TeamTaskSnapshot {
  requireStatus(current, ['pending']);
  if (!isReady(current, tasks)) throw new TeamBoardError(`task ${current.id} is blocked`, 'TEAM_TASK_BLOCKED');
  if (current.ownerSessionId !== undefined && current.ownerSessionId !== actor.sessionId) {
    throw new TeamBoardError(`task ${current.id} is claimed by ${current.ownerSessionId}`, 'TEAM_TASK_ALREADY_CLAIMED');
  }
  return { ...current, status: 'in_progress', ownerSessionId: actor.sessionId, revision: current.revision + 1 };
}

function review(
  current: TeamTaskSnapshot,
  actor: { sessionId: string; lead: boolean },
  status: 'completed' | 'in_progress',
  note: string | undefined,
  requireNote = false,
): TeamTaskSnapshot {
  requireStatus(current, ['review']);
  if (current.ownerSessionId === undefined || current.ownerSessionId === actor.sessionId) {
    throw new TeamBoardError(
      `task ${current.id} must be accepted by a session other than its owner`,
      'TEAM_REVIEWER_REQUIRED',
    );
  }
  if (requireNote && (note === undefined || note.trim() === '')) {
    throw new TeamBoardError(`returning task ${current.id} requires a note`, 'TEAM_TASK_STATUS');
  }
  return {
    ...current,
    status,
    ...(note === undefined ? {} : { note }),
    revision: current.revision + 1,
  };
}

function clearOwner(task: TeamTaskSnapshot, note: string | undefined): TeamTaskSnapshot {
  const { ownerSessionId: _owner, ...rest } = task;
  return { ...rest, ...(note === undefined ? {} : { note }), revision: task.revision + 1 };
}

function requireLead(actor: { lead: boolean }, action: string): void {
  if (!actor.lead) throw new TeamBoardError(`${action} requires the team coordinator`, 'TEAM_LEAD_REQUIRED');
}

function requireOwnerOrLead(owner: boolean, action: string): void {
  if (!owner) throw new TeamBoardError(`${action} requires the task owner or the coordinator`, 'TEAM_TASK_FORBIDDEN');
}

function requireOwner(task: TeamTaskSnapshot, actor: { sessionId: string }, action: string): void {
  if (task.ownerSessionId !== actor.sessionId) {
    throw new TeamBoardError(`${action} requires the task owner`, 'TEAM_TASK_FORBIDDEN');
  }
}

function requireStatus(task: TeamTaskSnapshot, allowed: readonly TeamTaskStatus[]): void {
  if (!allowed.includes(task.status)) {
    throw new TeamBoardError(
      `task ${task.id} is ${task.status}; ${allowed.join(' or ')} required`,
      'TEAM_TASK_STATUS',
    );
  }
}

function planFields(
  input: { planId?: string; planVersion?: number; planHeading?: string; acceptance?: string; paths?: readonly string[] },
  current?: TeamTaskSnapshot,
): Pick<TeamTaskSnapshot, 'planId' | 'planVersion' | 'planHeading' | 'acceptance' | 'paths'> {
  const planId = input.planId ?? current?.planId;
  const planVersion = input.planVersion ?? current?.planVersion;
  const planHeading = input.planHeading ?? current?.planHeading;
  if ((planId === undefined) !== (planVersion === undefined) || (planId === undefined) !== (planHeading === undefined)) {
    throw new TeamBoardError('planId, planVersion, and planHeading must be set together', 'TEAM_TASK_DEPENDENCY');
  }
  return {
    ...(planId === undefined ? {} : { planId, planVersion, planHeading }),
    ...(input.acceptance === undefined ? (current?.acceptance === undefined ? {} : { acceptance: current.acceptance }) : { acceptance: input.acceptance }),
    ...(input.paths === undefined
      ? (current?.paths === undefined ? {} : { paths: current.paths })
      : { paths: [...input.paths] }),
  };
}

function checkedBlockers(
  tasks: ReadonlyMap<string, TeamTaskSnapshot>,
  taskId: string,
  blockedBy: readonly string[],
): string[] {
  const ids = normalizeIds(blockedBy);
  if (ids.includes(taskId)) throw new TeamBoardError(`task ${taskId} cannot depend on itself`, 'TEAM_TASK_DEPENDENCY');
  assertBlockers(tasks, ids);
  return ids;
}

function assertBlockers(tasks: ReadonlyMap<string, TeamTaskSnapshot>, blockedBy: readonly string[]): void {
  for (const id of blockedBy) {
    const blocker = tasks.get(id);
    if (blocker === undefined || blocker.status === 'deleted') {
      throw new TeamBoardError(`task ${id} is not a live blocker`, 'TEAM_TASK_DEPENDENCY');
    }
  }
}

function isReady(task: TeamTaskSnapshot, tasks: ReadonlyMap<string, TeamTaskSnapshot>): boolean {
  if (task.status !== 'pending') return false;
  return task.blockedBy.every((id) => tasks.get(id)?.status === 'completed');
}

function assertAcyclic(tasks: ReadonlyMap<string, TeamTaskSnapshot>, next: TeamTaskSnapshot): void {
  const blockedBy = new Map<string, readonly string[]>();
  for (const task of tasks.values()) {
    if (task.status === 'deleted') continue;
    blockedBy.set(task.id, task.id === next.id ? next.blockedBy : task.blockedBy);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TeamBoardError(`task dependencies cycle through ${id}`, 'TEAM_TASK_DEPENDENCY');
    visiting.add(id);
    for (const blocker of blockedBy.get(id) ?? []) visit(blocker);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of blockedBy.keys()) visit(id);
}

function requireHealthy(events: readonly { type: string; data: unknown }[]): BoardFold {
  const fold = foldBoard(events);
  if (fold.failure !== undefined) throw new TeamBoardError(fold.failure, 'TEAM_TASK_STATUS');
  return fold;
}

function foldBoard(events: readonly { type: string; data: unknown }[]): BoardFold {
  const tasks = new Map<string, TeamTaskSnapshot>();
  let nextNumber = 1;
  let failure: string | undefined;
  for (const event of events) {
    if (failure !== undefined) break;
    if (event.type !== TEAM_TASK_EVENT) continue;
    const data = typeof event.data === 'object' && event.data !== null && 'task' in event.data
      ? (event.data as { task?: unknown }).task
      : undefined;
    const parsed = TeamTaskSnapshotSchema.safeParse(data);
    if (!parsed.success) {
      failure = 'team task record is not a valid snapshot';
      break;
    }
    const task = parsed.data;
    const number = Number(task.id.slice('task-'.length));
    if (number >= nextNumber) nextNumber = number + 1;
    const current = tasks.get(task.id);
    if (current === undefined) {
      if (task.revision !== 1) {
        failure = `task ${task.id} starts at revision ${task.revision}`;
        break;
      }
    } else if (task.revision !== current.revision + 1) {
      failure = `task ${task.id} jumps from revision ${current.revision} to ${task.revision}`;
      break;
    }
    const probe = new Map(tasks);
    probe.set(task.id, task);
    try {
      assertBlockers(probe, task.blockedBy);
      assertAcyclic(probe, task);
    } catch (error) {
      failure = error instanceof Error ? error.message : 'team task graph is invalid';
      break;
    }
    tasks.set(task.id, task);
  }
  return { tasks, nextNumber, ...(failure === undefined ? {} : { failure }) };
}

function visibleTasks(fold: BoardFold): TeamTaskView[] {
  return [...fold.tasks.values()]
    .filter((task) => task.status !== 'deleted')
    .map((task) => enrich(task, fold.tasks));
}

function enrich(task: TeamTaskSnapshot, tasks: ReadonlyMap<string, TeamTaskSnapshot>): TeamTaskView {
  return { ...task, ready: isReady(task, tasks) };
}

function normalizeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

