import type { AgentEvent, PermissionRequest, StopReason, ToolCall, ToolResult } from '@omniagent/core';
import { assistantText } from '@omniagent/core';
import type { Theme } from './ansi';
import { createTheme, displayWidth, truncateDisplay } from './ansi';
import {
  GLYPH,
  assistantLabel,
  formatElapsed,
  helpGroups,
  joinParts,
  noticeLine,
  reasoningHeader,
  reasoningPrefix,
  separator,
  statusLine,
  toolBodyLine,
  toolFoldNote,
  toolHeader,
  turnSummary,
  type ToolStatus,
  type TurnOutcome,
} from './blocks';
import { MarkdownStream, wrapSegments } from './markdown';
import { createRoles, type Roles } from './palette';
import { describeToolCall, describeToolResult, type ToolCallInfo } from './tools';

/**
 * 事件流 -> 终端文本。
 *
 * 渲染器只消费 AgentEvent，不知道 Session 和模型怎么工作；main.ts 负责
 * readline、权限问答和 slash 命令。这样以后换 Ink 或 Web 只替换这一层。
 *
 * 排版规则集中在 blocks.ts：这里只决定「什么时候输出哪个块、块与块之间要不要
 * 空行」。四类内容的左缘互不相同（正文 2 空格、思考 `┊`、工具体 `│`、其余用
 * 引导符），因此长对话里可以靠列位和颜色扫读，而不必逐字阅读。
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

/** 运行态状态行：无内容可看时（等首个 token、工具执行中）用它报告「还在动」。 */
const WAITING_LABEL = '等待模型';

/** 块的身份，用于决定两块之间要不要空行。 */
type BlockKind = 'reasoning' | 'markdown' | 'tool' | 'notice' | 'summary' | 'none';

export class TuiRenderer {
  readonly theme: Theme;
  readonly roles: Roles;
  private readonly writeFn: (chunk: string) => void;
  private readonly widthFn: () => number;
  private readonly interactive: boolean;
  private thinkingMode: ThinkingMode;
  private verbose: boolean;

  private reasoningRaw = '';
  private reasoningStream?: MarkdownStream;
  private reasoningHeaderShown = false;
  private reasoningStartedAt = 0;

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
  private spinnerActive = false;
  private pendingStartedAt = 0;
  private turnStartedAt = 0;

  /** 上一个写出的块，用于压缩空行。 */
  private lastBlock: BlockKind = 'none';
  /** 本回合是否已经打出 `Assistant` 标签。 */
  private assistantLabeled = false;

  private wroteOutput = false;
  private newlines = 0;

  constructor(options: TuiRendererOptions = {}) {
    this.theme = options.theme ?? createTheme();
    this.roles = createRoles(this.theme);
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

  /** `/color` 用；只影响之后写出的内容，已经落到终端的历史行不会重绘。 */
  setColor(enabled: boolean): void {
    this.theme.enabled = enabled;
  }

  get color(): boolean {
    return this.theme.enabled;
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'turn.start':
        this.stopSpinner();
        this.endBlocks();
        this.streamedText = '';
        this.assistantLabeled = false;
        this.turnStartedAt = Date.now();
        this.startSpinner();
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
        this.write(`${noticeLine(this.roles, 'context', `上下文压缩 · ${event.beforeTokens} → ${event.afterTokens} tokens`)}\n`);
        this.lastBlock = 'notice';
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
        this.write(`${noticeLine(this.roles, 'error', `错误：${sanitizeTerminal(event.error.message)}`)}\n`);
        this.lastBlock = 'notice';
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
    this.lastBlock = 'none';
  }

  /** Print the approval card and return the readline prompt. */
  showPermissionRequest(request: PermissionRequest): string {
    this.beforePrompt();
    const info = describeToolCall({
      id: request.call.id,
      name: request.call.name,
      arguments: request.call.arguments,
    });
    this.write(`${GLYPH.indent}${this.roles.attention(GLYPH.warn)} ${this.roles.attention('需要授权')}${separator(this.roles)}${this.roles.accentBold(sanitizeTerminal(info.title))}\n`);
    if (info.summary.length > 0) {
      this.write(`${GLYPH.indent}${this.roles.dim('操作')}  ${sanitizeTerminal(info.summary)}\n`);
    }
    if (info.detail !== undefined) {
      this.write(`${GLYPH.indent}  ${this.roles.dim('提升')}  ${this.roles.attention(sanitizeTerminal(info.detail))}\n`);
    }
    this.write(`${GLYPH.indent}  ${this.roles.dim('原因')}  ${this.roles.dim(sanitizeTerminal(request.reason))}\n`);
    this.lastBlock = 'notice';
    return `${GLYPH.indent}${this.roles.accentBold('允许执行？(y/N) ')}`;
  }

  recordPermissionAnswer(allowed: boolean, callId?: string): void {
    if (callId !== undefined) this.answered.set(callId, allowed);
    this.write(allowed
      ? `${noticeLine(this.roles, 'info', '已允许')}\n`
      : `${noticeLine(this.roles, 'warn', '已拒绝')}\n`);
    this.lastBlock = 'notice';
  }

  /** Write preformatted UI text (banner, command output) as-is. */
  print(text: string): void {
    this.write(text);
  }

  private get width(): number {
    return Math.max(24, this.widthFn());
  }

  /**
   * 输出闸门：连续空行最多留一个。
   *
   * 模型正文常以空行结尾，块切换时渲染器又会补空行，两层叠加就会在段落之间留
   * 下两三个空行。这里在写入路径上统一压回一个，块间距只由 `enterBlock` 决定。
   */
  private write(chunk: string): void {
    if (chunk.length === 0) return;
    let output = '';
    for (const char of chunk) {
      if (char === '\n') {
        if (this.newlines >= 2) continue;
        this.newlines += 1;
        this.wroteOutput = true;
        output += char;
      } else {
        this.newlines = 0;
        this.wroteOutput = true;
        output += char;
      }
    }
    if (output.length > 0) this.writeFn(output);
  }

  private ensureBlankLine(): void {
    if (this.wroteOutput && this.newlines < 2) this.write('\n');
  }

  // -- 块间距 ---------------------------------------------------------------

  /**
   * 进入一个新块：同类块之间只换行，跨类块之间留一个空行。
   *
   * 连续三个工具调用因此读起来是一列卡片，而不是被空行打散的三段；而思考、
   * 正文、工具之间总有空行，四类内容才有清晰的段落边界。
   */
  private enterBlock(kind: BlockKind): void {
    this.closePending();
    // 连续的卡片/通知本来就靠导轨和引导符分界，再加空行会把一列卡片打散；
    // 其余情况（包括同类块）都留一个空行，段落边界才稳定。
    const tight = kind === 'tool' || kind === 'notice';
    if (tight && this.lastBlock === kind) this.ensureLineBreak();
    else this.ensureBlankLine();
    this.lastBlock = kind;
  }

  private ensureLineBreak(): void {
    if (this.wroteOutput && this.newlines === 0) this.write('\n');
  }

  // -- 思考 -----------------------------------------------------------------

  private consumeReasoning(text: string): void {
    if (text.length === 0) return;
    this.reasoningRaw += text;
    if (this.thinkingMode !== 'full') return;
    this.stopSpinner();
    this.ensureReasoning();
    this.reasoningStream?.push(sanitizeTerminal(text));
  }

  private ensureReasoning(): void {
    if (this.reasoningHeaderShown) return;
    this.reasoningHeaderShown = true;
    this.reasoningStartedAt = Date.now();
    this.enterBlock('reasoning');
    this.write(`${reasoningHeader(this.roles)}\n`);
    this.reasoningStream = new MarkdownStream((chunk) => this.write(chunk), {
      theme: this.theme,
      width: () => this.width,
      baseStyle: { dim: true, italic: true },
      linePrefix: reasoningPrefix(this.roles),
    });
  }

  private endReasoning(): void {
    if (this.thinkingMode === 'full') {
      this.reasoningStream?.end();
    } else if (this.thinkingMode === 'compact' && this.reasoningRaw.trim().length > 0) {
      this.stopSpinner();
      const summaryLine = this.reasoningRaw
        .split('\n')
        .map((line) => plainText(line))
        .find((line) => line.length > 0) ?? '';
      const summary = truncateDisplay(summaryLine, Math.max(16, this.width - 18));
      this.enterBlock('reasoning');
      this.write(`${reasoningHeader(this.roles, { summary })}\n`);
    }
    this.reasoningRaw = '';
    this.reasoningStream = undefined;
    this.reasoningHeaderShown = false;
  }

  // -- 正文 -----------------------------------------------------------------

  private ensureMarkdown(): void {
    if (this.markdown !== undefined) return;
    this.enterBlock('markdown');
    if (!this.assistantLabeled) {
      this.assistantLabeled = true;
      this.write(`${assistantLabel(this.roles)}\n`);
    }
    this.markdownWrote = false;
    this.markdown = new MarkdownStream((chunk) => {
      if (chunk.trim().length > 0) this.markdownWrote = true;
      this.write(chunk);
    }, { theme: this.theme, width: () => this.width, linePrefix: GLYPH.indent });
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

  // -- 工具 -----------------------------------------------------------------

  private startTool(call: ToolCall): void {
    const info = describeToolCall(call);
    this.calls.set(call.id, { call, info });
    this.enterBlock('tool');
    if (!this.interactive) return;
    const row = toolHeader(this.roles, {
      title: sanitizeTerminal(info.title),
      name: sanitizeTerminal(call.name),
      summary: sanitizeTerminal(info.summary),
      status: 'pending',
      width: this.width,
    });
    this.write(`\r\x1b[2K${row}`);
    this.pendingOpen = true;
    this.pendingCallId = call.id;
    this.pendingStartedAt = Date.now();
    // 运行中的卡片自己就是进度指示，但长命令需要知道已经等了多久。
    this.ensureTicker();
  }

  private finishTool(result: ToolResult): void {
    const stored = this.calls.get(result.callId);
    const call = stored?.call ?? { id: result.callId, name: result.name, arguments: {} };
    const info = stored?.info ?? describeToolCall(call);
    const denied = this.denied.has(result.callId);
    const outcome = describeToolResult(call, result, { verbose: this.verbose });
    const status: ToolStatus = denied ? 'denied' : result.ok ? 'ok' : 'error';
    const row = toolHeader(this.roles, {
      title: sanitizeTerminal(info.title),
      name: sanitizeTerminal(call.name),
      summary: sanitizeTerminal(info.summary),
      status,
      meta: outcome.meta.map(sanitizeTerminal),
      width: this.width,
    });

    if (this.pendingOpen && this.pendingCallId === result.callId) {
      this.pendingOpen = false;
      this.pendingCallId = undefined;
      this.stopSpinner();
      this.write(`\r\x1b[2K${row}\n`);
    } else {
      this.closePending();
      this.ensureLineBreak();
      this.write(`${row}\n`);
    }

    if (info.detail !== undefined) {
      this.write(`${GLYPH.indent}${this.roles.dim('提升')}  ${this.roles.attention(sanitizeTerminal(info.detail))}\n`);
    }

    if (!denied) {
      for (const line of outcome.body) {
        this.writeBodyLine(line, !result.ok);
      }
      if (outcome.hiddenBodyLines > 0) {
        this.write(`${toolFoldNote(this.roles, outcome.hiddenBodyLines, this.verbose)}\n`);
      }
    }

    this.calls.delete(result.callId);
    this.denied.delete(result.callId);
    this.lastBlock = 'tool';
  }

  private writeBodyLine(text: string, failed: boolean): void {
    const value = sanitizeTerminal(text);
    // Keep significant indentation (line numbers, nested output) on the first line.
    const leading = /^\s*/.exec(value)?.[0] ?? '';
    const rest = value.slice(leading.length);
    const available = Math.max(1, this.width - 6 - displayWidth(leading));
    const lines = rest.length > 0
      ? wrapSegments([{ text: rest, style: {} }], available)
      : [[]];
    if (lines.length === 0) {
      this.write(`${toolBodyLine(this.roles, '', failed)}\n`);
      return;
    }
    lines[0] = [{ text: leading, style: {} }, ...(lines[0] ?? [])];
    for (const line of lines) {
      this.write(`${toolBodyLine(this.roles, line.map((segment) => segment.text).join(''), failed)}\n`);
    }
  }

  private handlePermission(callId: string, decision: 'allow' | 'deny', source: string): void {
    const alreadyAnswered = this.answered.get(callId) === false;
    if (decision === 'allow') {
      if (!this.verbose) return;
      this.closePending();
      this.write(`${noticeLine(this.roles, 'info', `权限 allow（${sanitizeTerminal(source)}）`)}\n`);
      this.lastBlock = 'notice';
      return;
    }
    this.denied.add(callId);
    this.answered.delete(callId);
    if (alreadyAnswered) return;
    this.closePending();
    this.write(`${noticeLine(this.roles, 'warn', `已拒绝 · ${sanitizeTerminal(source)}`)}\n`);
    this.lastBlock = 'notice';
  }

  // -- 回合结束 -------------------------------------------------------------

  private turnEnd(reason: StopReason): void {
    const elapsed = this.turnStartedAt === 0 ? undefined : Date.now() - this.turnStartedAt;
    const outcome: TurnOutcome = reason === 'interrupted'
      ? { kind: 'interrupted' }
      : reason === 'max_steps'
        ? { kind: 'max_steps' }
        : reason === 'max_tokens'
          ? { kind: 'max_tokens' }
          : reason === 'error'
            ? { kind: 'error' }
            : { kind: 'done', ...(elapsed === undefined ? {} : { elapsedMs: elapsed }) };
    // 尾行总是跟着上一个块，不再单独补空行，避免正文和尾行之间出现断层。
    this.closePending();
    this.ensureLineBreak();
    this.write(`${turnSummary(this.roles, outcome)}\n`);
    this.ensureBlankLine();
    this.lastBlock = 'summary';
    this.turnStartedAt = 0;
    this.assistantLabeled = false;
  }

  private closePending(): void {
    if (!this.pendingOpen) return;
    this.write('\n');
    this.pendingOpen = false;
    this.pendingCallId = undefined;
  }

  // -- 运行态状态行 ---------------------------------------------------------

  /**
   * 「还在动」提示：等待模型时是转圈 + 耗时，工具执行时是原地刷新卡片头部的耗时。
   *
   * 两类内容都只占一行、靠 `\r\x1b[2K` 原地位刷新，因此不会污染已经写出的对话。
   * 一旦有正文、思考或结果落地，就因为「有内容可看」而停止——不需要一个常驻底栏。
   */
  private startSpinner(): void {
    if (!this.interactive) return;
    this.stopSpinner();
    this.spinnerFrame = 0;
    this.spinnerActive = true;
    this.renderSpinner();
    this.ensureTicker();
  }

  private ensureTicker(): void {
    if (!this.interactive || this.spinner !== undefined) return;
    // 计时以秒为单位，120ms 足够让转圈连续，又不至于狂写终端。
    this.spinner = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.renderSpinner();
    }, 120);
    this.spinner.unref();
  }

  private renderSpinner(): void {
    if (!this.interactive) return;
    if (this.pendingOpen) {
      const pending = this.calls.get(this.pendingCallId ?? '');
      if (pending !== undefined) {
        const row = toolHeader(this.roles, {
          title: sanitizeTerminal(pending.info.title),
          name: sanitizeTerminal(pending.call.name),
          summary: sanitizeTerminal(pending.info.summary),
          status: 'pending',
          meta: [formatElapsed(Date.now() - this.pendingStartedAt)],
          width: this.width,
        });
        this.writeFn(`\r\x1b[2K${row}`);
      }
      return;
    }
    if (!this.spinnerActive) return;
    const frame = SPINNER_FRAMES[this.spinnerFrame] ?? '⠋';
    const elapsed = this.turnStartedAt === 0 ? '' : ` ${formatElapsed(Date.now() - this.turnStartedAt)}`;
    this.writeFn(`\r\x1b[2K${GLYPH.indent}${this.roles.warning(frame)} ${this.roles.dim(WAITING_LABEL)}${this.roles.dim(elapsed)}`);
  }

  private stopSpinner(): void {
    if (this.spinner !== undefined) {
      clearInterval(this.spinner);
      this.spinner = undefined;
    }
    if (this.spinnerActive) {
      this.writeFn('\r\x1b[2K');
      this.spinnerActive = false;
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
  const roles = createRoles(theme);
  const workspace = truncateDisplay(info.workspace, Math.max(20, width - info.permission.length - 8));
  const detail = joinParts(roles, [
    roles.dim(sanitizeTerminal(workspace)),
    roles.warning(sanitizeTerminal(info.permission)),
    roles.dim(sanitizeTerminal(info.sessionId)),
  ]);
  return [
    `${GLYPH.indent}${roles.accentBold(`◆ OmniAgent`)}${separator(roles)}${roles.accent(sanitizeTerminal(info.model))}`,
    `${GLYPH.indent}${detail}`,
    `${GLYPH.indent}${roles.dim('/help 查看命令')}${separator(roles)}${roles.dim('exit 退出')}`,
    '',
    '',
  ].join('\n');
}

/**
 * `/help`：按用途分组，命令列按**显示宽度**补齐。
 *
 * 原来用 `padEnd` 按字符数补齐，中文命令名会把右列推歪；`displayWidth` 把 CJK
 * 记作两格，列才对得齐。
 */
export function renderHelp(theme: Theme): string {
  const roles = createRoles(theme);
  const groups = helpGroups();
  const left = Math.max(...groups.flatMap((group) => group.rows.map((row) => displayWidth(row.command))));
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`${GLYPH.indent}${roles.dim(group.title)}`);
    for (const row of group.rows) {
      const padding = ' '.repeat(Math.max(0, left - displayWidth(row.command) + 2));
      lines.push(`${GLYPH.indent}${roles.accent(row.command)}${padding}${roles.dim(row.description)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface StatusLineInfo {
  sessionId: string;
  permission: string | null;
  model: string;
  plan: boolean;
  todos: { done: number; total: number } | null;
}

/** 输入提示上方的状态行；main.ts 在每次 `rl.question` 前打印它。 */
export function renderStatus(info: StatusLineInfo, theme: Theme, width = process.stdout.columns || 100): string {
  const roles = createRoles(theme);
  return statusLine(roles, {
    sessionId: info.sessionId,
    permission: info.permission,
    model: info.model,
    mode: info.plan ? 'plan' : 'chat',
    ...(info.todos === null ? {} : { todos: info.todos }),
    width,
  });
}

export function renderPrompt(theme: Theme): string {
  const roles = createRoles(theme);
  return `${GLYPH.indent}${roles.accentBold(GLYPH.prompt)} `;
}

/** 供 main.ts 复用：把一段 Markdown 用正文的缩进和主题渲染出来（`/plan` 预览）。 */
export function renderBodyMarkdown(text: string, theme: Theme, width: number): string {
  return renderMarkdownWith(text, theme, width, GLYPH.indent);
}

function renderMarkdownWith(text: string, theme: Theme, width: number, prefix: string): string {
  let output = '';
  const stream = new MarkdownStream((chunk) => { output += chunk; }, {
    theme,
    width: () => width,
    linePrefix: prefix,
  });
  stream.push(text);
  stream.end();
  return output;
}

/** 供 main.ts 的 todo 列表使用：三态各自的角色。 */
export function todoMark(
  status: 'pending' | 'in_progress' | 'completed',
  theme: Theme,
): string {
  const roles = createRoles(theme);
  if (status === 'completed') return roles.success('✓');
  if (status === 'in_progress') return roles.accent('▸');
  return roles.dim('○');
}
