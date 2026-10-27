import type { ToolCall } from '../domain/message';
import type {
  PermissionMode,
  Rule,
  RuleBasedResult,
} from '../protocol/permission';
import { isEditTool, touchesProtectedPath } from './modes';
import { matchesCall } from './rules';

/**
 * 权限求值：一个纯函数。
 *
 * 输入只有 call + 规则 + 模式 + cwd，输出一个决定和理由。
 * 不读文件、不发网络、不问人 —— 所以可以全量单测，也不会有「测试要 mock 半天」的问题。
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

  const matched = rules.filter((rule) => matchesCall(rule, call, cwd));

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
