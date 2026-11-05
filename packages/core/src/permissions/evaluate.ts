import type { ToolCall } from '../domain/message';
import type {
  PermissionMode,
  Rule,
  RuleBasedResult,
} from '../protocol/permission';
import { isEditTool, touchesProtectedPath } from './modes';
import { matchesCall } from './rules';

/**
 * 权限求值。
 *
 * 文件路径 deny / ask 在需要时读取文件系统已有前缀，以识别路径别名。
 * 不发网络、不问人；路径匹配仍不是抵御 symlink 或 TOCTOU 的沙盒。
 *
 * 求值顺序沿用 Claude Code：
 *   deny -> ask -> allow -> 模式默认。
 * 注意这是「按类别」而不是「按匹配精度」：一个宽的 deny 不会被更窄的 allow 覆盖。
 */

export interface DecideInput {
  call: ToolCall;
  mode: PermissionMode;
  rules: Rule[];
  cwd: string;
}

export function decide(input: DecideInput): RuleBasedResult {
  const { call, mode, rules, cwd } = input;

  const pathCache = new Map<string, string | null>();
  const matched = rules.filter((rule) => matchesCall(rule, call, cwd, pathCache));

  const deny = matched.find((rule) => rule.decision === 'deny');
  if (deny) {
    return { decision: 'deny', rule: deny, reason: `命中 deny 规则 ${deny.raw}` };
  }

  const ask = matched.find((rule) => rule.decision === 'ask');
  if (ask) {
    return { decision: 'ask', rule: ask, reason: `命中 ask 规则 ${ask.raw}` };
  }

  const allow = matched.find((rule) => rule.decision === 'allow');
  if (allow) {
    return { decision: 'allow', rule: allow, reason: `命中 allow 规则 ${allow.raw}` };
  }

  return modeDefault(call, mode);
}

function modeDefault(call: ToolCall, mode: PermissionMode): RuleBasedResult {
  switch (mode) {
    case 'bypass':
      return { decision: 'allow', reason: 'bypass 模式跳过确认' };

    case 'dontAsk':
      return { decision: 'deny', reason: 'dontAsk 模式下未预授权的调用一律拒绝' };

    case 'plan':
      return isEditTool(call.name) || call.name === 'shell'
        ? { decision: 'deny', reason: 'plan 模式只读，不允许修改或执行命令' }
        : { decision: 'allow', reason: 'plan 模式允许读取' };

    case 'workspace-write': {
      if (touchesProtectedPath(call)) {
        return { decision: 'ask', reason: '访问受保护路径（如 .git）需要确认' };
      }
      if (
        call.name === 'read_file' ||
        call.name === 'list_dir' ||
        isEditTool(call.name)
      ) {
        return { decision: 'allow', reason: 'workspace-write 自动允许工作区文件读写' };
      }
      return { decision: 'ask', reason: 'workspace-write 下其他工具调用仍需确认' };
    }

    case 'acceptEdits': {
      if (touchesProtectedPath(call)) {
        return { decision: 'ask', reason: '写入受保护路径（如 .git）需要确认' };
      }
      if (isEditTool(call.name)) {
        return { decision: 'allow', reason: 'acceptEdits 自动接受文件编辑' };
      }
      return { decision: 'ask', reason: 'acceptEdits 下非编辑类调用仍需确认' };
    }

    case 'default':
    default:
      return { decision: 'ask', reason: '默认模式：首次使用需要确认' };
  }
}
