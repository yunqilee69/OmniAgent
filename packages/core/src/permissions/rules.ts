import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { ToolCall } from '../domain/message';
import type { Decision, Rule, RuleSource } from '../protocol/permission';
import { matchesAllSubcommands, matchesAnySubcommand } from './bash';

/**
 * 规则解析与匹配。
 *
 * 规则语法直接借 Claude Code 的形状：`Tool` 或 `Tool(specifier)`，
 * 三种决策 allow / ask / deny。好处是 JSON 可读、可手写、可 diff。
 *
 * 明确不做的：不把规则当安全边界。`Bash(curl *)` 拦不住 `/usr/bin/curl`，
 * 也拦不住 `sh -c 'curl ...'`。真正的执法在沙盒层，规则只表达意图。
 */

export function parseRule(
  raw: string,
  decision: Decision,
  source: RuleSource,
  anchor: string,
): Rule {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('规则不能为空');
  }

  const open = trimmed.indexOf('(');
  if (open === -1) {
    return { raw: trimmed, decision, source, tool: trimmed, anchor };
  }
  if (!trimmed.endsWith(')')) {
    throw new Error(`规则括号不闭合：${raw}`);
  }

  const tool = trimmed.slice(0, open).trim();
  const specifier = trimmed.slice(open + 1, -1).trim();
  if (tool.length === 0) {
    throw new Error(`规则缺少工具名：${raw}`);
  }

  return {
    raw: trimmed,
    decision,
    source,
    tool,
    specifier: specifier.length === 0 ? undefined : specifier,
    anchor,
  };
}

export function parseRuleSet(
  groups: Partial<Record<Decision, string[]>>,
  source: RuleSource,
  anchor: string,
): Rule[] {
  const rules: Rule[] = [];
  for (const decision of ['allow', 'ask', 'deny'] as const) {
    for (const raw of groups[decision] ?? []) {
      rules.push(parseRule(raw, decision, source, anchor));
    }
  }
  return rules;
}

/** 工具名匹配：支持 `*` 和 `mcp__server__*` 这种前缀通配。 */
export function matchesToolName(pattern: string, toolName: string): boolean {
  if (pattern === '*' || pattern === toolName) {
    return true;
  }
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return false;
}

const FS_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir']);

export function matchesCall(rule: Rule, call: ToolCall, cwd: string): boolean {
  if (!matchesToolName(rule.tool, call.name)) {
    return false;
  }
  if (rule.specifier === undefined || rule.specifier === '*') {
    return true;
  }

  try {
    if (call.name === 'shell') {
      const command = readStringArg(call, 'command');
      if (command === undefined) {
        return false;
      }
      // allow 要每个子命令都命中；deny / ask 命中一个就够。
      return rule.decision === 'allow'
        ? matchesAllSubcommands(rule.specifier, command)
        : matchesAnySubcommand(rule.specifier, command);
    }
    if (FS_TOOLS.has(call.name)) {
      const path = readStringArg(call, 'path');
      return path !== undefined && matchesPath(rule.specifier, path, rule.anchor, cwd);
    }
  } catch {
    return false;
  }

  // 未知工具：只按工具名匹配，specifier 忽略（宁可少放行也不要错误匹配）。
  return false;
}

function readStringArg(call: ToolCall, key: string): string | undefined {
  const args = call.arguments;
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 路径规则。
 *
 * 前缀语义借自 Claude Code，解决了「规则文件在哪、路径相对谁」的问题：
 *   //path  -> 文件系统根
 *   ~/path  -> home
 *   /path   -> 相对规则来源（anchor）
 *   ./path 或 path -> 相对工作区 cwd
 */
export function resolveRulePath(specifier: string, anchor: string, cwd: string): string {
  if (specifier.startsWith('//')) {
    return resolve('/', specifier.slice(2));
  }
  if (specifier.startsWith('~/')) {
    return resolve(homedir(), specifier.slice(2));
  }
  if (specifier.startsWith('/')) {
    return resolve(anchor, specifier.slice(1));
  }
  return resolve(cwd, specifier.replace(/^\.\//, ''));
}

export function matchesPath(
  specifier: string,
  path: string,
  anchor: string,
  cwd: string,
): boolean {
  const target = resolve(cwd, path);
  const pattern = resolveRulePath(specifier, anchor, cwd);
  return globToRegExp(pattern).test(target);
}

const REGEX_SPECIALS = '\\^$.|?+()[]{}';

/** 最小 glob：`**` 跨目录，`*` 不跨目录。够用就好，别自己写正则引擎。 */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        out += '.*';
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += REGEX_SPECIALS.includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`${out}$`);
}
