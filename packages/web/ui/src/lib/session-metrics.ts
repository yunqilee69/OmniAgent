export interface SessionMetrics {
  version: 1;
  runs: { started: number; completed: number; durationMs: number | null; knownDurationCount: number };
  steps: { started: number };
  requests: { count: number; durationMs: number | null; knownDurationCount: number };
  usage: { inputTokens: number | null; outputTokens: number | null; inputKnownCount: number; outputKnownCount: number };
  throughput: { outputTokens: number; durationMs: number; count: number };
  cache: { inputTokens: number; cachedInputTokens: number; count: number };
}

export function emptyMetrics(): SessionMetrics {
  return {
    version: 1,
    runs: { started: 0, completed: 0, durationMs: null, knownDurationCount: 0 },
    steps: { started: 0 },
    requests: { count: 0, durationMs: null, knownDurationCount: 0 },
    usage: { inputTokens: null, outputTokens: null, inputKnownCount: 0, outputKnownCount: 0 },
    throughput: { outputTokens: 0, durationMs: 0, count: 0 },
    cache: { inputTokens: 0, cachedInputTokens: 0, count: 0 },
  };
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function duration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function validateSessionMetrics(value: unknown): SessionMetrics | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as SessionMetrics;
  if (m.version !== 1 || !m.runs || !m.steps || !m.requests || !m.usage || !m.throughput || !m.cache) return null;
  if (![m.runs.started, m.runs.completed, m.runs.knownDurationCount, m.steps.started,
    m.requests.count, m.requests.knownDurationCount, m.usage.inputKnownCount, m.usage.outputKnownCount,
    m.throughput.count, m.throughput.outputTokens, m.cache.inputTokens, m.cache.cachedInputTokens, m.cache.count].every(count)) return null;
  if (![m.runs.durationMs, m.requests.durationMs].every((v) => v === null || duration(v))
    || !duration(m.throughput.durationMs)
    || ![m.usage.inputTokens, m.usage.outputTokens].every((v) => v === null || count(v))) return null;
  return structuredClone(m);
}

export function applyMetricsEvent(metrics: SessionMetrics, event: Record<string, unknown>, newRun: boolean): void {
  if (event.type === 'turn.start') {
    if (newRun) metrics.runs.started += 1;
    metrics.steps.started += 1;
  } else if (event.type === 'assistant.message' && typeof event.message === 'object' && event.message !== null) {
    const message = event.message as { usage?: { inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown }; requestDurationMs?: unknown };
    metrics.requests.count += 1;
    const input = message.usage?.inputTokens;
    const output = message.usage?.outputTokens;
    const cached = message.usage?.cachedInputTokens;
    const elapsed = message.requestDurationMs;
    if (count(input) && input > 0 && count(cached) && cached <= input) {
      metrics.cache.inputTokens += input;
      metrics.cache.cachedInputTokens += cached;
      metrics.cache.count += 1;
    }
    if (count(input)) {
      metrics.usage.inputTokens = (metrics.usage.inputTokens ?? 0) + input;
      metrics.usage.inputKnownCount += 1;
    }
    if (count(output)) {
      metrics.usage.outputTokens = (metrics.usage.outputTokens ?? 0) + output;
      metrics.usage.outputKnownCount += 1;
    }
    if (duration(elapsed)) {
      metrics.requests.durationMs = (metrics.requests.durationMs ?? 0) + elapsed;
      metrics.requests.knownDurationCount += 1;
      if (elapsed > 0 && count(output)) {
        metrics.throughput.durationMs += elapsed;
        metrics.throughput.outputTokens += output;
        metrics.throughput.count += 1;
      }
    }
  } else if (event.type === 'turn.end') {
    metrics.runs.completed += 1;
  }
}
