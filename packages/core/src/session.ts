import type { Message } from './domain/message';
import { userMessage } from './domain/message';
import type { AgentEvent } from './protocol/events';
import type {
  ApprovalHandler,
  PermissionMode,
  Rule,
} from './protocol/permission';
import type { ModelClient } from './providers/types';
import type { AuditSink } from './store/audit';
import { createDefaultRegistry } from './tools';
import type { ToolRegistry } from './tools';
import { RuleBasedGate } from './permissions/gate';
import { AgentLoop, DEFAULT_MAX_STEPS } from './loop/agent-loop';

/**
 * 组合根（composition root）。
 *
 * 全项目只有这里知道「怎么把零件拼起来」：模型 + 工具 + 权限 + 循环 + 审计。
 * 其他模块互相之间只认接口，不认具体实现。以后加沙盒、加 skills、
 * 加 compaction，都是在这里换零件，而不是去改循环。
 */

export const DEFAULT_SYSTEM_PROMPT = `你是一个运行在用户本机的个人智能体。

工作方式：
- 需要了解文件时先列目录或读取，不要凭空猜测内容。
- 修改文件用 write_file，写入前先读一遍确认当前内容。
- 每次工具调用都会经过权限检查，被拒绝时不要重复同样的调用，换一种做法或直接说明。
- 回答保持简洁，说明你做了什么、结果如何。`;

export interface SessionOptions {
  cwd: string;
  model: ModelClient;
  modelId?: string;
  system?: string;
  mode?: PermissionMode;
  rules?: Rule[];
  /** UI 提供：渲染一次确认提示并返回结果。 */
  approve: ApprovalHandler;
  maxSteps?: number;
  sessionId?: string;
  audit?: AuditSink;
  tools?: ToolRegistry;
}

export class Session {
  readonly id: string;
  private history: Message[] = [];
  private readonly loop: AgentLoop;
  private readonly controller = new AbortController();

  constructor(options: SessionOptions) {
    this.id = options.sessionId ?? `s_${Date.now().toString(36)}`;
    this.loop = new AgentLoop({
      model: options.model,
      modelId: options.modelId ?? 'fake',
      system: options.system ?? DEFAULT_SYSTEM_PROMPT,
      tools: options.tools ?? createDefaultRegistry(),
      permissions: new RuleBasedGate({
        mode: options.mode ?? 'default',
        rules: options.rules ?? [],
        cwd: options.cwd,
        approve: options.approve,
      }),
      cwd: options.cwd,
      sessionId: this.id,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      ...(options.audit ? { audit: options.audit } : {}),
    });
  }

  get messages(): readonly Message[] {
    return this.history;
  }

  interrupt(): void {
    this.controller.abort();
  }

  /** 消费事件流即可；返回值由 core 自己维护（持久化在后续版本加）。 */
  async *send(input: string): AsyncGenerator<AgentEvent> {
    this.history.push(userMessage(input));
    const generator = this.loop.run(this.history, this.controller.signal);

    let next = await generator.next();
    while (!next.done) {
      yield next.value;
      next = await generator.next();
    }
    this.history = next.value;
  }
}
