import type { ToolCall } from '../domain/message';

/** Permission decisions and approval requests shared by execution and UI. */

export const DECISIONS = ['allow', 'ask', 'deny'] as const;
export type Decision = (typeof DECISIONS)[number];

/** 一次「需要人拍板」的请求，交给 UI 渲染。 */
export interface PermissionRequest {
  id: string;
  call: ToolCall;
  /** 一句话说明为什么需要确认，直接显示给人看。 */
  reason: string;
}

/** UI 的回答。 */
export type ApprovalResponse = 'allow' | 'deny';

export type ApprovalHandler = (request: PermissionRequest) => Promise<ApprovalResponse>;

/** 执行器之前的那道门。loop 只依赖这个接口，不知道规则怎么算出来的。 */
export interface PermissionGate {
  check(call: ToolCall): Promise<{ decision: 'allow' | 'deny'; source: string }>;
}
