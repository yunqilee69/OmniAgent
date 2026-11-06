/**
 * 各类终端「块」的文本构建。
 *
 * 这一层只做拼装：给定角色表和数据，返回可直接写出的字符串（含 ANSI）。它不
 * 关心事件何时到达，也不写 stdout，所以每个块的排版都能单独断言。
 *
 * 布局的核心是**三块左缘各不相同**，让一屏里的四类内容靠列位就能扫读：
 *
 *   2 空格 + Markdown     正文（助手回答、命令输出）
 *   ┊ 虚线导轨            思考
 *   │ 实线导轨            工具调用的结果体
 *   ● ✻ ✓ ◇ ✗ 引导符      工具头、思考头、回合尾行、通知
 */
import { displayWidth, truncateDisplay } from './ansi';
import type { RoleName, Roles } from './palette';

/** 引导符与导轨，集中在一处，方便测试和后续替换。 */
export const GLYPH = {
  /** 块首的缩进：所有块都从第 3 列开始，留出两个空格的呼吸位。 */
  indent: '  ',
  reasoningRail: '┊',
  toolRail: '│',
  bullet: '·',
  thinking: '✻',
  pendingRing: '○',
  doneRing: '●',
  deniedRing: '⊘',
  ok: '✓',
  fail: '✗',
  notice: '◇',
  stop: '■',
  warn: '⚠',
  prompt: '❯',
} as const;

export function separator(roles: Roles): string {
  return roles.paint('rule', ` ${GLYPH.bullet} `);
}

/** 用 `·` 把若干片段连成一行；空片段自动省略。 */
export function joinParts(roles: Roles, parts: readonly (string | undefined)[]): string {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.join(separator(roles));
}

// ---------------------------------------------------------------------------
// 思考
// ---------------------------------------------------------------------------

export interface ReasoningHeaderOptions {
  /** compact 模式把首句摘要接在头后面。 */
  summary?: string;
}

/** `✻ 思考`：思考块的唯一锚点，块体用虚线导轨 `┊` 与工具卡的实线 `│` 区分。 */
export function reasoningHeader(roles: Roles, options: ReasoningHeaderOptions = {}): string {
  const head = `${GLYPH.indent}${roles.reasoning(GLYPH.thinking)} ${roles.reasoning('思考')}`;
  if (options.summary === undefined || options.summary.length === 0) return head;
  return `${head}${separator(roles)}${roles.dim(options.summary)}`;
}

/**
 * 思考正文的每行前缀（虚线导轨）。
 *
 * Markdown 流按整行输出，把导轨做成可上色的 `linePrefix` 就能让换行、缩进、
 * 代码块都自动带上同一条导轨，而正文本身由 `baseStyle` 统一收暗、倾斜。
 */
export function reasoningPrefix(roles: Roles): string {
  return `${GLYPH.indent}${roles.paint('reasoning', GLYPH.reasoningRail)} `;
}

// ---------------------------------------------------------------------------
// 工具卡
// ---------------------------------------------------------------------------

export type ToolStatus = 'pending' | 'ok' | 'error' | 'denied';

const TOOL_HEAD_ROLE: Record<ToolStatus, 'warning' | 'success' | 'error' | 'attention'> = {
  pending: 'warning',
  ok: 'success',
  error: 'error',
  denied: 'attention',
};

const TOOL_RING: Record<ToolStatus, string> = {
  pending: GLYPH.pendingRing,
  ok: GLYPH.doneRing,
  error: GLYPH.doneRing,
  denied: GLYPH.deniedRing,
};

export interface ToolHeaderOptions {
  /** 面向人的动作名，例如「读取文件」「执行命令」；未知工具回落到工具名。 */
  title: string;
  /** 工具身份，仅在动作名缺失时使用。 */
  name: string;
  /** 一行参数摘要，例如 `README.md` 或 `$ pnpm test`。 */
  summary?: string;
  status: ToolStatus;
  /** 结果元信息，例如 `2 行`、`exit 0`、`1.2s`。 */
  meta?: readonly string[];
  /** 终端宽度，用于裁剪尾段。 */
  width?: number;
}

/**
 * 工具卡头部：整行一个状态色（待定黄 / 成功绿 / 失败红 / 拒绝亮黄），细节
 * 用 `·` 分隔。头部本身就是「这张卡的结果」这一眼可见的结论，体部只补充细节。
 */
export function toolHeader(roles: Roles, options: ToolHeaderOptions): string {
  const width = options.width ?? 100;
  const role = TOOL_HEAD_ROLE[options.status];
  const frame = `工具 / ${options.title.length > 0 ? options.title : options.name}`;

  const meta = (options.meta ?? []).filter((item) => item.length > 0).join(' · ');
  const headWidth = displayWidth(`${GLYPH.indent}${GLYPH.doneRing} `) + displayWidth(frame);
  const budget = Math.max(16, width - headWidth - (meta.length > 0 ? displayWidth(meta) + 3 : 0));
  const summary = options.summary === undefined ? '' : truncateDisplay(options.summary, budget);

  const head = `${GLYPH.indent}${roles.paint(role, TOOL_RING[options.status])} ${roles.paint(role, frame)}`;
  const detail = joinParts(roles, [summary, meta]);
  return detail.length > 0 ? `${head}${separator(roles)}${detail}` : head;
}

/** 工具结果的一行：实线导轨 + 内收正文；失败时正文转红，避免只剩头部变色。 */
export function toolBodyLine(roles: Roles, text: string, failed = false): string {
  const rail = roles.paint('rule', `${GLYPH.toolRail} `);
  if (text.length === 0) return `${GLYPH.indent}${roles.paint('rule', GLYPH.toolRail)}`;
  return `${GLYPH.indent}${rail}${failed ? roles.error(text) : roles.dim(text)}`;
}

/** 体部被裁掉多少行的折叠提示。 */
export function toolFoldNote(roles: Roles, hiddenLines: number, verbose: boolean): string {
  return toolBodyLine(roles, `… 还有 ${hiddenLines} 行${verbose ? '' : '（/verbose 展开）'}`);
}

// ---------------------------------------------------------------------------
// 助手正文与回合尾行
// ---------------------------------------------------------------------------

/** 正文的语言者标签，一回合只出现一次。 */
export function assistantLabel(roles: Roles): string {
  return `${GLYPH.indent}${roles.accentBold('Assistant')}`;
}

export type TurnOutcome =
  | { kind: 'done'; elapsedMs?: number }
  | { kind: 'interrupted' }
  | { kind: 'max_steps' }
  | { kind: 'max_tokens' }
  | { kind: 'error' };

/** 回合尾行：正常结束也留一行，让下一句提问和上一段回答之间有结构边界。 */
export function turnSummary(roles: Roles, outcome: TurnOutcome): string {
  switch (outcome.kind) {
    case 'done': {
      const elapsed = outcome.elapsedMs === undefined
        ? ''
        : `${separator(roles)}${roles.dim(formatElapsed(outcome.elapsedMs))}`;
      return `${GLYPH.indent}${roles.success(GLYPH.ok)} ${roles.dim('完成')}${elapsed}`;
    }
    case 'interrupted':
      return `${GLYPH.indent}${roles.attention(GLYPH.stop)} ${roles.attention('已中断')}`;
    case 'max_steps':
      return `${GLYPH.indent}${roles.warning(GLYPH.stop)} ${roles.dim('达到最大步数')}`;
    case 'max_tokens':
      return `${GLYPH.indent}${roles.warning(GLYPH.stop)} ${roles.dim('输出达到模型上限')}`;
    case 'error':
      return `${GLYPH.indent}${roles.error(GLYPH.fail)} ${roles.error('回合因错误结束')}`;
  }
}

// ---------------------------------------------------------------------------
// 通知行
// ---------------------------------------------------------------------------

export type NoticeKind = 'error' | 'warn' | 'info' | 'context';

const NOTICE_ROLE: Record<NoticeKind, RoleName> = {
  error: 'error',
  warn: 'attention',
  info: 'dim',
  context: 'rule',
};

const NOTICE_GLYPH: Record<NoticeKind, string> = {
  error: GLYPH.fail,
  warn: GLYPH.warn,
  info: GLYPH.notice,
  context: GLYPH.notice,
};

/** 一行通知（错误、压缩、权限决定、后台子代理事件）。 */
export function noticeLine(roles: Roles, kind: NoticeKind, text: string): string {
  const role = NOTICE_ROLE[kind];
  return `${GLYPH.indent}${roles.paint(role, NOTICE_GLYPH[kind])} ${roles.paint(role, text)}`;
}

// ---------------------------------------------------------------------------
// 状态行与输入提示
// ---------------------------------------------------------------------------

export interface StatusLineOptions {
  sessionId: string;
  permission: string | null;
  model: string;
  mode: 'plan' | 'chat';
  todos?: { done: number; total: number };
  /** 终端宽度；尾部按优先级裁剪。 */
  width?: number;
}

/** 权限预设的语义色：只读最轻，全权最重。 */
function permissionRole(preset: string | null): 'dim' | 'warning' | 'error' | 'rule' {
  if (preset === null) return 'rule';
  if (preset === 'danger-full-access') return 'error';
  if (preset === 'read-only') return 'dim';
  return 'warning';
}

/**
 * 输入提示上方那行状态。
 *
 * 分段按重要性从高到低排列，宽度不够时先丢会话 id，再丢 todo 计数，最后截断
 * 模型名——`❯` 所在的那一行永远不参与裁剪。
 */
export function statusLine(roles: Roles, options: StatusLineOptions): string {
  const width = options.width ?? 100;
  const permission = options.permission ?? 'permission required';
  const todo = options.todos === undefined || options.todos.total === 0
    ? undefined
    : `${options.todos.done}/${options.todos.total} todos`;

  const build = (parts: {
    id: boolean;
    todo: boolean;
    model: boolean;
  }): string => {
    const segments: string[] = [];
    if (parts.id) segments.push(roles.dim(options.sessionId.slice(0, 8)));
    segments.push(roles.paint(permissionRole(options.permission), permission));
    if (parts.model) segments.push(roles.accent(options.model));
    segments.push(options.mode === 'plan' ? roles.accent('plan') : roles.dim('chat'));
    if (parts.todo && todo !== undefined) segments.push(roles.dim(todo));
    return `${GLYPH.indent}${segments.join(separator(roles))}`;
  };

  const candidates = [
    build({ id: true, todo: true, model: true }),
    build({ id: false, todo: true, model: true }),
    build({ id: false, todo: false, model: true }),
    build({ id: false, todo: false, model: false }),
  ];
  for (const candidate of candidates) {
    if (displayWidth(candidate) <= width) return candidate;
  }
  return truncateDisplay(candidates[candidates.length - 1] ?? '', width);
}

/** 输入提示符。整份 TUI 里 `❯` 只应从这里出现，否则 readline 的宽度与测试都会错。 */
export function promptText(roles: Roles): string {
  return `${GLYPH.indent}${roles.accentBold(GLYPH.prompt)} `;
}

// ---------------------------------------------------------------------------
// 帮助
// ---------------------------------------------------------------------------

export interface HelpRow {
  command: string;
  description: string;
}

export interface HelpGroup {
  title: string;
  rows: readonly HelpRow[];
}

export function helpGroups(): readonly HelpGroup[] {
  return [
    {
      title: '会话',
      rows: [
        { command: '/new', description: '新建会话' },
        { command: '/sessions', description: '列出本工作区的会话' },
        { command: '/resume <id>', description: '恢复指定会话' },
        { command: '/todos', description: '查看当前任务清单' },
      ],
    },
    {
      title: '模型与权限',
      rows: [
        { command: '/agent [id]', description: '查看或切换智能体' },
        { command: '/model [序号|agent|role <id>|<provider> <model>]', description: '查看或切换模型来源' },
        { command: '/permission <preset>', description: 'read-only / workspace-write / danger-full-access' },
        { command: '/plan [on|off]', description: '切换计划模式' },
      ],
    },
    {
      title: '显示',
      rows: [
        { command: '/think [full|compact|off]', description: '思考内容：完整 / 摘要 / 隐藏' },
        { command: '/verbose', description: '展开或收起工具输出' },
        { command: '/color [on|off]', description: '开关颜色（NO_COLOR 优先）' },
        { command: '/clear', description: '清空当前屏幕' },
      ],
    },
    {
      title: '其他',
      rows: [
        { command: '/help', description: '显示这份帮助' },
        { command: 'exit', description: '退出' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// 计时
// ---------------------------------------------------------------------------

/**
 * 耗时的粒度随长度变粗：10 秒内保留一位小数（短命令的差别就在这几百毫秒），
 * 一分钟内取整秒，再长就换成 `1m05s`——读者的注意力随等待时间递减。
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}
