import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const MAX_SKILL_BYTES = 1_048_576;

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source: string;
}

export interface LoadedSkill extends SkillSummary {
  body: string;
}

export interface SkillOptions {
  roots?: readonly string[];
  workspace?: string;
  home?: string;
}

function skillRoots(options: SkillOptions = {}): readonly string[] {
  const home = options.home ?? homedir();
  return options.roots ?? [
    ...(options.workspace ? [join(options.workspace, '.agents', 'skills')] : []),
    join(home, '.agents', 'skills'),
  ];
}

export async function discoverSkills(options: SkillOptions = {}): Promise<SkillSummary[]> {
  const found = new Map<string, SkillSummary>();
  for (const root of skillRoots(options)) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory()) {
        const path = join(root, entry.name, 'SKILL.md');
        const source = await readOptional(path);
        if (source !== undefined) {
          const summary = parseSummary(source, entry.name, path, root);
          if (!found.has(summary.name)) found.set(summary.name, summary);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const path = join(root, entry.name);
        const source = await readOptional(path);
        if (source === undefined) continue;
        const summary = parseSummary(source, basename(entry.name, '.md'), path, root);
        if (!found.has(summary.name)) found.set(summary.name, summary);
      }
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadSkill(root: string, name: string): Promise<LoadedSkill> {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error('invalid skill name');
  }
  const candidates = [join(root, name, 'SKILL.md'), join(root, `${name}.md`)];
  for (const path of candidates) {
    const source = await readOptional(path);
    if (source === undefined) continue;
    const summary = parseSummary(source, name, path, root);
    return { ...summary, body: parseBody(source) };
  }
  throw new Error(`skill not found: ${name}`);
}

/** Load an exact catalog entry; the name may differ from its directory name. */
export async function loadSkillByName(options: SkillOptions, name: string): Promise<LoadedSkill> {
  const summary = (await discoverSkills(options)).find((skill) => skill.name === name);
  if (!summary) throw new Error(`skill not found: ${name}`);
  const source = await readOptional(summary.path);
  if (source === undefined) throw new Error(`skill not found: ${name}`);
  return { ...summary, body: parseBody(source) };
}

/** Filter discovered skills by an agent profile. Unknown names grant nothing. */
export function filterSkills(
  skills: readonly SkillSummary[],
  allowed: '*' | ReadonlySet<string>,
): SkillSummary[] {
  return allowed === '*' ? [...skills] : skills.filter((skill) => allowed.has(skill.name));
}

/** Model-facing catalog injected once per session. Descriptions are untrusted text. */
export function renderSkillCatalog(skills: readonly SkillSummary[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((skill) => `- \`${skill.name}\`: ${skill.description.replace(/\s+/g, ' ').trim()}`);
  return [
    '<available_skills>',
    ...lines,
    '</available_skills>',
    'When the user names a skill, or the task clearly matches one of these descriptions, call the `skill` tool with the exact name before acting. The catalog contains summaries only; load the skill before following its instructions.',
  ].join('\n');
}

function parseSummary(source: string, fallbackName: string, path: string, root: string): SkillSummary {
  const frontmatter = readFrontmatter(source);
  const heading = source.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const description = frontmatter.description ?? firstParagraph(parseBody(source)) ?? '';
  return {
    name: frontmatter.name ?? fallbackName,
    description,
    path,
    source: root,
  };
}

function readFrontmatter(source: string): Record<string, string> {
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) return {};
  const values: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (pair?.[1] && pair[2]) values[pair[1]] = pair[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function parseBody(source: string): string {
  return source.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

function firstParagraph(source: string): string | undefined {
  return source.split(/\r?\n\s*\r?\n/).map((part) => part.replace(/^#+\s*/, '').trim()).find(Boolean);
}

async function readOptional(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('skill path must be a regular file');
    if (info.size > MAX_SKILL_BYTES) throw new Error(`skill file exceeds ${MAX_SKILL_BYTES} bytes: ${path}`);
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: string }).code === 'ENOENT';
}
