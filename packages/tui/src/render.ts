import type { AgentEvent, PermissionRequest, StopReason, ToolCall, ToolResult } from '@omniagent/core';
import { assistantText } from '@omniagent/core';
import type { Theme } from './ansi';
import { createTheme, displayWidth, truncateDisplay } from './ansi';
import { MarkdownStream, wrapSegments } from './markdown';
import { describeToolCall, describeToolResult, type ToolCallInfo } from './tools';

/**
 * 事件流 -> 终端文本。
 *
 * 渲染器只消费 AgentEvent，不知道 Session 和模型怎么工作；main.ts 负责
 * readline、权限问答和 slash 命令。这样以后换 Ink 或 Web 只替换这一层。
 */

export type ThinkingMode = 'full' | 'compact' | 'off';

export interface TuiRendererOptions {
  write?: (chunk: string) => void;
  theme?: Theme;
  width?: () => number;
  thinking?: ThinkingMode;
  verbose?: boolean;
  interactive?: boolean;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class TuiRenderer {
  readonly theme: Theme;
  private readonly writeFn: (chunk: string) => void;
  private readonly widthFn: () => number;
  private readonly interactive: boolean;
  private thinkingMode: ThinkingMode;
  private verbose: boolean;

  private reasoningRaw = '';
  private reasoningStream?: MarkdownStream;
  private reasoningHeaderShown = false;
  private markdown?: MarkdownStream;
  private markdownWrote = false;
  private streamedText = '';

  private calls = new Map<string, { call: ToolCall; info: ToolCallInfo }>();
  private readonly denied = new Set<string>();
  private readonly answered = new Map<string, boolean>();
  private pendingOpen = false;
  private pendingCallId?: string;

  private spinner?: NodeJS.Timeout;
  private spinnerFrame = 0;
  private spinnerLabel = '';
  private spinnerActive = false;

  private wroteOutput = false;
  private newlines = 0;

  constructor(options: TuiRendererOptions = {}) {
    this.theme = options.theme ?? createTheme();
    this.widthFn = options.width ?? (() => process.stdout.columns || 100);
    this.writeFn = options.write ?? ((chunk) => process.stdout.write(chunk));
    this.thinkingMode = options.thinking ?? 'full';
    this.verbose = options.verbose ?? false;
    this.interactive = options.interactive ?? process.stdout.isTTY === true;
  }

  setThinkingMode(mode: ThinkingMode): void {
    this.thinkingMode = mode;
  }

  get thinking(): ThinkingMode {
    return this.thinkingMode;
  }

  setVerbose(value: boolean): void {
    this.verbose = value;
  }

  get isVerbose(): boolean {
    return this.verbose;
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'turn.start':
        this.stopSpinner();
        this.endBlocks();
        this.streamedText = '';
        this.startSpinner('思考中…');
        break;

      case 'assistant.reasoning.delta':
        this.consumeReasoning(event.text);
        break;

      case 'assistant.delta':
        this.stopSpinner();
        this.endReasoning();
        this.ensureMarkdown();
        this.streamedText += event.text;
        this.markdown?.push(sanitizeTerminal(event.text));
        break;

      case 'assistant.message': {
        this.stopSpinner();
        this.endReasoning();
        // Providers without stream() deliver text only here. Streamed providers
        // already painted it, so append only a missing suffix.
        const fullText = sanitizeTerminal(assistantText(event.message));
        if (fullText.length > 0) {
          const missing = fullText.startsWith(this.streamedText)
            ? fullText.slice(this.streamedText.length)
            : this.streamedText.length === 0 ? fullText : '';
          if (missing.length > 0) {
            this.ensureMarkdown();
            this.markdown?.push(missing);
          }
        }
        this.endMarkdown();
        this.streamedText = '';
        break;
      }

      case 'tool.call':
        this.stopSpinner();
        this.endReasoning();
        this.endMarkdown();
        this.startTool(event.call);
        break;

      case 'permission.decided':
        this.handlePermission(event.callId, event.decision, event.source);
        break;

      case 'tool.result':
        this.finishTool(event.result);
        break;

      case 'context.compacted':
        this.stopSpinner();
        this.endBlocks();
        this.ensureBlankLine();
        this.line(`  ${this.theme.paint('◇', { fg: 'cyan' })} ${this.theme.paint(`上下文压缩 · ${event.beforeTokens} → ${event.afterTokens} tokens`, { dim: true })}`);
        break;

      case 'turn.end':
        this.stopSpinner();
        this.endBlocks();
        this.turnEnd(event.reason);
        break;

      case 'error':
        this.stopSpinner();
        this.endBlocks();
        this.ensureBlankLine();
        this.line(`  ${this.theme.paint('✗', { fg: 'red' })} ${this.theme.paint(`错误：${sanitizeTerminal(event.error.message)}`, { fg: 'red' })}`);
        break;

      case 'permission.requested':
        break;
    }
  }

  /** Flush live blocks and finish the current line before a readline prompt. */
  beforePrompt(): void {
    this.stopSpinner();
    this.endReasoning();
    this.endMarkdown();
    this.closePending();
    this.ensureBlankLine();
  }

  /** Print the approval card and return the readline prompt. */
  showPermissionRequest(request: PermissionRequest): string {
    this.beforePrompt();
    const info = describeToolCall({
      id: request.call.id,
      name: request.call.name,
      arguments: request.call.arguments,
    });
    const yellow = { fg: 'brightYellow' as const };
    this.write(`  ${this.theme.paint('⚠', yellow)} ${this.theme.paint('需要授权', { ...yellow, bold: true })}${this.sep()}${this.theme.paint(sanitizeTerminal(info.title), { bold: true })}\n`);
    if (info.summary.length > 0) {
      this.write(`    ${this.theme.paint('操作', { dim: true })}  ${sanitizeTerminal(info.summary)}\n`);
    }
    if (info.detail !== undefined) {
      this.write(`    ${this.theme.paint('提升', { dim: true })}  ${this.theme.paint(sanitizeTerminal(info.detail), yellow)}\n`);
    }
    this.write(`    ${this.theme.paint('原因', { dim: true })}  ${this.theme.paint(sanitizeTerminal(request.reason), { dim: true })}\n`);
    return this.theme.paint('    允许执行？(y/N) ', { bold: true });
  }

  recordPermissionAnswer(allowed: boolean, callId?: string): void {
    if (callId !== undefined) this.answered.set(callId, allowed);
    this.write(allowed
      ? `  ${this.theme.paint('✓', { fg: 'green' })} ${this.theme.paint('已允许', { dim: true })}\n`
      : `  ${this.theme.paint('⊘', { fg: 'brightYellow' })} ${this.theme.paint('已拒绝', { fg: 'brightYellow' })}\n`);
  }

  /** Write preformatted UI text (banner, command output) as-is. */
  print(text: string): void {
    this.write(text);
  }

  private get width(): number {
    return Math.max(24, this.widthFn());
  }

  private write(chunk: string): void {
    if (chunk.length === 0) return;
    this.writeFn(chunk);
    for (const char of chunk) {
      if (char === '\n') {
        this.wroteOutput = true;
        this.newlines += 1;
      } else {
        this.wroteOutput = true;
        this.newlines = 0;
      }
    }
  }

  private line(text: string): void {
    this.write(`${text}\n`);
  }

  private sep(): string {
    return this.theme.paint(' · ', { dim: true, fg: 'gray' });
  }

  private ensureBlankLine(): void {
    if (this.wroteOutput && this.newlines < 2) this.write('\n');
  }

  private consumeReasoning(text: string): void {
    if (text.length === 0) return;
    this.reasoningRaw += text;
    if (this.thinkingMode === 'off') return;
    if (this.thinkingMode === 'compact') return;
    this.stopSpinner();
    this.ensureReasoning();
    this.reasoningStream?.push(sanitizeTerminal(text));
  }

  private ensureReasoning(): void {
    if (this.reasoningHeaderShown) return;
    this.reasoningHeaderShown = true;
    this.ensureBlankLine();
    this.line(`  ${this.theme.paint('✻ 思考', { fg: 'magenta', bold: true })}`);
    this.reasoningStream = new MarkdownStream((chunk) => this.write(chunk), {
      theme: this.theme,
      width: () => this.width,
      baseStyle: { dim: true, italic: true },
      linePrefix: '  │ ',
    });
  }

  private endReasoning(): void {
    if (this.thinkingMode === 'full') {
      this.reasoningStream?.end();
      if (this.reasoningHeaderShown) this.ensureBlankLine();
    } else if (this.thinkingMode === 'compact' && this.reasoningRaw.trim().length > 0) {
      this.stopSpinner();
      const summaryLine = this.reasoningRaw
        .split('\n')
        .map((line) => plainText(line))
        .find((line) => line.length > 0) ?? '';
      const summary = truncateDisplay(summaryLine, Math.max(16, this.width - 14));
      this.ensureBlankLine();
      this.line(`  ${this.theme.paint('✻ 思考', { fg: 'magenta', bold: true })}${this.sep()}${this.theme.paint(summary, { dim: true })}`);
    }
    this.reasoningRaw = '';
    this.reasoningStream = undefined;
    this.reasoningHeaderShown = false;
  }

  private ensureMarkdown(): void {
    if (this.markdown !== undefined) return;
    this.closePending();
    this.ensureBlankLine();
    this.markdownWrote = false;
    this.markdown = new MarkdownStream((chunk) => {
      if (chunk.trim().length > 0) this.markdownWrote = true;
      this.write(chunk);
    }, { theme: this.theme, width: () => this.width, linePrefix: '  ' });
  }

  private endMarkdown(): void {
    if (this.markdown === undefined) return;
    this.markdown.end();
    this.markdown = undefined;
    if (this.markdownWrote) this.write('\n');
    this.markdownWrote = false;
  }

  private endBlocks(): void {
    this.endReasoning();
    this.endMarkdown();
  }

  private startTool(call: ToolCall): void {
    this.closePending();
    const info = describeToolCall(call);
    this.calls.set(call.id, { call, info });
    if (!this.interactive) return;
    const status = this.theme.paint('◐', { fg: 'cyan' });
    const meta = this.theme.paint('运行中', { dim: true, fg: 'gray' });
    const title = truncateDisplay(sanitizeTerminal(info.title), Math.max(8, this.width - 24));
    const fixed = 2 + 1 + 1 + displayWidth(title) + 3 + 3 + displayWidth('运行中');
    const summaryText = truncateDisplay(sanitizeTerminal(info.summary), Math.max(0, this.width - fixed));
    const summary = summaryText.length > 0 ? `${this.sep()}${summaryText}` : '';
    this.write(`\r\x1b[2K  ${status} ${this.theme.paint(title, { bold: true })}${summary}${this.sep()}${meta}`);
    this.pendingOpen = true;
    this.pendingCallId = call.id;
  }

  private finishTool(result: ToolResult): void {
    const stored = this.calls.get(result.callId);
    const call = stored?.call ?? { id: result.callId, name: result.name, arguments: {} };
    const info = stored?.info ?? describeToolCall(call);
    const denied = this.denied.has(result.callId);
    const outcome = describeToolResult(call, result, { verbose: this.verbose });
    const status = denied
      ? this.theme.paint('⊘', { fg: 'brightYellow' })
      : result.ok ? this.theme.paint('✓', { fg: 'green' }) : this.theme.paint('✗', { fg: 'red' });
    const title = truncateDisplay(sanitizeTerminal(info.title), Math.max(8, this.width - 28));
    const metaText = truncateDisplay(outcome.meta.map(sanitizeTerminal).join(' · '), Math.max(8, Math.floor(this.width / 2)));
    const fixed = 2 + 1 + 1 + displayWidth(title) + 3 + 3 + displayWidth(metaText);
    const summaryText = truncateDisplay(sanitizeTerminal(info.summary), Math.max(0, this.width - fixed - 1));
    const meta = metaText.length > 0
      ? `${this.sep()}${this.theme.paint(metaText, { dim: true, fg: 'gray' })}`
      : '';
    const summary = summaryText.length > 0
      ? `${this.sep()}${this.theme.paint(summaryText, {})}`
      : '';
    const row = `  ${status} ${this.theme.paint(title, { bold: true })}${summary}${meta}`;

    if (this.pendingOpen && this.pendingCallId === result.callId) {
      this.write(`\r\x1b[2K${row}\n`);
      this.pendingOpen = false;
      this.pendingCallId = undefined;
    } else {
      this.closePending();
      this.write(`${row}\n`);
    }

    if (info.detail !== undefined) {
      this.write(`    ${this.theme.paint('提升', { dim: true })}  ${this.theme.paint(sanitizeTerminal(info.detail), { fg: 'brightYellow' })}\n`);
    }

    if (!denied) {
      const style = result.ok ? { dim: true, fg: 'gray' as const } : { fg: 'red' as const };
      for (const line of outcome.body) {
        this.writeBodyLine(line, style);
      }
      if (outcome.hiddenBodyLines > 0) {
        this.writeBodyLine(`… 还有 ${outcome.hiddenBodyLines} 行${this.verbose ? '' : '（/verbose 展开）'}`, { dim: true, fg: 'gray' });
      }
    }

    this.calls.delete(result.callId);
    this.denied.delete(result.callId);
  }

  private writeBodyLine(text: string, style: { dim?: boolean; fg?: 'red' | 'gray' }): void {
    const value = sanitizeTerminal(text);
    const rail = this.theme.paint('│', { dim: true, fg: 'gray' });
    // Keep significant indentation (line numbers, nested output) on the first line.
    const leading = /^\s*/.exec(value)?.[0] ?? '';
    const rest = value.slice(leading.length);
    const available = Math.max(1, this.width - 4 - displayWidth(leading));
    const lines = rest.length > 0
      ? wrapSegments([{ text: rest, style: {} }], available)
      : [[]];
    if (lines.length === 0) {
      this.write(`  ${rail}\n`);
      return;
    }
    lines[0] = [{ text: leading, style: {} }, ...(lines[0] ?? [])];
    for (const line of lines) {
      this.write(`  ${rail} ${this.theme.paint(line.map((segment) => segment.text).join(''), style)}\n`);
    }
  }

  private handlePermission(callId: string, decision: 'allow' | 'deny', source: string): void {
    if (decision === 'allow') {
      if (!this.verbose) return;
      this.closePending();
      this.write(`  ${this.theme.paint('·', { dim: true, fg: 'gray' })} ${this.theme.paint(`权限 allow（${sanitizeTerminal(source)}）`, { dim: true, fg: 'gray' })}\n`);
      return;
    }
    this.denied.add(callId);
    const alreadyAnswered = this.answered.get(callId) === false;
    this.answered.delete(callId);
    if (alreadyAnswered) return;
    this.closePending();
    this.write(`  ${this.theme.paint('⊘', { fg: 'brightYellow' })} ${this.theme.paint(`已拒绝 · ${sanitizeTerminal(source)}`, { fg: 'brightYellow' })}\n`);
  }

  private turnEnd(reason: StopReason): void {
    if (reason === 'interrupted') {
      this.ensureBlankLine();
      this.line(`  ${this.theme.paint('■', { fg: 'brightYellow' })} ${this.theme.paint('已中断', { fg: 'brightYellow' })}`);
      return;
    }
    if (reason === 'max_steps') {
      this.ensureBlankLine();
      this.line(`  ${this.theme.paint('■', { fg: 'yellow' })} ${this.theme.paint('达到最大步数', { dim: true })}`);
      return;
    }
    if (reason === 'max_tokens') {
      this.ensureBlankLine();
      this.line(`  ${this.theme.paint('■', { fg: 'yellow' })} ${this.theme.paint('输出达到模型上限', { dim: true })}`);
      return;
    }
    this.ensureBlankLine();
  }

  private closePending(): void {
    if (!this.pendingOpen) return;
    this.write('\n');
    this.pendingOpen = false;
    this.pendingCallId = undefined;
  }

  private startSpinner(label: string): void {
    if (!this.interactive) return;
    this.stopSpinner();
    this.spinnerLabel = label;
    this.spinnerFrame = 0;
    this.spinnerActive = true;
    this.renderSpinner();
    this.spinner = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.renderSpinner();
    }, 90);
    this.spinner.unref();
  }

  private renderSpinner(): void {
    if (!this.spinnerActive) return;
    const frame = SPINNER_FRAMES[this.spinnerFrame] ?? '⠋';
    this.writeFn(`\r\x1b[2K  ${this.theme.paint(frame, { fg: 'cyan' })} ${this.theme.paint(this.spinnerLabel, { dim: true })}`);
  }

  private stopSpinner(): void {
    if (this.spinner !== undefined) {
      clearInterval(this.spinner);
      this.spinner = undefined;
    }
    if (this.spinnerActive) {
      this.writeFn('\r\x1b[2K');
      this.spinnerActive = false;
      this.spinnerLabel = '';
    }
  }
}

/** Remove terminal control characters from model and tool output. */
export function sanitizeTerminal(value: string): string {
  return value
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Strip common inline Markdown so a thinking summary stays one clean line. */
function plainText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface BannerInfo {
  model: string;
  workspace: string;
  permission: string;
  sessionId: string;
}

/** Compact DSH-style welcome header: identity, context, then discoverability. */
export function renderBanner(info: BannerInfo, theme: Theme, width = process.stdout.columns || 100): string {
  const accent = (text: string): string => theme.paint(text, { fg: 'brightCyan', bold: true });
  const dim = (text: string): string => theme.paint(text, { dim: true, fg: 'gray' });
  const workspace = truncateDisplay(info.workspace, Math.max(20, width - info.permission.length - 8));
  return [
    `  ${accent('◆ OmniAgent')}  ${theme.paint(sanitizeTerminal(info.model), {})}`,
    `  ${dim(sanitizeTerminal(workspace))}${dim(' · ')}${theme.paint(sanitizeTerminal(info.permission), { fg: 'brightYellow' })}${dim(' · ')}${dim(sanitizeTerminal(info.sessionId))}`,
    `  ${dim('/help 查看命令')}${dim(' · ')}${dim('exit 退出')}`,
    '',
  ].join('\n');
}

export function renderHelp(theme: Theme): string {
  const dim = (text: string): string => theme.paint(text, { dim: true, fg: 'gray' });
  const command = (text: string): string => theme.paint(text, { fg: 'brightCyan' });
  const rows: Array<[string, string]> = [
    ['/help', '显示这份帮助'],
    ['/think [full|compact|off]', '思考内容：完整 / 摘要 / 隐藏'],
    ['/verbose', '展开或收起工具输出'],
    ['/sessions', '列出本工作区的会话'],
    ['/resume <id>', '恢复指定会话'],
    ['/new', '新建会话'],
    ['/permission <preset>', 'read-only / workspace-write / danger-full-access'],
    ['/model [序号]', '查看或切换模型'],
    ['/plan [on|off]', '切换计划模式'],
    ['/todos', '查看当前任务清单'],
    ['/clear', '清空当前屏幕'],
    ['exit', '退出'],
  ];
  const left = Math.max(...rows.map(([name]) => displayWidth(name)));
  return [
    `  ${theme.paint('命令', { bold: true })}`,
    ...rows.map(([name, description]) => `  ${command(name.padEnd(left + 2))}${dim(description)}`),
    '',
  ].join('\n');
}
