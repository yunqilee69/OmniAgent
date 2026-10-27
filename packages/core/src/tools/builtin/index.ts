import type { Tool } from '../../domain/tool';
import { listDirTool } from './list-dir';
import { readFileTool } from './read-file';
import { writeFileTool } from './write-file';

/** M1 的内置工具集。shell 工具会在沙盒那一层一起加，不单独裸奔。 */
export const builtinTools: Tool[] = [readFileTool, writeFileTool, listDirTool];
