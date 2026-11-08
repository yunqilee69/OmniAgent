/**
 * Lossless guided and Custom editor projections for typed Schedule timing.
 * Ported from DSH's ui-schedule `editor-timing.ts` without the Host parsers;
 * the server remains authoritative for validating the generated rule.
 */
import type {
  ScheduleCatalogEntry,
  ScheduleTargetRequest,
  ScheduleTiming,
} from './wire.ts';

/** Periods represented by guided controls, plus a lossless advanced editor. */
export type FrequencyPreset = 'once' | 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'advanced';

/** Editable values that determine one typed timing selector. */
export interface TimingDraft {
  readonly frequency: FrequencyPreset;
  readonly interval: string;
  readonly start: string;
  readonly timeZone: string;
  readonly rrule: string;
  readonly retainedTiming?: ScheduleTiming;
  readonly weekdays: readonly number[];
  readonly monthDay: number;
  readonly dailyTime: string;
}

/** One complete task form. */
export interface ScheduleDraft extends TimingDraft {
  readonly title: string;
  readonly prompt: string;
  readonly target: 'session' | 'new_once' | 'new';
  readonly sessionId: string;
  readonly cwd: string;
}

const WEEKDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const FREQUENCY = {
  minutely: 'MINUTELY', hourly: 'HOURLY', daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY',
} as const;

/** Render an instant as the selected zone's local date and clock time. */
function startInZone(timeZone: string, at: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const field = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year').padStart(4, '0')}-${field('month')}-${field('day')}T${field('hour')}:${field('minute')}:${field('second')}`;
}

/** Default local zone for new tasks. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Initial form values: guided timing with a one-hour-ahead one-shot default. */
export function defaultTiming(): TimingDraft {
  const date = new Date(Date.now() + 60 * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  const start = `${local.toISOString().slice(0, 16)}:00`;
  const day = Number(start.slice(8, 10));
  const weekday = (new Date(`${start.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7 + 1;
  return {
    frequency: 'once', interval: '1', start,
    timeZone: systemTimeZone(), rrule: '',
    weekdays: [weekday], monthDay: day, dailyTime: start.slice(11, 16),
  };
}

/** Format guided timing as DTSTART and RRULE content lines; return advanced text verbatim. */
export function rruleFromDraft(draft: TimingDraft, intervalFromNow = false): string {
  if (draft.frequency === 'advanced') return draft.rrule;
  const now = Date.now();
  const anchor = intervalFromNow && (draft.frequency === 'minutely' || draft.frequency === 'hourly')
    ? startInZone(draft.timeZone, Math.floor(now / 60_000) * 60_000) : draft.start;
  const time = draft.frequency === 'daily' ? `${draft.dailyTime}:00` : anchor.slice(11);
  let start = `${anchor.slice(0, 10)}T${time}`.replaceAll(/[-:]/g, '');
  let rule: string;
  switch (draft.frequency) {
    case 'once': rule = 'FREQ=DAILY;COUNT=1'; break;
    case 'minutely':
    case 'hourly': rule = `FREQ=${FREQUENCY[draft.frequency]};INTERVAL=${draft.interval}`; break;
    case 'daily':
      rule = `FREQ=DAILY;INTERVAL=${draft.interval};BYHOUR=${Number(draft.dailyTime.slice(0, 2))}`
        + `;BYMINUTE=${Number(draft.dailyTime.slice(3, 5))}`;
      break;
    case 'weekly': rule = `FREQ=WEEKLY;INTERVAL=${draft.interval};BYDAY=${draft.weekdays.map((day) => WEEKDAY[day - 1]).join(',')}`; break;
    case 'monthly': rule = `FREQ=MONTHLY;INTERVAL=${draft.interval};BYMONTHDAY=${draft.monthDay},-1;BYSETPOS=1`; break;
    default: throw new Error(`Unsupported schedule timing: ${String(draft.frequency)}`);
  }
  if (intervalFromNow && draft.retainedTiming !== undefined
    && draft.frequency !== 'once' && draft.frequency !== 'minutely' && draft.frequency !== 'hourly') {
    start = startInZone(draft.timeZone, now).replaceAll(/[-:]/g, '');
  }
  return `DTSTART;TZID=${draft.timeZone}:${start}\nRRULE:${rule}`;
}

/** Recover only supported form rules; unknown rules remain verbatim in Advanced mode. */
export function timingFromRecord(record: ScheduleCatalogEntry): TimingDraft {
  const initial = defaultTiming();
  if (record.kind === 'cron') {
    return { ...initial, frequency: 'advanced', rrule: record.expression ?? '', timeZone: record.timeZone ?? initial.timeZone };
  }
  if (record.kind !== 'rrule') {
    let retainedTiming: ScheduleTiming;
    switch (record.kind) {
      case 'after':
      case 'at': retainedTiming = { kind: 'at', at: record.scheduledAt }; break;
      case 'every': retainedTiming = { kind: 'every', every_seconds: record.everySeconds ?? 60 }; break;
      case 'daily': retainedTiming = { kind: 'daily', daily: { time: record.time ?? '09:00:00', time_zone: record.timeZone ?? initial.timeZone } }; break;
      case 'weekly':
        retainedTiming = {
          kind: 'weekly',
          weekly: {
            time: record.time ?? '09:00:00',
            time_zone: record.timeZone ?? initial.timeZone,
            weekdays: record.weekdays ?? [1],
          },
        };
        break;
    }
    const scheduledAt = Date.parse(record.scheduledAt);
    let timeZone = record.timeZone ?? initial.timeZone;
    let start = Number.isFinite(scheduledAt) ? startInZone(timeZone, scheduledAt) : initial.start;
    if (record.kind === 'after' || record.kind === 'at') {
      // A local time that cannot round-trip needs an unambiguous UTC display.
      const roundTrip = new Date(`${start}Z`).getTime();
      if (Number.isFinite(roundTrip) && Math.abs(roundTrip - Math.floor(scheduledAt / 1_000) * 1_000) > 1_000) {
        timeZone = 'UTC';
        start = startInZone(timeZone, scheduledAt);
      }
    }
    const guided = {
      ...initial, start, timeZone, retainedTiming, dailyTime: start.slice(11, 16),
      monthDay: Number(start.slice(8, 10)),
      weekdays: [(new Date(`${start.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7 + 1],
    };
    if (record.kind === 'after' || record.kind === 'at') return { ...guided, frequency: 'once' };
    if (record.kind === 'every' && Number.isSafeInteger((record.everySeconds ?? 0) / 60)) {
      const seconds = record.everySeconds ?? 60;
      const hourly = seconds % 3_600 === 0;
      return { ...guided, frequency: hourly ? 'hourly' : 'minutely', interval: String(seconds / (hourly ? 3_600 : 60)) };
    }
    if (record.kind === 'daily' && /^\d{2}:\d{2}:00(?:\.0+)?$/.test(record.time ?? '')) {
      return { ...guided, frequency: 'daily', dailyTime: (record.time ?? '').slice(0, 5) };
    }
    if (record.kind === 'weekly' && /^\d{2}:\d{2}:\d{2}(?:\.0+)?$/.test(record.time ?? '')) {
      return { ...guided, frequency: 'weekly', start: `${start.slice(0, 10)}T${(record.time ?? '').slice(0, 8)}`, weekdays: record.weekdays ?? [1] };
    }
    return { ...initial, frequency: 'advanced', rrule: '', timeZone, retainedTiming };
  }
  const startMatch = /^DTSTART(?:;TZID=([^:]+))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/m.exec(record.rrule ?? '');
  const fields = new Map<string, string>();
  for (const line of (record.rrule ?? '').split('\n')) {
    if (!line.startsWith('RRULE:')) continue;
    for (const part of line.slice(6).split(';')) {
      const [key, value] = part.split('=');
      if (key !== undefined && value !== undefined) fields.set(key, value);
    }
  }
  const start = startMatch === null ? initial.start
    : `${startMatch[2]}-${startMatch[3]}-${startMatch[4]}T${startMatch[5]}:${startMatch[6]}:${startMatch[7]}`;
  const byDay = fields.get('BYDAY')?.split(',') ?? [];
  const hour = fields.get('BYHOUR') ?? start.slice(11, 13);
  const minute = fields.get('BYMINUTE') ?? start.slice(14, 16);
  const startWeekday = (new Date(`${start.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7 + 1;
  const freq = fields.get('FREQ')?.toLowerCase();
  const countedOnce = freq === 'daily' && fields.get('COUNT') === '1'
    && !fields.has('BYHOUR') && !fields.has('BYMINUTE') && !fields.has('BYDAY');
  const frequency: FrequencyPreset = countedOnce ? 'once'
    : freq === 'minutely' || freq === 'hourly' || freq === 'daily' || freq === 'weekly' || freq === 'monthly'
      ? freq : 'advanced';
  return {
    frequency,
    interval: fields.get('INTERVAL') ?? '1',
    start,
    timeZone: startMatch?.[1] ?? 'UTC',
    rrule: record.rrule ?? '',
    weekdays: byDay.length === 0 ? [startWeekday] : byDay.map((day) => WEEKDAY.indexOf(day as typeof WEEKDAY[number]) + 1),
    monthDay: Number.parseInt(fields.get('BYMONTHDAY') ?? start.slice(8, 10), 10),
    dailyTime: frequency === 'daily' ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` : start.slice(11, 16),
  };
}

/** Resolve form values into the shared Schedule timing union. */
export function timingFromDraft(draft: TimingDraft, intervalFromNow = false): ScheduleTiming {
  if (draft.frequency === 'advanced') {
    if (draft.rrule.trim() === '' && draft.retainedTiming !== undefined) return draft.retainedTiming;
    if (!draft.rrule.trimStart().startsWith('DTSTART')) {
      return { kind: 'cron', cron: { expression: draft.rrule.trim(), time_zone: draft.timeZone } };
    }
  }
  return { kind: 'rrule', rrule: rruleFromDraft(draft, intervalFromNow) };
}

/** A new task form without creating or activating a Session. */
export function newScheduleDraft(cwd: string): ScheduleDraft {
  return { ...defaultTiming(), title: '', prompt: '', target: 'new_once', sessionId: '', cwd };
}

/** Seed an edit without normalizing unsupported stored rules. */
export function scheduleDraft(entry: ScheduleCatalogEntry): ScheduleDraft {
  return {
    ...timingFromRecord(entry),
    title: entry.title,
    prompt: entry.prompt,
    target: entry.target.kind,
    sessionId: entry.target.kind === 'session' ? entry.target.sessionId : '',
    cwd: entry.target.kind === 'session' ? '' : entry.target.create.cwd ?? '',
  };
}

/** Resolve the explicit destination, preserving an existing preset when the project is unchanged. */
export function draftTarget(draft: ScheduleDraft, original?: ScheduleCatalogEntry): ScheduleTargetRequest {
  if (draft.target === 'session') return { kind: 'session', sessionId: draft.sessionId };
  const previous = original?.target.kind === 'session' ? undefined : original?.target.create;
  const create = {
    ...(draft.cwd === '' ? {} : { cwd: draft.cwd }),
    ...((previous?.cwd ?? '') === draft.cwd && previous?.agentPreset !== undefined ? { agentPreset: previous.agentPreset } : {}),
  };
  return { kind: draft.target, create };
}

/** First form correction key, `incomplete`, or undefined when the draft can be submitted. */
export function scheduleDraftIssue(draft: ScheduleDraft): string | undefined {
  if (draft.title.trim() === '' || draft.prompt.trim() === '' || (draft.target === 'session' && draft.sessionId === '')) return 'incomplete';
  if (draft.title.trim().length > 120) return 'The name must be 120 characters or fewer.';
  if (draft.frequency !== 'once' && draft.frequency !== 'advanced'
    && (!/^[1-9]\d*$/.test(draft.interval) || !Number.isSafeInteger(Number(draft.interval)))) return 'The interval must be a positive whole number.';
  if (draft.frequency === 'weekly' && draft.weekdays.length === 0) return 'Choose at least one weekday.';
  if (draft.frequency === 'monthly' && (!Number.isInteger(draft.monthDay) || draft.monthDay < 1 || draft.monthDay > 31)) return 'The day of the month must be 1 through 31.';
  if (draft.frequency === 'daily' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.dailyTime)) return 'Enter a valid time.';
  if (draft.frequency === 'advanced' && draft.rrule.trim() === '' && draft.retainedTiming === undefined) return 'Enter a cron expression or an iCalendar rule.';
  if (draft.frequency !== 'advanced' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(draft.start)) return 'Enter a valid start time.';
  return undefined;
}
