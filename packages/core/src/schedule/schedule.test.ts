import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScheduleRecord } from './update.ts';
import { ScheduleStore } from './store.ts';
import { ScheduleService } from './service.ts';
import type { ScheduleDeliveryHost, ScheduleDeliveryRequest } from './runtime.ts';
import { ScheduleInputError } from './domain.ts';
import { renderScheduleToolGuidance, SCHEDULE_TOOL_GROUP } from './tools.ts';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-schedule-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function host(overrides: Partial<ScheduleDeliveryHost> = {}): ScheduleDeliveryHost {
  return {
    validateSession: async () => ({ ok: true }),
    deliver: async (request: ScheduleDeliveryRequest) => ({ sessionId: request.target.kind === 'session' ? request.target.sessionId : 'created-session' }),
    ...overrides,
  };
}

describe('schedule domain', () => {
  it('builds one-shot, fixed-rate, daily, cron, and rrule records', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const at = createScheduleRecord('schedule-1', 'Standup', 'Say hello', { kind: 'at', at: '2026-01-02T09:00:00.000Z' }, now);
    expect(at).toMatchObject({ kind: 'at', title: 'Standup', prompt: 'Say hello' });
    expect(Date.parse(at.scheduledAt)).toBeGreaterThan(now);

    const every = createScheduleRecord('schedule-2', 'Ping', 'Ping', { kind: 'every', every_seconds: 120 }, now);
    expect(every.kind).toBe('every');
    if (every.kind === 'every') expect(every.everySeconds).toBe(120);

    const daily = createScheduleRecord('schedule-3', 'Daily', 'Daily', {
      kind: 'daily', daily: { time: '09:30:00', time_zone: 'UTC' },
    }, now);
    expect(daily.kind).toBe('daily');

    const cron = createScheduleRecord('schedule-4', 'Cron', 'Cron', {
      kind: 'cron', cron: { expression: '*/5 * * * *', time_zone: 'UTC' },
    }, now);
    expect(cron.kind).toBe('cron');

    const rrule = createScheduleRecord('schedule-5', 'RRule', 'RRule', {
      kind: 'rrule', rrule: 'DTSTART;TZID=UTC:20260101T090000\nRRULE:FREQ=DAILY',
    }, now);
    expect(rrule.kind).toBe('rrule');
  });

  it('rejects an empty prompt with a stable code', () => {
    expect(() => createScheduleRecord('schedule-1', 'Title', '  ', { kind: 'every', every_seconds: 60 }, Date.now()))
      .toThrowError(ScheduleInputError);
    try {
      createScheduleRecord('schedule-1', 'Title', '  ', { kind: 'every', every_seconds: 60 }, Date.now());
    } catch (error) {
      expect((error as ScheduleInputError).code).toBe('invalid_prompt');
    }
  });
});

describe('ScheduleStore', () => {
  it('round-trips tasks through an atomic JSON file', async () => {
    const root = await tempRoot();
    const file = join(root, 'schedules.json');
    const store = new ScheduleStore(file);
    await store.open();
    const now = Date.now();
    const record = createScheduleRecord('schedule-1', 'Title', 'Prompt', { kind: 'every', every_seconds: 60 }, now);
    await store.put('schedule-1', {
      record,
      target: { kind: 'new_once', sessionId: 'session-reserved', create: { cwd: root } },
      involvedSessionIds: [],
      status: 'active',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      deliveryHistory: { records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
    });
    await store.close();

    const reopened = new ScheduleStore(file);
    await reopened.open();
    expect(reopened.get('schedule-1')?.record.title).toBe('Title');
    await reopened.close();
    const text = JSON.parse(await readFile(file, 'utf8')) as { version: number };
    expect(text.version).toBe(1);
  });
});

describe('ScheduleService', () => {
  it('creates, lists, runs, pauses, resumes, records history, and deletes', async () => {
    const root = await tempRoot();
    const deliveries: ScheduleDeliveryRequest[] = [];
    const service = new ScheduleService({
      file: join(root, 'schedules.json'),
      host: host({
        deliver: async (request) => {
          deliveries.push(request);
          return { sessionId: 'created-session' };
        },
      }),
    });
    await service.open();
    try {
      const created = await service.create({
        title: 'Morning brief',
        prompt: 'Summarize the overnight changes.',
        timing: { kind: 'every', every_seconds: 60 },
        target: { kind: 'new_once', create: { cwd: root } },
      });
      expect(created.status).toBe('active');
      expect(created.target.kind).toBe('new_once');

      const page = await service.list();
      expect(page.total).toBe(1);
      expect(page.items[0]?.id).toBe(created.id);

      const run = await service.run({ id: created.id });
      expect(run).toMatchObject({ id: created.id, status: 'active' });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.text).toContain('Summarize the overnight changes.');

      const history = await service.history({ id: created.id, limit: 10 });
      expect('records' in history).toBe(true);
      if ('records' in history) {
        expect(history.records).toHaveLength(1);
        expect(history.records[0]?.targetSessionId).toBe('created-session');
      }

      const paused = await service.edit({ id: created.id, action: 'update', patch: { active: false } });
      expect(paused).toMatchObject({ status: 'paused' });
      const resumed = await service.edit({ id: created.id, action: 'update', patch: { active: true } });
      expect(resumed).toMatchObject({ status: 'active' });

      const deleted = await service.edit({ id: created.id, action: 'delete' });
      expect(deleted).toEqual({ id: created.id, deleted: true });
      expect((await service.list()).total).toBe(0);
    } finally {
      await service.close();
    }
  });

  it('refuses an unavailable session target without creating the task', async () => {
    const root = await tempRoot();
    const service = new ScheduleService({
      file: join(root, 'schedules.json'),
      host: host({
        validateSession: async () => ({ ok: false, code: 'invalid_rule', message: 'The target session does not exist.' }),
      }),
    });
    await service.open();
    try {
      await expect(service.create({
        title: 'Reminder',
        prompt: 'Ping',
        timing: { kind: 'every', every_seconds: 60 },
        target: { kind: 'session', sessionId: 'missing' },
      })).rejects.toMatchObject({ code: 'invalid_rule' });
      expect((await service.list()).total).toBe(0);
    } finally {
      await service.close();
    }
  });

  it('reports a stable conflict for a stale expectedUpdatedAt', async () => {
    const root = await tempRoot();
    const service = new ScheduleService({ file: join(root, 'schedules.json'), host: host() });
    await service.open();
    try {
      const created = await service.create({
        title: 'Task',
        prompt: 'Prompt',
        timing: { kind: 'every', every_seconds: 60 },
      });
      const conflict = await service.edit({
        id: created.id,
        action: 'update',
        patch: { title: 'Changed' },
        expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
      });
      expect(conflict).toEqual({ id: created.id, code: 'schedule_conflict' });
    } finally {
      await service.close();
    }
  });
});

describe('schedule tool surface', () => {
  it('names the four tools and renders the management guidance', () => {
    expect(SCHEDULE_TOOL_GROUP).toEqual([
      'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
    ]);
    expect(renderScheduleToolGuidance()).toContain('explicit request');
  });
});
