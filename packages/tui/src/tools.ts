/**
 * 把工具调用翻译成一行可读的「谁做了什么」，以及结果卡片里值得看的几行。
 *
 * 这一层不画 ANSI：把工具语义和终端样式分开，测试就能只断言内容。
 */
import type { ToolCall, ToolResult } from '@omniagent/core';
import { truncateDisplay } from './ansi';

export interface ToolCallInfo {
  icon: string;
  title: string;
  summary: string;
  /** Escalation request or other secondary line shown under the row. */
  detail?: string;
}

export interface ToolResultInfo {
  meta: string[];
  body: string[];
  hiddenBodyLines: number;
}

const PRESENTATION: Record<string, { title: string; icon: string }> = {
  bash: { title: '执行命令', icon: '❯' },
  read_file: { title: '读取文件', icon: '▤' },
  write_file: { title: '写入文件', icon: '✎' },
  list_dir: { title: '浏览目录', icon: '☰' },
  skill: { title: '加载技能', icon: '◆' },
  todo_write: { title: '更新任务', icon: '☑' },
  subagent: { title: '子代理', icon: '⑂' },
  send_message: { title: '发送消息', icon: '✉' },
  wait_agent: { title: '等待代理', icon: '◷' },
  list_agents: { title: '代理列表', icon: '⑂' },
  interrupt_agent: { title: '中断代理', icon: '■' },
  exit_plan_mode: { title: '提交计划', icon: '◫' },
};

const SHELL_TOOL = 'bash';

export function describeToolCall(call: ToolCall): ToolCallInfo {
  const presentation = PRESENTATION[call.name] ?? { title: call.name, icon: '⚙' };
  const args = asRecord(call.arguments);
  const content = args === undefined ? '' : summarizeArguments(call.name, args);
  const detail = escalationDetail(args);
  return {
    icon: presentation.icon,
    title: presentation.title,
    summary: truncateDisplay(firstLine(content), 100),
    ...(detail === undefined ? {} : { detail }),
  };
}

function summarizeArguments(name: string, args: Record<string, unknown>): string {
  if (name === SHELL_TOOL) {
    const command = stringValue(args['command']) ?? '';
    return `$ ${firstLine(command)}`;
  }
  switch (name) {
    case 'read_file': {
      const path = stringValue(args['path']) ?? '';
      const offset = numberValue(args['offset']);
      const limit = numberValue(args['limit']);
      if (offset !== undefined && limit !== undefined) return `${path}:${offset + 1}-${offset + limit}`;
      if (offset !== undefined) return `${path}:${offset + 1}`;
      return path;
    }
    case 'write_file': {
      const path = stringValue(args['path']) ?? '';
      const body = stringValue(args['content']);
      return body === undefined ? path : `${path} · ${formatCharacters(body.length)}`;
    }
    case 'list_dir':
      return stringValue(args['path']) ?? '.';
    case 'skill':
      return stringValue(args['name']) ?? '';
    case 'todo_write': {
      const todos = Array.isArray(args['todos']) ? args['todos'] : [];
      const counts = countTodos(todos);
      return `${counts.total} 项 · ${counts.inProgress} 进行中 · ${counts.pending} 待办`;
    }
    case 'subagent':
      return stringValue(args['description']) ?? '';
    case 'send_message': {
      const target = stringValue(args['agent_id']) ?? 'agent';
      const message = stringValue(args['message']) ?? '';
      return `${target} · ${firstLine(message)}`;
    }
    case 'wait_agent':
    case 'interrupt_agent':
      return stringValue(args['agent_id']) ?? '';
    case 'list_agents':
      return '';
    case 'exit_plan_mode': {
      const plan = stringValue(args['plan']) ?? '';
      const heading = plan.split('\n').find((line) => /^#{1,6}\s+\S/.test(line.trim()));
      return heading?.replace(/^#{1,6}\s+/, '') ?? firstLine(plan);
    }
    default:
      break;
  }
  const first = Object.values(args).find((value) => typeof value === 'string' && value.length > 0);
  return typeof first === 'string' ? firstLine(first) : compactJson(args);
}

function escalationDetail(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined;
  const target = stringValue(args['sandbox_permissions']);
  if (target === undefined) return undefined;
  const justification = stringValue(args['justification']) ?? '';
  return `申请提升：${target}${justification.length > 0 ? ` · ${justification}` : ''}`;
}

export interface ResultDisplayOptions {
  verbose: boolean;
  maxLines?: number;
}

export function describeToolResult(
  call: ToolCall,
  result: ToolResult,
  options: ResultDisplayOptions,
): ToolResultInfo {
  const meta: string[] = [];
  const body: string[] = [];
  let hiddenBodyLines = 0;
  const duration = formatDuration(result.durationMs);
  if (duration !== undefined) meta.push(duration);
  if (result.truncated) meta.push('已截断');

  if (call.name === SHELL_TOOL) {
    const lines = result.content.split('\n');
    const status = lines[0]?.trim() ?? '';
    const output = trimBlankLines(lines.slice(1));
    if (status.length > 0) meta.unshift(normalizeShellStatus(status));
    const limit = options.verbose ? (options.maxLines ?? 200) : result.ok ? 6 : 14;
    const selected = result.ok ? output.slice(0, limit) : output.slice(-limit);
    body.push(...selected);
    hiddenBodyLines = Math.max(0, output.length - selected.length);
    return { meta, body, hiddenBodyLines };
  }

  if (call.name === 'read_file' && result.ok) {
    const lines = result.content.split('\n');
    const header = /^#\s+(.+?)（共\s*(\d+)\s*行）\s*$/.exec(lines[0] ?? '');
    if (header !== null) meta.unshift(`${header[2]} 行`);
    const content = trimBlankLines(lines.slice(1));
    const limit = options.verbose ? (options.maxLines ?? 60) : 5;
    const selected = content.slice(0, limit);
    body.push(...selected.map(stripLineNumberPrefix));
    hiddenBodyLines = Math.max(0, content.length - selected.length);
    return { meta, body, hiddenBodyLines };
  }

  if (call.name === 'list_dir' && result.ok) {
    const lines = trimBlankLines(result.content.split('\n'));
    meta.unshift(`${Math.max(0, lines.length - 1)} 项`);
    return { meta, body, hiddenBodyLines: 0 };
  }

  if (call.name === 'write_file' && result.ok) {
    const size = /(?:（(\d+)\s*字符|\((\d+)\s*characters?)/.exec(result.content);
    const characters = size?.[1] ?? size?.[2];
    if (characters !== undefined) meta.unshift(`${Number(characters).toLocaleString('en-US')} 字符`);
    return { meta, body, hiddenBodyLines: 0 };
  }

  if (call.name === 'skill' && result.ok) {
    meta.unshift('已加载');
    return { meta, body, hiddenBodyLines: 0 };
  }

  if (call.name === 'todo_write' && result.ok) {
    const counts = countTodos(asRecord(call.arguments)?.['todos']);
    meta.unshift(`${counts.completed}/${counts.total} 完成`);
    return { meta, body, hiddenBodyLines: 0 };
  }

  const lines = trimBlankLines(result.content.split('\n'));
  if (!result.ok) {
    const limit = options.verbose ? (options.maxLines ?? 200) : 14;
    const selected = lines.slice(0, limit);
    body.push(...selected);
    hiddenBodyLines = Math.max(0, lines.length - selected.length);
    return { meta, body, hiddenBodyLines };
  }

  // Successful misc tools: stay quiet unless the user asked for details.
  if (options.verbose) {
    const selected = lines.slice(0, options.maxLines ?? 200);
    body.push(...selected);
    hiddenBodyLines = Math.max(0, lines.length - selected.length);
  } else if (lines.length > 0 && lines.length <= 2) {
    meta.push(firstLine(lines[0] ?? ''));
  }
  return { meta, body, hiddenBodyLines };
}

export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function toolStatusLabel(result: ToolResult | undefined, denied: boolean): string {
  if (denied) return '已拒绝';
  if (result === undefined) return '运行中';
  return result.ok ? '完成' : '失败';
}

function formatCharacters(characters: number): string {
  if (characters < 1000) return `${characters} 字符`;
  if (characters < 1_000_000) return `${(characters / 1000).toFixed(1)}K 字符`;
  return `${(characters / 1_000_000).toFixed(1)}M 字符`;
}

function normalizeShellStatus(status: string): string {
  const exit = /^exit code:\s*(-?\d+)$/.exec(status);
  if (exit !== null) return `exit ${exit[1]}`;
  return status;
}

function stripLineNumberPrefix(line: string): string {
  const match = /^\s*(\d+)\t(.*)$/.exec(line);
  return match === null ? line : `${match[1]?.padStart(4, ' ')}  ${match[2] ?? ''}`;
}

function countTodos(value: unknown): { total: number; pending: number; inProgress: number; completed: number } {
  const todos = Array.isArray(value) ? value : [];
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const item of todos) {
    const status = asRecord(item)?.['status'];
    if (status === 'completed') completed += 1;
    else if (status === 'in_progress') inProgress += 1;
    else pending += 1;
  }
  return { total: todos.length, pending, inProgress, completed };
}

export function firstLine(value: string): string {
  const newline = value.indexOf('\n');
  return (newline === -1 ? value : value.slice(0, newline)).trim();
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim().length === 0) start += 1;
  while (end > start && (lines[end - 1] ?? '').trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
