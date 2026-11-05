import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  AuditLog,
  DEFAULT_SYSTEM_PROMPT,
  FakeModel,
  Session,
  SessionStore,
  SubagentManager,
  createModelSelectionEvent,
  createModelSwitch,
  createPlanModeEvent,
  projectPlanMode,
  projectTodos,
  createSelectedModel,
  defaultModelSelection,
  discoverSkills,
  listConfiguredModels,
  loadConfig,
  projectModelSelection,
  renderSkillCatalog,
  resolveContextWindowTokens,
  textResponse,
  toolCallResponse,
} from '@omniagent/core';
import type {
  AgentEvent,
  ApprovalResponse,
  ModelChoice,
  ModelClient,
  PermissionRequest,
  PlanReviewResponse,
  SessionHandle,
  SessionModelSelection,
  TodoItem,
} from '@omniagent/core';
import {
  createDshPresetSwitch, createInitialDshPermissionEvent, isDshPermissionPreset,
  projectDshPermissions, resolveDshDefaultPreset, snapshotDshPermissions,
} from '../../core/src/permissions/dsh-permissions';
import type { DshPermissionProjection, DshPermissionSettings, DshPermissionSnapshot } from '../../core/src/permissions/dsh-permissions';
import { createTheme } from './ansi';
import { renderMarkdown } from './markdown';
import { TuiRenderer, renderBanner, renderHelp, sanitizeTerminal } from './render';
import type { ThinkingMode } from './render';
import { describeToolCall, describeToolResult } from './tools';

const cwd = process.cwd();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const theme = createTheme();
const renderer = new TuiRenderer({ theme });

function createDemoModel(): FakeModel {
  return new FakeModel([
    {
      ...toolCallResponse([{ name: 'list_dir', args: { path: '.' } }], '先看一下工作区里有什么。'),
      reasoning: '用户刚进入工作区。先列出目录，再读 README；每一步都应该让权限门检查。',
    },
    {
      ...toolCallResponse([{ name: 'read_file', args: { path: 'README.md' } }], '再看一眼 README。'),
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
  renderer.print(`\n  ${theme.paint('计划', { fg: 'brightCyan', bold: true })}\n\n`);
  renderer.print(renderMarkdown(sanitizeTerminal(plan), {
    theme,
    width: () => process.stdout.columns || 100,
    linePrefix: '  ',
  }));
  renderer.print('\n');
  const answer = await rl.question(`  ${theme.paint('批准并退出 plan 模式？(y/N)', { bold: true })} `);
  signal.throwIfAborted();
  if (answer.trim().toLowerCase() === 'y') return { approved: true };
  const feedback = (await rl.question(`  ${theme.paint('继续规划，补充意见（可空）：', { dim: true })} `)).trim();
  signal.throwIfAborted();
  return { approved: false, ...(feedback ? { feedback } : {}) };
}

function printTodos(todos: readonly TodoItem[] | null): void {
  if (!todos || todos.length === 0) {
    renderer.print(`  ${theme.paint('当前没有任务清单。', { dim: true })}\n`);
    return;
  }
  for (const item of todos) {
    const mark = item.status === 'completed'
      ? theme.paint('✓', { fg: 'green' })
      : item.status === 'in_progress'
        ? theme.paint('▸', { fg: 'brightCyan' })
        : theme.paint('○', { dim: true, fg: 'gray' });
    renderer.print(`  ${mark} ${sanitizeTerminal(item.content)}\n`);
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
  return resolveDshDefaultPreset(Object.hasOwn(config, 'mode') || Object.hasOwn(config, 'permissions') ? null : undefined);
}

function modelKey(selection: SessionModelSelection | undefined): string {
  return selection ? `${selection.provider}\0${selection.model}\0${selection.reasoningEffort ?? ''}` : '\0demo\0';
}

function describeModel(selection: SessionModelSelection | undefined): string {
  return selection ? `${sanitizeTerminal(selection.provider)}/${sanitizeTerminal(selection.model)}` : 'demo';
}

function describeChoice(choice: ModelChoice): string {
  return `${sanitizeTerminal(choice.provider)}/${sanitizeTerminal(choice.model)} — ${sanitizeTerminal(choice.name)}`;
}

function paintDim(text: string): string {
  return theme.paint(text, { dim: true, fg: 'gray' });
}

function paintError(text: string): string {
  return `${theme.paint('✗', { fg: 'red' })} ${theme.paint(text, { fg: 'red' })}`;
}

function paintOk(text: string): string {
  return `${theme.paint('✓', { fg: 'green' })} ${text}`;
}

function paintWarn(text: string): string {
  return `${theme.paint('⚠', { fg: 'brightYellow' })} ${text}`;
}

/** Keep async subagent output from corrupting the main transcript. */
function backgroundNotice(label: string, event: AgentEvent): void {
  let text: string | undefined;
  if (event.type === 'tool.call') {
    const info = describeToolCall(event.call);
    text = `${theme.paint('⚙', { fg: 'cyan' })} ${info.title}${info.summary.length > 0 ? ` · ${sanitizeTerminal(info.summary)}` : ''}`;
  } else if (event.type === 'tool.result') {
    const outcome = describeToolResult({ id: event.result.callId, name: event.result.name, arguments: {} }, event.result, { verbose: false });
    const mark = event.result.ok ? theme.paint('✓', { fg: 'green' }) : theme.paint('✗', { fg: 'red' });
    text = `${mark} ${sanitizeTerminal(event.result.name)}${outcome.meta.length > 0 ? ` · ${sanitizeTerminal(outcome.meta.join(' · '))}` : ''}`;
  } else if (event.type === 'error') {
    text = `${theme.paint('✗', { fg: 'red' })} ${sanitizeTerminal(event.error.message)}`;
  } else if (event.type === 'turn.end' && event.reason !== 'end_turn' && event.reason !== 'tool_use') {
    text = `${theme.paint('■', { fg: 'brightYellow' })} ${sanitizeTerminal(event.reason)}`;
  } else if (event.type === 'context.compacted') {
    text = paintDim(`上下文压缩 · ${event.beforeTokens} → ${event.afterTokens} tokens`);
  }
  if (text !== undefined) {
    renderer.print(`\n  ${paintDim(`[${label}]`)} ${text}\n`);
  }
}

async function main(): Promise<void> {
  const { config, configDir } = await loadConfig();
  const initialSelection = defaultModelSelection(config);
  const modelCatalog = listConfiguredModels(config);
  const store = new SessionStore(join(configDir, 'sessions'));
  const audit = new AuditLog(join(cwd, '.omniagent', 'audit.jsonl'));
  const failedPermissions = new Set<string>();
  const modelCache = new Map<string, ModelClient>();
  let demoModel: FakeModel | undefined;
  let catalog: string;
  try {
    catalog = renderSkillCatalog(await discoverSkills({ workspace: cwd }));
  } catch {
    catalog = 'Skill discovery failed; do not infer a skill catalog this session.';
  }
  const system = [config.system ?? DEFAULT_SYSTEM_PROMPT, catalog].filter(Boolean).join('\n\n');

  function selectedModel(selection: SessionModelSelection | undefined): ModelClient {
    if (!selection) {
      demoModel ??= createDemoModel();
      return demoModel;
    }
    const key = modelKey(selection);
    let client = modelCache.get(key);
    if (!client) {
      client = createSelectedModel(config, selection);
      modelCache.set(key, client);
    }
    return client;
  }

  // Fail at startup when the configured default cannot be constructed.
  selectedModel(initialSelection);

  const subagents = new SubagentManager({
    store,
    createModel: selectedModel,
    modelIdFor: (selection) => selection?.model ?? config.model,
    modelCatalog,
    defaultModelSelection: initialSelection,
    systemForChild: () => system,
    maxSteps: config.maxSteps,
    contextWindowTokens: (selection) => resolveContextWindowTokens(config, selection),
    ...(config.retainContextTokens === undefined ? {} : { retainContextTokens: config.retainContextTokens }),
    approve,
    audit: (entry) => audit.record(entry),
    maxDepth: config.subagents?.maxDepth ?? 1,
    maxActive: config.subagents?.maxActive ?? 8,
    onBackgroundEvent: (sessionId, event) => {
      if (event.type === 'assistant.delta' || event.type === 'assistant.reasoning.delta' || event.type === 'assistant.message') return;
      backgroundNotice(sanitizeTerminal(sessionId.slice(0, 8)), event);
    },
  });

  async function createHandle(): Promise<SessionHandle> {
    const settings = await readDefaultPreset(configDir);
    const created = await store.create({ workspace: cwd, cwd });
    if (!settings.requiresSelection && created.events.length === 0) {
      try {
        await created.append(createInitialDshPermissionEvent(settings.defaultPreset));
      } catch (error) {
        failedPermissions.add(created.id);
        throw error;
      }
    }
    if (initialSelection) await created.append(createModelSelectionEvent(initialSelection));
    return created;
  }

  function projection(current: SessionHandle): DshPermissionProjection {
    return failedPermissions.has(current.id) ? { status: 'invalid', preset: null } : projectDshPermissions(current.events);
  }

  function modelSelectionFor(current: SessionHandle): { selection?: SessionModelSelection; error?: string } {
    const projection = projectModelSelection(current.events);
    if (projection.status === 'invalid') return { error: '会话的模型选择无效，请使用 /model 重新选择。' };
    return { selection: projection.status === 'selected' ? projection.selection : initialSelection };
  }

  function modelLabel(current: SessionHandle): string {
    const resolved = modelSelectionFor(current);
    return resolved.error ? 'invalid model' : describeModel(resolved.selection);
  }

  let handle = await createHandle();
  let session: Session | undefined;
  let sessionSettings = '';

  function resetSession(): void {
    session = undefined;
    sessionSettings = '';
  }

  function makeSession(
    nextHandle: SessionHandle,
    permissions: DshPermissionSnapshot,
    selection: SessionModelSelection | undefined,
    model: ModelClient,
  ): Session {
    const contextWindowTokens = resolveContextWindowTokens(config, selection);
    return new Session({
      cwd,
      workspace: cwd,
      model,
      modelId: selection?.model ?? config.model,
      ...(selection === undefined ? {} : { modelSelection: selection }),
      dshPermissions: permissions,
      maxSteps: config.maxSteps,
      approve,
      reviewPlan,
      audit: (entry) => audit.record(entry),
      session: nextHandle,
      system,
      subagents,
      onBackgroundEvent: (event) => {
        if (event.type === 'assistant.delta' || event.type === 'assistant.reasoning.delta' || event.type === 'assistant.message') return;
        backgroundNotice('background', event);
      },
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      ...(config.retainContextTokens === undefined ? {} : { retainContextTokens: config.retainContextTokens }),
    });
  }

  function showBanner(): void {
    const permission = projection(handle);
    renderer.print(renderBanner({
      model: modelLabel(handle),
      workspace: cwd,
      permission: permission.status === 'ready' ? permission.preset : 'permission required',
      sessionId: handle.id,
    }, theme));
  }

  function say(text = ''): void {
    renderer.print(`${text}\n`);
  }

  function sayIndented(text: string): void {
    say(`  ${text}`);
  }

  showBanner();

  for (;;) {
    const current = projection(handle);
    const model = modelLabel(handle);
    const plan = projectPlanMode(handle.events).active;
    const todos = projectTodos(handle.events);
    const todoLabel = todos && todos.length > 0
      ? ` | ${todos.filter((item) => item.status === 'completed').length}/${todos.length} todos`
      : '';
    const status = `[${sanitizeTerminal(handle.id.slice(0, 8))} | ${current.preset ?? 'permission required'} | ${model} | ${plan ? 'plan' : 'chat'}${todoLabel}]`;
    const line = (await rl.question(`${paintDim(status)} ${theme.paint('❯', { fg: 'brightCyan', bold: true })} `)).trim();
    if (line.length === 0) continue;
    if (line === 'exit' || line === 'q') {
      await subagents.close();
      break;
    }
    if (line === '/help') {
      renderer.print(renderHelp(theme));
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
        sayIndented(`思考内容显示：${theme.paint(renderer.thinking, { fg: 'brightCyan' })}`);
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
      sayIndented(theme.paint('会话', { bold: true }));
      for (const item of items) {
        const relation = item.parentSessionId
          ? `child of ${sanitizeTerminal(item.parentSessionId)} (depth ${item.depth ?? 1})`
          : 'root';
        const marker = item.id === handle.id ? theme.paint('*', { fg: 'brightCyan' }) : ' ';
        say(`  ${marker} ${theme.paint(sanitizeTerminal(item.id), { fg: 'brightCyan' })}  ${paintDim(`${item.eventCount} events`)}  ${paintDim(relation)}  ${paintDim(sanitizeTerminal(item.workspace))}`);
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
        sayIndented(paintError(`计划模式切换失败：${sanitizeTerminal(error instanceof Error ? error.message : String(error))}`));
      }
      continue;
    }
    if (line === '/new') {
      await handle.flush();
      try {
        handle = await createHandle();
        resetSession();
        sayIndented(paintOk(`新建会话 ${theme.paint(sanitizeTerminal(handle.id), { fg: 'brightCyan' })}`));
      } catch (error) {
        sayIndented(paintError(`新建失败：${sanitizeTerminal(error instanceof Error ? error.message : String(error))}`));
      }
      continue;
    }
    if (line === '/permission' || line.startsWith('/permission ')) {
      const preset = line.slice('/permission'.length).trim();
      if (preset.length === 0) {
        sayIndented(`当前权限：${theme.paint(current.preset ?? '未选择', { fg: 'brightYellow' })}`);
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
          sayIndented(paintError(`权限保存失败：${sanitizeTerminal(error instanceof Error ? error.message : String(error))}`));
          continue;
        }
      }
      sayIndented(paintOk(`当前权限：${theme.paint(preset, { fg: 'brightYellow' })}`));
      continue;
    }
    if (line === '/model' || line.startsWith('/model ')) {
      handle = await store.open(cwd, handle.id);
      const modelProjection = projectModelSelection(handle.events);
      const activeSelection = modelProjection.status === 'selected' ? modelProjection.selection : initialSelection;
      const argument = line.slice('/model'.length).trim();
      if (modelProjection.status === 'invalid') sayIndented(paintWarn('当前会话的模型选择无效；请重新选择。'));
      if (argument.length === 0) {
        if (!modelCatalog.length) {
          sayIndented(paintDim('当前配置没有可选择的模型；未配置 provider 时使用 FakeModel 演示。'));
          continue;
        }
        sayIndented(theme.paint('模型', { bold: true }));
        for (const [index, choice] of modelCatalog.entries()) {
          const active = !!activeSelection && activeSelection.provider === choice.provider && activeSelection.model === choice.model;
          const reasoning = active && activeSelection.reasoningEffort ? ` (${activeSelection.reasoningEffort})` : '';
          say(`  ${active ? theme.paint('*', { fg: 'brightCyan' }) : ' '} ${index + 1}. ${describeChoice(choice)}${paintDim(reasoning)}`);
        }
        sayIndented(paintDim('使用 /model <序号> 或 /model <provider> <model> 切换。'));
        continue;
      }
      let target: ModelChoice | undefined;
      if (/^\d+$/.test(argument)) {
        target = modelCatalog[Number(argument) - 1];
      } else {
        const [provider, ...rest] = argument.split(/\s+/);
        const model = rest.join(' ');
        if (provider && model) target = modelCatalog.find((choice) => choice.provider === provider && choice.model === model);
      }
      if (!target) {
        sayIndented(paintWarn('该模型不在当前配置的模型目录中。'));
        continue;
      }
      const selection: SessionModelSelection = { version: 1, provider: target.provider, model: target.model };
      const event = createModelSwitch(modelProjection, selection);
      if (event) {
        try {
          await handle.append(event);
          resetSession();
        } catch (error) {
          resetSession();
          sayIndented(paintError(`模型保存失败：${sanitizeTerminal(error instanceof Error ? error.message : String(error))}`));
          continue;
        }
      }
      sayIndented(paintOk(`当前模型：${describeChoice(target)}`));
      continue;
    }
    if (line.startsWith('/resume ')) {
      const id = line.slice('/resume '.length).trim();
      if (id.length === 0) continue;
      try {
        handle = await store.open(cwd, id);
        resetSession();
        sayIndented(paintOk(`已恢复 ${theme.paint(sanitizeTerminal(id), { fg: 'brightCyan' })} · 消息数 ${handle.messages.length}`));
      } catch (error) {
        sayIndented(paintError(`恢复失败：${sanitizeTerminal(error instanceof Error ? error.message : String(error))}`));
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
    const resolvedModel = modelSelectionFor(handle);
    if (resolvedModel.error) {
      sayIndented(paintError(resolvedModel.error));
      continue;
    }
    let modelClient: ModelClient;
    try {
      modelClient = selectedModel(resolvedModel.selection);
    } catch (error) {
      sayIndented(paintError(`模型不可用：${sanitizeTerminal(error instanceof Error ? error.message : String(error))}`));
      continue;
    }
    const snapshot = snapshotDshPermissions(permission);
    const settingsKey = `${snapshot.preset}\0${modelKey(resolvedModel.selection)}`;
    if (!session || sessionSettings !== settingsKey) {
      session = makeSession(handle, snapshot, resolvedModel.selection, modelClient);
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
      renderer.handle({ type: 'error', error: { message: error instanceof Error ? error.message : String(error) } });
    }
    renderer.beforePrompt();
  }
  await subagents.close();
  await handle.close();
  rl.close();
}

main().catch((error: unknown) => {
  renderer.print(`  ${paintError(`启动失败：${sanitizeTerminal(error instanceof Error ? error.message : String(error))}`)}\n`);
  process.exitCode = 1;
});
