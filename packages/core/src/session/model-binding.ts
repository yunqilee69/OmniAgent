import { z } from 'zod';
import { ReasoningEffortSchema } from '../protocol/reasoning';
import type { ReasoningEffort } from '../protocol/reasoning';
import type { ConfigCatalog, ModelDescriptor, RoleDefinition } from '../config/models';
import { findCatalogModel } from '../config/models';

export const MODEL_SELECTION_EVENT = 'model/selected';
export const MODEL_SELECTION_VERSION = 2;

const nonEmpty = z.string().trim().min(1).max(256);

/** A credential-free reference to how a session chooses its model. */
export const ModelBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ version: z.literal(MODEL_SELECTION_VERSION), kind: z.literal('agent') }),
  z.strictObject({ version: z.literal(MODEL_SELECTION_VERSION), kind: z.literal('role'), role: nonEmpty }),
  z.strictObject({
    version: z.literal(MODEL_SELECTION_VERSION),
    kind: z.literal('model'),
    provider: nonEmpty,
    model: nonEmpty,
    reasoningEffort: ReasoningEffortSchema.optional(),
  }),
]);
export type ModelBinding = z.infer<typeof ModelBindingSchema>;

export type ModelSelectionProjection =
  | { status: 'selected'; binding: ModelBinding }
  | { status: 'legacy' | 'invalid'; binding: null };

export interface ResolvedModelBinding {
  binding: ModelBinding;
  role?: RoleDefinition;
  model?: ModelDescriptor;
  reasoningEffort?: ReasoningEffort;
}

export function defaultModelBinding(): ModelBinding {
  return { version: MODEL_SELECTION_VERSION, kind: 'agent' };
}

export function createModelSelectionEvent(binding: unknown): { type: typeof MODEL_SELECTION_EVENT; data: ModelBinding } {
  return { type: MODEL_SELECTION_EVENT, data: ModelBindingSchema.parse(binding) };
}

export function projectModelSelection(
  events: readonly { type: string; data: unknown }[],
): ModelSelectionProjection {
  let projection: ModelSelectionProjection = { status: 'legacy', binding: null };
  for (const event of events) {
    if (event.type !== MODEL_SELECTION_EVENT) continue;
    const parsed = ModelBindingSchema.safeParse(event.data);
    projection = parsed.success
      ? { status: 'selected', binding: parsed.data }
      : { status: 'invalid', binding: null };
  }
  return projection;
}

export function createModelSwitch(
  projection: ModelSelectionProjection,
  target: unknown,
): { type: typeof MODEL_SELECTION_EVENT; data: ModelBinding } | undefined {
  const binding = ModelBindingSchema.parse(target);
  if (projection.status === 'selected' && JSON.stringify(projection.binding) === JSON.stringify(binding)) {
    return undefined;
  }
  return createModelSelectionEvent(binding);
}

/**
 * Resolve a persisted binding against the current config catalog.
 *
 * `kind: "agent"` follows the session agent's role. The returned model is
 * undefined only when the default role is intentionally unconfigured (demo).
 */
export function resolveModelBinding(
  catalog: ConfigCatalog,
  agentRole: string,
  binding: ModelBinding,
): ResolvedModelBinding {
  if (binding.kind === 'model') {
    const model = findCatalogModel(catalog, binding.provider, binding.model);
    if (!model) throw new Error(`Unknown model "${binding.provider}/${binding.model}"`);
    return validateReasoningEffort(binding, undefined, model);
  }

  const roleId = binding.kind === 'agent' ? agentRole : binding.role;
  const role = catalog.roles.get(roleId);
  if (!role) {
    const error = catalog.roleErrors.get(roleId);
    throw new Error(error ?? `Unknown role "${roleId}"`);
  }
  const model = findCatalogModel(catalog, role.provider, role.model);
  if (!model) throw new Error(`Unknown model "${role.provider}/${role.model}" for role "${roleId}"`);
  return validateReasoningEffort(binding, role, model);
}

function validateReasoningEffort(
  binding: ModelBinding,
  role: RoleDefinition | undefined,
  model: ModelDescriptor,
): ResolvedModelBinding {
  const explicit = binding.kind === 'model' ? binding.reasoningEffort : undefined;
  const effort = explicit ?? role?.reasoningEffort ?? model.reasoning?.default;
  if (effort !== undefined) {
    if (!model.reasoning?.efforts || !(effort in model.reasoning.efforts)) {
      throw new Error(`Model "${model.provider}/${model.id}" does not support reasoning effort "${effort}"`);
    }
  }
  return {
    binding,
    ...(role === undefined ? {} : { role }),
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
}
