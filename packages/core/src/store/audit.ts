import { appendFile, mkdir } from 'node:fs/promises';
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

export class AuditLog {
  private initialized = false;

  constructor(private readonly filePath: string) {}

  async record(entry: AuditEntry): Promise<void> {
    if (!this.initialized) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.initialized = true;
    }
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

export function digestArgs(args: unknown, maxLength = 200): string {
  const raw = JSON.stringify(args ?? null);
  return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength)}…`;
}
