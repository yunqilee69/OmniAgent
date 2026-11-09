import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AgentAuthoringService,
  AgentCatalog,
  ConfigStore,
  FakeModel,
  McpService,
  ModeStore,
  RuntimeResolver,
  ScheduleService,
  Session,
  SessionStore,
  SubagentManager,
  defaultConfigDir,
  listCatalogModels,
  supportedReasoningEfforts,
  textResponse,
} from '@omniagent/core';
import type { DshPermissionSnapshot, ResolvedSessionRuntime, SessionHandle } from '@omniagent/core';
import type { AgentSummary, RoleSummary } from './server';
import { readWorkspaceAudit, recordWorkspaceAudit } from './audit';
import { ApprovalBroker } from './approval';
import { RoleSettings } from './catalog-settings';
import { McpSettings } from './mcp-settings';
import { ModelSettings } from './model-settings';
import { LiveSessionRegistry } from './live-sessions';
import { PermissionSettings } from './permissions';
import { SessionScheduleHost } from './schedule-host';
import { parseWebPort, startWebHost } from './server';
import { WorkspaceRegistry } from './workspaces';

async function main(): Promise<void> {
  const configDir = defaultConfigDir();
  const permissionSettings = await PermissionSettings.open(join(configDir, 'config.json'), { trustedHome: homedir() });
  const configStore = await ConfigStore.open(join(configDir, 'config.json'));
  const roleSettings = await RoleSettings.open(join(configDir, 'config.json'), { trustedHome: homedir() });
  const modelSettings = await ModelSettings.open(join(configDir, 'config.json'), { trustedHome: homedir() });
  const mcp = new McpService({
    loadServers: async () => (await configStore.refresh()).config.mcpServers,
    log: (message) => console.error(message),
  });
  const mcpSettings = await McpSettings.open(join(configDir, 'config.json'), {
    trustedHome: homedir(),
    statuses: () => mcp.statuses(),
    onChange: () => mcp.sync(),
  });
  await mcp.sync();
  const agents = new AgentCatalog(join(configDir, 'agents'));
  const modes = new ModeStore({
    path: join(configDir, 'modes.json'),
    configStore,
    agents,
  });
  const agentAuthoring = new AgentAuthoringService({
    dir: join(configDir, 'agents'),
    catalog: agents,
    configStore,
  });
  const runtime = new RuntimeResolver({ configStore, agents });
  const store = new SessionStore(join(configDir, 'sessions'));
  const workspaces = new WorkspaceRegistry(join(configDir, 'workspaces.json'));
  const approvals = new ApprovalBroker();
  const demo = new FakeModel(
    [textResponse('当前未配置模型服务。请在 ~/.omniagent/config.json 配置 provider。')],
    { onExhausted: textResponse('当前未配置模型服务。') },
  );
  const initialConfig = configStore.snapshot.config;
  const webConfig = initialConfig.web;
  const subagents = new SubagentManager({
    store,
    createModel: () => demo,
    runtime,
    maxSteps: initialConfig.maxSteps,
    ...(initialConfig.retainContextTokens === undefined ? {} : { retainContextTokens: initialConfig.retainContextTokens }),
    audit: (entry, workspacePath) => recordWorkspaceAudit(configDir, workspacePath, entry),
    maxDepth: initialConfig.subagents?.maxDepth ?? 1,
    maxActive: initialConfig.subagents?.maxActive ?? 8,
    mcpTools: () => mcp.tools(),
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
      builtIn: agent.sourcePath.startsWith('builtin:'),
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

  const liveSessions = new LiveSessionRegistry();
  const schedules = new ScheduleService({
    file: join(configDir, 'schedules.json'),
    host: new SessionScheduleHost({
      store,
      workspaces,
      runtime,
      subagents,
      permissionSettings,
      modes,
      liveSessions,
      compose: (workspacePath, handle, permissions, resolved) =>
        composeSession(workspacePath, handle, permissions, resolved, false),
      log: (message) => console.error(message),
    }),
    log: (message) => console.error(message),
  });
  await workspaces.ensureDefault(join(configDir, 'default-workspace'));
  await workspaces.add(process.cwd());
  await schedules.open();

  /**
   * Compose one Session around an opened handle. Foreground Web turns route
   * approvals to the browser; unattended scheduled deliveries auto-deny.
   */
  function composeSession(
    workspacePath: string,
    handle: SessionHandle,
    permissions: DshPermissionSnapshot,
    resolved: ResolvedSessionRuntime,
    interactive: boolean,
  ): Session {
    const config = configStore.snapshot.config;
    return new Session({
      cwd: handle.header.cwd ?? workspacePath,
      workspace: workspacePath,
      model: resolved.model ?? demo,
      ...(resolved.modelId === undefined ? {} : { modelId: resolved.modelId }),
      agent: resolved.sessionAgent,
      modelCapabilities: resolved.capabilities,
      todoAllowParallelInProgress: resolved.todoAllowParallelInProgress,
      dshPermissions: permissions,
      maxSteps: config.maxSteps,
      ...(resolved.contextWindowTokens === undefined ? {} : { contextWindowTokens: resolved.contextWindowTokens }),
      ...(config.retainContextTokens === undefined ? {} : { retainContextTokens: config.retainContextTokens }),
      approve: interactive ? approvals.handler(workspacePath, handle.id) : async () => 'deny',
      reviewPlan: interactive
        ? approvals.planHandler(workspacePath, handle.id)
        : async () => ({ approved: false, feedback: 'Plan review is unavailable in an unattended scheduled session.' }),
      audit: (entry) => recordWorkspaceAudit(configDir, workspacePath, entry),
      session: handle,
      system: resolved.system,
      title: {
        ...(resolved.model === undefined || resolved.modelId === undefined ? {} : {
          model: resolved.model,
          modelId: resolved.modelId,
          ...(resolved.modelDescriptor?.provider === undefined ? {} : { provider: resolved.modelDescriptor.provider }),
        }),
      },
      subagents,
      mcpTools: mcp.tools(),
      schedule: schedules,
      ...(interactive && resolved.agent.id === 'creator' ? { agentAuthoring } : {}),
    });
  }

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
    modeStore: modes,
    roleSettings,
    modelSettings,
    mcpSettings,
    mcpToolNames: () => mcp.toolNames(),
    agentAuthoring,
    readAudit: (workspace, sessionId) => readWorkspaceAudit(configDir, workspace.path, sessionId),
    liveSessions,
    schedule: schedules,
    createRuntimeSession: async (workspace, handle, permissions, resolved) =>
      composeSession(workspace.path, handle, permissions, resolved, true),
    host: webConfig.host,
    auth: webConfig.auth,
  }, parseWebPort(process.env.OMNIAGENT_PORT, webConfig.port));
  console.log(`OmniAgent Web: ${host.address()}`);
  const shutdown = () => void (async () => {
    await schedules.close();
    await mcp.close();
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
