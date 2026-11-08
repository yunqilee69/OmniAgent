/**
 * Model-facing `schedule_create`, `schedule_list`, `schedule_view`, and
 * `schedule_edit` tools over the session's Schedule service.
 *
 * Ported from DSH's `dsh-tool-schedule`: tasks belong to the Host, not to a
 * session; the tools read and change any task by id, and only the delivery
 * target names a session.
 * @module @omniagent/core/schedule/tools
 */

import { z } from 'zod';
import type { Tool } from '../domain/tool.ts';
import type { Session } from '../session.ts';
import type { ScheduleService } from './service.ts';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from './service.ts';
import {
  MAX_TITLE_LENGTH,
  MIN_EVERY_INTERVAL_SECONDS,
  scheduleId,
  ScheduleInputError,
  formatScheduleLocalTime,
} from './domain.ts';
import type {
  ScheduleCatalogEntry,
  ScheduleDeliveryReceipt,
  ScheduleEditRequest,
  ScheduleRecord,
  ScheduleTargetRequest,
  ScheduleToolError,
} from './types.ts';

export const SCHEDULE_CREATE_TOOL_NAME = 'schedule_create';
export const SCHEDULE_LIST_TOOL_NAME = 'schedule_list';
export const SCHEDULE_VIEW_TOOL_NAME = 'schedule_view';
export const SCHEDULE_EDIT_TOOL_NAME = 'schedule_edit';

export const SCHEDULE_TOOL_GROUP = [
  SCHEDULE_CREATE_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  SCHEDULE_VIEW_TOOL_NAME,
  SCHEDULE_EDIT_TOOL_NAME,
] as const;

const TARGET_CHOICES = ['this_session', 'new_once', 'new'] as const;

const CreateParams = z.object({
  title: z.string().describe(`Task name of at most ${MAX_TITLE_LENGTH} characters in the user's language: action plus object.`),
  prompt: z.string().describe('The instruction delivered at each occurrence.'),
  rrule: z.string().describe(
    'Supported RFC 5545 subset: one DTSTART line, a newline, and one RRULE line. '
    + 'DTSTART ends in Z for UTC or carries TZID with an IANA time zone. '
    + 'Use RRULE:FREQ=DAILY;COUNT=1 for a one-time delivery. '
    + 'After downtime, only the latest missed occurrence is delivered.',
  ),
  target: z.enum(TARGET_CHOICES).describe(
    'this_session delivers to this session; new_once delivers to the same new session every time, '
    + 'opened at the first delivery; new opens a different new session for every delivery. '
    + 'Use this_session for reminders and follow-ups to this conversation; use new_once or new for independent work.',
  ),
}).strict();

const ListParams = z.object({
  active: z.boolean().describe('true for active tasks only; false for paused and ended tasks only; omitted for all tasks.').optional(),
  limit: z.number().int().describe(`Page size from 1 to ${MAX_LIST_LIMIT}; defaults to ${DEFAULT_LIST_LIMIT}.`).optional(),
  offset: z.number().int().describe('Number of tasks to skip; defaults to 0.').optional(),
}).strict();

const ViewParams = z.object({
  id: z.string().describe('Task id.'),
}).strict();

const EditParams = z.object({
  id: z.string().describe('Task id.'),
  action: z.enum(['update', 'delete']).describe('update applies the provided fields, at least one; delete removes the task.'),
  title: z.string().describe('New task name.').optional(),
  prompt: z.string().describe('New instruction delivered at each occurrence.').optional(),
  rrule: z.string().describe('New recurrence in the schedule_create rrule format.').optional(),
  target: z.enum(TARGET_CHOICES).describe('Omit to retain the destination and its creation settings.').optional(),
  active: z.boolean().describe('false pauses the task; true resumes only if its timing has a future occurrence.').optional(),
  expectedUpdatedAt: z.string().describe(
    'updatedAt from the latest result that returned this task; if the task changed after that result, '
    + 'the result is schedule_conflict and nothing changes.',
  ).optional(),
}).strict();

const MANAGEMENT_AUTHORIZATION =
  'Only create or modify scheduled tasks at the user\'s explicit request; '
  + 'prior explicit user authorization for the running scheduled task remains valid.';

const CREATE_DESCRIPTION =
  'Create a scheduled task. At each occurrence of rrule, prompt is delivered to the target session '
  + 'as a scheduled message from the user. The result includes the task id and the next occurrence as scheduledAt in UTC '
  + 'and scheduledAtLocal in the zone of rrule. '
  + 'After downtime, only the latest missed occurrence is delivered. Delivery can repeat after a crash.';

const LIST_DESCRIPTION =
  'List scheduled tasks, including tasks created from other sessions. Active tasks come first, ordered by scheduledAt.';

const VIEW_DESCRIPTION = 'View one scheduled task by id.';

const EDIT_DESCRIPTION = 'Update, pause, resume, or delete one scheduled task by id. Deleting does not retract queued messages.';

/** Withhold Host delivery bookkeeping from model results. */
type ModelTask = ScheduleRecord & Pick<ScheduleCatalogEntry, 'target' | 'status' | 'updatedAt'> & {
  readonly scheduledAtLocal: string;
  readonly lastDelivery?: Pick<ScheduleDeliveryReceipt, 'scheduledAt' | 'deliveredAt' | 'targetSessionId'>;
};

function modelTask(task: ScheduleCatalogEntry): ModelTask {
  const {
    involvedSessionIds: _involved, createdAt: _created, executionActive: _execution,
    deliveryFloorEndsAt: _floor, lastDelivery, ...record
  } = task;
  return {
    ...record,
    scheduledAtLocal: formatScheduleLocalTime(task, task.scheduledAt),
    ...(lastDelivery === undefined ? {} : {
      lastDelivery: {
        scheduledAt: lastDelivery.scheduledAt,
        deliveredAt: lastDelivery.deliveredAt,
        targetSessionId: lastDelivery.targetSessionId,
      },
    }),
  };
}

function output(value: unknown, ok = true): { content: string; ok?: boolean } {
  return { content: JSON.stringify(value), ...(ok ? {} : { ok: false }) };
}

function inputError(error: unknown): { content: string; ok: false } | undefined {
  if (error instanceof ScheduleInputError) {
    return output({ code: error.code, message: error.message }, false) as { content: string; ok: false };
  }
  return undefined;
}

/** Resolve one model target choice to a delivery destination. */
function targetFor(session: Session, target: typeof TARGET_CHOICES[number]): ScheduleTargetRequest {
  if (target === 'this_session') return { kind: 'session', sessionId: session.id };
  return {
    kind: target,
    create: {
      cwd: session.cwd,
      ...(session.agent === undefined ? {} : { agentPreset: session.agent.id }),
    },
  };
}

/** Whether the calling session is a delegated subagent. */
function delegated(session: Session): boolean {
  return session.depth > 0;
}

/**
 * Build the four schedule tools for one session. The tools share the session's
 * schedule service, so every call acts for this session and refuses delegated
 * subagents.
 */
export function createScheduleTools(session: Session, service: ScheduleService): Tool[] {
  const refuseDelegated = (): { content: string; ok: false } | undefined => delegated(session)
    ? output({ code: 'subagent_session', message: 'A delegated subagent cannot use scheduled tasks.' }, false) as {
      content: string; ok: false;
    }
    : undefined;

  const withErrors = async (
    work: () => Promise<unknown>,
  ): Promise<{ content: string; ok?: boolean }> => {
    try {
      return output(await work());
    } catch (error) {
      const known = inputError(error);
      if (known !== undefined) return known;
      throw error;
    }
  };

  return [
    {
      name: SCHEDULE_CREATE_TOOL_NAME,
      description: CREATE_DESCRIPTION,
      parameters: CreateParams,
      mutating: false,
      async execute(args) {
        const refused = refuseDelegated();
        if (refused !== undefined) return refused;
        const input = CreateParams.parse(args);
        return withErrors(async () => modelTask(await service.create({
          title: input.title,
          prompt: input.prompt,
          timing: { kind: 'rrule', rrule: input.rrule },
          target: targetFor(session, input.target),
        }, session.id)));
      },
    },
    {
      name: SCHEDULE_LIST_TOOL_NAME,
      description: LIST_DESCRIPTION,
      parameters: ListParams,
      mutating: false,
      async execute(args) {
        const refused = refuseDelegated();
        if (refused !== undefined) return refused;
        const input = ListParams.parse(args);
        return withErrors(async () => {
          const page = await service.list({
            ...(input.active === undefined ? {} : { active: input.active }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.offset === undefined ? {} : { offset: input.offset }),
          });
          return { ...page, items: page.items.map(modelTask) };
        });
      },
    },
    {
      name: SCHEDULE_VIEW_TOOL_NAME,
      description: VIEW_DESCRIPTION,
      parameters: ViewParams,
      mutating: false,
      async execute(args) {
        const refused = refuseDelegated();
        if (refused !== undefined) return refused;
        const input = ViewParams.parse(args);
        return withErrors(async () => {
          const result = await service.view({ id: scheduleId(input.id) });
          return 'kind' in result ? modelTask(result) : result;
        });
      },
    },
    {
      name: SCHEDULE_EDIT_TOOL_NAME,
      description: EDIT_DESCRIPTION,
      parameters: EditParams,
      mutating: false,
      async execute(args) {
        const refused = refuseDelegated();
        if (refused !== undefined) return refused;
        const input = EditParams.parse(args);
        const id = scheduleId(input.id);
        const expected = input.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: input.expectedUpdatedAt };
        return withErrors(async () => {
          let request: ScheduleEditRequest;
          if (input.action === 'delete') {
            if (input.title !== undefined || input.prompt !== undefined || input.rrule !== undefined
              || input.target !== undefined || input.active !== undefined) {
              throw new ScheduleInputError('invalid_selector', 'delete accepts only id, action, and expectedUpdatedAt.');
            }
            request = { id, action: 'delete', ...expected };
          } else {
            const patch = {
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
              ...(input.rrule === undefined ? {} : { timing: { kind: 'rrule' as const, rrule: input.rrule } }),
              ...(input.target === undefined ? {} : { target: targetFor(session, input.target) }),
              ...(input.active === undefined ? {} : { active: input.active }),
            };
            if (Object.keys(patch).length === 0) {
              throw new ScheduleInputError('invalid_selector', 'update requires at least one of title, prompt, rrule, target, or active.');
            }
            request = { id, action: 'update', patch, ...expected };
          }
          const result = await service.edit(request, session.id);
          return 'kind' in result ? modelTask(result) : result;
        });
      },
    },
  ];
}

/** System-prompt authorization shared by every mounted schedule tool. */
export function renderScheduleToolGuidance(): string {
  return MANAGEMENT_AUTHORIZATION;
}

/** Whether a tool name belongs to the schedule group. */
export function isScheduleToolName(name: string): boolean {
  return (SCHEDULE_TOOL_GROUP as readonly string[]).includes(name);
}
