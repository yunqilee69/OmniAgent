import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubagentListEntry, SubagentService, SubagentStartRequest } from '../../domain/subagent';
import { snapshotDshPermissions } from '../../permissions/dsh-permissions';
import { FakeModel, textResponse } from '../../providers/fake';
import { Session } from '../../session';
import type { TeamMemberSnapshot } from '../../session/mode-selection';
import { SessionStore } from '../../session/store';
import { createTeamDelegationTool, renderTeamGuidance } from './team';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

const members: TeamMemberSnapshot[] = [{
  id: 'researcher',
  name: 'Researcher',
  agent: 'explorer',
  model: { version: 2, kind: 'agent' },
  prompt: 'Focus on primary sources.',
  tools: '*',
  skills: '*',
}];

function fakeService(entries: SubagentListEntry[] = []) {
  const starts: SubagentStartRequest[] = [];
  const service: SubagentService = {
    async start(_parent, request) {
      starts.push(request);
      return { id: `child-${starts.length}`, status: 'running' };
    },
    async send() { return { messageId: 'message-1' }; },
    async list() { return entries; },
    async wait() { return { id: 'child-1', status: 'completed' }; },
    async waitForInput() { return { timedOut: false }; },
    async interrupt() { return true; },
    canStart() { return true; },
  };
  return { service, starts };
}

const signal = () => new AbortController().signal;

describe('team delegation', () => {
  it('renders member ids and the concurrency limit for the coordinator', () => {
    const guidance = renderTeamGuidance(members, 2);
    expect(guidance).toContain('You are the coordinator, not a worker');
    expect(guidance).toContain('delegate_team_member');
    expect(guidance).toContain('"researcher"');
    expect(guidance).toContain('Researcher');
    expect(guidance).toContain('Focus on primary sources.');
    expect(guidance).toContain('At most 2 member(s) may run at once');
  });

  it('prepends member instructions and forwards the snapshot binding', async () => {
    const { service, starts } = fakeService();
    const tool = createTeamDelegationTool({ id: 'root' } as unknown as Session, service, members, 50, 2);
    const output = await tool.execute(
      { member: 'researcher', description: 'Look up facts', task: 'Do it' },
      { cwd: '/', signal: signal() },
    );
    expect(output.content).toBe('started team member researcher as child-1');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      description: 'Look up facts',
      prompt: 'Focus on primary sources.\n\nDo it',
      agent: 'explorer',
      binding: { version: 2, kind: 'agent' },
      tools: '*',
      skills: '*',
      maxSteps: 50,
    });
  });

  it('rejects delegation when every member slot is active', async () => {
    const running: SubagentListEntry[] = [{
      kind: 'child', id: 'child-1', label: 'Busy', status: 'running', parent: 'root',
    }];
    const { service } = fakeService(running);
    const tool = createTeamDelegationTool({ id: 'root' } as unknown as Session, service, members, 50, 1);
    await expect(tool.execute(
      { member: 'researcher', description: 'Look up facts', task: 'Do it' },
      { cwd: '/', signal: signal() },
    )).rejects.toThrow('Team capacity reached');
  });

  it('injects coordinator guidance and hides the generic subagent tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-team-'));
    roots.push(root);
    const handle = await new SessionStore(root).create({ id: 'root', workspace: root, cwd: root });
    const { service } = fakeService();
    const model = new FakeModel([textResponse('done')]);
    const session = new Session({
      cwd: root,
      model,
      session: handle,
      dshPermissions: snapshotDshPermissions({ status: 'ready', preset: 'workspace-write' }),
      subagents: service,
      teamMembers: members,
      teamMaxActive: 2,
    });
    for await (const _event of session.send('handle this')) { /* Drain the turn. */ }
    const request = model.requests[0]!;
    expect(request.system).toContain('You are the coordinator, not a worker');
    expect(request.system).toContain('"researcher"');
    expect(request.tools.map((tool) => tool.name)).toContain('delegate_team_member');
    expect(request.tools.map((tool) => tool.name)).not.toContain('subagent');
  });
});
