import { z } from 'zod';
import type { Tool, ToolSpec } from '../domain/tool';
import { MAX_OUTPUT_CHARS } from './limits';

/** zod schema -> 给模型看的 JSON Schema。zod v4 自带这个能力。 */
export function toSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
  };
}

/**
 * 输出截断：保留开头和结尾。
 *
 * 只留开头会丢掉错误信息（大多在末尾），只留结尾会丢掉上下文。
 * 中间被省略的部分给出字符数，让模型知道自己看到的是残缺的。
 */
export function truncateOutput(content: string, max = MAX_OUTPUT_CHARS) {
  if (content.length <= max) {
    return { content };
  }
  const headLength = Math.floor(max * 0.7);
  const tailLength = Math.floor(max * 0.2);
  const head = content.slice(0, headLength);
  const tail = content.slice(-tailLength);
  const omitted = content.length - headLength - tailLength;
  return {
    content: `${head}\n\n... [已截断 ${omitted} 个字符] ...\n\n${tail}`,
    truncated: true,
  };
}
