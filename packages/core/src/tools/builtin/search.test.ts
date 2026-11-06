import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globTool } from './glob';
import { grepTool } from './grep';

let fixture: string;
let workspace: string;

const signal = new AbortController().signal;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(homedir(), '.omni-search-')));
  workspace = join(fixture, 'workspace');
  await mkdir(join(workspace, 'src/nested'), { recursive: true });
  await mkdir(join(workspace, 'node_modules/noise'), { recursive: true });
  await mkdir(join(workspace, '.hidden'), { recursive: true });
  // ripgrep honors .gitignore only inside a repository unless --no-require-git is passed.
  await mkdir(join(workspace, '.git'));
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');
  await writeFile(join(workspace, 'src/index.ts'), 'export const answer = 42;\n// NOTE 大写注释\n');
  await writeFile(join(workspace, 'src/nested/helper.ts'), 'export function helper() { return answer; }\n');
  await writeFile(join(workspace, 'src/nested/data.json'), '{"answer": 42}\n');
  await writeFile(join(workspace, 'README.md'), '# answer is documented\n');
  await writeFile(join(workspace, '.hidden/secret.ts'), 'export const answer = -1;\n');
  await writeFile(join(workspace, 'node_modules/noise/index.ts'), 'export const answer = 0;\n');
});

afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe('grep tool', () => {
  it('finds matches with ripgrep JSON and respects ignore files', async () => {
    const result = await grepTool.execute({ pattern: 'answer' }, { cwd: workspace, signal });
    expect(result.content).toContain('src/index.ts\nLine 1: export const answer = 42;');
    expect(result.content).toContain('src/nested/helper.ts');
    expect(result.content).not.toContain('node_modules');
    expect(result.content).toContain('Found 4 matches');
  });

  it('is case-sensitive by default and supports explicit character classes', async () => {
    const sensitive = await grepTool.execute({ pattern: 'note' }, { cwd: workspace, signal });
    expect(sensitive.content).toBe('No matches found');

    const insensitive = await grepTool.execute({ pattern: '(?i)note' }, { cwd: workspace, signal });
    expect(insensitive.content).toContain('NOTE');
  });

  it('filters by one include glob and searches a single file', async () => {
    const filtered = await grepTool.execute({ pattern: 'answer', include: '*.json' }, { cwd: workspace, signal });
    expect(filtered.content).toContain('src/nested/data.json');
    expect(filtered.content).not.toContain('src/index.ts');

    const single = await grepTool.execute(
      { pattern: 'answer', path: 'src/nested/helper.ts' },
      { cwd: workspace, signal },
    );
    expect(single.content).toContain('src/nested/helper.ts');
  });

  it('rejects invalid include selectors and invalid regexes', async () => {
    await expect(grepTool.execute({ pattern: 'x', include: '!*.ts' }, { cwd: workspace, signal }))
      .rejects.toThrow(/positive glob filter/);
    await expect(grepTool.execute({ pattern: 'x', include: '*.ts,*.js' }, { cwd: workspace, signal }))
      .rejects.toThrow(/one glob/);
    await expect(grepTool.execute({ pattern: '([' }, { cwd: workspace, signal }))
      .rejects.toThrow(/pattern rejected by ripgrep/);
  });

  it('refuses to escape the workspace', async () => {
    await symlink(join(fixture), join(workspace, 'escape'));
    await expect(grepTool.execute({ pattern: 'x', path: 'escape' }, { cwd: workspace, signal }))
      .rejects.toThrow(/路径越出工作区/);
  });
});

describe('glob tool', () => {
  it('matches nested files with ** and searches ignored and hidden files', async () => {
    const result = await globTool.execute({ pattern: '**/*.ts' }, { cwd: workspace, signal });
    expect(result.content).toContain('src/index.ts');
    expect(result.content).toContain('src/nested/helper.ts');
    expect(result.content).toContain('node_modules/noise/index.ts');
    expect(result.content).toContain('.hidden/secret.ts');
  });

  it('a pattern without a slash matches a basename at any depth', async () => {
    const result = await globTool.execute({ pattern: '*.md' }, { cwd: workspace, signal });
    expect(result.content).toContain('README.md');
    expect(result.content).not.toContain('data.json');
  });

  it('reports no matches and accepts a file as the starting path', async () => {
    const none = await globTool.execute({ pattern: '**/*.rs' }, { cwd: workspace, signal });
    expect(none.content).toBe('No files found');

    const single = await globTool.execute(
      { pattern: '*.ts', path: 'src/index.ts' },
      { cwd: workspace, signal },
    );
    expect(single.content).toContain('src/index.ts');
  });

  it('does not list VCS metadata', async () => {
    await mkdir(join(workspace, '.git/objects'), { recursive: true });
    await writeFile(join(workspace, '.git/objects/secret.ts'), 'x');
    const result = await globTool.execute({ pattern: '**/*.ts' }, { cwd: workspace, signal });
    expect(result.content).not.toContain('.git/');
  });

  it('refuses to escape the workspace', async () => {
    await symlink(join(fixture), join(workspace, 'escape'));
    await expect(globTool.execute({ pattern: '*', path: 'escape' }, { cwd: workspace, signal }))
      .rejects.toThrow(/路径越出工作区/);
  });
});
