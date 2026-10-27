import { builtinTools } from './builtin';
import { ToolRegistry } from './registry';

/** M1 的默认工具集：内置工具 + 空注册表。沙盒工具在 M3 往这里加。 */
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
export { MAX_OUTPUT_CHARS, DEFAULT_READ_LINES } from './limits';
export { resolveInside } from './paths';
