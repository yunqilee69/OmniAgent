import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 审计日志：一行一个 JSON。
 *
 * 第一天就要有，理由很实际：以后调试「模型为什么老是不干活」，
 * 靠翻日志比靠猜快十倍。便宜、只增不改、可以直接 grep。
 */

export interface AuditEntry {
  ts: string;
  sessionId: string;
  step: number;
  tool: string;
  callId: string;
  /** 参数摘要，避免把整份文件内容写进日志。 */
  argsDigest: string;
  decision: 'allow' | 'ask' | 'deny';
  /** 决策来源：命中的规则文本或模式原因。 */
  source: string;
  ok?: boolean;
  durationMs?: number;
}

export type AuditSink = (entry: AuditEntry) => void | Promise<void>;

const AUDIT_DIRECTORY_MODE = 0o700;
const AUDIT_FILE_MODE = 0o600;

/**
 * New directories are private, but an existing directory is left untouched.
 * Tightening a pre-existing path would silently rewrite user state, and the
 * audit file itself is still created as 0600.
 */
async function ensureAuditDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: AUDIT_DIRECTORY_MODE });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Audit directory must be a real directory, not a symbolic link');
  }
}

export class AuditLog {
  private initialized = false;

  constructor(private readonly filePath: string) {}

  async record(entry: AuditEntry): Promise<void> {
    if (!this.initialized) {
      await ensureAuditDirectory(dirname(this.filePath));
      this.initialized = true;
    }
    // O_NOFOLLOW refuses a symlinked log; O_NONBLOCK makes a FIFO fail rather
    // than hang; the fstat check rejects any other non-regular target.
    const file = await open(
      this.filePath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      AUDIT_FILE_MODE,
    );
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Audit log path must be a regular file');
      await file.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
    } finally {
      await file.close();
    }
  }
}

export function digestArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex');
}
