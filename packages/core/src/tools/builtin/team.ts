import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import type { SubagentService } from '../../domain/subagent';
import type { Session } from '../../session';
import type { TeamMemberSnapshot } from '../../session/mode-selection';

export const DELEGATE_TEAM_MEMBER_TOOL_NAME = 'delegate_team_member';

/** Coordinator guidance injected into the team mode system prompt. */
export function renderTeamGuidance(
  members: readonly TeamMemberSnapshot[],
  maxActive: number,
): string {
  const catalog = members.map((member) => {
    const prompt = member.prompt.trim().replace(/\s+/gu, ' ');
    const clipped = prompt.length > 240 ? `${prompt.slice(0, 240)}…` : prompt;
    return `- ${JSON.stringify(member.id)} (${member.name}, agent ${member.agent})${clipped === '' ? '' : `: ${clipped}`}`;
  });
  return [
    'Team mode is active. You are the coordinator, not a worker.',
    'Every unit of work a configured member can perform MUST be delegated with delegate_team_member, '
      + 'including creating or editing files, running commands, and searching the workspace. Do not '
      + 'call write_file, edit_file, or bash yourself while a capable member is available. Use your '
      + 'own tools only to inspect outcomes and integrate the final answer.',
    'Configured members:',
    ...catalog,
    `At most ${maxActive} member(s) may run at once. After delegating, wait for the settlement `
      + 'notice, then verify the reported result before relying on it. Do not start agents that are '
      + 'not in this list.',
  ].join('\n');
}

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
  maxActive?: number,
): Tool {
  const catalog = new Map(members.map((member) => [member.id, member]));
  let starting = 0;
  return {
    name: DELEGATE_TEAM_MEMBER_TOOL_NAME,
    description: 'Delegate work to one configured team member. Members: '
      + members.map((member) => `${member.id} (${member.name})`).join(', ') + '.',
    parameters: Params,
    mutating: false,
    async execute(args, ctx) {
      const parsed = Params.parse(args);
      const member = catalog.get(parsed.member);
      if (member === undefined) throw new Error(`Unknown team member "${parsed.member}"`);
      ctx.signal.throwIfAborted();
      if (maxActive !== undefined) {
        // Count only direct children that are actively working; completed and
        // idle members leave capacity for new work.
        const active = (await service.list(session)).filter((entry) => entry.kind === 'child'
          && entry.parent === session.id && entry.status === 'running').length;
        if (active + starting >= maxActive) {
          throw new Error(
            `Team capacity reached: ${active + starting} of ${maxActive} members are active. `
            + 'Wait for a member to finish before delegating.',
          );
        }
      }
      starting += 1;
      try {
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
      } finally {
        starting -= 1;
      }
    },
  };
}
