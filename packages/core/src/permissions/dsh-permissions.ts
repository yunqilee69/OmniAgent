export const DSH_PERMISSION_PRESETS = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const);

export type DshPermissionPreset = (typeof DSH_PERMISSION_PRESETS)[number];
export type DshSandboxMode = DshPermissionPreset;
export type DshApprovalPolicy = 'ask' | 'never';

export interface DshPresetBundle {
  readonly sandbox: DshSandboxMode;
  readonly approval: DshApprovalPolicy;
}

export const DSH_PRESET_BUNDLES = Object.freeze({
  'read-only': Object.freeze({ sandbox: 'read-only', approval: 'ask' }),
  'workspace-write': Object.freeze({ sandbox: 'workspace-write', approval: 'ask' }),
  'danger-full-access': Object.freeze({ sandbox: 'danger-full-access', approval: 'never' }),
} as const satisfies Record<DshPermissionPreset, DshPresetBundle>);

export const DSH_DEFAULT_PRESET: DshPermissionPreset = 'workspace-write';
export const DSH_PERMISSION_EVENT = 'permission/dsh-preset';

/** A complete, atomic permission change, suitable for SessionHandle.append. */
export interface DshPermissionEvent {
  type: typeof DSH_PERMISSION_EVENT;
  data: { version: 1; preset: DshPermissionPreset };
}

export type DshPermissionProjection =
  | { status: 'ready'; preset: DshPermissionPreset }
  | { status: 'legacy' | 'invalid'; preset: null };

export type DshPermissionSettings =
  | { defaultPreset: DshPermissionPreset; requiresSelection: false }
  | { defaultPreset: null; requiresSelection: true };

export interface DshPermissionSnapshot extends DshPresetBundle {
  readonly preset: DshPermissionPreset;
}

export function isDshPermissionPreset(value: unknown): value is DshPermissionPreset {
  return typeof value === 'string' && (DSH_PERMISSION_PRESETS as readonly string[]).includes(value);
}

/** An absent setting uses the default; invalid values require an explicit selection. */
export function resolveDshDefaultPreset(value: unknown): DshPermissionSettings {
  if (value === undefined) return { defaultPreset: DSH_DEFAULT_PRESET, requiresSelection: false };
  return isDshPermissionPreset(value)
    ? { defaultPreset: value, requiresSelection: false }
    : { defaultPreset: null, requiresSelection: true };
}

function requirePreset(value: unknown): DshPermissionPreset {
  if (!isDshPermissionPreset(value)) throw new TypeError('Invalid DSH permission preset');
  return value;
}

/** Only use for a newly created session, never to infer permissions on restore. */
export function createInitialDshPermissionEvent(preset: unknown): DshPermissionEvent {
  return { type: DSH_PERMISSION_EVENT, data: { version: 1, preset: requirePreset(preset) } };
}

/** Fold committed events in order. Empty histories are legacy, not new sessions. */
export function projectDshPermissions(events: readonly { type: string; data: unknown }[]): DshPermissionProjection {
  let projection: DshPermissionProjection = { status: 'legacy', preset: null };
  for (const event of events) {
    if (event.type !== DSH_PERMISSION_EVENT) continue;
    const data = event.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data) ||
        Object.keys(data).length !== 2 || !Object.hasOwn(data, 'version') || !Object.hasOwn(data, 'preset')) {
      projection = { status: 'invalid', preset: null };
      continue;
    }
    const value = data as Record<string, unknown>;
    projection = value.version === 1 && isDshPermissionPreset(value.preset)
      ? { status: 'ready', preset: value.preset }
      : { status: 'invalid', preset: null };
  }
  return projection;
}

/** Call only after an explicit user selection; append before publishing the change. */
export function createDshPresetSwitch(
  projection: DshPermissionProjection,
  target: unknown,
): DshPermissionEvent | undefined {
  const preset = requirePreset(target);
  if (projection.status === 'ready' && projection.preset === preset) return undefined;
  return createInitialDshPermissionEvent(preset);
}

/** Capture once at turn admission; an unknown or legacy state cannot authorize execution. */
export function snapshotDshPermissions(projection: DshPermissionProjection): DshPermissionSnapshot {
  if (projection.status !== 'ready' || !isDshPermissionPreset(projection.preset)) {
    throw new Error('DSH permission selection is required before execution');
  }
  return Object.freeze({ preset: projection.preset, ...DSH_PRESET_BUNDLES[projection.preset] });
}
