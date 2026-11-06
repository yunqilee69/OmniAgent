import { z } from 'zod';
import type { Tool } from '../../domain/tool';

export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode';

const Params = z.object({
  plan: z.string().describe('The complete plan, as markdown, starting with a # heading that names it.'),
}).strict();

export interface PlanReviewResponse {
  approved: boolean;
  feedback?: string;
}

export interface ExitPlanModeToolOptions {
  review(plan: string, signal: AbortSignal): Promise<PlanReviewResponse>;
  onApproved(): Promise<void>;
}

/** The plan must be usable as a review document, not an empty acknowledgement. */
export function hasPlanHeading(plan: string): boolean {
  return /^#\s+\S/.test(plan.trim());
}

export function createExitPlanModeTool(options: ExitPlanModeToolOptions): Tool {
  return {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description:
      'Use only in plan mode. Present your plan for the user\'s review and, on approval, leave plan mode. '
      + 'The user may approve (carry out the plan from your next step) or keep '
      + 'planning — their feedback comes back in the tool result; revise and present again.',
    parameters: Params,
    mutating: false,
    async execute(args, ctx) {
      const plan = Params.parse(args).plan;
      if (!hasPlanHeading(plan)) {
        throw new Error('exit_plan_mode requires a non-empty markdown plan starting with a # heading');
      }
      ctx.signal.throwIfAborted();
      const response = await options.review(plan, ctx.signal);
      ctx.signal.throwIfAborted();
      if (response.approved) {
        await options.onApproved();
        return {
          content: 'Plan approved — plan mode exited; carry out the plan starting with your next step.',
        };
      }
      const feedback = response.feedback?.trim() ?? '';
      throw new Error(feedback === ''
        ? 'The user chose to keep planning; revise the plan and present it again.'
        : `The user chose to keep planning; their feedback: ${feedback}`);
    },
  };
}
