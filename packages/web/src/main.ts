import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AgentCatalog,
  ConfigStore,
  FakeModel,
  RuntimeResolver,
  Session,
  SessionStore,
  SubagentManager,
  defaultConfigDir,
  listCatalogModels,
  supportedReasoningEfforts,
  textResponse,
} from '@omniagent/core';
import type { AgentSummary, RoleSummary } from './server';
import { readWorkspaceAudit, recordWorkspaceAudit } from './audit';
import { ApprovalBroker } from './approval';
import { PermissionSettings } from './permissions';
import { startWebHost } from './server';
import { WorkspaceRegistry } from './workspaces';

async function main(): Promise<void> {
  const configDir = defaultConfigDir();
  const permissionSettings = await PermissionSettings.open(join(configDir, 'config.json'), { trustedHome: homedir() });
  const configStore = await ConfigStore.open(join(configDir, 'config.json'));
  const agents = new AgentCatalog(join(configDir, 'agents'));
  const runtime = new RuntimeResolver({ configStore, agents });
  const store = new SessionStore(join(configDir, 'sessions'));
  const workspaces = new WorkspaceRegistry(join(configDir, 'workspaces.json'));
  const approvals = new ApprovalBroker();
  const demo = new FakeModel(
    [textResponse('当前未配置模型服务。请在 ~/.omniagent/config.json 配置 provider。')],
    { onExhausted: textResponse('当前未配置模型服务。') },
  );
  const initialConfig = configStore.snapshot.config;
  const subagents = new SubagentManager({
    store,
    createModel: () => demo,
    runtime,
    maxSteps: initialConfig.maxSteps,
    ...(initialConfig.retainContextTokens === undefined ? {} : { retainContextTokens: initialConfig.retainContextTokens }),
    audit: (entry, workspacePath) => recordWorkspaceAudit(configDir, workspacePath, entry),
    maxDepth: initialConfig.subagents?.maxDepth ?? 1,
    maxActive: initialConfig.subagents?.maxActive ?? 8,
  });

  async function listAgents(): Promise<AgentSummary[]> {
    const snapshot = await configStore.refresh();
    const catalog = await agents.refresh(snapshot.catalog);
    const valid: AgentSummary[] = catalog.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      role: agent.role,
      usage: agent.usage,
      profile: agent.profile,
      valid: true,
      warnings: [],
    }));
    const invalid: AgentSummary[] = catalog.errors.map((error) => ({
      id: error.id,
      name: error.id,
      description: '',
      role: '',
      usage: 'both',
      profile: '',
      valid: false,
      warnings: [error.error],
    }));
    return [...valid, ...invalid].sort((left, right) => left.id.localeCompare(right.id));
  }

  async function listRoles(): Promise<RoleSummary[]> {
    const snapshot = await configStore.refresh();
    return [...snapshot.catalog.roles.values()]
      .map((role) => ({
        id: role.id,
        name: role.name,
        provider: role.provider,
        model: role.model,
        ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort }),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  await workspaces.add(process.cwd());
  const host = await startWebHost({
    workspaces,
    store,
    permissionSettings,
    approvalBroker: approvals,
    runtime,
    modelCatalog: async () => {
      const snapshot = await configStore.refresh();
      return listCatalogModels(snapshot.catalog).map((model) => ({
        provider: model.provider,
        model: model.id,
        name: model.name,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        capabilities: model.capabilities,
        reasoningEfforts: supportedReasoningEfforts(model),
        ...(model.reasoning?.default === undefined ? {} : { defaultReasoningEffort: model.reasoning.default }),
      }));
    },
    listAgents,
    listRoles,
    readAudit: (workspace, sessionId) => readWorkspaceAudit(configDir, workspace.path, sessionId),
    createRuntimeSession: async (workspace, handle, permissions, resolved) => {
      const config = configStore.snapshot.config;
      return new Session({
        cwd: workspace.path,
        workspace: workspace.path,
        model: resolved.model ?? demo,
        ...(resolved.modelId === undefined ? {} : { modelId: resolved.modelId }),
        agent: resolved.sessionAgent,
        modelCapabilities: resolved.capabilities,
        dshPermissions: permissions,
        maxSteps: config.maxSteps,
        ...(resolved.contextWindowTokens === undefined ? {} : { contextWindowTokens: resolved.contextWindowTokens }),
        ...(config.retainContextTokens === undefined ? {} : { retainContextTokens: config.retainContextTokens }),
        approve: approvals.handler(workspace.path, handle.id),
        reviewPlan: approvals.planHandler(workspace.path, handle.id),
        audit: (entry) => recordWorkspaceAudit(configDir, workspace.path, entry),
        session: handle,
        system: resolved.system,
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
