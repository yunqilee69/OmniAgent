import { LIST_AGENT_DEFINITIONS_TOOL_NAME, WRITE_AGENT_DEFINITION_TOOL_NAME } from '../agents/authoring.ts';
import { SCHEDULE_TOOL_GROUP } from '../schedule/tools.ts';

export const READ_FILE_TOOL_NAME = 'read_file';
export const WRITE_FILE_TOOL_NAME = 'write_file';
export const EDIT_FILE_TOOL_NAME = 'edit_file';
export const LIST_DIR_TOOL_NAME = 'list_dir';
export const GREP_TOOL_NAME = 'grep';
export const GLOB_TOOL_NAME = 'glob';
export const WEB_FETCH_TOOL_NAME = 'web_fetch';
export const SKILL_TOOL_NAME = 'skill';
export const TODO_WRITE_TOOL_NAME = 'todo_write';
export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode';
export const GET_GOAL_TOOL_NAME = 'get_goal';
export const CREATE_GOAL_TOOL_NAME = 'create_goal';
export const UPDATE_GOAL_TOOL_NAME = 'update_goal';
export const BASH_TOOL_NAME = 'bash';
export const SUBAGENT_TOOL_NAME = 'subagent';
export const SEND_MESSAGE_TOOL_NAME = 'send_message';
export const LIST_AGENTS_TOOL_NAME = 'list_agents';
export const WAIT_AGENT_TOOL_NAME = 'wait_agent';
export const INTERRUPT_AGENT_TOOL_NAME = 'interrupt_agent';
export {
  SCHEDULE_CREATE_TOOL_NAME,
  SCHEDULE_EDIT_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  SCHEDULE_VIEW_TOOL_NAME,
  SCHEDULE_TOOL_GROUP,
} from '../schedule/tools.ts';

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
  EDIT_FILE_TOOL_NAME,
  LIST_DIR_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  SKILL_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  CREATE_GOAL_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  BASH_TOOL_NAME,
  LIST_AGENT_DEFINITIONS_TOOL_NAME,
  WRITE_AGENT_DEFINITION_TOOL_NAME,
  ...SUBAGENT_TOOL_GROUP,
  ...SCHEDULE_TOOL_GROUP,
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
