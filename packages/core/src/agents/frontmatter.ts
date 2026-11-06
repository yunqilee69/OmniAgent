export interface ParsedMarkdown {
  frontmatter: Record<string, string>;
  body: string;
}

/** Parse flat YAML frontmatter used by skills and agent definitions. */
export function parseMarkdown(source: string): ParsedMarkdown {
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatter: Record<string, string> = {};
  if (match?.[1]) {
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/);
      if (pair?.[1] && pair[2]) frontmatter[pair[1]] = pair[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return {
    frontmatter,
    body: source.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim(),
  };
}
