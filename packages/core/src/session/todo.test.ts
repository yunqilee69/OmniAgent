import { describe, expect, it } from 'vitest';
import {
  TODO_WRITE_EVENT,
  parseTodoList,
  projectTodos,
  todoCounts,
} from './todo';

const items = [
  { content: 'Inspect the session log', status: 'completed' as const },
  { content: 'Implement the tool', status: 'in_progress' as const },
  { content: 'Run verification', status: 'pending' as const },
];

describe('todo projection', () => {
  it('accepts only complete, unique lists with one active item by default', () => {
    expect(parseTodoList(items)).toEqual(items);
    expect(() => parseTodoList([
      { content: 'same', status: 'pending' },
      { content: 'same', status: 'completed' },
    ])).toThrow(/duplicate/);
    expect(() => parseTodoList([
      { content: 'first', status: 'in_progress' },
      { content: 'second', status: 'in_progress' },
    ])).toThrow(/one todo/);
    expect(parseTodoList([
      { content: 'first', status: 'in_progress' },
      { content: 'second', status: 'in_progress' },
    ], { allowParallel: true })).toHaveLength(2);
    expect(() => parseTodoList([{ content: '  ', status: 'pending' }])).toThrow();
  });

  it('folds whole-list replacements and ignores malformed writes', () => {
    const events = [
      { type: 'message/user', data: { text: 'go' } },
      { type: TODO_WRITE_EVENT, data: { todos: items } },
      { type: TODO_WRITE_EVENT, data: { todos: 'not a list' } },
      { type: TODO_WRITE_EVENT, data: [items[0]] },
    ];
    expect(projectTodos(events)).toEqual([items[0]]);
  });

  it('keeps the list across model steps but retires it on the next user turn', () => {
    const events = [
      { type: 'message/user', data: { text: 'first turn' } },
      { type: 'trace/turn.start', data: { step: 0 } },
      { type: TODO_WRITE_EVENT, data: { todos: items } },
      { type: 'trace/turn.start', data: { step: 1 } },
      { type: 'trace/turn.end', data: { reason: 'end_turn' } },
    ];
    expect(projectTodos(events)).toEqual(items);
    expect(projectTodos([...events, { type: 'message/user', data: { text: 'second turn' } }])).toBeNull();
  });

  it('counts each status for tool feedback and UI summaries', () => {
    expect(todoCounts(items)).toEqual({ pending: 1, inProgress: 1, completed: 1 });
  });
});
