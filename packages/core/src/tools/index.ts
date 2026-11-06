import { builtinTools } from './builtin';
import { ToolRegistry } from './registry';

/**
 * 默认工具集：无状态内置工具。
 *
 * 会话相关的工具（沙盒 write_file/bash、todo_write、exit_plan_mode、subagent 组）
 * 不在默认注册表里，由 Session 这个组合根在构造时按权限预设和智能体 profile 追加。
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of builtinTools) {
    registry.register(tool);
  }
  return registry;
}

export { ToolRegistry } from './registry';
export { builtinTools } from './builtin';
export { truncateOutput, toSpec } from './tool';
export {
  MAX_OUTPUT_CHARS,
  MAX_DIRECTORY_ENTRIES,
} from './limits';
export {
  GLOB_MAX_RESULTS,
  GREP_MAX_MATCHES,
  GREP_MAX_LINE_BYTES,
} from './ripgrep';
export { resolveInside, resolveInsidePhysical } from './paths';
