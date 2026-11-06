import type { Tool } from '../../domain/tool';
import { editFileTool } from './edit-file';
import { globTool } from './glob';
import { grepTool } from './grep';
import { listDirTool } from './list-dir';
import { readFileTool } from './read-file';
import { skillTool } from './skill';
import { webFetchTool } from './web-fetch';
import { writeFileTool } from './write-file';

/**
 * 无状态的内置工具集。
 *
 * 这里的工具只依赖 ctx（cwd + signal），不绑定会话状态，所以可以直接共享实例。
 * 需要会话上下文的工具不在这里注册，由组合根按需构造：
 *
 * - `bash`、`write_file`、`edit_file` 的沙盒版本 → session.ts（要 DSH 权限策略）
 * - `todo_write` / `exit_plan_mode` → session.ts（要写会话事件、要审批回调）
 * - `get_goal` / `create_goal` / `update_goal` → session.ts（要读写 goal 事件与轮次状态）
 * - `subagent` 组 → session.ts（要 SubagentService）
 *
 * 文件读取、glob/grep、web_fetch 及 `list_dir` 是只读能力；`web_fetch` 带
 * 默认 SSRF 防护，并允许注入 fetch/解析器做测试。
 */
export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  grepTool,
  globTool,
  skillTool,
  webFetchTool,
];
