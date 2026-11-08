import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../config/store';
import { snapshotDshPermissions } from '../permissions/dsh-permissions';
import { FakeModel, textResponse, toolCallResponse } from '../providers/fake';
import { Session } from '../session';
import { AgentAuthoringService } from './authoring';
import { AgentCatalog } from './catalog';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

const CONFIG = {
  model: 'deepseek-flash',
  provider: 'deepseek-official',
  roles: { quick: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
  agentProfiles: {
    default: { tools: '*', skills: '*' },
    search: { tools: ['read_file'], skills: [] },
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-authoring-'));
  roots.push(root);
  const dir = join(root, 'agents');
  await mkdir(dir);
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(CONFIG));
  const configStore = await ConfigStore.open(configPath);
  const catalog = new AgentCatalog(dir);
  const service = new AgentAuthoringService({ dir, catalog, configStore });
  return { root, dir, catalog, service };
}

describe('creator agent authoring', () => {
  it('creates a valid definition and lists it with the built-ins', async () => {
    const { dir, service } = await fixture();
    const result = await service.write({
      id: 'writer',
      name: 'Writer',
      description: 'Writes focused code changes',
      role: 'quick',
      usage: 'primary',
      profile: 'default',
      instructions: 'You write code.',
    });
    expect(result).toEqual({ id: 'writer', path: join(dir, 'writer.md'), created: true });
    const source = await readFile(join(dir, 'writer.md'), 'utf8');
    expect(source).toContain('name: Writer');
    expect(source).toContain('role: quick');
    expect(source).toContain('You write code.');
    expect(await service.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'writer', role: 'quick', usage: 'primary', builtIn: false }),
      expect.objectContaining({ id: 'default', builtIn: true }),
      expect.objectContaining({ id: 'creator', builtIn: true }),
    ]));
  });

  it('refuses reserved, duplicate, unknown role and unknown profile definitions', async () => {
    const { service } = await fixture();
    await expect(service.write({
      id: 'default', name: 'X', description: 'X', instructions: '',
    })).rejects.toThrow(/reserved/);
    await expect(service.write({
      id: 'explorer', name: 'X', description: 'X', role: 'missing', instructions: '',
    })).rejects.toThrow(/unknown role/);
    await expect(service.write({
      id: 'explorer', name: 'X', description: 'X', profile: 'missing', instructions: '',
    })).rejects.toThrow(/unknown profile/);

    await service.write({ id: 'explorer', name: 'Explorer', description: 'Finds', instructions: 'Explore.' });
    await expect(service.write({
      id: 'explorer', name: 'Again', description: 'Again', instructions: 'Again.',
    })).rejects.toThrow(/already exists/);
    await expect(service.write({
      id: 'explorer', name: 'Again', description: 'Again', instructions: 'Again.', overwrite: true,
    })).resolves.toMatchObject({ created: false });
  });

  it('reads definitions, lists profiles, and removes custom files safely', async () => {
    const { dir, service } = await fixture();
    await service.write({ id: 'writer', name: 'Writer', description: '', instructions: 'You write code.' });

    expect(await service.listProfiles()).toEqual(['default', 'search']);
    expect(await service.read('writer')).toEqual({
      id: 'writer',
      name: 'Writer',
      description: '',
      role: 'default',
      usage: 'both',
      profile: 'default',
      builtIn: false,
      instructions: 'You write code.',
    });
    expect(await service.read('default')).toMatchObject({ id: 'default', builtIn: true, instructions: '' });
    await expect(service.read('missing')).rejects.toThrow(/unknown agent/);

    expect(await service.remove('writer')).toBe(true);
    expect(await service.remove('writer')).toBe(false);
    await expect(service.remove('default')).rejects.toThrow(/reserved/);
    await expect(readFile(join(dir, 'writer.md'))).rejects.toThrow();
  });

  it('refuses to remove a symlinked definition', async () => {
    const { root, dir, service } = await fixture();
    const outside = join(root, 'outside.md');
    await writeFile(outside, 'keep');
    await symlink(outside, join(dir, 'linked.md'));
    await expect(service.remove('linked')).rejects.toThrow(/regular file/);
    expect(await readFile(outside, 'utf8')).toBe('keep');
  });

  it('rejects a symlink target instead of following it', async () => {
    const { root, dir, service } = await fixture();
    const outside = join(root, 'outside.md');
    await writeFile(outside, 'do not touch');
    await symlink(outside, join(dir, 'linked.md'));
    await expect(service.write({
      id: 'linked', name: 'Linked', description: 'Link', instructions: 'Body', overwrite: true,
    })).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('do not touch');
  });

  it('executes the authoring tool inside a creator session', async () => {
    const { root, dir, service } = await fixture();
    const model = new FakeModel([
      toolCallResponse([{
        id: 'call-1',
        name: 'write_agent_definition',
        args: {
          id: 'reviewer',
          name: 'Reviewer',
          description: 'Reviews changes',
          role: 'quick',
          usage: 'primary',
          profile: 'default',
          instructions: 'Review carefully.',
        },
      }]),
      textResponse('done'),
    ]);
    const session = new Session({
      cwd: root,
      model,
      dshPermissions: snapshotDshPermissions({ status: 'ready', preset: 'workspace-write' }),
      agent: {
        id: 'creator', name: 'Creator', role: 'default', usage: 'primary', tools: '*', skills: '*',
      },
      agentAuthoring: service,
    });
    for await (const _event of session.send('create a reviewer')) {
      // Drain the turn so the tool call executes.
    }
    expect(await readFile(join(dir, 'reviewer.md'), 'utf8')).toContain('name: Reviewer');
  });
});
