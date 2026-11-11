export interface TrajectoryEvent {
  seq: number;
  ts?: number | null;
  type: string;
  data: unknown;
}

export type TrajectoryLane = 'input' | 'model' | 'tools';
export type TrajectoryToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_dir'
  | 'glob'
  | 'grep'
  | 'web_fetch'
  | 'skill'
  | 'bash'
  | 'todo_write'
  | 'exit_plan_mode'
  | 'get_goal'
  | 'create_goal'
  | 'update_goal'
  | 'subagent'
  | 'send_message'
  | 'list_agents'
  | 'wait_agent'
  | 'interrupt_agent';

const TRAJECTORY_TOOL_NAMES = new Set<string>([
  'read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'web_fetch',
  'skill', 'bash', 'todo_write',
  'exit_plan_mode', 'get_goal', 'create_goal', 'update_goal', 'subagent', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
]);
export type TrajectoryEndReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'max_steps' | 'interrupted' | 'error';

export interface TrajectoryTurn {
  id: string;
  inputRecordId: string | null;
  startSeq: number;
  endSeq: number | null;
  endReason: TrajectoryEndReason | null;
}

interface TrajectoryRecordBase {
  id: string;
  seq: number;
  turnId: string | null;
  stepId: string | null;
  step: number | null;
  timestamp: number | null;
  /** True when a content field was clipped by the projection limit. */
  clipped: boolean;
}

export interface TrajectoryInputRecord extends TrajectoryRecordBase {
  kind: 'input';
  /** The user's own words: message text or the text parts of the message content. */
  text: string | null;
}

export interface TrajectoryModelRecord extends TrajectoryRecordBase {
  kind: 'model';
  assistantSeq: number | null;
  assistantRecordedAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The assistant's message text; reasoning and replay payloads stay out. */
  text: string | null;
}

export interface TrajectoryToolRecord extends TrajectoryRecordBase {
  kind: 'tool';
  name: TrajectoryToolName | null;
  callSeq: number | null;
  callRecordedAt: number | null;
  resultSeq: number | null;
  resultRecordedAt: number | null;
  durationMs: number | null;
  ok: boolean | null;
  truncated: boolean | null;
  decision: 'allow' | 'deny' | null;
  /** The call arguments as pretty-printed JSON, so a reader can see what ran. */
  arguments: string | null;
  /** The tool result text a model saw; for failures this carries the reason. */
  output: string | null;
}

export type TrajectoryRecord = TrajectoryInputRecord | TrajectoryModelRecord | TrajectoryToolRecord;
export interface TrajectorySpan {
  recordId: string;
  lane: TrajectoryLane;
  start: number;
  end: number;
}
export interface TrajectoryProjection {
  version: 1;
  turns: TrajectoryTurn[];
  records: TrajectoryRecord[];
  timeline: { sequence: TrajectorySpan[]; time: TrajectorySpan[] };
}

type Data = Record<string, unknown>;
type ToolObservationKind = 'assistant-call' | 'trace-call' | 'message-result' | 'trace-result' | 'decision';

interface ToolObservation {
  kind: ToolObservationKind;
  event: TrajectoryEvent;
  index: number;
  callId: string | null;
  name: string | null;
  durationMs: number | null;
  ok: boolean | null;
  truncated: boolean | null;
  decision: 'allow' | 'deny' | null;
  arguments: unknown;
  content: string | null;
}

interface ToolGroup {
  turnId: string | null;
  stepId: string | null;
  step: number | null;
  observations: ToolObservation[];
}

interface ToolEntry {
  callId: string | null;
  rawName: string | null;
  observations: ToolObservation[];
}

function object(value: unknown): Data | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(event: TrajectoryEvent): number | null {
  return integer(event.ts);
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function toolName(value: string | null): TrajectoryToolName | null {
  return value !== null && TRAJECTORY_TOOL_NAMES.has(value) ? value as TrajectoryToolName : null;
}

/** Content longer than this many characters is clipped out of a projection. */
export const TRAJECTORY_CONTENT_LIMIT = 8_000;

interface Content {
  value: string;
  clipped: boolean;
}

function content(value: string): Content | null {
  if (value.length === 0) return null;
  return value.length > TRAJECTORY_CONTENT_LIMIT
    ? { value: value.slice(0, TRAJECTORY_CONTENT_LIMIT), clipped: true }
    : { value, clipped: false };
}

/** Message body text: either a plain string or the text parts of a content array. */
function messageText(value: unknown): Content | null {
  if (typeof value === 'string') return content(value);
  if (!Array.isArray(value)) return null;
  const text = value.flatMap((part) => {
    const item = object(part);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  }).join('\n\n');
  return content(text);
}

/** Tool arguments as pretty-printed JSON, so a reader can see what actually ran. */
function argumentText(value: unknown): Content | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return content(value);
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? null : content(serialized);
  } catch {
    return null;
  }
}

function endReason(value: unknown): TrajectoryEndReason | null {
  switch (value) {
    case 'end_turn': case 'tool_use': case 'max_tokens': case 'max_steps': case 'interrupted': case 'error':
      return value;
    default:
      return null;
  }
}

function decision(value: unknown): 'allow' | 'deny' | null {
  return value === 'allow' || value === 'deny' ? value : null;
}

function observation(kind: ToolObservationKind, event: TrajectoryEvent, data: Data | null, index = 0): ToolObservation {
  const isResult = kind === 'message-result' || kind === 'trace-result';
  return {
    kind, event, index,
    callId: string(kind === 'assistant-call' || kind === 'trace-call' ? data?.id : data?.callId),
    name: string(data?.name),
    durationMs: nonnegative(data?.durationMs),
    ok: boolean(data?.ok),
    truncated: boolean(data?.truncated),
    decision: decision(data?.decision),
    arguments: isResult ? undefined : data?.arguments,
    content: isResult ? string(data?.content) : null,
  };
}

function entry(item: ToolObservation): ToolEntry {
  return { callId: item.callId, rawName: item.name, observations: [item] };
}

function compatible(left: ToolEntry, right: ToolEntry): boolean {
  return left.callId !== null && left.callId === right.callId
    && (left.rawName === null || right.rawName === null || left.rawName === right.rawName);
}

function sameResultCopy(left: ToolEntry, right: ToolEntry): boolean {
  if (left.rawName !== null && right.rawName !== null && left.rawName !== right.rawName) return false;
  if (left.callId !== null && right.callId !== null) return left.callId === right.callId;
  return left.rawName !== null && left.rawName === right.rawName;
}

function join(left: ToolEntry, right: ToolEntry): ToolEntry {
  return {
    callId: left.callId ?? right.callId,
    rawName: left.rawName ?? right.rawName,
    observations: [...left.observations, ...right.observations],
  };
}

/** Only join a pair when neither endpoint has another compatible candidate. */
function joinUnique(left: ToolEntry[], right: ToolEntry[]): ToolEntry[] {
  const rightById = new Map<string, ToolEntry[]>();
  const leftById = new Map<string, ToolEntry[]>();
  for (const item of left) if (item.callId !== null) leftById.set(item.callId, [...leftById.get(item.callId) ?? [], item]);
  for (const item of right) if (item.callId !== null) rightById.set(item.callId, [...rightById.get(item.callId) ?? [], item]);
  const used = new Set<ToolEntry>();
  const result = left.map((item) => {
    const matches = item.callId === null ? [] : (rightById.get(item.callId) ?? []).filter((candidate) => compatible(item, candidate));
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match || (leftById.get(match.callId!) ?? []).filter((candidate) => compatible(candidate, match)).length !== 1) return item;
    used.add(match);
    return join(item, match);
  });
  return [...result, ...right.filter((item) => !used.has(item))];
}

function consistent<T>(values: readonly (T | null)[]): T | null {
  const known = values.filter((value): value is T => value !== null);
  return known.length > 0 && known.every((value) => value === known[0]) ? known[0]! : null;
}

function projectTools(group: ToolGroup): TrajectoryToolRecord[] {
  const assistants = group.observations.filter((item) => item.kind === 'assistant-call').map(entry);
  const traces = group.observations.filter((item) => item.kind === 'trace-call').map(entry);
  const calls = joinUnique(assistants, traces);
  const messageResults = group.observations.filter((item) => item.kind === 'message-result').map(entry);
  const traceResults = group.observations.filter((item) => item.kind === 'trace-result').map(entry);
  const usedTraceResults = new Set<ToolEntry>();
  const results = messageResults.map((message) => {
    const first = message.observations[0]!;
    const trace = traceResults.find((candidate) => {
      const next = candidate.observations[0]!;
      return next.event.seq === first.event.seq + 1 && sameResultCopy(message, candidate);
    });
    if (!trace) return message;
    usedTraceResults.add(trace);
    return join(message, trace);
  });
  results.push(...traceResults.filter((item) => !usedTraceResults.has(item)));
  const combined = joinUnique(calls, results);
  const decisions = group.observations.filter((item) => item.kind === 'decision').map(entry);
  return joinUnique(combined, decisions).map((item) => {
    const sorted = [...item.observations].sort((a, b) => a.event.seq - b.event.seq || a.index - b.index);
    const first = sorted[0]!;
    const call = sorted.find((candidate) => candidate.kind === 'trace-call');
    const result = sorted.find((candidate) => candidate.kind === 'message-result' || candidate.kind === 'trace-result');
    const resultItems = sorted.filter((candidate) => candidate.kind === 'message-result' || candidate.kind === 'trace-result');
    const args = argumentText(sorted.find((candidate) => candidate.arguments !== undefined)?.arguments);
    const output = content(resultItems.find((candidate) => candidate.content !== null)?.content ?? '');
    return {
      id: `tool:${first.event.seq}:${first.index}`,
      kind: 'tool',
      seq: first.event.seq,
      turnId: group.turnId,
      stepId: group.stepId,
      step: group.step,
      timestamp: timestamp(first.event),
      name: toolName(item.rawName),
      callSeq: call?.event.seq ?? null,
      callRecordedAt: call ? timestamp(call.event) : null,
      resultSeq: result?.event.seq ?? null,
      resultRecordedAt: result ? timestamp(result.event) : null,
      durationMs: consistent(resultItems.map((candidate) => candidate.durationMs)),
      ok: consistent(resultItems.map((candidate) => candidate.ok)),
      truncated: consistent(resultItems.map((candidate) => candidate.truncated)),
      decision: consistent(sorted.map((candidate) => candidate.decision)),
      arguments: args?.value ?? null,
      output: output?.value ?? null,
      clipped: args?.clipped === true || output?.clipped === true,
    };
  });
}

function lane(record: TrajectoryRecord): TrajectoryLane {
  return record.kind === 'tool' ? 'tools' : record.kind;
}

function timeSpan(record: TrajectoryRecord): TrajectorySpan | null {
  if (record.kind === 'tool') {
    const call = record.callRecordedAt;
    const result = record.resultRecordedAt;
    if (call !== null && result !== null && record.callSeq !== null && record.resultSeq !== null
      && record.callSeq < record.resultSeq && call <= result) {
      return { recordId: record.id, lane: 'tools', start: call, end: result };
    }
    const point = record.resultSeq !== null && (record.callSeq === null || record.resultSeq < record.callSeq)
      ? result ?? call ?? record.timestamp
      : call ?? result ?? record.timestamp;
    return point === null ? null : { recordId: record.id, lane: 'tools', start: point, end: point };
  }
  const point = record.timestamp ?? (record.kind === 'model' ? record.assistantRecordedAt : null);
  return point === null ? null : { recordId: record.id, lane: lane(record), start: point, end: point };
}

/**
 * Project a committed event snapshot to a bounded, JSON-serializable ledger.
 *
 * Sequence numbers determine order and identity; duplicate/invalid numbers throw.
 * Turns begin at user input or an otherwise unowned step, and repeated `turn.start`
 * markers are model steps, not turn endings. A non-increasing step starts a new
 * turn fragment. Tool associations never cross a step or user-turn boundary, and ambiguous IDs
 * remain separate. Orphan events have no turn. Unknown metadata is null.
 *
 * Records carry the text a reader needs — the user message, the assistant message,
 * tool arguments and the tool result — clipped to {@link TRAJECTORY_CONTENT_LIMIT}
 * characters and flagged with `clipped`. Still deliberately omitted: call IDs, tool
 * names outside the built-in allowlist, permission rule text, reasoning and provider
 * replay payloads, and error strings (the persisted error trace is a placeholder).
 * Model spans are observation points, not durations. Tool spans reflect recorded
 * call/result event times, not execution time; durationMs is separately recorded.
 */
export function projectTrajectory(events: readonly TrajectoryEvent[]): TrajectoryProjection {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const [index, event] of ordered.entries()) {
    if (integer(event.seq) === null || (index > 0 && ordered[index - 1]!.seq === event.seq)) {
      throw new Error('Trajectory events must have unique nonnegative integer sequence numbers');
    }
  }

  const turns: TrajectoryTurn[] = [];
  const records: TrajectoryRecord[] = [];
  const groups: ToolGroup[] = [];
  let turn: TrajectoryTurn | null = null;
  let step: TrajectoryModelRecord | null = null;
  let group: ToolGroup | null = null;
  let stepSeen = false;

  const beginTurn = (seq: number, inputRecordId: string | null): void => {
    turn = { id: `turn:${seq}`, inputRecordId, startSeq: seq, endSeq: null, endReason: null };
    turns.push(turn);
    step = null;
    group = null;
    stepSeen = false;
  };
  const createGroup = (): ToolGroup => {
    const created: ToolGroup = {
      turnId: turn?.id ?? null, stepId: step?.stepId ?? null, step: step?.step ?? null, observations: [],
    };
    groups.push(created);
    return created;
  };
  const addTool = (item: ToolObservation): void => {
    // Without a turn, only the adjacent message/trace copy is identifiable.
    if (turn === null) {
      const previous = groups.at(-1);
      const last = previous?.observations.at(-1);
      if (item.kind === 'trace-result' && previous?.turnId === null && last?.kind === 'message-result'
        && item.event.seq === last.event.seq + 1 && sameResultCopy(entry(last), entry(item))) {
        previous.observations.push(item);
      } else createGroup().observations.push(item);
    } else {
      group ??= createGroup();
      group.observations.push(item);
    }
  };

  for (const event of ordered) {
    const data = object(event.data);
    if (event.type === 'message/user' || event.type === 'user/message') {
      if (data?.role !== undefined && data.role !== 'user') continue;
      if (data?.source !== undefined && object(data.source)?.kind !== 'user') continue;
      beginTurn(event.seq, `input:${event.seq}`);
      const input = messageText(data?.text) ?? messageText(data?.content);
      records.push({ id: `input:${event.seq}`, kind: 'input', seq: event.seq, turnId: turn!.id,
        stepId: null, step: null, timestamp: timestamp(event),
        text: input?.value ?? null, clipped: input?.clipped === true });
    } else if (event.type === 'trace/turn.start') {
      const stepNumber = integer(data?.step);
      if (turn === null || (stepSeen && stepNumber !== null
        && (stepNumber === 0 || (step?.step !== null && step?.step !== undefined && stepNumber <= step.step)))) {
        beginTurn(event.seq, null);
      }
      stepSeen = true;
      step = { id: `model:${event.seq}`, kind: 'model', seq: event.seq, turnId: turn!.id,
        stepId: `step:${event.seq}`, step: stepNumber, timestamp: timestamp(event),
        assistantSeq: null, assistantRecordedAt: null, inputTokens: null, outputTokens: null,
        text: null, clipped: false };
      group = null;
      records.push(step);
    } else if (event.type === 'trace/turn.end') {
      if (turn !== null) {
        const active = turn as TrajectoryTurn;
        active.endSeq = event.seq;
        active.endReason = endReason(data?.reason);
      }
      turn = null;
      step = null;
      group = null;
      stepSeen = false;
    } else if (event.type === 'message/assistant' || event.type === 'assistant/message') {
      if (data?.role !== undefined && data.role !== 'assistant') continue;
      if (step === null || step.assistantSeq !== null) group = null;
      let model: TrajectoryModelRecord;
      if (step !== null && step.assistantSeq === null) model = step;
      else {
        model = { id: `model:${event.seq}`, kind: 'model', seq: event.seq, turnId: (turn as TrajectoryTurn | null)?.id ?? null,
          stepId: step?.stepId ?? null, step: step?.step ?? null, timestamp: timestamp(event),
          assistantSeq: null, assistantRecordedAt: null, inputTokens: null, outputTokens: null,
          text: null, clipped: false };
        records.push(model);
      }
      const usage = object(data?.usage);
      const answer = messageText(data?.content);
      model.assistantSeq = event.seq;
      model.assistantRecordedAt = timestamp(event);
      model.inputTokens = integer(usage?.inputTokens);
      model.outputTokens = integer(usage?.outputTokens);
      model.text = answer?.value ?? null;
      model.clipped = model.clipped || answer?.clipped === true;
      if (Array.isArray(data?.toolCalls)) {
        for (const [index, value] of data.toolCalls.entries()) {
          const call = object(value);
          if (call && (string(call.id) !== null || string(call.name) !== null)) {
            addTool(observation('assistant-call', event, call, index));
          }
        }
      }
    } else if (event.type === 'trace/tool.call') {
      addTool(observation('trace-call', event, data));
    } else if (event.type === 'trace/permission.decided') {
      if (decision(data?.decision) !== null) addTool(observation('decision', event, data));
    } else if (event.type === 'message/tool-result' || event.type === 'tool/result') {
      const result = data && 'result' in data ? object(data.result) : data;
      if (result) addTool(observation('message-result', event, result));
    } else if (event.type === 'trace/tool.result') {
      addTool(observation('trace-result', event, data));
    }
  }

  for (const item of groups) records.push(...projectTools(item));
  records.sort((a, b) => a.seq - b.seq || (a.kind === 'model' && b.kind !== 'model' ? -1
    : b.kind === 'model' && a.kind !== 'model' ? 1 : 0));
  const sequence = records.map((record, index): TrajectorySpan => ({
    recordId: record.id, lane: lane(record), start: index, end: index + 1,
  }));
  const time = records.flatMap((record) => {
    const span = timeSpan(record);
    return span === null ? [] : [span];
  });
  return { version: 1, turns, records, timeline: { sequence, time } };
}
