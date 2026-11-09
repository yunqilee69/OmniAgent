import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  AgentCatalog,
  AuditLog,
  ConfigStore,
  FakeModel,
  McpService,
  RuntimeResolver,
  Session,
  SessionStore,
  SubagentManager,
  createAgentSelectionEvent,
  createAgentSwitch,
  createModelSelectionEvent,
  createModelSwitch,
  createPlanModeEvent,
  defaultConfigDir,
  defaultModelBinding,
  listCatalogModels,
  projectAgentSelection,
  projectModelSelection,
  projectPlanMode,
  projectTodos,
  textResponse,
  toolCallResponse,
  usageAllowsRoot,
} from '@omniagent/core';
import type {
  AgentEvent,
  ApprovalResponse,
  ModelBinding,
  PermissionRequest,
  PlanReviewResponse,
  ResolvedSessionRuntime,
  SessionHandle,
  TodoItem,
} from '@omniagent/core';
import {
  createDshPresetSwitch, createInitialDshPermissionEvent, isDshPermissionPreset,
  projectDshPermissions, resolveDshDefaultPreset, snapshotDshPermissions,
} from '../../core/src/permissions/dsh-permissions';
import type { DshPermissionProjection, DshPermissionSettings, DshPermissionSnapshot } from '../../core/src/permissions/dsh-permissions';
import { createTheme } from './ansi';
import { GLYPH } from './blocks';
import { createRoles } from './palette';
import {
  TuiRenderer,
  renderBanner,
  renderBodyMarkdown,
  renderHelp,
  renderPrompt,
  renderStatus,
  sanitizeTerminal,
  todoMark,
} from './render';
import type { ThinkingMode } from './render';
import { describeToolCall, describeToolResult } from './tools';

const cwd = process.cwd();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const theme = createTheme();
const roles = createRoles(theme);
const renderer = new TuiRenderer({ theme });

function createDemoModel(): FakeModel {
  return new FakeModel([
    {
      ...toolCallResponse([{ name: 'list_dir', args: { path: '.' } }], '先看一下工作区里有什么。'),
      reasoning: '用户刚进入工作区。先列出目录，再读 README；每一步都应该让权限门检查。',
    },
    {
      ...toolCallResponse([{ name: 'read_file', args: { file_path: 'README.md' } }], '再看一眼 README。'),
      reasoning: '目录里 README 最可能是项目说明，读它来确认这个项目的用途。',
    },
    {
      ...textResponse('以上就是演示：模型发起了两次工具调用，每次都被权限门拦下来问过你。配置 provider 后即可接真模型。'),
      reasoning: '两次工具调用都完成了，现在把演示流程总结给用户。',
    },
  ], { onExhausted: textResponse('演示剧本已结束。配置 provider 后即可接真模型。') });
}

async function approve(request: PermissionRequest): Promise<ApprovalResponse> {
  const prompt = renderer.showPermissionRequest(request);
  let answer: string;
  try {
    answer = await rl.question(prompt);
  } catch {
    renderer.recordPermissionAnswer(false, request.call.id);
    return 'deny';
  }
  const normalized = answer.trim().toLowerCase();
  const allowed = normalized === 'y' || normalized === 'yes';
  renderer.recordPermissionAnswer(allowed, request.call.id);
  return allowed ? 'allow' : 'deny';
}

async function reviewPlan(plan: string, signal: AbortSignal): Promise<PlanReviewResponse> {
  signal.throwIfAborted();
  renderer.beforePrompt();
  renderer.print(`\n${sayIndent(roles.accentBold('计划'))}\n\n`);
  renderer.print(renderBodyMarkdown(sanitizeTerminal(plan), theme, process.stdout.columns || 100));
  renderer.print('\n');
  const answer = await rl.question(`${sayIndent(roles.accentBold('批准并退出 plan 模式？(y/N)'))} `);
  signal.throwIfAborted();
  if (answer.trim().toLowerCase() === 'y') return { approved: true };
  const feedback = (await rl.question(`${sayIndent(roles.dim('继续规划，补充意见（可空）：'))} `)).trim();
  signal.throwIfAborted();
  return { approved: false, ...(feedback ? { feedback } : {}) };
}

function printTodos(todos: readonly TodoItem[] | null): void {
  if (!todos || todos.length === 0) {
    renderer.print(`${sayIndent(roles.dim('当前没有任务清单。'))}\n`);
    return;
  }
  for (const item of todos) {
    const mark = todoMark(item.status, theme);
    const text = item.status === 'completed'
      ? roles.dim(sanitizeTerminal(item.content))
      : sanitizeTerminal(item.content);
    renderer.print(`${sayIndent(`${mark} ${text}`)}\n`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readDefaultPreset(configDir: string): Promise<DshPermissionSettings> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return resolveDshDefaultPreset(undefined);
    }
    throw error;
  }
  if (!isRecord(config)) return resolveDshDefaultPreset(null);
  if (Object.hasOwn(config, 'dsh')) {
    if (!isRecord(config.dsh)) return resolveDshDefaultPreset(null);
    if (Object.hasOwn(config.dsh, 'permission')) {
      if (!isRecord(config.dsh.permission)) return resolveDshDefaultPreset(null);
      if (Object.hasOwn(config.dsh.permission, 'defaultPreset')) {
        return resolveDshDefaultPreset(config.dsh.permission.defaultPreset ?? null);
      }
    }
  }
  return resolveDshDefaultPreset(undefined);
}

/** 命令输出沿用与正文相同的两空格缩进，保证「终端里所有内容同一列起」。 */
function sayIndent(text: string): string {
  return `${GLYPH.indent}${text}`;
}

function paintDim(text: string): string {
  return roles.dim(text);
}

function paintError(text: string): string {
  return `${roles.error(GLYPH.fail)} ${roles.error(text)}`;
}

function paintOk(text: string): string {
  return `${roles.success(GLYPH.ok)} ${text}`;
}

function paintWarn(text: string): string {
  return `${roles.attention(GLYPH.warn)} ${text}`;
}

function errorMessage(error: unknown): string {
  return sanitizeTerminal(error instanceof Error ? error.message : String(error));
}

/** Keep async subagent output from corrupting the main transcript. */
function backgroundNotice(label: string, event: AgentEvent): void {
  const tag = roles.dim(`[${label}]`);
  let text: string | undefined;
  if (event.type === 'tool.call') {
    const info = describeToolCall(event.call);
    const detail = info.summary.length > 0 ? ` ${roles.dim('·')} ${roles.dim(sanitizeTerminal(info.summary))}` : '';
    text = `${roles.accent(GLYPH.notice)} ${roles.dim(info.title)}${detail}`;
  } else if (event.type === 'tool.result') {
    const outcome = describeToolResult({ id: event.result.callId, name: event.result.name, arguments: {} }, event.result, { verbose: false });
    const mark = event.result.ok ? roles.success(GLYPH.ok) : roles.error(GLYPH.fail);
    const meta = outcome.meta.length > 0 ? ` ${roles.dim('·')} ${roles.dim(sanitizeTerminal(outcome.meta.join(' · ')))}` : '';
    text = `${mark} ${roles.dim(sanitizeTerminal(event.result.name))}${meta}`;
  } else if (event.type === 'error') {
    text = `${roles.error(GLYPH.fail)} ${roles.error(sanitizeTerminal(event.error.message))}`;
  } else if (event.type === 'turn.end' && event.reason !== 'end_turn' && event.reason !== 'tool_use') {
    text = `${roles.attention(GLYPH.stop)} ${roles.attention(sanitizeTerminal(event.reason))}`;
  } else if (event.type === 'context.compacted') {
    text = `${roles.dim(GLYPH.notice)} ${roles.dim(`上下文压缩 · ${event.beforeTokens} → ${event.afterTokens} tokens`)}`;
  }
  if (text !== undefined) {
    renderer.print(`\n${sayIndent(tag)} ${text}\n`);
  }
}

function bindingLabel(binding: ModelBinding | undefined): string {
  if (!binding) return '未选择';
  if (binding.kind === 'agent') return '跟随智能体';
  if (binding.kind === 'role') return `角色 ${sanitizeTerminal(binding.role)}`;
  return `${sanitizeTerminal(binding.provider)}/${sanitizeTerminal(binding.model)}${binding.reasoningEffort ? ` (${binding.reasoningEffort})` : ''}`;
}

function resolvedModelLabel(runtime: ResolvedSessionRuntime): string {
  if (!runtime.modelDescriptor) return 'demo';
  return `${sanitizeTerminal(runtime.modelDescriptor.provider)}/${sanitizeTerminal(runtime.modelDescriptor.id)}`
    + (runtime.reasoningEffort ? ` (${runtime.reasoningEffort})` : '');
}

async function main(): Promise<void> {
  const configDir = defaultConfigDir();
  const configStore = await ConfigStore.open(join(configDir, 'config.json'));
  const agents = new AgentCatalog(join(configDir, 'agents'));
  const runtime = new RuntimeResolver({ configStore, agents });
  const store = new SessionStore(join(configDir, 'sessions'));
  const audit = new AuditLog(join(cwd, '.omniagent', 'audit.jsonl'));
  const failedPermissions = new Set<string>();
  let demoModel: FakeModel | undefined;
  const demo = (): FakeModel => (demoModel ??= createDemoModel());
  const config = configStore.snapshot.config;
  const mcp = new McpService({
    loadServers: async () => (await configStore.refresh()).config.mcpServers,
    log: (message) => renderer.print(`${sayIndent(paintWarn(`MCP: ${sanitizeTerminal(message)}`))}\n`),
  });
  await mcp.sync();

  const subagents = new SubagentManager({
    store,
    createModel: () => demo(),
    runtime,
    maxSteps: config.maxSteps,
    ...(config.retainContextTokens === undefined ? {} : { retainContextTokens: config.retainContextTokens }),
    approve,
    audit: (entry) => audit.record(entry),
    maxDepth: config.subagents?.maxDepth ?? 1,
    maxActive: config.subagents?.maxActive ?? 8,
    mcpTools: () => mcp.tools(),
    onBackgroundEvent: (sessionId, event) => {
      if (event.type === 'assistant.delta' || event.type === 'assistant.reasoning.delta' || event.type === 'assistant.message') return;
      backgroundNotice(sanitizeTerminal(sessionId.slice(0, 8)), event);
    },
  });

  function projection(current: SessionHandle): DshPermissionProjection {
    return failedPermissions.has(current.id) ? { status: 'invalid', preset: null } : projectDshPermissions(current.events);
  }

  function currentAgentId(current: SessionHandle): string {
    const agent = projectAgentSelection(current.events);
    return agent.status === 'selected' ? agent.agent : 'default';
  }

  async function resolveSessionRuntime(current: SessionHandle): Promise<ResolvedSessionRuntime> {
    const agent = projectAgentSelection(current.events);
    if (agent.status !== 'selected') {
      throw new Error(agent.status === 'invalid'
        ? '会话的智能体选择无效；请使用 /agent 重新选择。'
        : '会话尚未选择智能体；请使用 /agent 选择。');
    }
    const binding = projectModelSelection(current.events);
    if (binding.status !== 'selected') {
      throw new Error(binding.status === 'invalid'
        ? '会话的模型选择无效；请使用 /model 重新选择。'
        : '会话尚未选择模型；请使用 /model 选择。');
    }
    return runtime.resolve({ cwd, agentId: agent.agent, binding: binding.binding, isRoot: true });
  }

  async function createHandle(previous?: SessionHandle): Promise<SessionHandle> {
    const settings = await readDefaultPreset(configDir);
    const agentId = previous ? currentAgentId(previous) : 'default';
    // Validate before writing a new session: fail closed instead of creating one that cannot run.
    await runtime.resolve({ cwd, agentId, binding: defaultModelBinding(), isRoot: true });
    const created = await store.create({ workspace: cwd, cwd });
    if (!settings.requiresSelection && created.events.length === 0) {
      try {
        await created.append(createInitialDshPermissionEvent(settings.defaultPreset));
      } catch (error) {
        failedPermissions.add(created.id);
        throw error;
      }
    }
    await created.append(createAgentSelectionEvent(agentId));
    await created.append(createModelSelectionEvent(defaultModelBinding()));
    return created;
  }

  let handle = await createHandle();
  let session: Session | undefined;
  let sessionSettings = '';
  let statusAgent = 'default';
  let statusModel = 'demo';
  let statusError = '';

  function resetSession(): void {
    session = undefined;
    sessionSettings = '';
  }

  async function refreshStatus(): Promise<void> {
    const agent = projectAgentSelection(handle.events);
    const binding = projectModelSelection(handle.events);
    if (agent.status !== 'selected') {
      statusAgent = '未选择智能体';
      statusModel = bindingLabel(binding.status === 'selected' ? binding.binding : undefined);
      statusError = '';
      return;
    }
    if (binding.status !== 'selected') {
      statusAgent = sanitizeTerminal(agent.agent);
      statusModel = binding.status === 'invalid' ? '模型无效' : '未选择模型';
      statusError = '';
      return;
    }
    try {
      const resolved = await runtime.resolve({ cwd, agentId: agent.agent, binding: binding.binding, isRoot: true });
      statusAgent = sanitizeTerminal(resolved.agent.name);
      statusModel = resolvedModelLabel(resolved);
      statusError = '';
    } catch (error) {
      statusAgent = sanitizeTerminal(agent.agent);
      statusModel = '不可用';
      statusError = errorMessage(error);
    }
  }

  function makeSession(
    nextHandle: SessionHandle,
    permissions: DshPermissionSnapshot,
    resolved: ResolvedSessionRuntime,
  ): Session {
    const latest = configStore.snapshot.config;
    return new Session({
      cwd,
      workspace: cwd,
      model: resolved.model ?? demo(),
      ...(resolved.modelId === undefined ? {} : { modelId: resolved.modelId }),
      agent: resolved.sessionAgent,
      modelCapabilities: resolved.capabilities,
      todoAllowParallelInProgress: resolved.todoAllowParallelInProgress,
      dshPermissions: permissions,
      maxSteps: latest.maxSteps,
      approve,
      reviewPlan,
      audit: (entry) => audit.record(entry),
      session: nextHandle,
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
      onBackgroundEvent: (event) => {
        if (event.type === 'assistant.delta' || event.type === 'assistant.reasoning.delta' || event.type === 'assistant.message') return;
        backgroundNotice('background', event);
      },
      ...(resolved.contextWindowTokens === undefined ? {} : { contextWindowTokens: resolved.contextWindowTokens }),
      ...(latest.retainContextTokens === undefined ? {} : { retainContextTokens: latest.retainContextTokens }),
    });
  }

  function showBanner(): void {
    const permission = projection(handle);
    renderer.print(renderBanner({
      model: `${statusAgent} · ${statusModel}`,
      workspace: cwd,
      permission: permission.status === 'ready' ? permission.preset : 'permission required',
      sessionId: handle.id,
    }, theme));
  }

  function say(text = ''): void {
    renderer.print(`${text}\n`);
  }

  function sayIndented(text: string): void {
    say(sayIndent(text));
  }

  /**
   * 打印状态行 + 输入提示。
   *
   * 状态行单独成行、由渲染器写出，`rl.question` 只拿到一行提示符：readline 用
   * 提示符的显示宽度算光标列，多行 prompt 会让编辑和回显错位，所以这里不合并。
   */
  function promptLine(): string {
    const current = projection(handle);
    const todos = projectTodos(handle.events);
    const done = todos?.filter((item) => item.status === 'completed').length ?? 0;
    renderer.print(`${renderStatus({
      sessionId: handle.id,
      permission: current.status === 'ready' ? current.preset : null,
      model: `${statusAgent} · ${statusModel}`,
      plan: projectPlanMode(handle.events).active,
      todos: todos && todos.length > 0 ? { done, total: todos.length } : null,
    }, theme, process.stdout.columns || 100)}\n`);
    return renderPrompt(theme);
  }

  await refreshStatus();
  showBanner();

  for (;;) {
    try {
      await refreshStatus();
    } catch (error) {
      statusError = errorMessage(error);
    }
    const current = projection(handle);
    const line = (await rl.question(promptLine())).trim();
    if (line.length === 0) continue;
    if (statusError && line !== '/help' && line !== '/clear' && line !== 'exit' && line !== 'q') {
      sayIndented(paintError(`配置不可用：${statusError}`));
      continue;
    }
    if (line === 'exit' || line === 'q') {
      await subagents.close();
      break;
    }
    if (line === '/help') {
      renderer.print(renderHelp(theme));
      continue;
    }
    if (line === '/color' || line.startsWith('/color ')) {
      const argument = line.slice('/color'.length).trim();
      if (argument.length === 0) {
        sayIndented(`颜色：${renderer.color ? roles.accent('on') : roles.dim('off')}`);
        sayIndented(roles.dim('用法：/color on | /color off（NO_COLOR / TERM=dumb 会让默认值为 off）'));
        continue;
      }
      if (argument !== 'on' && argument !== 'off') {
        sayIndented(paintWarn('请选择 on 或 off。'));
        continue;
      }
      renderer.setColor(argument === 'on');
      sayIndented(argument === 'on'
        ? paintOk('颜色已开启（只影响之后输出的内容）')
        : paintOk('颜色已关闭（只影响之后输出的内容）'));
      continue;
    }
    if (line === '/clear') {
      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
      else say();
      showBanner();
      continue;
    }
    if (line === '/think' || line.startsWith('/think ')) {
      const argument = line.slice('/think'.length).trim();
      if (argument.length === 0) {
        sayIndented(`思考内容显示：${roles.accent(renderer.thinking)}`);
        sayIndented(paintDim('用法：/think full | compact | off'));
        continue;
      }
      if (argument !== 'full' && argument !== 'compact' && argument !== 'off') {
        sayIndented(paintWarn('请选择 full、compact 或 off。'));
        continue;
      }
      renderer.setThinkingMode(argument as ThinkingMode);
      sayIndented(paintOk(`思考内容显示：${argument}`));
      continue;
    }
    if (line === '/verbose') {
      renderer.setVerbose(!renderer.isVerbose);
      sayIndented(paintOk(`工具详情：${renderer.isVerbose ? '展开' : '收起'}`));
      continue;
    }
    if (line === '/sessions') {
      const items = await store.list();
      if (items.length === 0) {
        sayIndented(paintDim('还没有会话。'));
        continue;
      }
      sayIndented(roles.dim('会话'));
      for (const item of items) {
        const relation = item.parentSessionId
          ? `child of ${sanitizeTerminal(item.parentSessionId)} (depth ${item.depth ?? 1})`
          : 'root';
        let agent: string | undefined;
        try {
          agent = currentAgentId(await store.open(item.workspace, item.id));
        } catch {
          agent = undefined;
        }
        const marker = item.id === handle.id ? roles.accent('*') : ' ';
        const id = item.id === handle.id ? roles.accent(sanitizeTerminal(item.id)) : sanitizeTerminal(item.id);
        const title = item.description?.trim()
          || item.title?.trim()
          || (item.blank ? '新会话' : '未命名');
        const detail = [
          ...(agent === undefined ? [] : [roles.dim(`agent ${sanitizeTerminal(agent)}`)]),
          roles.dim(`${item.eventCount} events`),
          roles.dim(relation),
          roles.dim(sanitizeTerminal(item.workspace)),
        ];
        say(sayIndent(`${marker} ${sanitizeTerminal(title)}  ${id}  ${detail.join(roles.dim('  '))}`));
      }
      continue;
    }
    if (line === '/todos') {
      printTodos(projectTodos(handle.events));
      continue;
    }
    if (line === '/plan' || line.startsWith('/plan ')) {
      if (session?.activeTurn) {
        sayIndented(paintWarn('当前回合运行中，不能切换 plan 模式。'));
        continue;
      }
      const argument = line.slice('/plan'.length).trim();
      const active = projectPlanMode(handle.events).active;
      const next = argument === 'on' ? true : argument === 'off' ? false : !active;
      if (argument && argument !== 'on' && argument !== 'off') {
        sayIndented(paintDim('用法：/plan、/plan on 或 /plan off'));
        continue;
      }
      try {
        handle = await store.open(cwd, handle.id);
        if (active !== next) await handle.append(createPlanModeEvent(next));
        resetSession();
        sayIndented(next
          ? paintOk('计划模式已开启；模型将先调研并通过 exit_plan_mode 提交计划。')
          : paintOk('计划模式已关闭。'));
      } catch (error) {
        sayIndented(paintError(`计划模式切换失败：${errorMessage(error)}`));
      }
      continue;
    }
    if (line === '/new') {
      await handle.flush();
      try {
        handle = await createHandle(handle);
        resetSession();
        await refreshStatus();
        sayIndented(paintOk(`新建会话 ${roles.accent(sanitizeTerminal(handle.id))} · 智能体 ${roles.accent(statusAgent)}`));
      } catch (error) {
        sayIndented(paintError(`新建失败：${errorMessage(error)}`));
      }
      continue;
    }
    if (line === '/permission' || line.startsWith('/permission ')) {
      const preset = line.slice('/permission'.length).trim();
      if (preset.length === 0) {
        sayIndented(`当前权限：${roles.warning(current.preset ?? '未选择')}`);
        sayIndented(paintDim('用法：/permission read-only | workspace-write | danger-full-access'));
        continue;
      }
      if (!isDshPermissionPreset(preset)) {
        sayIndented(paintWarn('请选择 read-only、workspace-write 或 danger-full-access。'));
        continue;
      }
      handle = await store.open(cwd, handle.id);
      const event = createDshPresetSwitch(projection(handle), preset);
      if (event) {
        try {
          await handle.append(event);
          failedPermissions.delete(handle.id);
          resetSession();
        } catch (error) {
          failedPermissions.add(handle.id);
          resetSession();
          sayIndented(paintError(`权限保存失败：${errorMessage(error)}`));
          continue;
        }
      }
      sayIndented(paintOk(`当前权限：${roles.warning(preset)}`));
      continue;
    }
    if (line === '/agent' || line.startsWith('/agent ')) {
      handle = await store.open(cwd, handle.id);
      try {
        const snapshot = await configStore.refresh();
        const catalog = await agents.refresh(snapshot.catalog);
        const argument = line.slice('/agent'.length).trim();
        const rootAgents = catalog.agents.filter((agent) => usageAllowsRoot(agent.usage));
        const selected = projectAgentSelection(handle.events);
        if (argument.length === 0) {
          if (rootAgents.length === 0) {
            sayIndented(paintDim('当前配置没有可作为主智能体的 agent。'));
            continue;
          }
          sayIndented(roles.dim('智能体'));
          for (const agent of rootAgents) {
            const active = selected.status === 'selected' && selected.agent === agent.id;
            const mark = active ? roles.accent('*') : ' ';
            const label = active ? roles.accent(sanitizeTerminal(agent.id)) : sanitizeTerminal(agent.id);
            const detail = [agent.name, agent.role, agent.usage, agent.profile].map((value) => sanitizeTerminal(value));
            say(sayIndent(`${mark} ${label}  ${roles.dim(detail.join(' · '))}`));
          }
          sayIndented(paintDim('使用 /agent <id> 切换智能体。'));
          continue;
        }
        const target = catalog.agents.find((agent) => agent.id === argument);
        if (!target) {
          sayIndented(paintWarn('该智能体不存在或无效。'));
          continue;
        }
        if (!usageAllowsRoot(target.usage)) {
          sayIndented(paintWarn('该智能体只能作为子智能体使用。'));
          continue;
        }
        const binding = projectModelSelection(handle.events);
        if (binding.status === 'invalid') {
          sayIndented(paintWarn('当前模型选择无效；请先使用 /model 重新选择。'));
          continue;
        }
        await runtime.resolve({
          cwd,
          agentId: target.id,
          binding: binding.status === 'selected' ? binding.binding : defaultModelBinding(),
          isRoot: true,
        });
        const event = createAgentSwitch(selected, { version: 1, agent: target.id });
        if (event) await handle.append(event);
        resetSession();
        await refreshStatus();
        sayIndented(paintOk(`当前智能体：${roles.accent(statusAgent)}`));
      } catch (error) {
        sayIndented(paintError(`切换智能体失败：${errorMessage(error)}`));
      }
      continue;
    }
    if (line === '/model' || line.startsWith('/model ')) {
      handle = await store.open(cwd, handle.id);
      try {
        const snapshot = await configStore.refresh();
        const modelList = listCatalogModels(snapshot.catalog)
          .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`));
        const bindingProjection = projectModelSelection(handle.events);
        const activeBinding = bindingProjection.status === 'selected' ? bindingProjection.binding : undefined;
        const argument = line.slice('/model'.length).trim();
        if (bindingProjection.status === 'invalid') sayIndented(paintWarn('当前会话的模型选择无效；请重新选择。'));
        if (argument.length === 0) {
          sayIndented(roles.dim('模型'));
          const follow = activeBinding?.kind === 'agent' || activeBinding?.kind === 'role' ? roles.accent('*') : ' ';
          say(sayIndent(`${follow} 1. ${roles.dim('跟随智能体')}${roles.dim(' — 使用智能体角色对应的模型')}`));
          let index = 2;
          for (const model of modelList) {
            const active = activeBinding?.kind === 'model' && activeBinding.provider === model.provider && activeBinding.model === model.id;
            const mark = active ? roles.accent('*') : ' ';
            const reasoning = model.reasoning?.default ? ` (${model.reasoning.default})` : '';
            const label = `${model.provider}/${model.id} — ${model.name}${reasoning}`;
            say(sayIndent(`${mark} ${index++}. ${roles.dim('模型')} ${active ? roles.accent(sanitizeTerminal(label)) : sanitizeTerminal(label)}`));
          }
          sayIndented(paintDim('使用 /model <序号>、/model agent 或 /model <provider> <model> 切换。'));
          continue;
        }

        let binding: ModelBinding | undefined;
        if (argument === 'agent') {
          binding = defaultModelBinding();
        } else if (/^\d+$/.test(argument)) {
          const numeric = Number(argument);
          if (numeric === 1) binding = defaultModelBinding();
          else {
            const model = modelList[numeric - 2];
            if (model) {
              binding = {
                version: 2,
                kind: 'model',
                provider: model.provider,
                model: model.id,
                ...(model.reasoning?.default === undefined ? {} : { reasoningEffort: model.reasoning.default }),
              };
            }
          }
          if (!binding) {
            sayIndented(paintWarn('序号超出范围。'));
            continue;
          }
        } else {
          const [provider, ...rest] = argument.split(/\s+/);
          const modelId = rest.join(' ');
          if (!provider || !modelId) {
            sayIndented(paintDim('用法：/model <序号>、/model agent 或 /model <provider> <model>'));
            continue;
          }
          const model = modelList.find((entry) => entry.provider === provider && entry.id === modelId);
          if (!model) {
            sayIndented(paintWarn('该模型不在当前配置的模型目录中。'));
            continue;
          }
          binding = {
            version: 2,
            kind: 'model',
            provider,
            model: modelId,
            ...(model.reasoning?.default === undefined ? {} : { reasoningEffort: model.reasoning.default }),
          };
        }

        const agent = projectAgentSelection(handle.events);
        if (agent.status !== 'selected') {
          sayIndented(paintWarn('请先使用 /agent 选择智能体。'));
          continue;
        }
        await runtime.resolve({ cwd, agentId: agent.agent, binding, isRoot: true });
        const event = createModelSwitch(bindingProjection, binding);
        if (event) await handle.append(event);
        resetSession();
        await refreshStatus();
        sayIndented(paintOk(`当前模型：${roles.accent(statusModel)}`));
      } catch (error) {
        sayIndented(paintError(`模型切换失败：${errorMessage(error)}`));
      }
      continue;
    }
    if (line.startsWith('/resume ')) {
      const id = line.slice('/resume '.length).trim();
      if (id.length === 0) continue;
      try {
        handle = await store.open(cwd, id);
        resetSession();
        await refreshStatus();
        const selection = projectAgentSelection(handle.events);
        sayIndented(paintOk(`已恢复 ${roles.accent(sanitizeTerminal(id))}${roles.dim(' · ')}消息数 ${handle.messages.length}${roles.dim(' · ')}智能体 ${selection.status === 'selected' ? sanitizeTerminal(selection.agent) : '未选择'}`));
        if (selection.status !== 'selected') {
          sayIndented(paintWarn('该会话需要先使用 /agent 选择智能体，并使用 /model 选择模型后才能继续。'));
        }
      } catch (error) {
        sayIndented(paintError(`恢复失败：${errorMessage(error)}`));
      }
      continue;
    }
    if (line.startsWith('/')) {
      sayIndented(paintWarn(`未知命令：${sanitizeTerminal(line)}`));
      sayIndented(paintDim('输入 /help 查看可用命令。'));
      continue;
    }

    handle = await store.open(cwd, handle.id);
    const permission = projection(handle);
    if (permission.status !== 'ready') {
      sayIndented(paintWarn('请先使用 /permission <preset> 选择会话权限。'));
      continue;
    }
    let resolved: ResolvedSessionRuntime;
    try {
      resolved = await resolveSessionRuntime(handle);
    } catch (error) {
      sayIndented(paintError(`无法开始回合：${errorMessage(error)}`));
      continue;
    }
    const snapshot = snapshotDshPermissions(permission);
    const settingsKey = `${snapshot.preset}\0${resolved.revision}`;
    if (!session || sessionSettings !== settingsKey) {
      session = makeSession(handle, snapshot, resolved);
      sessionSettings = settingsKey;
    }
    try {
      for await (const event of session.send(line)) {
        renderer.handle(event);
        if (event.type === 'tool.result' && event.result.name === 'todo_write') {
          printTodos(projectTodos(handle.events));
        }
      }
    } catch (error) {
      renderer.handle({ type: 'error', error: { message: errorMessage(error) } });
    }
    renderer.beforePrompt();
  }
  await subagents.close();
  await mcp.close();
  await handle.close();
  rl.close();
}

main().catch((error: unknown) => {
  renderer.print(`${sayIndent(paintError(`启动失败：${errorMessage(error)}`))}\n`);
  process.exitCode = 1;
});
