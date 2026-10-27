import type { z } from 'zod';

/**
 * 工具的定义与执行契约。
 *
 * 三条硬规则（都来自踩坑）：
 * 1. execute 里抛出的异常最终会被转成 ok:false 的 ToolResult 回灌给模型，
 *    绝不把异常抛进主循环——模型需要看到错误文本才能自己纠正。
 * 2. 输出必须截断，并给出完整输出所在的引用。
 * 3. parameters 是 zod schema，既做运行时校验，也用来生成给模型的 JSON Schema。
 */

/** 发给模型的工具描述。parameters 是 JSON Schema，不是 zod 对象。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolOutput {
  content: string;
  truncated?: boolean;
  /** 完整输出落盘的位置，截断时填。 */
  fullOutputRef?: string;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType;
  /** 是否会改变工作区。权限层和 plan 模式都靠这个字段判断。 */
  readonly mutating: boolean;
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutput>;
}
