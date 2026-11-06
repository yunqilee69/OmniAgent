import { z } from 'zod';

export const TODO_WRITE_EVENT = 'todo/write';
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TodoItemSchema = z.object({
  content: z.string().trim().min(1),
  status: z.enum(TODO_STATUSES),
}).strict();
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoListSchema = z.array(TodoItemSchema);
export type TodoList = z.infer<typeof TodoListSchema>;

/**
 * Canonicalize a model-supplied whole list. The tool contract is intentionally
 * strict: duplicate or empty items are rejected instead of silently repaired so
 * the persisted snapshot matches what the model believes it wrote.
 */
export function parseTodoList(value: unknown, options: { allowParallel?: boolean } = {}): TodoItem[] {
  const parsed = TodoListSchema.parse(value);
  const seen = new Set<string>();
  let active = 0;
  for (const item of parsed) {
    if (seen.has(item.content)) throw new Error(`duplicate todo content: ${JSON.stringify(item.content)}`);
    seen.add(item.content);
    if (item.status === 'in_progress') active += 1;
  }
  if (!options.allowParallel && active > 1) {
    throw new Error(`at most one todo may be in_progress (got ${active})`);
  }
  return parsed;
}

/**
 * The standing todo list is the latest whole-list write, cleared when the next
 * turn starts. `turn/end` keeps the finished checklist visible for the next UI
 * render; only a new turn resets it.
 */
export function projectTodos(events: readonly { type: string; data: unknown }[]): TodoItem[] | null {
  let todos: TodoItem[] | null = null;
  for (const event of events) {
    if (event.type === TODO_WRITE_EVENT) {
      const data = typeof event.data === 'object' && event.data !== null && 'todos' in event.data
        ? (event.data as Record<string, unknown>).todos
        : event.data;
      const parsed = TodoListSchema.safeParse(data);
      if (parsed.success) todos = parsed.data;
      continue;
    }
    if (event.type === 'turn/start' || event.type === 'message/user' || event.type === 'user/message') {
      todos = null;
    }
  }
  return todos;
}

export function todoCounts(todos: readonly TodoItem[]): { pending: number; inProgress: number; completed: number } {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const todo of todos) {
    if (todo.status === 'pending') pending += 1;
    else if (todo.status === 'in_progress') inProgress += 1;
    else completed += 1;
  }
  return { pending, inProgress, completed };
}
