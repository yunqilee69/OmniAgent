import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skillTool } from './skill';

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal });

describe('skill tool', () => {
  it('loads a discovered skill by its frontmatter name', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omniagent-skill-tool-'));
    await mkdir(join(cwd, '.agents', 'skills', 'directory-name'), { recursive: true });
    await writeFile(join(cwd, '.agents', 'skills', 'directory-name', 'SKILL.md'),
      '---\nname: display-name\ndescription: Loaded on demand\n---\nFollow these instructions.', 'utf8');

    const result = await skillTool.execute({ name: 'display-name' }, ctx(cwd));

    expect(result.content).toContain('Follow these instructions.');
    expect(result.content).toContain('display-name');
  });

  it('rejects unknown names without treating them as paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omniagent-skill-tool-'));

    await expect(skillTool.execute({ name: '../outside' }, ctx(cwd))).rejects.toThrow('skill not found');
  });
});
