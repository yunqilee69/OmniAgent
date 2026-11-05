import { describe, expect, it } from 'vitest';
import { createTheme, stripAnsi } from './ansi';
import { MarkdownStream, parseInline, renderMarkdown, wrapSegments } from './markdown';
import { TuiRenderer, sanitizeTerminal } from './render';
import { describeToolCall, describeToolResult } from './tools';

function renderer(): { output: () => string; tui: TuiRenderer } {
  let output = '';
  const tui = new TuiRenderer({
    write: (chunk) => { output += chunk; },
    theme: createTheme({ enabled: true }),
    interactive: false,
    thinking: 'off',
    width: () => 100,
  });
  return { output: () => output, tui };
}

describe('TUI terminal safety', () => {
  it('removes escape, carriage-return, and bidi controls while keeping line breaks', () => {
    expect(sanitizeTerminal('safe\ttext\n\u001b[31mred\u001b[0m\r\n\u202Etxt')).toBe('safe\ttext\n[31mred[0m\ntxt');
  });

  it('sanitizes streamed model text before writing it to the terminal', () => {
    const { output, tui } = renderer();
    tui.handle({ type: 'assistant.delta', text: '\u001b[2J\u001b]0;pwned\u0007ok' });
    tui.beforePrompt();
    const rendered = output();
    expect(rendered).toContain('[2J]0;pwnedok');
    expect(rendered).not.toContain('\u001b[2J');
  });

  it('sanitizes tool output and errors while preserving renderer styling', () => {
    const tool = renderer();
    tool.tui.handle({
      type: 'tool.result',
      result: { callId: 'c', name: 'bash', ok: false, content: '\u001b[2Jsecret\u001b[0m', truncated: false },
    });
    expect(tool.output()).toContain('\x1b[31m✗\x1b[0m');
    expect(tool.output()).not.toContain('\u001b[2J');

    const error = renderer();
    error.tui.handle({ type: 'error', error: { message: '\u001b[31mboom\u001b[0m' } });
    expect(error.output()).toContain('错误：');
    expect(error.output()).not.toContain('\u001b[31mboom');
  });
});

describe('Markdown rendering', () => {
  const plain = createTheme({ enabled: false });
  const markdown = (text: string, width = 72): string =>
    renderMarkdown(text, { theme: plain, width: () => width });

  it('renders headings, emphasis, lists, fences, and tables without markers', () => {
    const output = markdown([
      '# 标题',
      '',
      '一段 **粗体**、*斜体*、`code` 和 [链接](https://example.com)。',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '```ts',
      'const value: number = 1;',
      '```',
      '',
      '| 名称 | 数量 |',
      '| --- | ---: |',
      '| a | 12 |',
      '| bb | 3 |',
    ].join('\n'));

    expect(output).toContain('标题');
    expect(output).toContain('粗体');
    expect(output).toContain('斜体');
    expect(output).toContain('code');
    expect(output).toContain('https://example.com');
    expect(output).toContain('• 第一项');
    expect(output).toContain('╭─ ts');
    expect(output).toContain('│ 名称 │ 数量 │');
    expect(output).toContain('│ a    │   12 │');
    expect(output).not.toContain('```');
    expect(output).not.toContain('**');
  });

  it('keeps streaming chunks intact until a complete line arrives', () => {
    let output = '';
    const stream = new MarkdownStream((chunk) => { output += chunk; }, { theme: plain, width: () => 80 });
    stream.push('**bold');
    expect(output).toBe('');
    stream.push('**\nnext');
    expect(output).toContain('bold');
    expect(output).not.toContain('**');
    expect(output).not.toContain('next');
    stream.end();
    expect(output).toContain('next');
  });

  it('wraps CJK text by display width', () => {
    const lines = wrapSegments([{ text: '一二三四五六七八九十', style: {} }], 6);
    expect(lines.map((line) => line.map((segment) => segment.text).join(''))).toEqual(['一二三', '四五六', '七八九', '十']);
  });

  it('parses nested inline emphasis and leaves unmatched markers alone', () => {
    expect(parseInline('**粗体 `code`**').map((segment) => segment.text).join('')).toBe('粗体 code');
    expect(parseInline('a * b').map((segment) => segment.text).join('')).toBe('a * b');
  });
});

describe('TuiRenderer blocks', () => {
  function harness(options: {
    thinking?: 'full' | 'compact' | 'off';
    verbose?: boolean;
  } = {}): { output: () => string; text: () => string; tui: TuiRenderer } {
    let output = '';
    const tui = new TuiRenderer({
      write: (chunk) => { output += chunk; },
      theme: createTheme({ enabled: false }),
      interactive: false,
      width: () => 80,
      ...options,
    });
    return { output: () => output, text: () => stripAnsi(output), tui };
  }

  it('renders streaming reasoning, markdown body, and a tool result card', () => {
    const { text, tui } = harness();
    tui.handle({ type: 'turn.start', step: 0 });
    tui.handle({ type: 'assistant.reasoning.delta', text: '先分析**需求**。\n' });
    tui.handle({ type: 'assistant.delta', text: '## 结果\n\n完成了 `read_file`。\n' });
    tui.handle({ type: 'assistant.message', message: { role: 'assistant', content: [{ type: 'text', text: '## 结果' }], toolCalls: [] } });
    tui.handle({ type: 'tool.call', call: { id: 'c1', name: 'read_file', arguments: { path: 'README.md' } } });
    tui.handle({
      type: 'tool.result',
      result: {
        callId: 'c1', name: 'read_file', ok: true, truncated: false, durationMs: 12,
        content: '# README.md（共 2 行）\n    1\t# Hi\n    2\ttext',
      },
    });
    tui.handle({ type: 'turn.end', reason: 'end_turn' });

    const output = text();
    expect(output).toContain('✻ 思考');
    expect(output).toContain('先分析需求。');
    expect(output).toContain('结果');
    expect(output).toContain('✓ 读取文件 · README.md · 2 行 · 12ms');
    expect(output).toContain('│    1  # Hi');
    expect(output).not.toContain('```');
  });

  it('renders assistant text when the provider does not stream', () => {
    const { text, tui } = harness();
    tui.handle({
      type: 'assistant.message',
      message: { role: 'assistant', content: [{ type: 'text', text: '**完成**\n' }], toolCalls: [] },
    });
    expect(text()).toContain('完成');
    expect(text()).not.toContain('**');
  });

  it('supports compact and hidden reasoning modes', () => {
    const compact = harness({ thinking: 'compact' });
    compact.tui.handle({ type: 'assistant.reasoning.delta', text: '第一段思考。\n第二段。' });
    compact.tui.handle({ type: 'assistant.delta', text: '答案。\n' });
    expect(compact.text()).toContain('✻ 思考 · 第一段思考。');
    expect(compact.text()).not.toContain('第二段。');

    const off = harness({ thinking: 'off' });
    off.tui.handle({ type: 'assistant.reasoning.delta', text: '不可见。' });
    off.tui.handle({ type: 'assistant.delta', text: '答案。\n' });
    expect(off.text()).not.toContain('不可见');
    expect(off.text()).not.toContain('思考');
  });

  it('shows more tool output only in verbose mode', () => {
    const normal = harness();
    const verbose = harness({ verbose: true });
    const result = {
      callId: 'c1', name: 'bash', ok: false, truncated: false, durationMs: 5,
      content: `exit code: 1\n${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')}`,
    };
    for (const item of [normal, verbose]) {
      item.tui.handle({ type: 'tool.call', call: { id: 'c1', name: 'bash', arguments: { command: 'npm test' } } });
      item.tui.handle({ type: 'tool.result', result });
    }
    expect(normal.text()).toContain('line 20');
    expect(normal.text()).toContain('还有 6 行');
    expect(verbose.text()).toContain('line 1');
    expect(verbose.text()).toContain('line 20');
  });

  it('does not duplicate an answer already shown by the approval prompt', () => {
    const { text, tui } = harness();
    tui.showPermissionRequest({
      id: 'c1',
      call: { id: 'c1', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } },
      reason: '需要写入工作区',
    });
    tui.recordPermissionAnswer(false, 'c1');
    tui.handle({ type: 'permission.decided', callId: 'c1', decision: 'deny', source: 'test' });
    tui.handle({
      type: 'tool.result',
      result: { callId: 'c1', name: 'write_file', ok: false, content: 'denied', truncated: false },
    });
    expect(text().match(/已拒绝/g)).toHaveLength(1);
    expect(text()).toContain('需要授权');
    expect(text()).toContain('需要写入工作区');
    expect(text()).not.toContain('denied');
  });
});

describe('tool summaries', () => {
  it('derives readable call and result summaries per tool', () => {
    const call = describeToolCall({ id: 'c1', name: 'bash', arguments: { command: 'npm test' } });
    expect(call).toMatchObject({ title: '执行命令', summary: '$ npm test' });

    const read = describeToolResult(
      { id: 'c2', name: 'read_file', arguments: { path: 'a.txt' } },
      { callId: 'c2', name: 'read_file', ok: true, truncated: false, durationMs: 1500, content: '# a.txt（共 3 行）\n    1\tone' },
      { verbose: false },
    );
    expect(read.meta).toContain('3 行');
    expect(read.meta).toContain('1.5s');
  });
});

