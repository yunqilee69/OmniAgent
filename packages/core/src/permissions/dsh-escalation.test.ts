import { describe, expect, it, vi } from 'vitest';
import { projectDshPermissions, createInitialDshPermissionEvent, snapshotDshPermissions } from './dsh-permissions';
import type { DshPermissionPreset } from './dsh-permissions';
import { runDshEscalation } from './dsh-escalation';
import type { DshApprovalOutcome, DshEscalationRequest } from './dsh-escalation';

function snapshot(preset: DshPermissionPreset) {
  return snapshotDshPermissions(projectDshPermissions([createInitialDshPermissionEvent(preset)]));
}

function request(overrides: Partial<DshEscalationRequest> = {}): DshEscalationRequest {
  return {
    snapshot: snapshot('read-only'), callId: 'call-1', toolName: 'bash',
    target: 'workspace-write', justification: 'Write the requested file', ...overrides,
  };
}

const allow = async () => 'allowed-once' as const;

describe('DSH one-shot escalation', () => {
  it('asks with the minimum useful request and executes once under the approved target', async () => {
    const approve = vi.fn(allow);
    const execute = vi.fn(async (mode: string) => `ran:${mode}`);
    const turnSnapshot = snapshot('read-only');
    const input = { ...request({ snapshot: turnSnapshot }), secret: 'do-not-disclose' };

    await expect(runDshEscalation(input, approve, execute)).resolves.toBe('ran:workspace-write');
    expect(approve).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledWith({
      callId: 'call-1', toolName: 'bash', target: 'workspace-write', justification: 'Write the requested file',
    }, undefined);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith('workspace-write', undefined);
    expect(turnSnapshot.preset).toBe('read-only');
  });

  it('executes without approval when neither escalation field is supplied', async () => {
    const execute = vi.fn(async (mode: string) => mode);
    const approve = vi.fn(allow);
    await expect(runDshEscalation(request({ target: undefined, justification: undefined }), approve, execute))
      .resolves.toBe('read-only');
    expect(approve).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith('read-only', undefined);
  });

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)(
    'uses the existing %s mode without asking when the target is unchanged', async (mode) => {
      const approve = vi.fn(allow);
      const execute = vi.fn(async (effective: string) => effective);
      await expect(runDshEscalation(request({ snapshot: snapshot(mode), target: mode }), approve, execute))
        .resolves.toBe(mode);
      expect(approve).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { target: 'workspace-write', justification: undefined },
    { target: undefined, justification: 'orphan reason' },
    { target: 'workspace-write', justification: '' },
    { target: 'workspace-write', justification: '   ' },
    { target: 'workspace-write', justification: null },
    { target: null, justification: 'reason' },
  ])('rejects unpaired or invalid escalation arguments %j before approval or execution', async (overrides) => {
    const approve = vi.fn(allow);
    const execute = vi.fn(async () => 'ran');
    await expect(runDshEscalation(request(overrides as Partial<DshEscalationRequest>), approve, execute)).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['read-only', 'workspace-write'],
    ['read-only', 'danger-full-access'],
    ['workspace-write', 'danger-full-access'],
  ] as const)('accepts an approved wider mode from %s to %s', async (from, to) => {
    const execute = vi.fn(async (mode: string) => mode);
    await expect(runDshEscalation(request({ snapshot: snapshot(from), target: to }), allow, execute)).resolves.toBe(to);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ['workspace-write', 'read-only'],
    ['danger-full-access', 'workspace-write'],
    ['danger-full-access', 'read-only'],
    ['read-only', 'bypass'],
    ['read-only', '__proto__'],
  ] as const)('refuses a narrower or unknown target %s -> %s before asking', async (from, to) => {
    const approve = vi.fn(allow);
    const execute = vi.fn(async () => 'ran');
    await expect(runDshEscalation(request({ snapshot: snapshot(from), target: to }), approve, execute)).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'cancelled', 'unavailable', 'allow', undefined] as const)(
    'refuses non-grant approval outcome %s', async (outcome) => {
      const execute = vi.fn(async () => 'ran');
      await expect(runDshEscalation(request(), async () => outcome as DshApprovalOutcome, execute)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('fails closed when there is no approver or the approver throws', async () => {
    const execute = vi.fn(async () => 'ran');
    await expect(runDshEscalation(request(), undefined, execute)).rejects.toThrow();
    await expect(runDshEscalation(request(), async () => { throw new Error('private data'); }, execute))
      .rejects.not.toThrow('private data');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('requires a non-empty call id for an approval request (%j)', async (callId) => {
    const approve = vi.fn(allow);
    const execute = vi.fn(async () => 'ran');
    await expect(runDshEscalation(request({ callId }), approve, execute)).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires a non-empty tool name for an approval request', async () => {
    const approve = vi.fn(allow);
    const execute = vi.fn(async () => 'ran');
    await expect(runDshEscalation(request({ toolName: '  ' }), approve, execute)).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { preset: 'read-only', sandbox: 'danger-full-access', approval: 'ask' },
    { preset: 'bypass', sandbox: 'danger-full-access', approval: 'never' },
    { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'never' },
    null,
  ])('rejects invalid or mismatched snapshots %j', async (value) => {
    const approve = vi.fn(allow);
    const execute = vi.fn(async () => 'ran');
    await expect(runDshEscalation(request({ snapshot: value as never }), approve, execute)).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not reuse a prior approval for another invocation of the same call', async () => {
    const approve = vi.fn()
      .mockResolvedValueOnce('allowed-once')
      .mockResolvedValueOnce('rejected');
    const execute = vi.fn(async () => 'ran');
    await expect(runDshEscalation(request(), approve, execute)).resolves.toBe('ran');
    await expect(runDshEscalation(request(), approve, execute)).rejects.toThrow();
    expect(approve).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects a pre-aborted call without asking or executing', async () => {
    const controller = new AbortController();
    controller.abort();
    const approve = vi.fn(allow);
    const execute = vi.fn(async () => 'ran');
    await expect(runDshEscalation(request({ signal: controller.signal }), approve, execute)).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await expect(runDshEscalation(request({ target: undefined, justification: undefined, signal: controller.signal }), approve, execute))
      .rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('cancels a pending approval promptly and ignores a late grant', async () => {
    const controller = new AbortController();
    let resolveApproval!: (outcome: DshApprovalOutcome) => void;
    const approve = vi.fn(() => new Promise<DshApprovalOutcome>((resolve) => { resolveApproval = resolve; }));
    const execute = vi.fn(async () => 'ran');
    const result = runDshEscalation(request({ signal: controller.signal }), approve, execute);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ target: 'workspace-write' }), controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow();
    resolveApproval('allowed-once');
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not execute if approval aborts the signal before returning a grant', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => 'ran');
    await expect(runDshEscalation(request({ signal: controller.signal }), async () => {
      controller.abort();
      return 'allowed-once';
    }, execute)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('captures immutable request values before awaiting a decision', async () => {
    let resolveApproval!: (outcome: DshApprovalOutcome) => void;
    const approve = vi.fn(() => new Promise<DshApprovalOutcome>((resolve) => { resolveApproval = resolve; }));
    const execute = vi.fn(async (mode: string) => mode);
    const mutable = request();
    const result = runDshEscalation(mutable, approve, execute);
    Object.assign(mutable, { target: 'danger-full-access', justification: 'changed' });
    resolveApproval('allowed-once');
    await expect(result).resolves.toBe('workspace-write');
    expect(execute).toHaveBeenCalledWith('workspace-write', undefined);
  });
});
