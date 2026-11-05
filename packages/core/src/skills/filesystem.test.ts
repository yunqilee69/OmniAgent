import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSkills, loadSkill } from './filesystem';

describe('skill filesystem', () => {
  it('discovers directory SKILL.md and flat markdown skills with metadata only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-skills-'));
    await mkdir(join(root, 'review'), { recursive: true });
    await writeFile(join(root, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\nFull instructions', 'utf8');
    await writeFile(join(root, 'deploy.md'), '# Deploy\n\nDeploy safely.', 'utf8');

    const catalog = await discoverSkills({ roots: [root], home: root });

    expect(catalog.map((skill) => skill.name)).toEqual(['deploy', 'review']);
    expect(catalog.find((skill) => skill.name === 'review')).toMatchObject({ description: 'Review code' });
    expect(catalog.find((skill) => skill.name === 'review')).not.toHaveProperty('body');
  });

  it('loads full skill instructions only on demand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-skills-'));
    await mkdir(join(root, 'review'), { recursive: true });
    await writeFile(join(root, 'review', 'SKILL.md'), '---\nname: review\n---\nFull instructions', 'utf8');

    const skill = await loadSkill(root, 'review');
    expect(skill.body).toContain('Full instructions');
  });
});
