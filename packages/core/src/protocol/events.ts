import type { ToolCall, ToolResult, AssistantMessage, Message } from '../domain/message';

/**
 * 对外协议层：core 与 UI 之间唯一的契约。
 *
 * TUI 现在消费它，以后换成 web / Electron 也消费同一套。
 * 这一层一旦定下来，UI 就是可替换的，所以事件要「足够描述 UI 需要画什么」，
 * 而不是「足够描述内部实现怎么想」。
 */

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'max_steps'
  | 'interrupted'
  | 'error';

export interface AgentError {
  message: string;
  code?: string;
  retryable?: boolean;
}

export type AgentEvent =
  | { type: 'turn.start'; step: number }
  /** 流式文本增量。拼接起来等于随后 assistant.message 的文本内容。 */
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; message: AssistantMessage }
  | { type: 'tool.call'; call: ToolCall }
  | { type: 'permission.decided'; callId: string; decision: 'allow' | 'deny'; source: string }
  | { type: 'tool.result'; result: ToolResult }
  | { type: 'context.compacted'; beforeTokens: number; afterTokens: number }
  | { type: 'turn.end'; reason: StopReason }
  | { type: 'error'; error: AgentError };

export type AgentEventHandler = (event: AgentEvent) => void;

/**
 * UI 发给 core 的指令。M1 只有中断会用到（通过 AbortSignal），
 * 权限应答目前走注入的 approve 回调，等做成常驻 daemon 时再统一到这条通道。
 */
export type AgentCommand =
  | { type: 'user.message'; text: string }
  | { type: 'permission.respond'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'interrupt' };

export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'turn.end' || event.type === 'error';
}

export type { Message };
