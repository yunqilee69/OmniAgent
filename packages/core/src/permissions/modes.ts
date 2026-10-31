import type { ToolCall } from '../domain/message';

/**
 * 模式与「敏感路径」的定义。
 *
 * 模式默认行为（显式规则优先）：
 * - workspace-write: 默认，已知文件读写自动放行，受保护路径和其他工具仍问
 * - default:      都问
 * - acceptEdits:  编辑类工具自动放行，shell 仍问
 * - plan:         只读，禁止修改
 * - dontAsk:      该问的一律拒（适合 CI / 无人值守）
 * - bypass:       全放行（只在一次性容器里用）
 *
 * 没做 auto（分类器）模式：它需要先有 eval harness 才能判断审得准不准。
 */

const EDIT_TOOLS = new Set(['write_file', 'edit_file']);

export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}

/** 写 `.git`、`.omniagent` 这类路径，即使在 acceptEdits 下也要问。 */
export const PROTECTED_PATH_SEGMENTS = ['.git', '.omniagent'];

export function touchesProtectedPath(call: ToolCall): boolean {
  const args = call.arguments;
  if (typeof args !== 'object' || args === null) {
    return false;
  }
  const path = (args as Record<string, unknown>)['path'];
  if (typeof path !== 'string') {
    return false;
  }
  const segments = path.split(/[\\/]+/);
  return PROTECTED_PATH_SEGMENTS.some((segment) => segments.includes(segment));
}
