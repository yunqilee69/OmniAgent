import { describe, expect, it, vi } from 'vitest';
import { createExitPlanModeTool, hasPlanHeading } from '../tools/builtin/exit-plan-mode';
import {
  PERMISSION_PENDING_EVENT,
  PLAN_MODE_EVENT,
  PLAN_REVIEW_DECISION_EVENT,
  PLAN_REVIEW_PENDING_EVENT,
  createPermissionPendingEvent,
  createPlanModeEvent,
  createPlanReviewDecisionEvent,
  createPlanReviewPendingEvent,
  projectPendingPermission,
  projectPendingPlanReview,
  projectPlanMode,
} from './plan';

describe('plan mode projection', () => {
  it('uses the last well-formed value and folds malformed state to inactive', () => {
    expect(projectPlanMode([])).toEqual({ active: false });
    expect(projectPlanMode([
      { type: PLAN_MODE_EVENT, data: { active: true } },
      { type: PLAN_MODE_EVENT, data: { active: false } },
      { type: PLAN_MODE_EVENT, data: 'broken' },
    ])).toEqual({ active: false });
    expect(projectPlanMode([{ type: PLAN_MODE_EVENT, data: { active: 'yes' } }])).toEqual({ active: false });
  });

  it('creates only a strict boolean mode event', () => {
    expect(createPlanModeEvent(true)).toEqual({ type: PLAN_MODE_EVENT, data: { active: true } });
    expect(() => createPlanModeEvent('true' as never)).toThrow(TypeError);
  });
});

describe('durable review and approval waits', () => {
  const review = { requestId: 'review-1', callId: 'exit', plan: '# Plan\n\nDo it.' };

  it('keeps the newest unanswered plan and retires it once decided or answered', () => {
    expect(projectPendingPlanReview([])).toBeNull();
    expect(projectPendingPlanReview([
      { type: PLAN_REVIEW_PENDING_EVENT, data: { requestId: 'old', callId: 'old', plan: '# Old' } },
      { type: PLAN_REVIEW_PENDING_EVENT, data: review },
    ])).toEqual(review);
    expect(projectPendingPlanReview([
      { type: PLAN_REVIEW_PENDING_EVENT, data: review },
      { type: PLAN_REVIEW_DECISION_EVENT, data: { requestId: 'someone-else', callId: 'exit', approved: false } },
    ])).toEqual(review);
    expect(projectPendingPlanReview([
      { type: PLAN_REVIEW_PENDING_EVENT, data: review },
      { type: PLAN_REVIEW_DECISION_EVENT, data: { requestId: 'review-1', callId: 'exit', approved: true } },
    ])).toBeNull();
    expect(projectPendingPlanReview([
      { type: PLAN_REVIEW_PENDING_EVENT, data: review },
      { type: 'message/tool-result', data: { result: { callId: 'exit' } } },
    ])).toBeNull();
    expect(projectPendingPlanReview([{ type: PLAN_REVIEW_PENDING_EVENT, data: { requestId: '', callId: 'exit', plan: '# Plan' } }])).toBeNull();
  });

  it('rejects a review record that cannot be shown or correlated', () => {
    expect(createPlanReviewPendingEvent(review)).toEqual({ type: PLAN_REVIEW_PENDING_EVENT, data: review });
    expect(() => createPlanReviewPendingEvent({ ...review, plan: '   ' })).toThrow(TypeError);
    expect(createPlanReviewDecisionEvent({ requestId: 'review-1', callId: 'exit', approved: false, feedback: '  Add tests  ' }))
      .toEqual({ type: PLAN_REVIEW_DECISION_EVENT, data: { requestId: 'review-1', callId: 'exit', approved: false, feedback: 'Add tests' } });
    expect(() => createPlanReviewDecisionEvent({ requestId: 'review-1', callId: 'exit', approved: 'yes' as never })).toThrow(TypeError);
  });

  it('keeps an unanswered escalation as a record and retires it once the call settles', () => {
    const pending = { requestId: 'ask-1', callId: 'bash-1', name: 'bash', reason: 'Allow one call to use workspace-write: needed' };
    expect(projectPendingPermission([
      { type: PERMISSION_PENDING_EVENT, data: { ...pending, requestId: 'older' } },
      { type: PERMISSION_PENDING_EVENT, data: pending },
    ])).toEqual(pending);
    expect(projectPendingPermission([
      { type: PERMISSION_PENDING_EVENT, data: pending },
      { type: 'trace/permission.decided', data: { callId: 'bash-1', decision: 'deny' } },
    ])).toBeNull();
    expect(projectPendingPermission([
      { type: PERMISSION_PENDING_EVENT, data: pending },
      { type: 'message/tool-result', data: { result: { callId: 'bash-1' } } },
    ])).toBeNull();
    expect(createPermissionPendingEvent(pending)).toEqual({ type: PERMISSION_PENDING_EVENT, data: pending });
    expect(() => createPermissionPendingEvent({ ...pending, reason: '' })).toThrow(TypeError);
  });
});

describe('exit_plan_mode', () => {
  it('requires a level-one markdown heading so an empty acknowledgement cannot exit planning', async () => {
    expect(hasPlanHeading('# Plan\n\nDo it.')).toBe(true);
    expect(hasPlanHeading('  # Plan\n\nDo it.')).toBe(true);
    expect(hasPlanHeading('## Plan\n\nDo it.')).toBe(false);
    expect(hasPlanHeading('intro\n# Plan')).toBe(false);
    expect(hasPlanHeading('plain text')).toBe(false);
    const onApproved = vi.fn(async () => undefined);
    const review = vi.fn(async () => ({ approved: true }));
    const tool = createExitPlanModeTool({ review, onApproved });
    await expect(tool.execute({ plan: 'plain text' }, {
      callId: 'c1', cwd: '/tmp', signal: new AbortController().signal,
    } as never)).rejects.toThrow(/markdown plan/);
    expect(review).not.toHaveBeenCalled();
    expect(onApproved).not.toHaveBeenCalled();
  });

  it('exits only after approval and returns feedback when planning continues', async () => {
    const onApproved = vi.fn(async () => undefined);
    const review = vi.fn()
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ approved: false, feedback: 'Add tests' });
    const tool = createExitPlanModeTool({ review, onApproved });
    const ctx = { callId: 'c1', cwd: '/tmp', signal: new AbortController().signal } as never;

    await expect(tool.execute({ plan: '# Plan\n\nDo it.' }, ctx)).resolves.toMatchObject({
      content: expect.stringContaining('Plan approved'),
    });
    expect(onApproved).toHaveBeenCalledOnce();
    await expect(tool.execute({ plan: '# Plan\n\nDo it better.' }, ctx)).rejects.toThrow(/Add tests/);
    expect(onApproved).toHaveBeenCalledOnce();
  });

  it('stops waiting for review when the presenting turn is interrupted', async () => {
    const controller = new AbortController();
    let approveLate: ((value: { approved: boolean }) => void) | undefined;
    const onApproved = vi.fn(async () => undefined);
    const review = vi.fn(() => new Promise<{ approved: boolean }>((resolve) => {
      approveLate = resolve;
    }));
    const tool = createExitPlanModeTool({ review, onApproved });
    const running = tool.execute({ plan: '# Plan\n\nDo it.' }, {
      callId: 'c1', cwd: '/tmp', signal: controller.signal,
    } as never);
    await vi.waitFor(() => { expect(review).toHaveBeenCalledOnce(); });
    controller.abort();
    await expect(running).resolves.toEqual({
      ok: false,
      content: 'Plan review was interrupted before the user answered.',
    });
    approveLate?.({ approved: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onApproved).not.toHaveBeenCalled();
  });
});
