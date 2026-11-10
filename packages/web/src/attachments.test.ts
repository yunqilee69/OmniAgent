import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { readFileTool } from '../../core/src/tools/builtin/read-file';
import { writeFileTool } from '../../core/src/tools/builtin/write-file';
import { executeDshShell } from '../../core/src/tools/builtin/dsh-shell';
import { probeDshSandbox } from '../../core/src/sandbox/dsh-sandbox';
import { projectImageInput } from '../../core/src/context/image-input';
import { parseSendAttachments, storeAttachments } from './attachments';

const file = (name: string, data = Buffer.from('payload').toString('base64')) => ({
  kind: 'file', name, mimeType: 'application/octet-stream', data,
});
const pathOf = (parts: Awaited<ReturnType<typeof storeAttachments>>['parts']) => {
  const part = parts[0]!;
  if (part.type !== 'text') throw new Error('expected text');
  return JSON.parse(part.text.match(/: ("[^\"]+")\./)![1]!) as string;
};
const signal = new AbortController().signal;

describe('attachment storage', () => {
  it('keeps files outside Git and a nested cwd, readable by read_file and across forks', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'attachments-')));
    await mkdir(join(root, 'sub'));
    execFileSync('git', ['init', '-q', root]);
    const input = parseSendAttachments([file('../../target'), file('../../target')]);
    const [first, second] = await Promise.all([storeAttachments(root, join(root, 'sub'), input), storeAttachments(root, root, input)]);
    const firstPath = pathOf(first.parts);
    const secondPath = pathOf(second.parts);
    try {
      expect(isAbsolute(firstPath)).toBe(true);
      expect(relative(root, firstPath).startsWith('..')).toBe(true);
      expect(dirname(firstPath)).not.toBe(dirname(secondPath));
      expect((await stat(dirname(firstPath))).mode & 0o777).toBe(0o700);
      expect((await stat(firstPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(firstPath, 'utf8')).toBe('payload');
      expect((await readFileTool.execute({ file_path: firstPath }, { cwd: join(root, 'sub'), signal })).content).toContain('payload');
      // Forked sessions retain the same durable path even with a different cwd.
      expect((await readFileTool.execute({ file_path: firstPath }, { cwd: root, signal })).content).toContain('payload');
      await expect(writeFileTool.execute({ file_path: firstPath, content: 'overwrite' }, { cwd: root, signal })).rejects.toThrow();
      const encoded = Buffer.from('hello').toString('base64');
      const image = await storeAttachments(root, root, parseSendAttachments([{ kind: 'image', name: 'a.png', mimeType: 'image/png', data: encoded }]));
      try {
        expect(image.parts[1]).toMatchObject({ type: 'image', filePath: pathOf(image.parts) });
        expect(await readFile(pathOf(image.parts), 'utf8')).toBe('hello');
      } finally { await image.finish(false); }
      execFileSync('git', ['-C', root, 'add', '-A']);
      expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    } finally {
      await first.finish(false);
      await second.finish(false);
      await rm(root, { recursive: true, force: true });
    }
    await expect(readFile(firstPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects symlink and hardlink substitutions on the read exception', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'attachments-')));
    const stored = await storeAttachments(root, root, parseSendAttachments([file('data')]));
    const path = pathOf(stored.parts);
    const victim = join(dirname(path), 'victim');
    try {
      await writeFile(victim, 'secret');
      await rm(path);
      await symlink(victim, path);
      await expect(readFileTool.execute({ file_path: path }, { cwd: root, signal })).rejects.toThrow();
      await rm(path);
      await link(victim, path);
      await chmod(victim, 0o600);
      await expect(readFileTool.execute({ file_path: path }, { cwd: root, signal })).rejects.toThrow();
      await expect(readFileTool.execute({ file_path: join(dirname(root), 'outside-secret') }, { cwd: root, signal })).rejects.toThrow(/越出工作区/);
    } finally { await rm(victim, { force: true }); await stored.finish(false); await rm(root, { recursive: true, force: true }); }
  });

  it('makes the persisted absolute path visible to a confined shell when available', async (context) => {
    if (!probeDshSandbox().selected) { context.skip(); return; }
    const root = await realpath(await mkdtemp(join(tmpdir(), 'attachments-')));
    const stored = await storeAttachments(root, root, parseSendAttachments([file('shell')]));
    const path = pathOf(stored.parts);
    try {
      const result = await executeDshShell({ command: 'test "$(<"$1")" = payload', shellArgs: ['attachment-test', path], cwd: root, policy: { mode: 'workspace-write', workspaceRoot: root } });
      expect(result.exitCode).toBe(0);
    } finally { await stored.finish(false); await rm(root, { recursive: true, force: true }); }
  });

  it.runIf(process.platform === 'linux' && process.env.OMNI_TEST_LANDLOCK === '1')('keeps attachments outside Landlock temp grants and denies shell writes', async () => {
    const workspace = await realpath(await mkdtemp('/tmp/attachments-landlock-'));
    const launcher = join(workspace, 'landlock-run');
    const source = fileURLToPath(new URL('../../core/native/linux/landlock-run.c', import.meta.url));
    let stored: Awaited<ReturnType<typeof storeAttachments>> | undefined;
    vi.stubEnv('TMPDIR', '/var/tmp');
    try {
      execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', launcher]);
      const sandbox = {
        platform: 'linux', landlockLauncher: launcher,
        runProbe: (argv: readonly string[], timeoutMs: number) => {
          if (argv[0] === '/usr/bin/bwrap') return { status: 1, stdout: '' };
          const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: timeoutMs });
          return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
        },
      };
      expect(probeDshSandbox(sandbox).selected).toBe('landlock');
      stored = await storeAttachments(workspace, workspace, parseSendAttachments([file('shell')]));
      const path = pathOf(stored.parts);
      expect(relative(await realpath('/var/tmp'), path).startsWith('..')).toBe(true);
      const result = await executeDshShell({
        command: 'test "$(<"$1")" = payload || exit 2; if printf changed > "$1"; then exit 3; fi',
        shellArgs: ['attachment-test', path], cwd: workspace,
        policy: { mode: 'workspace-write', workspaceRoot: workspace }, sandbox,
      });
      expect(result.backend).toBe('landlock');
      expect(result.exitCode, result.stderr).toBe(0);
      expect(await readFile(path, 'utf8')).toBe('payload');
    } finally {
      await stored?.finish(false);
      vi.unstubAllEnvs();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('does not store uploads inside a home directory workspace', async () => {
    const home = await realpath(homedir());
    const stored = await storeAttachments(home, home, parseSendAttachments([file('home')]));
    const path = pathOf(stored.parts);
    try {
      expect(relative(home, path).startsWith('..')).toBe(true);
      expect((await readFileTool.execute({ file_path: path }, { cwd: home, signal })).content).toContain('payload');
    } finally { await stored.finish(false); }
  });

  it('refuses an upload when the only external fallback is a writable temporary root', async () => {
    vi.stubEnv('TMPDIR', '/var/tmp');
    try {
      const home = await realpath(homedir());
      await expect(storeAttachments(home, home, parseSendAttachments([file('home')]))).rejects.toThrow(/No safe attachment storage/);
    } finally { vi.unstubAllEnvs(); }
  });

  it('fails closed if no external storage can exist', async () => {
    await expect(storeAttachments('/', '/', parseSendAttachments([file('root')]))).rejects.toThrow(/No safe attachment storage/);
  });

  it('enforces canonical base64, decoded limits, and total limits', () => {
    for (const data of ['A', 'AAA', 'AB==', 'AAB=', 'AA=', 'AA== ', 'AA-_', 'AA=A', '=AAA', 'AAAA====', 'AA\nA', 'ＡAAA']) {
      expect(() => parseSendAttachments([file('x', data)]), data).toThrow('Invalid base64 attachment');
    }
    expect(parseSendAttachments([file('empty', '')])[0]!.bytes.length).toBe(0);
    expect(() => parseSendAttachments([{ kind: 'image', name: 'empty.png', mimeType: 'image/png', data: '' }])).toThrow('Invalid base64 attachment');
    expect(() => parseSendAttachments([file('x', Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'))])).toThrow('Invalid base64 attachment');
    const data = Buffer.alloc(8 * 1024 * 1024).toString('base64');
    expect(parseSendAttachments([file('a', data)])[0]!.bytes.length).toBe(8 * 1024 * 1024);
    expect(parseSendAttachments([{ kind: 'image', name: 'a.png', mimeType: 'image/png', data }])[0]!.bytes.length).toBe(8 * 1024 * 1024);
    expect(parseSendAttachments([file('a', Buffer.alloc(4 * 1024 * 1024).toString('base64'))])[0]!.bytes.length).toBe(4 * 1024 * 1024);
    expect(parseSendAttachments([file('a', data), file('b', data), file('c', data)])).toHaveLength(3);
    expect(() => parseSendAttachments([file('x', `${data.slice(0, -1)}!`)])).toThrow('Invalid base64 attachment');
    expect(() => parseSendAttachments([file('a', data), file('b', data), file('c', data), file('d', 'AA==')])).toThrow('Attachments exceed the total size limit');
  });

  it('describes stored image paths according to whether they are absolute', () => {
    for (const [path, label] of [['/var/tmp/image.png', 'absolute'], ['.images/image.png', 'relative to cwd']]) {
      const [message] = projectImageInput([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'YQ==', filePath: path }] }], false);
      expect(message).toMatchObject({ role: 'user', content: [{ type: 'text', text: expect.stringContaining(`Path (${label}): "${path}"`) }] });
    }
  });
});
