import { describe, expect, it } from 'vitest';
import {
  MODE_SELECTION_EVENT,
  createModeSelectionEvent,
  projectModeSelection,
} from './mode-selection';
import type { ModeSelection } from './mode-selection';

const selection: ModeSelection = {
  version: 1,
  mode: 'standard',
  agent: 'default',
  model: { version: 2, kind: 'agent' },
  tools: '*',
  skills: ['docs'],
};

describe('mode selection', () => {
  it('round-trips an immutable mode snapshot through the event projection', () => {
    const event = createModeSelectionEvent(selection);
    expect(event.type).toBe(MODE_SELECTION_EVENT);
    expect(projectModeSelection([event])).toEqual({ status: 'selected', selection });
    expect(projectModeSelection([])).toEqual({ status: 'none', selection: null });
  });

  it('uses the last valid selection event', () => {
    const first = createModeSelectionEvent({ ...selection, mode: 'first' });
    const second = createModeSelectionEvent({ ...selection, mode: 'second' });
    expect(projectModeSelection([first, second])).toMatchObject({
      status: 'selected',
      selection: { mode: 'second' },
    });
  });

  it('reports an invalid selection instead of falling back to an earlier mode', () => {
    const valid = createModeSelectionEvent(selection);
    expect(projectModeSelection([
      valid,
      { type: MODE_SELECTION_EVENT, data: { ...selection, version: 99 } },
    ])).toEqual({ status: 'invalid', selection: null });
  });

  it('rejects unknown fields or empty selectors when creating an event', () => {
    expect(() => createModeSelectionEvent({ ...selection, extra: true } as ModeSelection))
      .toThrow();
    expect(() => createModeSelectionEvent({ ...selection, agent: '' })).toThrow();
    expect(() => createModeSelectionEvent({ ...selection, tools: [''] })).toThrow();
  });

  it('keeps a resolved team snapshot immutable', () => {
    const team: ModeSelection = {
      version: 2,
      type: 'team',
      mode: 'analysis',
      agent: 'default',
      model: { version: 2, kind: 'agent' },
      tools: ['read_file'],
      skills: [],
      members: [{
        id: 'reader', name: 'Reader', agent: 'default', model: { version: 2, kind: 'agent' },
        prompt: 'Read only.', tools: ['read_file'], skills: [],
      }],
      policy: { maxActive: 2, maxDepth: 1, maxSteps: 50, failure: 'continue', allowPlan: false, allowGoal: false },
    };
    expect(projectModeSelection([createModeSelectionEvent(team)])).toEqual({ status: 'selected', selection: team });
  });
});
