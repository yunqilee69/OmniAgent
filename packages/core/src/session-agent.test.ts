import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModel, textResponse, toolCallResponse } from './providers/fake';
import { Session } from './session';
import { SessionStore } from './session/store';
import { snapshotDshPermissions } from './permissions/dsh-permissions';
import type { AgentEvent } from './protocol/events';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

const permissions = snapshotDshPermissions({ status: 'ready', preset: 'danger-full-access' });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'omniagent-session-agent-'));
  roots.push(cwd);
  return cwd;
}

async function events(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of stream) collected.push(event);
  return collected;
}

describe('Session agent profiles', () => {
  it('registers only allowlisted tools and rejects fabricated calls', async () => {
    const cwd = await fixture();
    const model = new FakeModel([
      toolCallResponse([{ name: 'write_file', args: { file_path: 'escape.txt', content: 'x' } }], 'try to write'),
      textResponse('done'),
    ]);
    const session = new Session({
      cwd,
      model,
      dshPermissions: permissions,
      agent: {
        id: 'reader',
        name: 'Reader',
        role: 'default',
        usage: 'both',
        tools: new Set(['read_file', 'skill']),
        skills: '*',
      },
    });
    const collected = await events(session.send('go'));
    expect(model.requests[0]!.tools.map((tool) => tool.name).sort()).toEqual(['read_file', 'skill']);
    expect(model.requests[0]!.tools.some((tool) => tool.name === 'bash' || tool.name === 'write_file')).toBe(false);
    const denied = collected.find((event) => event.type === 'tool.result' && event.result.name === 'write_file');
    expect(denied).toMatchObject({ result: { ok: false } });
    expect((denied as Extract<AgentEvent, { type: 'tool.result' }>).result.content).toMatch(/not available|trusted sandbox/i);
  });

  it('enforces the skill allowlist inside the skill tool', async () => {
    const cwd = await fixture();
    for (const name of ['allowed', 'denied']) {
      await mkdir(join(cwd, '.agents', 'skills', name), { recursive: true });
      await writeFile(join(cwd, '.agents', 'skills', name, 'SKILL.md'), `---\ndescription: ${name}\n---\n${name} body`);
    }
    const model = new FakeModel([
      toolCallResponse([{ name: 'skill', args: { name: 'denied' } }], 'denied skill'),
      toolCallResponse([{ name: 'skill', args: { name: 'allowed' } }], 'allowed skill'),
      textResponse('done'),
    ]);
    const session = new Session({
      cwd,
      model,
      dshPermissions: permissions,
      agent: {
        id: 'skilled',
        name: 'Skilled',
        role: 'default',
        usage: 'both',
        tools: new Set(['skill']),
        skills: new Set(['allowed']),
      },
    });
    const collected = await events(session.send('go'));
    const results = collected.filter((event): event is Extract<AgentEvent, { type: 'tool.result' }> => event.type === 'tool.result');
    expect(results).toHaveLength(2);
    expect(results[0]!.result).toMatchObject({ name: 'skill', ok: false });
    expect(results[0]!.result.content).toMatch(/not available to this agent/i);
    expect(results[1]!.result).toMatchObject({ name: 'skill', ok: true });
    expect(results[1]!.result.content).toContain('allowed body');
  });

  it('rejects image history when the selected model has no image capability', async () => {
    const cwd = await fixture();
    const store = new SessionStore(join(cwd, 'sessions'));
    const handle = await store.create({ workspace: cwd, cwd });
    await handle.append({
      type: 'message/user',
      data: { content: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }] },
    });
    const session = new Session({
      cwd,
      workspace: cwd,
      session: handle,
      model: new FakeModel([textResponse('should not run')]),
      modelCapabilities: { imageInput: false },
      dshPermissions: permissions,
    });
    await expect(events(session.send('look'))).rejects.toThrow(/does not support image input/i);
    expect(session.messages).toContainEqual(expect.objectContaining({ role: 'user' }));
  });

  it('requires exit_plan_mode in the profile while plan mode is active', async () => {
    const cwd = await fixture();
    const session = new Session({
      cwd,
      model: new FakeModel([textResponse('should not run')]),
      planActive: true,
      dshPermissions: permissions,
      agent: {
        id: 'planner',
        name: 'Planner',
        role: 'default',
        usage: 'both',
        tools: new Set(['read_file']),
        skills: '*',
      },
    });
    await expect(events(session.send('plan'))).rejects.toThrow(/must allow exit_plan_mode/i);
  });
});
