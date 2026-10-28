import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { identifyWorkspace } from './id';
import { openWorkspace } from './open';

describe('identifyWorkspace', () => {
  it('目录名是基名加路径哈希，符号链接和原目录是同一个工作区', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omni-ws-'));
    const link = join(tmpdir(), `omni-link-${Date.now().toString(36)}`);
    await symlink(root, link);

    const direct = identifyWorkspace(root);
    const viaLink = identifyWorkspace(link);

    expect(direct.root).toBe(root);
    expect(viaLink).toEqual(direct);
    expect(direct.key).toMatch(/-[0-9a-f]{12}$/);
  });

  it('两个不同目录不会共用一个 key', async () => {
    const left = await mkdtemp(join(tmpdir(), 'omni-a-'));
    const right = await mkdtemp(join(tmpdir(), 'omni-b-'));

    expect(identifyWorkspace(left).key).not.toBe(identifyWorkspace(right).key);
  });
});

describe('openWorkspace', () => {
  it('在 ~/.omniagent/sessions/<key>/workspace.json 登记根目录，不写进项目', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omni-proj-'));
    const home = await mkdtemp(join(tmpdir(), 'omni-home-'));

    const opened = await openWorkspace(root, home);

    expect(opened.root).toBe(root);
    expect(opened.layout.dir).toBe(join(home, 'sessions', opened.key));
    expect(opened.layout.sessionPath('s_1')).toBe(join(opened.layout.dir, 's_1.jsonl'));
    expect(opened.layout.auditPath('s_1')).toBe(join(opened.layout.dir, 's_1.audit.jsonl'));
    expect(opened.layout.auditPath('s_2')).not.toBe(opened.layout.auditPath('s_1'));
    expect(JSON.parse(await readFile(opened.layout.configPath, 'utf8'))).toEqual({ path: root });
    await expect(readFile(join(root, '.omniagent', 'workspace.json'), 'utf8')).rejects.toThrow();
  });

  it('再次打开不覆盖已经写过的配置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omni-proj-'));
    const home = await mkdtemp(join(tmpdir(), 'omni-home-'));
    const first = await openWorkspace(root, home);
    await writeFile(first.layout.configPath, `${JSON.stringify({ path: root, note: 'keep' }, null, 2)}\n`);

    const second = await openWorkspace(root, home);

    expect(second.config).toEqual({ path: root, note: 'keep' });
    expect(JSON.parse(await readFile(second.layout.configPath, 'utf8'))).toEqual({
      path: root,
      note: 'keep',
    });
  });

  it('从子目录打开时，工作区根仍是传入的 cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omni-proj-'));
    const nested = join(root, 'packages', 'core');
    await mkdir(nested, { recursive: true });
    const home = await mkdtemp(join(tmpdir(), 'omni-home-'));

    const opened = await openWorkspace(nested, home);

    expect(opened.root).toBe(nested);
    expect(opened.config.path).toBe(nested);
  });
});
