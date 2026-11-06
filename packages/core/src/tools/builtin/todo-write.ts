import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { parseTodoList, todoCounts, TODO_STATUSES } from '../../session/todo';
import type { TodoItem } from '../../session/todo';

export const TODO_WRITE_TOOL_NAME = 'todo_write';

const Params = z.object({
  todos: z.array(z.object({
    content: z.string().describe('What the task is — a short imperative line.'),
    status: z.enum(TODO_STATUSES).describe('pending (not started) | in_progress (now) | completed (done).'),
  }).strict()).describe('The COMPLETE task list, replacing any previous list.'),
}).strict();

const DESCRIPTION_HEAD =
  'Record and update a task list to plan multi-step work and show progress; skip it for trivial '
  + 'single-step tasks. Add one todo per concrete step before you start. ';

const DESCRIPTION_PARALLEL =
  'While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. ';

const DESCRIPTION_SINGLE =
  'While work remains, keep exactly one todo `in_progress`. ';

const DESCRIPTION_TAIL = 'Mark each todo `completed` as soon as it is done.';

export function describeTodoWrite(allowParallel: boolean): string {
  return DESCRIPTION_HEAD
    + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE)
    + DESCRIPTION_TAIL;
}

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
    description: describeTodoWrite(options.allowParallel ?? false),
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
