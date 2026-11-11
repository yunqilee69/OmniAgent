import type { TrajectoryEvent } from './trajectory';

/**
 * Numeric aggregates for the composer readings. Every figure rides the whole
 * durable log: the conversation window is paged and compaction rewrites it, so
 * a window-scoped fold would disagree with the session totals.
 */
export interface SessionMetrics {
  version: 1;
  runs: { started: number; completed: number; durationMs: number | null; knownDurationCount: number };
  steps: { started: number };
  requests: { count: number; durationMs: number | null; knownDurationCount: number };
  /** Tool wall time, summed over results that recorded a duration. */
  tools: { count: number; durationMs: number; knownDurationCount: number };
  /** First-token latency, summed over requests that streamed content. */
  ttft: { durationMs: number; count: number };
  usage: { inputTokens: number | null; outputTokens: number | null; inputKnownCount: number; outputKnownCount: number };
  /** Decode-only speed: output tokens over request time minus first-token latency when known. */
  throughput: { outputTokens: number; durationMs: number; count: number };
  cache: { inputTokens: number; cachedInputTokens: number; count: number };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Project only numeric aggregates; user messages do not mark run boundaries. */
export function projectSessionMetrics(events: readonly TrajectoryEvent[]): SessionMetrics {
  const metrics: SessionMetrics = {
    version: 1,
    runs: { started: 0, completed: 0, durationMs: null, knownDurationCount: 0 },
    steps: { started: 0 },
    requests: { count: 0, durationMs: null, knownDurationCount: 0 },
    tools: { count: 0, durationMs: 0, knownDurationCount: 0 },
    ttft: { durationMs: 0, count: 0 },
    usage: { inputTokens: null, outputTokens: null, inputKnownCount: 0, outputKnownCount: 0 },
    throughput: { outputTokens: 0, durationMs: 0, count: 0 },
    cache: { inputTokens: 0, cachedInputTokens: 0, count: 0 },
  };
  let run: { start: number | null; lastStep: number | null } | null = null;

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const data = record(event.data);
    if (event.type === 'trace/turn.start') {
      const step = integer(data?.step);
      if (run === null || (step !== null && (step === 0 || (run.lastStep !== null && step <= run.lastStep)))) {
        metrics.runs.started++;
        run = { start: step === 0 ? integer(event.ts) : null, lastStep: step };
      } else {
        run.lastStep = step;
      }
      metrics.steps.started++;
    } else if (event.type === 'trace/turn.end') {
      if (run !== null) {
        metrics.runs.completed++;
        const end = integer(event.ts);
        if (run.start !== null && end !== null && end >= run.start) {
          metrics.runs.durationMs = (metrics.runs.durationMs ?? 0) + end - run.start;
          metrics.runs.knownDurationCount++;
        }
        run = null;
      }
    } else if (event.type === 'message/assistant' || event.type === 'assistant/message') {
      if (data?.role !== undefined && data.role !== 'assistant') continue;
      metrics.requests.count++;
      const duration = nonnegative(data?.requestDurationMs);
      const ttft = nonnegative(data?.firstTokenDurationMs);
      const usage = record(data?.usage);
      const input = integer(usage?.inputTokens);
      const output = integer(usage?.outputTokens);
      const cachedInput = integer(usage?.cachedInputTokens);
      if (duration !== null) {
        metrics.requests.durationMs = (metrics.requests.durationMs ?? 0) + duration;
        metrics.requests.knownDurationCount++;
      }
      if (input !== null) {
        metrics.usage.inputTokens = (metrics.usage.inputTokens ?? 0) + input;
        metrics.usage.inputKnownCount++;
      }
      if (output !== null) {
        metrics.usage.outputTokens = (metrics.usage.outputTokens ?? 0) + output;
        metrics.usage.outputKnownCount++;
      }
      if (input !== null && input > 0 && cachedInput !== null && cachedInput <= input) {
        metrics.cache.inputTokens += input;
        metrics.cache.cachedInputTokens += cachedInput;
        metrics.cache.count++;
      }
      // Decode speed ignores the wait for the first token, so a long prefill does
      // not read as a slow stream; requests without a measured TTFT keep the
      // whole request window.
      const decodable = duration !== null && ttft !== null && ttft <= duration;
      if (decodable) {
        metrics.ttft.durationMs += ttft;
        metrics.ttft.count++;
      }
      const decodeDuration = duration === null ? null : decodable ? duration - ttft : duration;
      if (decodeDuration !== null && decodeDuration > 0 && output !== null) {
        metrics.throughput.outputTokens += output;
        metrics.throughput.durationMs += decodeDuration;
        metrics.throughput.count++;
      }
    } else if (event.type === 'message/tool-result' || event.type === 'tool/result') {
      const result = data !== undefined && 'result' in data ? record(data.result) : data;
      const toolDuration = nonnegative(result?.durationMs);
      if (toolDuration === null) continue;
      metrics.tools.count++;
      metrics.tools.durationMs += toolDuration;
      metrics.tools.knownDurationCount++;
    }
  }
  return metrics;
}
