export const READ_FILE_TOOL_NAME = 'read_file';
export const WRITE_FILE_TOOL_NAME = 'write_file';
export const LIST_DIR_TOOL_NAME = 'list_dir';
export const SKILL_TOOL_NAME = 'skill';
export const TODO_WRITE_TOOL_NAME = 'todo_write';
export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode';
export const BASH_TOOL_NAME = 'bash';
export const SUBAGENT_TOOL_NAME = 'subagent';
export const SEND_MESSAGE_TOOL_NAME = 'send_message';
export const LIST_AGENTS_TOOL_NAME = 'list_agents';
export const WAIT_AGENT_TOOL_NAME = 'wait_agent';
export const INTERRUPT_AGENT_TOOL_NAME = 'interrupt_agent';

export const SUBAGENT_TOOL_GROUP = [
  SUBAGENT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  WAIT_AGENT_TOOL_NAME,
  INTERRUPT_AGENT_TOOL_NAME,
] as const;

export const KNOWN_TOOL_NAMES = new Set<string>([
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  LIST_DIR_TOOL_NAME,
  SKILL_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  BASH_TOOL_NAME,
  ...SUBAGENT_TOOL_GROUP,
]);

/** Expand the `subagent` group and dedupe a profile selector. */
export function expandToolSelector(selector: '*' | readonly string[]): '*' | string[] {
  if (selector === '*') return '*';
  const expanded = new Set<string>();
  for (const name of selector) {
    if (name === SUBAGENT_TOOL_NAME) {
      for (const tool of SUBAGENT_TOOL_GROUP) expanded.add(tool);
    } else {
      expanded.add(name);
    }
  }
  return [...expanded];
}
