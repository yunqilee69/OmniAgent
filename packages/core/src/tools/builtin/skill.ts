import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { loadSkillByName } from '../../skills/filesystem';
import { truncateOutput } from '../tool';

const Params = z.object({
  name: z.string().min(1).max(128).describe('The exact skill name from the available skills catalog'),
});

export const skillTool: Tool = {
  name: 'skill',
  description: 'Load the full instructions for a skill listed in the session skill catalog. Call it before acting on a task that names or clearly matches a skill.',
  parameters: Params,
  mutating: false,
  async execute(args, ctx) {
    const { name } = Params.parse(args);
    const skill = await loadSkillByName({ workspace: ctx.cwd }, name);
    ctx.signal.throwIfAborted();
    return truncateOutput(`# Skill: ${skill.name}\n\n${skill.body}`);
  },
};
