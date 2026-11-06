const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
export const RESERVED_WIRE_FIELDS = new Set(['model', 'messages', 'stream', 'tools']);

/** Set a dotted field on a cloned request payload. Rejects prototype paths. */
export function setWireField(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || RESERVED.has(segment))) {
    throw new Error(`Unsafe reasoning wire path "${path}"`);
  }
  if (RESERVED_WIRE_FIELDS.has(segments[0]!)) {
    throw new Error(`Reasoning wire path "${path}" targets a reserved field`);
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      current[segment] = next;
      current = next;
    } else if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>;
    } else {
      throw new Error(`Reasoning wire path "${path}" crosses a non-object field`);
    }
  }
  current[segments.at(-1)!] = value;
}
