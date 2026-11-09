import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRegistry } from './workspaces';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ root: string; filePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-workspaces-'));
  roots.push(root);
  return { root, filePath: join(root, 'config', 'workspaces.json') };
}

async function makeWorkspace(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return path;
}

describe('WorkspaceRegistry', () => {
  it('creates and persists the default workspace while keeping cwd registered', async () => {
    const { root, filePath } = await setup();
    const defaultPath = join(root, 'config', 'default-workspace');
    const cwd = await makeWorkspace(root, 'cwd');
    const registry = new WorkspaceRegistry(filePath);
    const defaultWorkspace = await registry.ensureDefault(defaultPath);
    const cwdWorkspace = await registry.add(cwd);
    expect(defaultWorkspace).toMatchObject({ path: await realpath(defaultPath), isDefault: true });
    expect((await stat(defaultPath)).isDirectory()).toBe(true);
    expect(await new WorkspaceRegistry(filePath).ensureDefault(defaultPath)).toEqual(defaultWorkspace);
    expect(await registry.add(defaultPath)).toEqual(defaultWorkspace);
    await expect(registry.remove(defaultWorkspace.id)).rejects.toThrow(/default workspace cannot be removed/i);
    expect(await registry.remove(cwdWorkspace.id)).toBe(true);
    expect(await registry.list()).toEqual([defaultWorkspace]);
  });

  it('marks an existing canonical record as default without changing its identity or metadata', async () => {
    const { root, filePath } = await setup();
    const directory = await makeWorkspace(root, 'default-workspace');
    const alias = join(root, 'alias');
    await symlink(directory, alias, 'dir');
    const registry = new WorkspaceRegistry(filePath);
    const original = await registry.add(alias, 'Existing name');
    const marked = await registry.ensureDefault(directory);
    expect(marked).toEqual({ ...original, isDefault: true });
    expect(await registry.add(alias)).toEqual(marked);
    expect(await new WorkspaceRegistry(filePath).list()).toEqual([marked]);
  });

  it('treats a missing registry as empty without creating it', async () => {
    const { filePath } = await setup();
    const registry = new WorkspaceRegistry(filePath);

    expect(await registry.list()).toEqual([]);
    expect(await registry.get('unknown')).toBeUndefined();
    expect(await registry.touch('unknown')).toBeUndefined();
    expect(await registry.remove('unknown')).toBe(false);
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists a canonical workspace and its stable UUID across reloads', async () => {
    const { root, filePath } = await setup();
    const directory = await makeWorkspace(root, 'project');
    const registry = new WorkspaceRegistry(filePath);
    const before = Date.now();

    const added = await registry.add(relative(process.cwd(), directory), 'My project');

    expect(added).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      path: await realpath(directory),
      name: 'My project',
      lastUsedAt: expect.any(Number),
    });
    expect(added.lastUsedAt).toBeGreaterThanOrEqual(before);
    expect(added.lastUsedAt).toBeLessThanOrEqual(Date.now());
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual([added]);

    const reopened = new WorkspaceRegistry(filePath);
    expect(await reopened.list()).toEqual([added]);
    expect(await reopened.get(added.id)).toEqual(added);
  });

  it('deduplicates symbolic-link aliases without changing the existing record', async () => {
    const { root, filePath } = await setup();
    const directory = await makeWorkspace(root, 'project');
    const alias = join(root, 'alias');
    await symlink(directory, alias, 'dir');
    const registry = new WorkspaceRegistry(filePath);

    const original = await registry.add(directory, 'Original');
    const duplicate = await registry.add(alias, 'Ignored');

    expect(duplicate).toEqual(original);
    expect(await new WorkspaceRegistry(filePath).list()).toEqual([original]);
  });

  it('defaults omitted and blank names to the canonical directory basename', async () => {
    const { root, filePath } = await setup();
    const first = await makeWorkspace(root, 'first-project');
    const second = await makeWorkspace(root, 'second-project');
    const third = await makeWorkspace(root, 'third-project');
    const registry = new WorkspaceRegistry(filePath);

    expect((await registry.add(first)).name).toBe(basename(await realpath(first)));
    expect((await registry.add(second, '  \t  ')).name).toBe(basename(await realpath(second)));
    expect((await registry.add(third, '  Custom name  ')).name).toBe('  Custom name  ');
  });

  it('rejects empty, missing, and non-directory paths without registering them', async () => {
    const { root, filePath } = await setup();
    const plainFile = join(root, 'file.txt');
    await writeFile(plainFile, 'not a directory');
    const registry = new WorkspaceRegistry(filePath);

    await expect(registry.add('')).rejects.toThrow(/directory/i);
    await expect(registry.add(join(root, 'missing'))).rejects.toThrow(/missing/i);
    await expect(registry.add(plainFile)).rejects.toThrow(/directory/i);
    expect(await registry.list()).toEqual([]);
  });

  it('unregisters without removing workspace or session files', async () => {
    const { root, filePath } = await setup();
    const directory = await makeWorkspace(root, 'project');
    const sessionDirectory = join(directory, '.omniagent', 'sessions');
    await mkdir(sessionDirectory, { recursive: true });
    const sessionFile = join(sessionDirectory, 'session.jsonl');
    await writeFile(sessionFile, 'session contents');
    const registry = new WorkspaceRegistry(filePath);
    const workspace = await registry.add(directory);

    expect(await registry.remove(workspace.id)).toBe(true);
    expect(await registry.remove(workspace.id)).toBe(false);
    expect(await readFile(sessionFile, 'utf8')).toBe('session contents');
    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(await new WorkspaceRegistry(filePath).list()).toEqual([]);
  });

  it('updates and persists the last-used time only for an existing workspace', async () => {
    const { root, filePath } = await setup();
    const directory = await makeWorkspace(root, 'project');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const registry = new WorkspaceRegistry(filePath);
    const workspace = await registry.add(directory);
    clock.mockReturnValue(2_000);

    expect(await registry.touch('missing')).toBeUndefined();
    expect(await registry.touch(workspace.id)).toEqual({ ...workspace, lastUsedAt: 2_000 });
    expect(await new WorkspaceRegistry(filePath).get(workspace.id)).toEqual({ ...workspace, lastUsedAt: 2_000 });
  });

  it('returns defensive copies from add, get, list, and touch', async () => {
    const { root, filePath } = await setup();
    const directory = await makeWorkspace(root, 'project');
    const registry = new WorkspaceRegistry(filePath);
    const added = await registry.add(directory, 'Original');
    const id = added.id;
    added.name = 'Changed add';
    const fromGet = await registry.get(id);
    expect(fromGet?.name).toBe('Original');
    fromGet!.name = 'Changed get';
    const fromList = await registry.list();
    fromList[0]!.name = 'Changed list';
    fromList.push({ id: 'fake', path: 'fake', name: 'fake', lastUsedAt: 0 });
    const touched = await registry.touch(id);
    expect(touched?.name).toBe('Original');
    touched!.name = 'Changed touch';

    expect(await registry.list()).toEqual([{ id, path: await realpath(directory), name: 'Original', lastUsedAt: touched!.lastUsedAt }]);
  });

  it('serializes concurrent additions and updates across instances for the same file', async () => {
    const { root, filePath } = await setup();
    const directories = await Promise.all(Array.from({ length: 16 }, (_, index) => makeWorkspace(root, `project-${index}`)));
    const alias = join(root, 'alias');
    await symlink(directories[0]!, alias, 'dir');
    const registries = [new WorkspaceRegistry(filePath), new WorkspaceRegistry(filePath)];
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    const added = await Promise.all([
      ...directories.map((directory, index) => registries[index % 2]!.add(directory)),
      registries[1]!.add(alias),
    ]);

    expect(added[16]).toEqual(added[0]);
    expect(new Set(added.map((workspace) => workspace.id)).size).toBe(16);
    clock.mockReturnValue(2_000);
    await Promise.all(added.slice(0, 16).map((workspace, index) => registries[index % 2]!.touch(workspace.id)));
    const reloaded = await new WorkspaceRegistry(filePath).list();
    expect(reloaded).toHaveLength(16);
    expect(new Set(reloaded.map((workspace) => workspace.id))).toEqual(new Set(added.map((workspace) => workspace.id)));
    expect(reloaded.every((workspace) => workspace.lastUsedAt === 2_000)).toBe(true);
  });

  it('orders conflicting operations and continues after a rejected operation', async () => {
    const { root, filePath } = await setup();
    const directory = await makeWorkspace(root, 'project');
    const registry = new WorkspaceRegistry(filePath);
    const other = new WorkspaceRegistry(filePath);
    const [failed, added] = await Promise.allSettled([registry.add(join(root, 'missing')), other.add(directory)]);
    expect(failed.status).toBe('rejected');
    expect(added.status).toBe('fulfilled');
    if (added.status !== 'fulfilled') throw added.reason;

    const [touched, removed, missing] = await Promise.all([
      registry.touch(added.value.id),
      other.remove(added.value.id),
      registry.touch(added.value.id),
    ]);
    expect(touched?.id).toBe(added.value.id);
    expect(removed).toBe(true);
    expect(missing).toBeUndefined();
    expect(await registry.list()).toEqual([]);
  });

  it.each([
    ['invalid JSON', '{ invalid'],
    ['invalid registry shape', '{"workspaces":[]}'],
    ['invalid workspace entry', '[{"id":"id","path":1,"name":"name","lastUsedAt":0}]'],
  ])('rejects %s without overwriting it', async (_description, contents) => {
    const { root, filePath } = await setup();
    const directory = await makeWorkspace(root, 'project');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
    const registry = new WorkspaceRegistry(filePath);

    await expect(registry.list()).rejects.toThrow(/invalid.*registry/i);
    await expect(registry.add(directory)).rejects.toThrow(/invalid.*registry/i);
    expect(await readFile(filePath, 'utf8')).toBe(contents);
  });

  it('reports registry read errors instead of treating them as an empty registry', async () => {
    const { filePath } = await setup();
    await mkdir(filePath, { recursive: true });
    await expect(new WorkspaceRegistry(filePath).list()).rejects.toThrow(/registry/i);
  });

  it('preserves the old registry and removes the temporary file when rename fails', async () => {
    const { root, filePath } = await setup();
    const first = await makeWorkspace(root, 'first');
    const second = await makeWorkspace(root, 'second');
    const registry = new WorkspaceRegistry(filePath);
    const original = await registry.add(first);
    const originalContents = await readFile(filePath, 'utf8');
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated rename failure'));

    await expect(registry.add(second)).rejects.toThrow(/write.*registry.*simulated rename failure/i);
    expect(await readFile(filePath, 'utf8')).toBe(originalContents);
    expect(await readdir(dirname(filePath))).toEqual([basename(filePath)]);
    rename.mockRestore();
    const added = await registry.add(second);
    expect(await new WorkspaceRegistry(filePath).list()).toEqual([original, added]);
  });

  it('leaves valid JSON visible to readers and no temporary files after writes', async () => {
    const { root, filePath } = await setup();
    const directories = await Promise.all(Array.from({ length: 12 }, (_, index) => makeWorkspace(root, `project-${index}`)));
    const registry = new WorkspaceRegistry(filePath);
    await registry.add(directories[0]!);

    await Promise.all([
      ...directories.slice(1).map((directory) => registry.add(directory)),
      ...Array.from({ length: 100 }, async () => JSON.parse(await readFile(filePath, 'utf8'))),
    ]);

    expect(await readdir(dirname(filePath))).toEqual([basename(filePath)]);
    expect(await new WorkspaceRegistry(filePath).list()).toHaveLength(12);
  });
});
