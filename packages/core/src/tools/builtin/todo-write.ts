import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { parseTodoList, todoCounts, TODO_STATUSES } from '../../session/todo';
import type { TodoItem } from '../../session/todo';

export const TODO_WRITE_TOOL_NAME = 'todo_write';

const Params = z.object({
  todos: z.array(z.object({
    content: z.string(),
    status: z.enum(TODO_STATUSES),
  }).strict()).max(100),
}).strict();

export interface TodoWriteToolOptions {
  append(todos: TodoItem[]): Promise<void>;
  allowParallel?: boolean;
}

/**
 * Model-facing whole-list replacement. The owning session appends the snapshot,
 * so a non-persisted caller cannot claim to have updated a list.
 */
export function createTodoWriteTool(options: TodoWriteToolOptions): Tool {
  return {
    name: TODO_WRITE_TOOL_NAME,
    description:
      'Record and update a task list to plan multi-step work and show progress. '
      + 'Pass the COMPLETE list on every call; it replaces the previous list. '
      + 'Keep at most one task in_progress and mark each task completed as soon as it is done.',
    parameters: Params,
    mutating: false,
    async execute(args, ctx) {
      const parsed = Params.parse(args);
      ctx.signal.throwIfAborted();
      const todos = parseTodoList(parsed.todos, options);
      await options.append(todos);
      ctx.signal.throwIfAborted();
      const counts = todoCounts(todos);
      return {
        content: `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`,
      };
    },
  };
}
