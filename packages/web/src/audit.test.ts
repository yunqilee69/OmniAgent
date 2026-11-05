import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWorkspaceAudit, recordWorkspaceAudit } from './audit';

function auditFile(configDir: string, workspace: string): string {
  const key = createHash('sha256').update(workspace, 'utf16le').digest('hex');
  return join(configDir, 'web-audit', `${key}.jsonl`);
}

const entry = {
  ts: '2026-01-01T00:00:00Z', sessionId: 'a', step: 1,
  tool: 'write_file', callId: 'c1', argsDigest: 'SECRET',
  decision: 'deny' as const, source: 'RULE_SECRET', ok: false, durationMs: 5,
};

describe('workspace audit projection', () => {
  it('reads only the selected session and omits argument digests and rule text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-audit-'));
    const workspace = join(root, 'workspace');
    await recordWorkspaceAudit(root, workspace, entry);
    await recordWorkspaceAudit(root, workspace, { ...entry, sessionId: 'b', argsDigest: 'PRIVATE' });
    const result = await readWorkspaceAudit(root, workspace, 'a');
    expect(result).toEqual([{ ts: entry.ts, sessionId: 'a', step: 1, tool: 'write_file', callId: 'c1', decision: 'deny', ok: false, durationMs: 5 }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(await readWorkspaceAudit(root, join(root, 'other'), 'a')).toEqual([]);
  });

  it('ignores workspace-local audit symlinks while writing private app-controlled logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-audit-'));
    const configDir = join(root, 'config');
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.jsonl');
    await mkdir(join(workspace, '.omniagent'), { recursive: true });
    await writeFile(outside, 'external data\n');
    await symlink(outside, join(workspace, '.omniagent', 'audit.jsonl'));

    expect(await readWorkspaceAudit(configDir, workspace, 'a')).toEqual([]);
    await recordWorkspaceAudit(configDir, workspace, entry);
    expect(await readFile(outside, 'utf8')).toBe('external data\n');
    expect((await readWorkspaceAudit(configDir, workspace, 'a'))[0]?.callId).toBe('c1');
    expect((await stat(join(configDir, 'web-audit'))).mode & 0o077).toBe(0);
    expect((await stat(auditFile(configDir, workspace))).mode & 0o077).toBe(0);
  });

  it('refuses audit file symlinks inside the app-controlled directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-audit-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.jsonl');
    await mkdir(join(root, 'web-audit'));
    await writeFile(outside, 'external data\n');
    await symlink(outside, auditFile(root, workspace));

    await expect(recordWorkspaceAudit(root, workspace, entry)).rejects.toThrow();
    await expect(readWorkspaceAudit(root, workspace, 'a')).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('external data\n');
  });

  it('refuses a symlink in place of the app-controlled audit directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-audit-'));
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'web-audit'));

    await expect(recordWorkspaceAudit(root, '/workspace', entry)).rejects.toThrow();
    await expect(readWorkspaceAudit(root, '/workspace', 'a')).rejects.toThrow();
  });

  it('rejects a non-regular app-controlled audit target without blocking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-audit-'));
    const workspace = join(root, 'workspace');
    await mkdir(join(root, 'web-audit'));
    const made = spawnSync('mkfifo', [auditFile(root, workspace)]);
    if (made.status !== 0) return;
    await expect(recordWorkspaceAudit(root, workspace, entry)).rejects.toThrow();
    await expect(readWorkspaceAudit(root, workspace, 'a')).rejects.toThrow();
  }, 5_000);

  it('returns an empty list when no audit log exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-audit-'));
    expect(await readWorkspaceAudit(root, '/workspace', 'missing')).toEqual([]);
  });
});
