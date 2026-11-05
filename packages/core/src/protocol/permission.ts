import type { ToolCall } from '../domain/message';

/**
 * 权限协议。
 *
 * 这里的类型是「决策」的公共形状，规则求值在 permissions/ 里，
 * 但决策结果会出现在事件流和审计日志里，所以放协议层。
 */

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypass',
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DECISIONS = ['allow', 'ask', 'deny'] as const;
export type Decision = (typeof DECISIONS)[number];

/** 作用域，从低到高。managed 最高且不可被覆盖。 */
export const RULE_SOURCES = [
  'cli',
  'session',
  'local',
  'project',
  'user',
  'managed',
] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

export interface Rule {
  /** 原始文本，如 "Bash(npm run *)"，用于日志和 UI 显示。 */
  raw: string;
  decision: Decision;
  source: RuleSource;
  /** 工具名，或 "*"。 */
  tool: string;
  /** 括号里的部分，语义由工具决定（命令模式 / 路径 / 域名）。 */
  specifier?: string;
  /** /path 这类相对路径规则的锚点目录。 */
  anchor: string;
}

/** 一次「需要人拍板」的请求，交给 UI 渲染。 */
export interface PermissionRequest {
  id: string;
  call: ToolCall;
  /** 一句话说明为什么需要确认，直接显示给人看。 */
  reason: string;
  matchedRule?: Rule;
}

export interface RuleBasedResult {
  decision: Decision;
  reason: string;
  rule?: Rule;
}

/** UI 的回答。M1 只有放行和拒绝；"always" 留到后面加规则。 */
export type ApprovalResponse = 'allow' | 'deny';

export type ApprovalHandler = (request: PermissionRequest) => Promise<ApprovalResponse>;

/** 执行器之前的那道门。loop 只依赖这个接口，不知道规则怎么算出来的。 */
export interface PermissionGate {
  check(call: ToolCall): Promise<{ decision: 'allow' | 'deny'; source: string }>;
}
