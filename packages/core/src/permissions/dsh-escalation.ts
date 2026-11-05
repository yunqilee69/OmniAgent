import { DSH_PRESET_BUNDLES, isDshPermissionPreset } from './dsh-permissions';
import type { DshPermissionSnapshot, DshSandboxMode } from './dsh-permissions';

export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface DshEscalationApprovalRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly target: DshSandboxMode;
  readonly justification: string;
}

export interface DshEscalationRequest {
  readonly snapshot: DshPermissionSnapshot;
  readonly callId: string;
  readonly toolName: string;
  readonly target?: string;
  readonly justification?: string;
  readonly signal?: AbortSignal;
}

export type DshEscalationApprover = (
  request: DshEscalationApprovalRequest,
  signal: AbortSignal | undefined,
) => Promise<DshApprovalOutcome>;

export type DshEscalationErrorCode =
  | 'invalid-snapshot'
  | 'invalid-request'
  | 'not-wider'
  | 'rejected'
  | 'cancelled'
  | 'unavailable';

export class DshEscalationError extends Error {
  constructor(readonly code: DshEscalationErrorCode) {
    super(`DSH escalation ${code}`);
    this.name = 'DshEscalationError';
  }
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DshEscalationError('cancelled');
}

function validSnapshot(snapshot: DshPermissionSnapshot): boolean {
  if (typeof snapshot !== 'object' || snapshot === null || !isDshPermissionPreset(snapshot.preset)) return false;
  const bundle = DSH_PRESET_BUNDLES[snapshot.preset];
  return snapshot.sandbox === bundle.sandbox && snapshot.approval === bundle.approval;
}

async function ask(
  approve: DshEscalationApprover,
  request: DshEscalationApprovalRequest,
  signal: AbortSignal | undefined,
): Promise<DshApprovalOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: DshApprovalOutcome) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    try {
      Promise.resolve(approve(request, signal)).then(finish, () => finish('unavailable'));
    } catch {
      finish('unavailable');
    }
  });
}

/**
 * Run exactly one operation under a per-call approved mode. This does not change
 * the session preset or persist a reusable grant. The caller must supply a real
 * enforcing executor and must separately enforce non-sandbox permission rules.
 */
export async function runDshEscalation<T>(
  request: DshEscalationRequest,
  approve: DshEscalationApprover | undefined,
  execute: (mode: DshSandboxMode, signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const { snapshot, target, justification, callId, toolName, signal } = request;
  cancelled(signal);
  if (!validSnapshot(snapshot)) throw new DshEscalationError('invalid-snapshot');
  const effectiveMode = snapshot.sandbox;
  if (target === undefined && justification === undefined) return execute(effectiveMode, signal);
  if (!isDshPermissionPreset(target) || typeof justification !== 'string' || !justification.trim()) {
    throw new DshEscalationError('invalid-request');
  }
  if (target === effectiveMode) return execute(effectiveMode, signal);
  const wider = effectiveMode === 'read-only'
    ? target === 'workspace-write' || target === 'danger-full-access'
    : effectiveMode === 'workspace-write' && target === 'danger-full-access';
  if (!wider) throw new DshEscalationError('not-wider');
  if (typeof callId !== 'string' || !callId.trim() || typeof toolName !== 'string' || !toolName.trim()) {
    throw new DshEscalationError('invalid-request');
  }
  if (typeof approve !== 'function') throw new DshEscalationError('unavailable');
  const outcome = await ask(approve, Object.freeze({ callId, toolName, target, justification }), signal);
  cancelled(signal);
  if (outcome !== 'allowed-once') {
    throw new DshEscalationError(outcome === 'rejected' || outcome === 'cancelled' ? outcome : 'unavailable');
  }
  return execute(target, signal);
}
