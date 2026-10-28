import { join } from 'node:path';
import { defaultConfigDir } from '../config/load';

/**
 * 一个工作区在用户目录里占一个文件夹，不写进项目本身。
 * 审计跟着会话走，不在工作区里汇总成一份。
 *
 * ~/.omniagent/sessions/<key>/
 *   workspace.json          这个工作区的配置（现在只有根路径）
 *   <sessionId>.jsonl       以后的会话事件，这次不创建
 *   <sessionId>.audit.jsonl 这一次会话的工具审计
 */

export interface WorkspaceLayout {
  root: string;
  key: string;
  /** ~/.omniagent/sessions/<key> */
  dir: string;
  configPath: string;
  sessionPath: (sessionId: string) => string;
  auditPath: (sessionId: string) => string;
}

export function workspaceLayout(
  home: string,
  workspace: { root: string; key: string },
): WorkspaceLayout {
  const dir = join(home, 'sessions', workspace.key);
  return {
    root: workspace.root,
    key: workspace.key,
    dir,
    configPath: join(dir, 'workspace.json'),
    sessionPath: (sessionId: string) => join(dir, `${sessionId}.jsonl`),
    auditPath: (sessionId: string) => join(dir, `${sessionId}.audit.jsonl`),
  };
}

export function defaultWorkspaceLayout(workspace: { root: string; key: string }): WorkspaceLayout {
  return workspaceLayout(defaultConfigDir(), workspace);
}
