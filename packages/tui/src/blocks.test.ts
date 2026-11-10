import { describe, expect, it } from 'vitest';
import { createTheme } from './ansi';
import {
  formatElapsed,
  helpGroups,
  promptText,
  reasoningHeader,
  reasoningPrefix,
  statusLine,
  toolFoldNote,
  toolHeader,
  turnSummary,
} from './blocks';
import { createRoles, ROLE_NAMES, roleViolations } from './palette';

const plain = createTheme({ enabled: false });
const roles = createRoles(plain);
const colored = createRoles(createTheme({ enabled: true }));

describe('角色调色板', () => {
  it('covers every role with a wrapper and keeps the text intact when color is off', () => {
    for (const role of ROLE_NAMES) {
      expect(roles[role]('x')).toBe('x');
    }
    expect(roleViolations(ROLE_NAMES.map((role) => colored[role]('x')).join(''))).toEqual([]);
  });

  it('keeps dim relative to the terminal foreground instead of pinning a gray', () => {
    expect(colored.dim('x')).toBe('\x1b[2mx\x1b[0m');
    expect(colored.dimItalic('x')).toBe('\x1b[2;3mx\x1b[0m');
  });

  it('rejects 24-bit, extended-palette, and background colors', () => {
    expect(roleViolations('\x1b[38;2;1;2;3mx\x1b[0m')).toHaveLength(1);
    expect(roleViolations('\x1b[38;5;200mx\x1b[0m')).toHaveLength(1);
    expect(roleViolations('\x1b[48;5;200mx\x1b[0m')).toHaveLength(1);
    expect(roleViolations('\x1b[1;96mx\x1b[0m')).toEqual([]);
  });
});

describe('块构建', () => {
  it('gives reasoning and tools different rails', () => {
    expect(reasoningPrefix(roles)).toBe('  ┊ ');
    expect(toolHeader(roles, { title: '读取文件', name: 'read_file', status: 'ok' })).toBe('  ● 工具 / 读取文件');
    expect(toolFoldNote(roles, 6, false)).toBe('  │ … 还有 6 行（/verbose 展开）');
    expect(toolFoldNote(roles, 6, true)).toBe('  │ … 还有 6 行');
  });

  it('colors the whole tool header by outcome and keeps detail dim', () => {
    const ok = toolHeader(colored, { title: '执行命令', name: 'bash', status: 'ok', summary: '$ ls', meta: ['exit 0'] });
    expect(ok).toContain('\x1b[32m●\x1b[0m');
    expect(ok).toContain('\x1b[32m工具 / 执行命令\x1b[0m');
    const failed = toolHeader(colored, { title: '执行命令', name: 'bash', status: 'error' });
    expect(failed).toContain('\x1b[31m●\x1b[0m');
    const denied = toolHeader(colored, { title: '写入文件', name: 'write_file', status: 'denied' });
    expect(denied).toContain('\x1b[93m⊘\x1b[0m');
  });

  it('truncates the summary instead of pushing the meta off the row', () => {
    const row = toolHeader(roles, {
      title: '执行命令', name: 'bash', status: 'ok',
      summary: `$ ${'x'.repeat(200)}`, meta: ['exit 0'], width: 60,
    });
    expect(row.length).toBeLessThan(140);
    expect(row).toContain('…');
    expect(row).toContain('exit 0');
  });

  it('formats the reasoning header with and without a summary', () => {
    expect(reasoningHeader(roles)).toBe('  ✻ 思考');
    expect(reasoningHeader(roles, { summary: '先看目录' })).toBe('  ✻ 思考 · 先看目录');
  });

  it('always closes a turn with a summary line', () => {
    expect(turnSummary(roles, { kind: 'done' })).toBe('  ✓ 完成');
    expect(turnSummary(roles, { kind: 'done', elapsedMs: 8000 })).toBe('  ✓ 完成 · 8.0s');
    expect(turnSummary(roles, { kind: 'interrupted' })).toBe('  ■ 已中断');
    expect(turnSummary(roles, { kind: 'max_steps' })).toBe('  ■ 达到最大步数');
  });
});

describe('状态行', () => {
  it('splits session, permission, model, mode, and todos', () => {
    const line = statusLine(roles, {
      sessionId: 'a1b2c3d4-9999', permission: 'workspace-write', model: 'deepseek-chat',
      mode: 'chat', todos: { done: 2, total: 5 },
    });
    expect(line).toBe('  a1b2c3d4 · workspace-write · deepseek-chat · chat · 2/5 todos');
  });

  it('drops the least important segment first when the terminal is narrow', () => {
    const options = {
      sessionId: 'a1b2c3d4-9999', permission: 'workspace-write', model: 'deepseek-chat',
      mode: 'chat' as const, todos: { done: 2, total: 5 },
    };
    const wide = statusLine(roles, { ...options, width: 100 });
    const medium = statusLine(roles, { ...options, width: 42 });
    const narrow = statusLine(roles, { ...options, width: 26 });
    expect(wide).toContain('a1b2c3d4');
    expect(medium).not.toContain('a1b2c3d4');
    expect(medium).toContain('workspace-write');
    expect(narrow.length).toBeLessThanOrEqual(26);
  });

  it('marks plan mode and the missing permission explicitly', () => {
    expect(statusLine(roles, { sessionId: 'x', permission: null, model: 'm', mode: 'plan' }))
      .toBe('  x · permission required · m · plan');
  });

  it('exposes a single prompt glyph so readline width stays predictable', () => {
    expect(promptText(roles)).toBe('  ❯ ');
  });
});

describe('帮助', () => {
  it('groups commands and keeps every command documented', () => {
    const commands = helpGroups().flatMap((group) => group.rows.map((row) => row.command));
    expect(commands).toContain('/init [notes]');
    expect(commands).toContain('/color [on|off]');
    expect(commands).toContain('/think [full|compact|off]');
    expect(new Set(commands).size).toBe(commands.length);
  });
});

describe('计时', () => {
  it('scales from tenths to minutes', () => {
    expect(formatElapsed(0)).toBe('0.0s');
    expect(formatElapsed(1500)).toBe('1.5s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(8000)).toBe('8.0s');
    expect(formatElapsed(65_000)).toBe('1m05s');
  });
});
