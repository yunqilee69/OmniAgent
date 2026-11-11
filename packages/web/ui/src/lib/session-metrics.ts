export interface SessionMetrics {
  version: 1;
  runs: { started: number; completed: number; durationMs: number | null; knownDurationCount: number };
  steps: { started: number };
  requests: { count: number; durationMs: number | null; knownDurationCount: number };
  tools: { count: number; durationMs: number; knownDurationCount: number };
  ttft: { durationMs: number; count: number };
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
    tools: { count: 0, durationMs: 0, knownDurationCount: 0 },
    ttft: { durationMs: 0, count: 0 },
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
  const normalized = structuredClone(m);
  // Sessions recorded before tool timing and TTFT existed report neither; read
  // them as empty readings instead of rejecting the whole projection.
  if (normalized.tools === undefined || normalized.tools === null
    || ![normalized.tools.count, normalized.tools.durationMs, normalized.tools.knownDurationCount].every(count)) {
    normalized.tools = { count: 0, durationMs: 0, knownDurationCount: 0 };
  }
  if (normalized.ttft === undefined || normalized.ttft === null
    || ![normalized.ttft.count, normalized.ttft.durationMs].every(count)) {
    normalized.ttft = { durationMs: 0, count: 0 };
  }
  return normalized;
}

export function applyMetricsEvent(metrics: SessionMetrics, event: Record<string, unknown>, newRun: boolean): void {
  if (event.type === 'turn.start') {
    if (newRun) metrics.runs.started += 1;
    metrics.steps.started += 1;
  } else if (event.type === 'assistant.message' && typeof event.message === 'object' && event.message !== null) {
    const message = event.message as {
      usage?: { inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown };
      requestDurationMs?: unknown;
      firstTokenDurationMs?: unknown;
    };
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
      const ttft = message.firstTokenDurationMs;
      let decodeDuration = elapsed;
      if (duration(ttft) && ttft <= elapsed) {
        metrics.ttft.durationMs += ttft;
        metrics.ttft.count += 1;
        decodeDuration = elapsed - ttft;
      }
      if (decodeDuration > 0 && count(output)) {
        metrics.throughput.durationMs += decodeDuration;
        metrics.throughput.outputTokens += output;
        metrics.throughput.count += 1;
      }
    }
  } else if (event.type === 'tool.result') {
    const result = typeof event.result === 'object' && event.result !== null
      ? event.result as { durationMs?: unknown } : null;
    const elapsed = result?.durationMs;
    if (duration(elapsed)) {
      metrics.tools.count += 1;
      metrics.tools.durationMs += elapsed;
      metrics.tools.knownDurationCount += 1;
    }
  } else if (event.type === 'turn.end') {
    metrics.runs.completed += 1;
  }
}
