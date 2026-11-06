import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import type { Session } from '../../session';
import {
  GOAL_DEFAULT_BLOCKED_AFTER,
  GoalError,
  renderGoalWrapup,
} from '../../session/goal';
import type { GoalRef, GoalView } from '../../session/goal';

export const GET_GOAL_TOOL_NAME = 'get_goal';
export const CREATE_GOAL_TOOL_NAME = 'create_goal';
export const UPDATE_GOAL_TOOL_NAME = 'update_goal';

const UPDATE_ACTIONS = ['edit', 'pause', 'resume', 'complete', 'blocked'] as const;

const EmptyParams = z.object({}).strict();

const CreateParams = z.object({
  objective: z.string().describe('The concrete completion objective inferred from the direct human request.'),
  max_goal_rounds: z.number().describe('Optional positive safe-integer limit on automatic continuation rounds.').optional(),
}).strict();

const UpdateParams = z.object({
  goal_id: z.string().describe('Exact id returned by get_goal.'),
  revision: z.number().describe('Exact positive revision returned by get_goal.'),
  action: z.enum(UPDATE_ACTIONS).describe(
    'edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed '
    + 'during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.',
  ),
  objective: z.string().describe('Replacement objective; valid only with action edit.').optional(),
  max_goal_rounds: z.number().describe('Replacement cap; valid only with action edit.').optional(),
  blocked_reason: z.string().describe(
    'Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.',
  ).optional(),
}).strict();

const CREATE_DESCRIPTION =
  'Create a persisted goal that keeps this session working across automatic continuation rounds. '
  + 'Use it when the direct human request is a long-running objective, even if the user did not say "goal"; '
  + 'not for single-turn work.';

const GET_DESCRIPTION = 'Read the current session goal, including the id and revision that update_goal requires.';

type GoalToolValue =
  | { goal: null }
  | {
    goal: {
      id: string;
      revision: number;
      objective: string;
      phase: GoalView['phase'];
      roundsStarted: number;
      maxGoalRounds: number;
      blockedReason?: { code: string; message: string };
    };
    activation: GoalView['activation'];
  };

function goalValue(goal: GoalView | undefined): GoalToolValue {
  if (goal === undefined) return { goal: null };
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined ? {} : {
        blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message },
      }),
    },
    activation: goal.activation,
  };
}

function goalOutput(goal: GoalView | undefined): { content: string } {
  return { content: JSON.stringify(goalValue(goal)) };
}

function goalRef(goalId: string, revision: number): GoalRef {
  if (goalId.length === 0 || goalId !== goalId.trim()
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw new GoalError(
      'goal_id must be non-empty and revision must be a positive safe integer',
      'GOAL_INVALID_TRANSITION',
    );
  }
  return { id: goalId, revision };
}

/** Whether optional text is meaningful rather than a strict-schema empty filler. */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** Whether an optional round cap is meaningful rather than a strict-schema zero filler. */
function hasRoundCap(value: number | undefined): value is number {
  return value !== undefined && value !== 0;
}

export function createGoalTools(session: Session): Tool[] {
  return [
    {
      name: GET_GOAL_TOOL_NAME,
      description: GET_DESCRIPTION,
      parameters: EmptyParams,
      mutating: false,
      async execute() {
        return goalOutput(session.goals.view());
      },
    },
    {
      name: CREATE_GOAL_TOOL_NAME,
      description: CREATE_DESCRIPTION,
      parameters: CreateParams,
      mutating: false,
      async execute(args) {
        const parsed = CreateParams.parse(args);
        session.assertGoalDirectHuman();
        const goal = await session.goals.create({
          objective: parsed.objective,
          ...(parsed.max_goal_rounds === undefined ? {} : { maxGoalRounds: parsed.max_goal_rounds }),
        });
        return goalOutput(goal);
      },
    },
    {
      name: UPDATE_GOAL_TOOL_NAME,
      description: 'Update the current goal.',
      parameters: UpdateParams,
      mutating: false,
      async execute(args, ctx) {
        const parsed = UpdateParams.parse(args);
        const ref = goalRef(parsed.goal_id, parsed.revision);
        if (parsed.action === 'edit') {
          session.assertGoalDirectHuman();
          const goal = await session.goals.edit(ref, {
            ...(hasText(parsed.objective) ? { objective: parsed.objective } : {}),
            ...(hasRoundCap(parsed.max_goal_rounds) ? { maxGoalRounds: parsed.max_goal_rounds } : {}),
          });
          return goalOutput(goal);
        }
        if (parsed.action === 'pause' || parsed.action === 'resume') {
          session.assertGoalDirectHuman();
          const goal = parsed.action === 'pause'
            ? await session.goals.pause(ref)
            : await session.goals.resume(ref);
          return goalOutput(goal);
        }
        const authority = session.goalCompletionAuthority();
        if (parsed.action === 'blocked'
          && (parsed.blocked_reason === undefined || parsed.blocked_reason.trim().length === 0)) {
          throw new GoalError('blocked_reason is required with action blocked', 'GOAL_INVALID_BLOCK_REASON');
        }
        if (parsed.action === 'blocked'
          && authority.kind === 'goal-round'
          && authority.goal.roundsStarted < GOAL_DEFAULT_BLOCKED_AFTER) {
          throw new GoalError(
            `blocked requires at least ${GOAL_DEFAULT_BLOCKED_AFTER} consecutive goal rounds; `
            + `current round is ${authority.goal.roundsStarted}`,
            'GOAL_INVALID_TRANSITION',
          );
        }
        const goal = parsed.action === 'complete'
          ? await session.goals.complete(ref)
          : await session.goals.block(ref, {
            code: 'model-reported',
            message: parsed.blocked_reason as string,
          });
        if (authority.kind === 'goal-round') {
          ctx.signal.throwIfAborted();
          await session.deferGoalContext(renderGoalWrapup(
            goal.objective,
            parsed.action === 'blocked' ? parsed.blocked_reason as string : undefined,
          ));
        }
        return goalOutput(goal);
      },
    },
  ];
}
