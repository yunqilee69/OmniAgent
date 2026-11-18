import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import type { SubagentService } from '../../domain/subagent';
import type { Session } from '../../session';
import type { TeamMemberSnapshot } from '../../session/mode-selection';

export const DELEGATE_TEAM_MEMBER_TOOL_NAME = 'delegate_team_member';

const Params = z.object({
  member: z.string().trim().min(1).max(128).describe('Configured team member id.'),
  description: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(100_000).describe('Complete task for that member.'),
}).strict();

export function createTeamDelegationTool(
  session: Session,
  service: SubagentService,
  members: readonly TeamMemberSnapshot[],
  maxSteps?: number,
): Tool {
  const catalog = new Map(members.map((member) => [member.id, member]));
  return {
    name: DELEGATE_TEAM_MEMBER_TOOL_NAME,
    description: `Delegate work to one configured team member: ${members.map((member) => member.id).join(', ')}.`,
    parameters: Params,
    mutating: false,
    async execute(args, ctx) {
      const parsed = Params.parse(args);
      const member = catalog.get(parsed.member);
      if (member === undefined) throw new Error(`Unknown team member "${parsed.member}"`);
      ctx.signal.throwIfAborted();
      const prompt = [member.prompt, parsed.task].filter(Boolean).join('\n\n');
      const started = await service.start(session, {
        description: parsed.description,
        prompt,
        agent: member.agent,
        binding: member.model,
        tools: member.tools,
        skills: member.skills,
        ...(maxSteps === undefined ? {} : { maxSteps }),
      });
      return { content: `started team member ${member.id} as ${started.id}` };
    },
  };
}
