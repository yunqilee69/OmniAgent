import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog, digestArgs } from './audit';
import type { AuditEntry } from './audit';

function entry(): AuditEntry {
  return {
    ts: new Date(0).toISOString(), sessionId: 'session', step: 0, tool: 'bash', callId: 'call',
    argsDigest: digestArgs({ command: 'echo PRIVATE' }), decision: 'allow', source: 'test',
  };
}

describe('AuditLog', () => {
  it('stores a one-way digest instead of raw tool arguments', () => {
    const args = { command: 'echo API_SECRET', content: 'private payload' };
    const digest = digestArgs(args);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest).not.toContain('API_SECRET');
    expect(digest).toBe(digestArgs(args));
  });

  it('creates audit files with private permissions and records no raw arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-audit-'));
    const directory = join(root, 'private');
    const path = join(directory, 'audit.jsonl');
    try {
      const audit = new AuditLog(path);
      await audit.record(entry());
      expect((await stat(directory)).mode & 0o077).toBe(0);
      expect((await stat(path)).mode & 0o077).toBe(0);
      const text = await readFile(path, 'utf8');
      expect(text).not.toContain('PRIVATE');
      expect(JSON.parse(text).argsDigest).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves pre-existing directory and file permissions untouched while appending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-audit-existing-'));
    const directory = join(root, 'existing');
    const path = join(directory, 'audit.jsonl');
    try {
      await mkdir(directory);
      await chmod(directory, 0o755);
      await writeFile(path, '{"existing":true}\n', { mode: 0o644 });
      await chmod(path, 0o644);

      await new AuditLog(path).record(entry());

      expect((await stat(directory)).mode & 0o777).toBe(0o755);
      expect((await stat(path)).mode & 0o777).toBe(0o644);
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('{"existing":true}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to follow a symlinked audit file and preserves the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-audit-symlink-'));
    const target = join(root, 'target.jsonl');
    const path = join(root, 'audit.jsonl');
    try {
      await writeFile(target, 'keep\n');
      await symlink(target, path);
      await expect(new AuditLog(path).record(entry())).rejects.toThrow();
      expect(await readFile(target, 'utf8')).toBe('keep\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-regular audit target without blocking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-audit-fifo-'));
    const path = join(root, 'audit.fifo');
    try {
      const made = spawnSync('mkfifo', [path]);
      if (made.status !== 0) return;
      await expect(new AuditLog(path).record(entry())).rejects.toThrow();
      expect((await stat(path)).isFIFO()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 5_000);
});
