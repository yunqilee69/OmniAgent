import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScheduleService } from '@omniagent/core';
import type { ScheduleDeliveryHost } from '@omniagent/core';
import { SessionStore } from '@omniagent/core';
import { startWebHost } from './server';
import type { WebHost } from './server';
import { WorkspaceRegistry } from './workspaces';

const hosts: WebHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-schedule-route-'));
  roots.push(root);
  const project = join(root, 'project');
  await mkdir(project);
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  await workspaces.add(project);
  const store = new SessionStore(join(root, 'sessions'));
  const host: ScheduleDeliveryHost = {
    validateSession: async () => ({ ok: true }),
    deliver: async (request) => ({
      sessionId: request.target.kind === 'session' ? request.target.sessionId : 'delivered-session',
    }),
  };
  const schedule = new ScheduleService({ file: join(root, 'schedules.json'), host });
  await schedule.open();
  const web = await startWebHost({ workspaces, store, schedule });
  hosts.push(web);
  return { base: web.address()!, project, schedule };
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('schedule web routes', () => {
  it('creates, lists, pauses, runs, reads history, and deletes a task', async () => {
    const { base, project } = await setup();
    const createdResponse = await fetch(`${base}/api/schedules`, post({
      title: 'Morning brief',
      prompt: 'Summarize the changes.',
      timing: { kind: 'every', every_seconds: 60 },
      target: { kind: 'new_once', create: { cwd: project } },
    }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { schedule: { id: string; status: string; target: { kind: string } } };
    expect(created.schedule.status).toBe('active');
    expect(created.schedule.target.kind).toBe('new_once');

    const list = await (await fetch(`${base}/api/schedules`)).json() as { schedules: unknown[]; total: number };
    expect(list.total).toBe(1);

    const pausedResponse = await fetch(`${base}/api/schedules/${encodeURIComponent(created.schedule.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { active: false } }),
    });
    expect(pausedResponse.status).toBe(200);
    expect((await pausedResponse.json() as { schedule: { status: string } }).schedule.status).toBe('paused');

    const runResponse = await fetch(`${base}/api/schedules/${encodeURIComponent(created.schedule.id)}/run`, post({}));
    expect(runResponse.status).toBe(200);

    const historyResponse = await fetch(`${base}/api/schedules/${encodeURIComponent(created.schedule.id)}/history?limit=10`);
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json() as { history: { records: Array<{ targetSessionId: string }> } };
    expect(history.history.records).toHaveLength(1);
    expect(history.history.records[0]?.targetSessionId).toBe('delivered-session');

    const deleteResponse = await fetch(`${base}/api/schedules/${encodeURIComponent(created.schedule.id)}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(200);
    expect((await (await fetch(`${base}/api/schedules`)).json() as { total: number }).total).toBe(0);
  });

  it('returns 400 with the stable code for invalid input and 404 for unknown tasks', async () => {
    const { base } = await setup();
    const invalid = await fetch(`${base}/api/schedules`, post({
      title: 'Bad',
      prompt: 'Bad',
      timing: { kind: 'every', every_seconds: 5 },
    }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { code: string }).code).toBe('frequency_too_high');

    const missing = await fetch(`${base}/api/schedules/schedule-missing`);
    expect(missing.status).toBe(404);
    expect((await missing.json() as { code: string }).code).toBe('schedule_not_found');
  });
});
