import type { ToolCall, ToolResult } from '../domain/message';
import type { ToolContext } from '../domain/tool';
import type { ToolRegistry } from '../tools/registry';

/**
 * 执行器：把 ToolCall 变成 ToolResult。
 *
 * 唯一的职责边界是——**异常不许跑出去**。工具崩了、参数没通过校验、
 * 文件不存在，统统变成 ok:false + 错误文本回灌给模型。模型看到错误能自己改，
 * 看不到错误就只能瞎猜或者停在原地。
 */
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly context: ToolContext,
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();

    const tool = this.registry.get(call.name);
    if (!tool) {
      return this.failure(call, `未知工具：${call.name}`, startedAt);
    }

    const parsed = tool.parameters.safeParse(call.arguments);
    if (!parsed.success) {
      return this.failure(
        call,
        `参数校验失败：${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
        startedAt,
      );
    }

    try {
      const output = await tool.execute(parsed.data, this.context);
      return {
        callId: call.id,
        name: call.name,
        ok: true,
        content: output.content,
        truncated: output.truncated ?? false,
        fullOutputRef: output.fullOutputRef,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return this.failure(call, `执行出错：${errorMessage(error)}`, startedAt);
    }
  }

  private failure(call: ToolCall, content: string, startedAt: number): ToolResult {
    return {
      callId: call.id,
      name: call.name,
      ok: false,
      content,
      truncated: false,
      durationMs: Date.now() - startedAt,
    };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
