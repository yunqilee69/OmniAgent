import type { ContentPart } from '../domain/message';

const INIT_COMMAND = /^\s*\/init(?:\s+([\s\S]*))?\s*$/i;

export function isInitCommand(input: string): boolean {
  return INIT_COMMAND.test(input);
}

export function expandInitCommand(content: readonly ContentPart[]): ContentPart[] | undefined {
  if (content.length !== 1 || content[0]?.type !== 'text' || content[0].attachment !== undefined) return undefined;
  const match = INIT_COMMAND.exec(content[0].text);
  if (!match) return undefined;
  const notes = match[1]?.trim();
  return [{ type: 'text', text: `Initialize or update the workspace instructions in the AGENTS.md file at the workspace root.

First inspect the repository using available read-only tools. Identify its purpose, structure, actual build and test commands, architecture, conventions, and any project-specific constraints that will help future agents. Base the document on evidence rather than guesses; keep it concise and useful.

If the root AGENTS.md already exists, read it before making changes. Preserve useful existing instructions and update it selectively rather than replacing it wholesale. If it does not exist, create it. Do not modify global instruction files or unrelated files. Follow the current tool permissions and approval requirements. Ask the user only when an important decision cannot be inferred from the repository. Summarize what you changed and give the file path when finished.${notes ? `\n\nAdditional user notes:\n${notes}` : ''}` }];
}
