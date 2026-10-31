import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Message } from '../domain/message';
import { assistantText } from '../domain/message';
import { parseRuleSet } from '../permissions/rules';
import type { AgentEvent, StopReason } from '../protocol/events';
import type {
  ApprovalResponse,
  PermissionMode,
  PermissionRequest,
} from '../protocol/permission';
import { FakeModel } from '../providers/fake';
import type { FakeStep } from '../providers/fake';
import type { ModelClient } from '../providers/types';
import { Session } from '../session';
import { resolveInside } from '../tools/paths';

/**
 * eval harness。
 *
 * 一句话：把「agent 遇到某个任务应该做什么」写成可重复运行、可断言的用例。
 *
 * 一个 case 的生命周期：
 *   建临时工作区 -> 铺 fixture -> 跑 Session -> 断言事件/消息/文件 -> 清理。
 *
 * 模型可以是 FakeModel 剧本（稳定、零 token，用来测循环和权限），
 * 也可以是真实 provider（用来测模型能力，但结果有随机性，要多次跑）。
 */

export type FileExpectation = string | RegExp | ((content: string) => boolean);

export interface EvalPermissions {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface EvalExpectations {
  /** 最后一次 turn 的结束原因。 */
  stopReason?: StopReason;
  /** 期望的工具调用顺序，如 ['list_dir', 'read_file']。 */
  tools?: string[];
  /** 期望的权限决策顺序，对应每次 tool.call。 */
  decisions?: Array<'allow' | 'deny'>;
  /** 最后一条 assistant 文本。字符串精确匹配，正则用 test()。 */
  finalText?: string | RegExp;
  /** 工作区文件断言：路径 -> 内容。 */
  files?: Record<string, FileExpectation>;
  /** 这些文件必须不存在。 */
  absentFiles?: string[];
}

export interface EvalCase {
  name: string;
  /** 初始工作区文件。 */
  files?: Record<string, string>;
  /** 依次发给 agent 的用户输入，默认 ['开始']。 */
  input?: string | string[];
  /** 剧本化模型。不填时使用 runEvalCase 传入的 model。 */
  steps?: FakeStep[];
  mode?: PermissionMode;
  /** 规则格式同 config.json 的 permissions。 */
  permissions?: EvalPermissions;
  /** 权限确认的默认回答。不填时一律 allow。 */
  approve?: (request: PermissionRequest) => ApprovalResponse | Promise<ApprovalResponse>;
  expect: EvalExpectations;
}

export interface EvalRunOptions {
  /** steps 未提供时使用，通常是真实 provider。 */
  model?: ModelClient;
  /** 覆盖默认 system prompt。 */
  system?: string;
  /** 保留临时工作区，方便失败后排查。 */
  keepWorkspace?: boolean;
}

export interface EvalResult {
  name: string;
  passed: boolean;
  failures: string[];
  events: AgentEvent[];
  messages: readonly Message[];
  durationMs: number;
  workspace: string;
  workspaceKept: boolean;
}

export interface EvalSuiteResult {
  results: EvalResult[];
  passed: number;
  failed: number;
  durationMs: number;
}

export async function runEvalCase(
  testCase: EvalCase,
  options: EvalRunOptions = {},
): Promise<EvalResult> {
  const startedAt = Date.now();
  const workspace = await mkdtemp(join(tmpdir(), 'omniagent-eval-'));
  const events: AgentEvent[] = [];
  const failures: string[] = [];
  let messages: readonly Message[] = [];

  try {
    await writeFixtures(workspace, testCase.files ?? {});

    const model = testCase.steps !== undefined ? new FakeModel(testCase.steps) : options.model;
    if (!model) {
      throw new Error('这个 case 没有 steps，也没有在 runEvalCase 里传 model');
    }

    const session = new Session({
      cwd: workspace,
      model,
      modelId: model.name,
      ...(testCase.mode !== undefined ? { mode: testCase.mode } : {}),
      rules: parseRuleSet(testCase.permissions ?? {}, 'session', workspace),
      approve: async (request) =>
        testCase.approve ? await testCase.approve(request) : 'allow',
      ...(options.system !== undefined ? { system: options.system } : {}),
    });

    const inputs = Array.isArray(testCase.input) ? testCase.input : [testCase.input ?? '开始'];
    for (const input of inputs) {
      for await (const event of session.send(input)) {
        events.push(event);
      }
    }
    messages = session.messages;
  } catch (error) {
    failures.push(`执行失败：${errorMessage(error)}`);
  }

  if (failures.length === 0) {
    try {
      await checkExpectations(testCase.expect, workspace, events, messages, failures);
    } catch (error) {
      failures.push(`断言失败：${errorMessage(error)}`);
    }
  }

  const workspaceKept = options.keepWorkspace === true;
  if (!workspaceKept) {
    await rm(workspace, { recursive: true, force: true });
  }

  return {
    name: testCase.name,
    passed: failures.length === 0,
    failures,
    events,
    messages,
    durationMs: Date.now() - startedAt,
    workspace,
    workspaceKept,
  };
}

export async function runEvalSuite(
  cases: readonly EvalCase[],
  options: EvalRunOptions = {},
): Promise<EvalSuiteResult> {
  const startedAt = Date.now();
  const results: EvalResult[] = [];

  for (const testCase of cases) {
    results.push(await runEvalCase(testCase, options));
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    results,
    passed,
    failed: results.length - passed,
    durationMs: Date.now() - startedAt,
  };
}

export function formatEvalResults(suite: EvalSuiteResult): string {
  const lines: string[] = [];

  for (const result of suite.results) {
    lines.push(`${result.passed ? '✓' : '✗'} ${result.name} (${result.durationMs}ms)`);
    for (const failure of result.failures) {
      lines.push(`    - ${failure}`);
    }
    if (!result.passed && result.workspaceKept) {
      lines.push(`    workspace: ${result.workspace}`);
    }
  }

  lines.push('');
  lines.push(`${suite.passed}/${suite.results.length} passed in ${suite.durationMs}ms`);
  return lines.join('\n');
}

async function writeFixtures(
  workspace: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = resolveInside(workspace, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
}

async function checkExpectations(
  expect: EvalExpectations,
  workspace: string,
  events: readonly AgentEvent[],
  messages: readonly Message[],
  failures: string[],
): Promise<void> {
  const errorEvent = events.find((event) => event.type === 'error');
  if (errorEvent?.type === 'error') {
    failures.push(`运行出错：${errorEvent.error.message}`);
  }

  if (expect.stopReason !== undefined) {
    const lastEnd = [...events].reverse().find((event) => event.type === 'turn.end');
    const actual = lastEnd?.type === 'turn.end' ? lastEnd.reason : '无';
    if (actual !== expect.stopReason) {
      failures.push(`stopReason：期望 ${expect.stopReason}，实际 ${actual}`);
    }
  }

  if (expect.tools !== undefined) {
    const actual = events.flatMap((event) =>
      event.type === 'tool.call' ? [event.call.name] : [],
    );
    if (!sameArray(actual, expect.tools)) {
      failures.push(`工具调用：期望 [${expect.tools.join(', ')}]，实际 [${actual.join(', ')}]`);
    }
  }

  if (expect.decisions !== undefined) {
    const actual = events.flatMap((event) =>
      event.type === 'permission.decided' ? [event.decision] : [],
    );
    if (!sameArray(actual, expect.decisions)) {
      failures.push(
        `权限决策：期望 [${expect.decisions.join(', ')}]，实际 [${actual.join(', ')}]`,
      );
    }
  }

  if (expect.finalText !== undefined) {
    const finalAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    const actual =
      finalAssistant !== undefined && finalAssistant.role === 'assistant'
        ? assistantText(finalAssistant)
        : '';
    if (!matches(actual, expect.finalText)) {
      failures.push(`最终文本：期望 ${describe(expect.finalText)}，实际 ${JSON.stringify(actual)}`);
    }
  }

  for (const [path, expected] of Object.entries(expect.files ?? {})) {
    const absolute = resolveInside(workspace, path);
    try {
      const actual = await readFile(absolute, 'utf8');
      if (!matches(actual, expected)) {
        failures.push(`文件 ${path}：内容不符合预期`);
      }
    } catch {
      failures.push(`文件 ${path}：不存在`);
    }
  }

  for (const path of expect.absentFiles ?? []) {
    const absolute = resolveInside(workspace, path);
    try {
      await access(absolute);
      failures.push(`文件 ${path}：不应存在`);
    } catch {
      // 不存在才是期望结果。
    }
  }
}

function matches(value: string, expected: FileExpectation): boolean {
  if (typeof expected === 'string') {
    return value === expected;
  }
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(value);
  }
  return expected(value);
}

function describe(expected: FileExpectation): string {
  if (typeof expected === 'string') {
    return JSON.stringify(expected);
  }
  if (expected instanceof RegExp) {
    return String(expected);
  }
  return '自定义断言函数';
}

function sameArray<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
