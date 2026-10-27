import type { AgentEvent } from '@omniagent/core';
import { assistantText } from '@omniagent/core';

/**
 * 把事件流画成人能看的文本。
 *
 * 这个文件是 TUI 的全部「业务逻辑」——它不认识 agent，只认识事件。
 * 以后换 Ink、换 web、换 Electron，替换的都是这一层。
 */
export function renderEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'turn.start':
      return `\x1b[2m── step ${event.step} ──\x1b[0m`;

    // 流式片段没有换行；调用方要用 process.stdout.write 直接吐出去。
    case 'assistant.delta':
      return event.text;

    case 'assistant.message': {
      const body = assistantText(event.message).trim();
      return body.length > 0 ? `\n${body}` : undefined;
    }

    case 'tool.call':
      return `\x1b[36m→ ${event.call.name}\x1b[0m ${clip(JSON.stringify(event.call.arguments), 160)}`;

    case 'permission.decided':
      return `\x1b[2m  权限：${event.decision}（${event.source}）\x1b[0m`;

    case 'tool.result': {
      const mark = event.result.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const body = event.result.content.split('\n').slice(0, 12).join('\n');
      const more = event.result.content.split('\n').length > 12 ? '\n\x1b[2m   …\x1b[0m' : '';
      return `\x1b[2m←\x1b[0m ${mark} ${body}${more}`;
    }

    case 'context.compacted':
      return `\x1b[33m上下文压缩：${event.beforeTokens} → ${event.afterTokens} tokens\x1b[0m`;

    case 'turn.end':
      return `\x1b[2m── 结束：${event.reason} ──\x1b[0m`;

    case 'error':
      return `\x1b[31m错误：${event.error.message}\x1b[0m`;

    default:
      return undefined;
  }
}

export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
