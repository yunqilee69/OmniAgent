/**
 * 角色调色板：TUI 里「一段文字是什么身份」的唯一事实来源。
 *
 * 组件不再自己写 `{ fg: 'magenta' }`，而是问角色表要一个包装器。这样改色只改
 * 一张表，也方便用 `roleViolations` 在测试里守住边界。
 *
 * 两条硬约束（参考 DSH 的终端阅读模型）：
 * 1. 只用 ANSI 0–15 前景色与属性，不用 24 位 RGB、不用背景色。终端配色方案
 *    因此可以整体重映射，浅色/深色终端都不用另设主题。
 * 2. 内收文字用 `dim`（SGR 2，只压暗相对终端前景），不用 `gray`（SGR 90）。
 *    固定的亮灰在浅色背景上会变成一块更重的颜色，破坏「次要」的语义。
 */
import type { Style, Theme } from './ansi';

export type RoleName =
  | 'body'
  | 'accent'
  | 'accentBold'
  | 'success'
  | 'error'
  | 'warning'
  | 'attention'
  | 'reasoning'
  | 'dim'
  | 'dimItalic'
  | 'code'
  | 'link'
  | 'rule';

/** 单一角色表：每个角色对应一组 SGR 属性。 */
export const ROLE_SPEC: Record<RoleName, Style> = {
  /** 终端默认前景色，对话正文与工具结果正文之外的内容都用它。 */
  body: {},
  /** 品牌与结构锚点：模型名、`Assistant` 标签、输入提示符。 */
  accent: { fg: 'brightCyan' },
  accentBold: { fg: 'brightCyan', bold: true },
  /** 成功：工具完成、todo 完成、回合收尾的勾。 */
  success: { fg: 'green' },
  /** 失败：工具失败、错误正文、diff 删除行。 */
  error: { fg: 'red' },
  /** 待定：工具运行中、权限预设、todo 进行中。 */
  warning: { fg: 'yellow' },
  /** 需要注意但没失败：一次性提权、中断、需授权。 */
  attention: { fg: 'brightYellow' },
  /** 思考：`✻ 思考` 头部与其虚线导轨。 */
  reasoning: { fg: 'magenta' },
  /** 内收：工具体、状态行、元信息。 */
  dim: { dim: true },
  /** 内收斜体：思考正文。 */
  dimItalic: { dim: true, italic: true },
  /** 行内代码与 JSON 键。与 `attention` 共用同一个 SGR，保留两个名字是因为语义不同。 */
  code: { fg: 'brightYellow' },
  link: { fg: 'brightCyan', underline: true },
  /** 分隔符、表格框线、折叠提示。 */
  rule: { dim: true },
};

export const ROLE_NAMES = Object.keys(ROLE_SPEC) as RoleName[];

type RoleWrappers = { readonly [K in RoleName]: (text: string) => string };

export interface Roles extends RoleWrappers {
  readonly theme: Theme;
  paint(role: RoleName, text: string): string;
  /** 按角色着色后再拼接片段，省掉调用点的一串 `+`。 */
  join(parts: readonly { role: RoleName; text: string }[]): string;
}

export function createRoles(theme: Theme): Roles {
  const wrappers = {} as Record<RoleName, (text: string) => string>;
  for (const role of ROLE_NAMES) {
    wrappers[role] = (text) => theme.paint(text, ROLE_SPEC[role]);
  }
  return {
    ...wrappers,
    theme,
    paint: (role, text) => theme.paint(text, ROLE_SPEC[role]),
    join: (parts) => parts.map((part) => theme.paint(part.text, ROLE_SPEC[part.role])).join(''),
  };
}

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * 列出输出里越界的 SGR 码。
 *
 * 允许的码只有：重置 0、属性 1/2/3/4/9、默认前景 39、标准 16 色前景 30–37 与
 * 90–97。24 位 RGB（38;2）、256 色（38;5）和任何背景色（4x / 48）都会被列出来。
 */
export function roleViolations(text: string): string[] {
  const violations: string[] = [];
  for (const match of text.matchAll(SGR_PATTERN)) {
    const sequence = match[1] ?? '';
    const tokens = sequence.split(';').filter((token) => token.length > 0).map(Number);
    if (tokens.every(isAllowedCode)) continue;
    violations.push(`\x1b[${sequence}m`);
  }
  return violations;
}

function isAllowedCode(code: number): boolean {
  return code === 0 // reset
    || code === 1 || code === 2 || code === 3 || code === 4 || code === 9 // attributes
    || code === 39 // default foreground
    || (code >= 30 && code <= 37)
    || (code >= 90 && code <= 97);
}
