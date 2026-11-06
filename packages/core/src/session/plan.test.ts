import { describe, expect, it, vi } from 'vitest';
import { createExitPlanModeTool, hasPlanHeading } from '../tools/builtin/exit-plan-mode';
import { PLAN_MODE_EVENT, createPlanModeEvent, projectPlanMode } from './plan';

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
});
