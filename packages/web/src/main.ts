import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SYSTEM_PROMPT, FakeModel, Session, SessionStore, SubagentManager, createConfiguredModel,
  createSelectedModel, defaultConfigDir, defaultModelSelection, discoverSkills, listConfiguredModels,
  renderSkillCatalog, resolveContextWindowTokens, textResponse,
} from '@omniagent/core';
import type { ModelClient, SessionModelSelection } from '@omniagent/core';
import { readWorkspaceAudit, recordWorkspaceAudit } from './audit';
import { ApprovalBroker } from './approval';
import { PermissionSettings } from './permissions';
import { startWebHost } from './server';
import { WorkspaceRegistry } from './workspaces';

async function main(): Promise<void> {
  const configDir = defaultConfigDir();
  const permissionSettings = await PermissionSettings.open(join(configDir, 'config.json'), { trustedHome: homedir() });
  const config = permissionSettings.configSnapshot();
  const configured = createConfiguredModel(config);
  const modelCatalog = listConfiguredModels(config);
  const initialModel = defaultModelSelection(config);
  const store = new SessionStore(join(configDir, 'sessions'));
  const workspaces = new WorkspaceRegistry(join(configDir, 'workspaces.json'));
  const approvals = new ApprovalBroker();
  const demo = new FakeModel(
    [textResponse('当前未配置模型服务。请在 ~/.omniagent/config.json 配置 provider。')],
    { onExhausted: textResponse('当前未配置模型服务。') },
  );
  const modelFor = (selection: SessionModelSelection | undefined): ModelClient =>
    selection ? createSelectedModel(config, selection) : configured ?? demo;
  const skillsFor = new Map<string, string>();
  async function skillCatalog(cwd: string): Promise<string> {
    const cached = skillsFor.get(cwd);
    if (cached !== undefined) return cached;
    let catalog: string;
    try {
      catalog = renderSkillCatalog(await discoverSkills({ workspace: cwd }));
    } catch {
      catalog = 'Skill discovery failed; do not infer a skill catalog this session.';
    }
    skillsFor.set(cwd, catalog);
    return catalog;
  }
  const subagents = new SubagentManager({
    store,
    createModel: modelFor,
    modelIdFor: (selection) => selection?.model ?? config.model,
    modelCatalog,
    defaultModelSelection: initialModel,
    systemForChild: async ({ cwd }) => [config.system ?? DEFAULT_SYSTEM_PROMPT, await skillCatalog(cwd)].filter(Boolean).join('\n\n'),
    maxSteps: config.maxSteps,
    contextWindowTokens: (selection) => resolveContextWindowTokens(config, selection),
    ...(config.retainContextTokens === undefined ? {} : { retainContextTokens: config.retainContextTokens }),
    audit: (entry, workspacePath) => recordWorkspaceAudit(configDir, workspacePath, entry),
    maxDepth: config.subagents?.maxDepth ?? 1,
    maxActive: config.subagents?.maxActive ?? 8,
  });
  await workspaces.add(process.cwd());
  const host = await startWebHost({
    workspaces,
    store,
    permissionSettings,
    approvalBroker: approvals,
    modelCatalog: () => modelCatalog,
    defaultModelSelection: () => initialModel,
    readAudit: (workspace, sessionId) => readWorkspaceAudit(configDir, workspace.path, sessionId),
    createSession: async (workspace, handle, permissions, selection) => {
      const model = modelFor(selection);
      const contextWindowTokens = resolveContextWindowTokens(config, selection);
      const system = [config.system ?? DEFAULT_SYSTEM_PROMPT, await skillCatalog(workspace.path)].filter(Boolean).join('\n\n');
      return new Session({
        cwd: workspace.path,
        workspace: workspace.path,
        model,
        modelId: selection?.model ?? config.model,
        ...(selection === undefined ? {} : { modelSelection: selection }),
        dshPermissions: permissions,
        maxSteps: config.maxSteps,
        ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        ...(config.retainContextTokens === undefined ? {} : { retainContextTokens: config.retainContextTokens }),
        approve: approvals.handler(workspace.path, handle.id),
        reviewPlan: approvals.planHandler(workspace.path, handle.id),
        audit: (entry) => recordWorkspaceAudit(configDir, workspace.path, entry),
        session: handle,
        system,
        subagents,
      });
    },
  }, Number(process.env.OMNIAGENT_PORT ?? 4317));
  console.log(`OmniAgent Web: ${host.address()}`);
  const shutdown = () => void (async () => {
    await subagents.close();
    await host.close();
    process.exit(0);
  })();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('Web 启动失败：', error);
  process.exitCode = 1;
});
