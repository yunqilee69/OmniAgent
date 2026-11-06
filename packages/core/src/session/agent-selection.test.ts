import { describe, expect, it } from 'vitest';
import {
  createAgentSelectionEvent,
  createAgentSwitch,
  projectAgentSelection,
  usageAllowsRoot,
  usageAllowsSubagent,
} from './agent-selection';

describe('agent selection events', () => {
  it('projects selected, legacy, and invalid sessions without defaulting', () => {
    expect(projectAgentSelection([])).toEqual({ status: 'legacy', agent: null });
    expect(projectAgentSelection([createAgentSelectionEvent('explorer')]))
      .toEqual({ status: 'selected', agent: 'explorer' });
    expect(projectAgentSelection([
      createAgentSelectionEvent('explorer'),
      { type: 'agent/selected', data: { version: 2, agent: 'writer' } },
    ])).toEqual({ status: 'invalid', agent: null });
  });

  it('persists a switch only when the agent changes', () => {
    const projection = projectAgentSelection([createAgentSelectionEvent('explorer')]);
    expect(createAgentSwitch(projection, { version: 1, agent: 'explorer' })).toBeUndefined();
    expect(createAgentSwitch(projection, { version: 1, agent: 'writer' })).toEqual({
      type: 'agent/selected',
      data: { version: 1, agent: 'writer' },
    });
  });

  it('separates root and subagent usage', () => {
    expect(usageAllowsRoot('primary')).toBe(true);
    expect(usageAllowsRoot('both')).toBe(true);
    expect(usageAllowsRoot('subagent')).toBe(false);
    expect(usageAllowsSubagent('subagent')).toBe(true);
    expect(usageAllowsSubagent('both')).toBe(true);
    expect(usageAllowsSubagent('primary')).toBe(false);
  });
});
