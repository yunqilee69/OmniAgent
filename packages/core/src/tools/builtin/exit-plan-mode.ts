import { z } from 'zod';
import type { Tool } from '../../domain/tool';

export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode';

const Params = z.object({
  plan: z.string().min(1),
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
  return plan.split('\n').some((line) => /^#{1,6}\s+\S/.test(line));
}

export function createExitPlanModeTool(options: ExitPlanModeToolOptions): Tool {
  return {
    name: EXIT_PLAN_MODE_TOOL_NAME,
    description:
      'Use only in plan mode. Present the complete Markdown plan for user review. '
      + 'On approval, plan mode ends and you carry out the plan from the next step. '
      + 'If the user keeps planning, revise the plan using the feedback and present it again.',
    parameters: Params,
    mutating: false,
    async execute(args, ctx) {
      const plan = Params.parse(args).plan;
      if (!hasPlanHeading(plan)) {
        throw new Error('exit_plan_mode requires a Markdown plan starting with a # heading');
      }
      ctx.signal.throwIfAborted();
      const response = await options.review(plan, ctx.signal);
      ctx.signal.throwIfAborted();
      if (response.approved) {
        await options.onApproved();
        return { content: 'Plan approved. Plan mode exited; carry out the plan starting with the next step.' };
      }
      const feedback = response.feedback?.trim();
      return {
        content: feedback
          ? `Plan not approved. The user asked to keep planning: ${feedback}`
          : 'Plan not approved. The user asked to keep planning; revise the plan and present it again.',
      };
    },
  };
}
