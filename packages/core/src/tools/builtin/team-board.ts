import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { planSection, projectPlanDocument } from '../../session/development-plan';
import type { PlanDocumentView } from '../../session/development-plan';
import {
  TEAM_TASK_ACTIONS,
  applyTeamTaskUpdate,
  createTeamTaskSnapshot,
  projectTeamBoard,
  projectTeamTask,
} from '../../session/team-board';
import type { CreateTeamTaskInput, TeamTaskSnapshot, TeamTaskView, UpdateTeamTaskInput } from '../../session/team-board';

/**
 * Tools for the shared team board.
 *
 * The board lives on the root session log. A child session uses the same tools
 * with `lead: false` and its own session id, so it can claim and submit but
 * cannot edit the plan's slices or accept its own work.
 */

export interface TeamBoardToolHost {
  readonly sessionId: string;
  readonly lead: boolean;
  events(): readonly { type: string; data: unknown }[];
  appendTask(task: TeamTaskSnapshot): Promise<void>;
  planDocument(id: string, version?: number): PlanDocumentView | undefined;
  /** Present only for the coordinator. Appends the next version of a confirmed plan. */
  revisePlan?(id: string, body: string): Promise<void>;
}

const PLAN_FIELDS = {
  plan_id: z.string().regex(/^plan-\d+$/u).optional(),
  plan_version: z.number().int().positive().optional(),
  plan_heading: z.string().trim().min(1).max(200).optional(),
  acceptance: z.string().max(16_384).optional(),
  paths: z.array(z.string().trim().min(1).max(300)).max(64).optional(),
};

const CreateParams = z.object({
  subject: z.string().trim().min(1).max(200),
  description: z.string().max(16_384),
  blocked_by: z.array(z.string().regex(/^task-\d+$/u)).max(64).optional(),
  ...PLAN_FIELDS,
}).strict();

const UpdateParams = z.object({
  task_id: z.string().regex(/^task-\d+$/u),
  expected_revision: z.number().int().positive(),
  action: z.enum(TEAM_TASK_ACTIONS),
  subject: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(16_384).optional(),
  blocked_by: z.array(z.string().regex(/^task-\d+$/u)).max(64).optional(),
  owner_session_id: z.string().min(1).max(256).optional(),
  note: z.string().max(4_000).optional(),
  ...PLAN_FIELDS,
}).strict();

const ListParams = z.object({
  status: z.enum(['pending', 'in_progress', 'review', 'completed']).optional(),
  owner: z.string().min(1).max(256).optional(),
  ready: z.boolean().optional(),
}).strict();

const GetParams = z.object({
  task_id: z.string().regex(/^task-\d+$/u),
}).strict();

const SectionParams = z.object({
  plan_id: z.string().regex(/^plan-\d+$/u),
  version: z.number().int().positive().optional(),
  heading: z.string().trim().min(1).max(200),
}).strict();

const ReviseParams = z.object({
  plan_id: z.string().regex(/^plan-\d+$/u),
  body: z.string().trim().min(1).max(200_000),
}).strict();

const CREATE_DESCRIPTION = 'Create one unowned pending task on the shared team board. '
  + 'The coordinator uses this after a development plan is confirmed. Cite the plan with plan_id, '
  + 'plan_version, and plan_heading together. A task is a delivery slice, not a design note.';

const UPDATE_DESCRIPTION = 'Compare-and-set one shared task. expected_revision must be the revision last read. '
  + 'Members claim a ready pending task, do the work, then submit it for review. '
  + 'accept and return require a different session than the owner, so the author cannot approve their own work. '
  + 'return requires a note saying what is missing. The coordinator edits, reassigns, reopens, and deletes. '
  + 'Task changes do not start or interrupt anyone; use send_message when a running member must change course.';

const LIST_DESCRIPTION = 'List shared team tasks, including readiness, owner, revision, blockers, and the cited plan section. '
  + 'Pass owner "unowned" for tasks with no owner. ready selects pending tasks whose blockers are completed.';

const GET_DESCRIPTION = 'Read one shared task, including a deleted tombstone, before changing or executing it.';

const SECTION_DESCRIPTION = 'Read one heading from a confirmed development plan. '
  + 'Omit version for the latest. A member working against an older version must pass that version.';

const REVISE_DESCRIPTION = 'Append the next version of a confirmed development plan after the user corrects it. '
  + 'The body is the whole plan and must start with a level-one heading. Then update board tasks that have not started. '
  + 'Do not use this for the first confirmation; that happens when the user approves the plan review.';

export function createTeamBoardTools(host: TeamBoardToolHost): Tool[] {
  return [
    tool('team_task_create', CREATE_DESCRIPTION, CreateParams, async (args) => {
      if (!host.lead) throw new Error('only the team coordinator can create tasks');
      const parsed = CreateParams.parse(args);
      const created = createTeamTaskSnapshot(host.events(), toCreate(parsed));
      await host.appendTask(created);
      return json(enrichCreated(created, host.events()));
    }),
    tool('team_task_update', UPDATE_DESCRIPTION, UpdateParams, async (args) => {
      const parsed = UpdateParams.parse(args);
      const updated = applyTeamTaskUpdate(host.events(), toUpdate(parsed), {
        sessionId: host.sessionId,
        lead: host.lead,
      });
      await host.appendTask(updated);
      return json(enrichCreated(updated, host.events()));
    }),
    tool('team_task_list', LIST_DESCRIPTION, ListParams, async (args) => {
      const parsed = ListParams.parse(args);
      const tasks = projectTeamBoard(host.events()).tasks.filter((task) => {
        if (parsed.status !== undefined && task.status !== parsed.status) return false;
        if (parsed.owner === 'unowned' && task.ownerSessionId !== undefined) return false;
        if (parsed.owner !== undefined && parsed.owner !== 'unowned' && task.ownerSessionId !== parsed.owner) return false;
        if (parsed.ready !== undefined && task.ready !== parsed.ready) return false;
        return true;
      });
      return json({ tasks: tasks.map((task) => withSection(task, host)) });
    }),
    tool('team_task_get', GET_DESCRIPTION, GetParams, async (args) => {
      const parsed = GetParams.parse(args);
      const task = projectTeamTask(host.events(), parsed.task_id);
      if (task === undefined) throw new Error(`unknown task ${parsed.task_id}`);
      return json(withSection(task, host));
    }),
    ...(host.lead && host.revisePlan !== undefined ? [tool('team_plan_revise', REVISE_DESCRIPTION, ReviseParams, async (args) => {
      const parsed = ReviseParams.parse(args);
      await host.revisePlan!(parsed.plan_id, parsed.body);
      const document = host.planDocument(parsed.plan_id);
      return json(document ?? { planId: parsed.plan_id });
    })] : []),
    tool('team_plan_section', SECTION_DESCRIPTION, SectionParams, async (args) => {
      const parsed = SectionParams.parse(args);
      const document = host.planDocument(parsed.plan_id, parsed.version);
      if (document === undefined) throw new Error(`unknown plan ${parsed.plan_id}`);
      const section = planSection(document.body, parsed.heading);
      if (section === undefined) throw new Error(`plan ${document.id} version ${document.version} has no heading ${parsed.heading}`);
      return json({
        planId: document.id,
        version: document.version,
        title: document.title,
        heading: parsed.heading,
        body: section,
      });
    }),
  ];
}

function tool(
  name: string,
  description: string,
  parameters: z.ZodType,
  execute: (args: unknown) => Promise<string>,
): Tool {
  return {
    name,
    description,
    parameters,
    mutating: false,
    async execute(args, ctx) {
      ctx.signal.throwIfAborted();
      const content = await execute(args);
      ctx.signal.throwIfAborted();
      return { content };
    },
  };
}

function toCreate(parsed: z.infer<typeof CreateParams>): CreateTeamTaskInput {
  return {
    subject: parsed.subject,
    description: parsed.description,
    ...(parsed.blocked_by === undefined ? {} : { blockedBy: parsed.blocked_by }),
    ...planInput(parsed),
  };
}

function toUpdate(parsed: z.infer<typeof UpdateParams>): UpdateTeamTaskInput {
  return {
    taskId: parsed.task_id,
    expectedRevision: parsed.expected_revision,
    action: parsed.action,
    ...(parsed.subject === undefined ? {} : { subject: parsed.subject }),
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    ...(parsed.blocked_by === undefined ? {} : { blockedBy: parsed.blocked_by }),
    ...(parsed.owner_session_id === undefined ? {} : { ownerSessionId: parsed.owner_session_id }),
    ...(parsed.note === undefined ? {} : { note: parsed.note }),
    ...planInput(parsed),
  };
}

function planInput(parsed: {
  plan_id?: string;
  plan_version?: number;
  plan_heading?: string;
  acceptance?: string;
  paths?: string[];
}): Pick<CreateTeamTaskInput, 'planId' | 'planVersion' | 'planHeading' | 'acceptance' | 'paths'> {
  return {
    ...(parsed.plan_id === undefined ? {} : { planId: parsed.plan_id }),
    ...(parsed.plan_version === undefined ? {} : { planVersion: parsed.plan_version }),
    ...(parsed.plan_heading === undefined ? {} : { planHeading: parsed.plan_heading }),
    ...(parsed.acceptance === undefined ? {} : { acceptance: parsed.acceptance }),
    ...(parsed.paths === undefined ? {} : { paths: parsed.paths }),
  };
}

function enrichCreated(task: TeamTaskSnapshot, events: readonly { type: string; data: unknown }[]): TeamTaskView {
  return projectTeamTask(events, task.id) ?? { ...task, ready: task.status === 'pending' && task.blockedBy.length === 0 };
}

function withSection(task: TeamTaskView, host: TeamBoardToolHost): TeamTaskView & { planSection?: string } {
  if (task.planId === undefined || task.planVersion === undefined || task.planHeading === undefined) return task;
  const document = host.planDocument(task.planId, task.planVersion);
  if (document === undefined) return task;
  const section = planSection(document.body, task.planHeading);
  return section === undefined ? task : { ...task, planSection: section };
}

/** Host view used by the root session: plans and tasks share its own log. */
export function rootBoardHost(options: {
  sessionId: string;
  events(): readonly { type: string; data: unknown }[];
  appendTask(task: TeamTaskSnapshot): Promise<void>;
  revisePlan?(id: string, body: string): Promise<void>;
}): TeamBoardToolHost {
  return {
    sessionId: options.sessionId,
    lead: true,
    events: options.events,
    appendTask: options.appendTask,
    planDocument: (id, version) => projectPlanDocument(options.events(), id, version),
    ...(options.revisePlan === undefined ? {} : { revisePlan: options.revisePlan }),
  };
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}
