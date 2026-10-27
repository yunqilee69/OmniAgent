import type { ToolCall } from '../domain/message';
import type {
  ApprovalHandler,
  PermissionGate,
  PermissionMode,
  Rule,
} from '../protocol/permission';
import { decide } from './evaluate';

/**
 * 把纯函数 decide() 接到「问人」这个副作用上。
 *
 * 关键点：core 不知道 UI 长什么样。它只拿到一个 approve 回调，
 * TUI 可以在回调里渲染提示，以后换成 web 也只需要换这个回调。
 * 这是「core 不认识 UI」这条边界的落点。
 */
export class RuleBasedGate implements PermissionGate {
  constructor(
    private readonly options: {
      mode: PermissionMode;
      rules: Rule[];
      cwd: string;
      approve: ApprovalHandler;
    },
  ) {}

  async check(call: ToolCall): Promise<{ decision: 'allow' | 'deny'; source: string }> {
    const result = decide({
      call,
      mode: this.options.mode,
      rules: this.options.rules,
      cwd: this.options.cwd,
    });

    if (result.decision === 'allow') {
      return { decision: 'allow', source: result.reason };
    }
    if (result.decision === 'deny') {
      return { decision: 'deny', source: result.reason };
    }

    const response = await this.options.approve({
      id: call.id,
      call,
      reason: result.reason,
      ...(result.rule ? { matchedRule: result.rule } : {}),
    });

    return { decision: response, source: `用户${response === 'allow' ? '放行' : '拒绝'}` };
  }
}
