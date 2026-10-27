import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '../domain/message';

/**
 * 会话记录持久化。
 *
 * M1 只做「整份 messages 存成 JSON」——够用，而且让你能一眼看到上下文里到底有什么。
 * 等到上下文变长、要做 compaction 和断点续跑时，这里会换成 append-only 的事件日志，
 * 那时候「状态是数据」这个设计就开始付利息了。
 */
export class TranscriptStore {
  constructor(private readonly dir: string) {}

  private pathFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  async save(sessionId: string, messages: Message[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(sessionId), JSON.stringify(messages, null, 2), 'utf8');
  }

  async load(sessionId: string): Promise<Message[] | undefined> {
    try {
      const raw = await readFile(this.pathFor(sessionId), 'utf8');
      return JSON.parse(raw) as Message[];
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
