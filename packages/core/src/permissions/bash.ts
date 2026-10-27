/**
 * shell 命令的规则匹配。
 *
 * 这里有一个不写就白做的点：**复合命令必须拆开**。
 * `Bash(npm *)` 如果按整串匹配，`npm install && rm -rf ~` 就整串能对上。
 * Claude Code 的处理是拆成子命令后：deny/ask 只要任一子命令命中就算命中，
 * allow 必须每个子命令都命中。
 *
 * 局限（有意接受，写在这里免得以后误以为它很安全）：
 * - 不处理 `$(...)`、反引号、进程替换。
 * - 不处理 heredoc。
 * - wrapper 剥离是启发式的，`env FOO=1 cmd` 这种只认得个大概。
 * 真正的隔离在沙盒层，不在这一层。
 */

const WRAPPER_PREFIX =
  /^(?:(?:timeout|nice|nohup|command|env)\s+(?:-\S+\s+|(?:\d+[smh]?)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)+/;

/** 引号感知的命令拆分：只在引号外切 `&&` `||` `;` `|` `&` 和换行。 */
export function splitCommand(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const flush = () => {
    parts.push(current);
    current = '';
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    const pair = input.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      flush();
      index += 1;
      continue;
    }
    if (char === ';' || char === '|' || char === '&' || char === '\n') {
      flush();
      continue;
    }

    current += char;
  }

  flush();
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function stripLeadingWrappers(command: string): string {
  return command.replace(WRAPPER_PREFIX, '').trim();
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function globToRegExpSource(pattern: string): string {
  let out = '';
  for (const char of pattern) {
    if (char === '*') {
      out += '.*';
    } else if ('\\^$.|?+()[]{}'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * 单个子命令是否匹配某条 Bash 模式。
 * 同时匹配原文和剥离 wrapper 之后的版本，因为规则通常写的是「真正那个命令」。
 */
export function matchesBashRule(pattern: string, command: string): boolean {
  const normalizedPattern = normalizeSpaces(pattern);
  if (normalizedPattern.length === 0) {
    return false;
  }
  const regex = new RegExp(`^${globToRegExpSource(normalizedPattern)}$`);
  const candidates = [normalizeSpaces(command), normalizeSpaces(stripLeadingWrappers(command))];
  return candidates.some((candidate) => regex.test(candidate));
}

/** deny / ask 语义：任一子命令命中即可。 */
export function matchesAnySubcommand(pattern: string, command: string): boolean {
  const subs = splitCommand(command);
  return subs.length > 0
    ? subs.some((sub) => matchesBashRule(pattern, sub))
    : matchesBashRule(pattern, command);
}

/** allow 语义：每个子命令都必须命中，否则 `npm * && rm -rf /` 会被放行。 */
export function matchesAllSubcommands(pattern: string, command: string): boolean {
  const subs = splitCommand(command);
  return subs.length > 0
    ? subs.every((sub) => matchesBashRule(pattern, sub))
    : matchesBashRule(pattern, command);
}
