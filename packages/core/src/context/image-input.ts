import { isAbsolute } from 'node:path';
import type { Message } from '../domain/message';

/** Project user images only for the current model request, leaving history intact. */
export function projectImageInput(messages: readonly Message[], imageInput: boolean | undefined): Message[] {
  if (imageInput !== false) return [...messages];
  return messages.map((message) => {
    if (message.role !== 'user' || !message.content.some((part) => part.type === 'image')) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'image') return part;
        const name = part.fileName ? ` Name: ${JSON.stringify(part.fileName)}.` : '';
        const location = part.filePath
          ? ` Path (${isAbsolute(part.filePath) ? 'absolute' : 'relative to cwd'}): ${JSON.stringify(part.filePath)}.`
          : ' No stored file path is available.';
        return { type: 'text' as const, text: `[Image unavailable to this model.${name}${location}]` };
      }),
    };
  });
}
