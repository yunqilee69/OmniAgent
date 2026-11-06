import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './protocol/events';
import { FakeModel, textResponse, toolCallResponse } from './providers/fake';
import { Session } from './session';
import { projectTodos } from './session/todo';
import { SessionStore } from './session/store';
import {
  createInitialDshPermissionEvent,
  projectDshPermissions,
  snapshotDshPermissions,
} from './permissions/dsh-permissions';

const permissions = snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent('read-only')]));

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const todos = [
  { content: 'Inspect the code', status: 'completed' },
  { content: 'Implement the change', status: 'in_progress' },
  { content: 'Run tests', status: 'pending' },
];

describe('Session todo_write', () => {
  it('persists the whole list and reports exact counts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omniagent-todo-session-'));
    try {
      const handle = await new SessionStore(join(cwd, 'sessions')).create({ id: 'agent', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        model: new FakeModel([
          toolCallResponse([{ id: 'todo', name: 'todo_write', args: { todos } }]),
          textResponse('tracked'),
        ]),
        modelId: 'fake',
        session: handle,
      });
      const events = await collect(session.send('work'));
      expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
        result: { name: 'todo_write', ok: true, content: expect.stringContaining('1 pending, 1 in progress, 1 completed') },
      });
      expect(projectTodos(handle.events)).toEqual(todos);
      expect(handle.events.find((event) => event.type === 'todo/write')).toMatchObject({ data: { todos } });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects parallel active items when parallel work is disabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omniagent-todo-invalid-'));
    try {
      const handle = await new SessionStore(join(cwd, 'sessions')).create({ id: 'agent', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        todoAllowParallelInProgress: false,
        model: new FakeModel([
          toolCallResponse([
            { id: 'valid', name: 'todo_write', args: { todos } },
            { id: 'invalid', name: 'todo_write', args: { todos: [
              { content: 'first', status: 'in_progress' },
              { content: 'second', status: 'in_progress' },
            ] } },
          ]),
          textResponse('done'),
        ]),
        modelId: 'fake',
        session: handle,
      });
      const events = await collect(session.send('change'));
      expect(events.filter((event) => event.type === 'tool.result')).toEqual([
        expect.objectContaining({ result: expect.objectContaining({ name: 'todo_write', ok: true }) }),
        expect.objectContaining({ result: expect.objectContaining({ name: 'todo_write', ok: false, content: expect.stringContaining('one todo') }) }),
      ]);
      expect(projectTodos(handle.events)).toEqual(todos);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps multiple todos in progress when parallel work is enabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omniagent-todo-parallel-'));
    try {
      const handle = await new SessionStore(join(cwd, 'sessions')).create({ id: 'agent', workspace: cwd, cwd });
      await handle.append(createInitialDshPermissionEvent('read-only'));
      const parallel = [
        { content: 'Explore the API', status: 'in_progress' },
        { content: 'Implement the client', status: 'in_progress' },
        { content: 'Review the result', status: 'pending' },
      ];
      const session = new Session({
        cwd,
        dshPermissions: permissions,
        todoAllowParallelInProgress: true,
        model: new FakeModel([
          toolCallResponse([{ id: 'parallel', name: 'todo_write', args: { todos: parallel } }]),
          textResponse('tracked'),
        ]),
        modelId: 'fake',
        session: handle,
      });
      const events = await collect(session.send('split work'));
      expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
        result: { name: 'todo_write', ok: true, content: expect.stringContaining('2 in progress') },
      });
      expect(projectTodos(handle.events)).toEqual(parallel);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
