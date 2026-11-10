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
  it('expands /init for the model while preserving the original conversation', async () => {
    const cwd = await fixture();
    const store = new SessionStore(join(cwd, 'sessions'));
    const handle = await store.create({ workspace: cwd, cwd });
    const model = new FakeModel([textResponse('done'), textResponse('continued')]);
    const session = new Session({ cwd, workspace: cwd, session: handle, model, dshPermissions: permissions });
    await events(session.send('/init focus on tests'));
    expect(model.requests[0]?.messages[0]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: expect.stringContaining('Additional user notes:\nfocus on tests') },
    ] });
    expect(session.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '/init focus on tests' }], initCommand: true });
    const reopened = await store.open(cwd, handle.id);
    const continued = new Session({ cwd, workspace: cwd, session: reopened, model, dshPermissions: permissions });
    await events(continued.send('continue'));
    expect(model.requests[1]?.messages[0]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: expect.stringContaining('Additional user notes:\nfocus on tests') },
    ] });
    await reopened.close();
    await handle.close();
  });
  it('reloads workspace instructions for each request in a cached session', async () => {
    const cwd = await fixture();
    const model = new FakeModel([textResponse('first'), textResponse('second')]);
    const session = new Session({ cwd, workspace: cwd, model, dshPermissions: permissions });
    await writeFile(join(cwd, 'AGENTS.md'), 'First rule');
    await events(session.send('first'));
    await writeFile(join(cwd, 'AGENTS.md'), 'Updated rule');
    await events(session.send('second'));
    expect(model.requests[0]?.system).toContain('First rule');
    expect(model.requests[1]?.system).toContain('Updated rule');
    expect(model.requests[1]?.system).not.toContain('First rule');
  });

  it('does not interpret external notices as init commands', async () => {
    const cwd = await fixture();
    const store = new SessionStore(join(cwd, 'sessions'));
    const handle = await store.create({ workspace: cwd, cwd });
    await handle.append({ type: 'message/notice', data: { text: '/init', source: 'agent' } });
    const model = new FakeModel([textResponse('done')]);
    const session = new Session({ cwd, workspace: cwd, session: handle, model, dshPermissions: permissions });
    await events(session.send('continue'));
    expect(model.requests[0]?.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '/init' }] });
    await handle.close();
  });

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

  it('projects image history for text models and restores images when switching models', async () => {
    const cwd = await fixture();
    const store = new SessionStore(join(cwd, 'sessions'));
    const handle = await store.create({ workspace: cwd, cwd });
    const image = { type: 'image' as const, mediaType: 'image/png', data: 'secret-base64', fileName: 'photo.png', filePath: '.images/photo.png' };
    const legacy = { type: 'image' as const, mediaType: 'image/png', data: 'legacy-base64' };
    await handle.append({ type: 'message/user', data: { content: [image, legacy] } });
    const model = new FakeModel([textResponse('done')]);
    const session = new Session({ cwd, workspace: cwd, session: handle, model,
      modelCapabilities: { imageInput: false }, dshPermissions: permissions });
    await events(session.send([image, { type: 'text', text: 'look' }]));
    const request = model.requests[0]!;
    expect(request.messages[0]).toEqual({ role: 'user', content: [
      { type: 'text', text: '[Image unavailable to this model. Name: "photo.png". Path (relative to cwd): ".images/photo.png".]' },
      { type: 'text', text: '[Image unavailable to this model. No stored file path is available.]' },
    ] });
    expect(request.messages[1]).toMatchObject({ role: 'user', content: [
      { type: 'text', text: expect.stringContaining('.images/photo.png') }, { type: 'text', text: 'look' },
    ] });
    expect(JSON.stringify(request.messages)).not.toContain('base64');
    expect(session.messages[0]).toEqual({ role: 'user', content: [image, legacy] });
    expect(session.messages[1]).toEqual({ role: 'user', content: [image, { type: 'text', text: 'look' }] });

    const visionModel = new FakeModel([textResponse('seen')]);
    const reopened = await store.open(cwd, handle.id);
    const vision = new Session({ cwd, workspace: cwd, session: reopened, model: visionModel,
      modelCapabilities: { imageInput: true }, dshPermissions: permissions });
    await events(vision.send('continue'));
    expect(visionModel.requests[0]?.messages[0]).toEqual({ role: 'user', content: [image, legacy] });
    expect(visionModel.requests[0]?.messages[1]).toEqual({ role: 'user', content: [image, { type: 'text', text: 'look' }] });
  });

  it('projects an in-flight human steer and retains it in session history', async () => {
    const cwd = await fixture();
    const handle = await new SessionStore(join(cwd, 'sessions')).create({ workspace: cwd, cwd });
    const model = new FakeModel([
      toolCallResponse([{ name: 'unknown', args: {} }]), textResponse('done'),
    ]);
    const session = new Session({ cwd, session: handle, model, modelCapabilities: { imageInput: false }, dshPermissions: permissions });
    const image = { type: 'image' as const, mediaType: 'image/png', data: 'steer-secret',
      fileName: 'steer.png', filePath: '.images/steer.png' };
    for await (const event of session.send('start')) {
      if (event.type === 'tool.call') await session.deliverUserMessage([image]);
    }
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: 'user', content: [
      { type: 'text', text: expect.stringContaining('.images/steer.png') },
    ] });
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain('steer-secret');
    expect(session.messages).toContainEqual({ role: 'user', content: [image] });
    const reopened = await new SessionStore(join(cwd, 'sessions')).open(cwd, handle.id);
    expect(new Session({ cwd, session: reopened, model }).messages).toContainEqual({ role: 'user', content: [image] });
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
