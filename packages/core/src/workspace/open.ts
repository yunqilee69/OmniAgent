import { identifyWorkspace } from './id';
import { ensureWorkspaceConfig } from './config';
import type { WorkspaceConfig } from './config';
import { workspaceLayout } from './layout';
import type { WorkspaceLayout } from './layout';

/**
 * 打开一个工作区：解析根目录，算出它在 ~/.omniagent 里的位置，
 * 没有 workspace.json 就写一份。已有的配置不会被覆盖。
 */

export interface OpenedWorkspace {
  root: string;
  key: string;
  layout: WorkspaceLayout;
  config: WorkspaceConfig;
}

export async function openWorkspace(cwd: string, home: string): Promise<OpenedWorkspace> {
  const id = identifyWorkspace(cwd);
  const layout = workspaceLayout(home, id);
  const config = await ensureWorkspaceConfig(layout.configPath, id.root);
  return { root: id.root, key: id.key, layout, config };
}
