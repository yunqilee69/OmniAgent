import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../config/load';
import { buildConfigCatalog } from '../config/models';
import { AgentCatalog, MAX_AGENT_BYTES } from './catalog';
import { parseMarkdown } from './frontmatter';
import { renderAgentCatalog } from './prompt';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-agents-'));
  roots.push(root);
  const dir = join(root, 'agents');
  await mkdir(dir);
  return { root, dir };
}

const catalog = buildConfigCatalog(ConfigSchema.parse({
  model: 'deepseek-flash',
  provider: 'deepseek-official',
  roles: { quick: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
  agentProfiles: {
    default: { tools: '*', skills: '*' },
    search: { tools: ['read_file'], skills: ['docs'] },
  },
}));

async function agent(dir: string, name: string, source: string): Promise<void> {
  await writeFile(join(dir, name), source);
}

describe('agent Markdown catalog', () => {
  it('uses the built-in default only when default.md is absent', async () => {
    const { dir } = await fixture();
    const agents = new AgentCatalog(dir);
    const snapshot = await agents.refresh(catalog);
    expect(snapshot.agents).toEqual([expect.objectContaining({
      id: 'default', name: 'Default', role: 'default', usage: 'both', profile: 'default', sourcePath: 'builtin:default',
    })]);

    await agent(dir, 'default.md', '---\nname: Custom\n---\nCustom body');
    await agents.refresh(catalog);
    expect(agents.get('default')).toMatchObject({ name: 'Custom', body: 'Custom body', sourcePath: join(dir, 'default.md') });
  });

  it('parses identity, usage, profile, role, and ignores x- extension fields', async () => {
    const { dir } = await fixture();
    await agent(dir, 'explorer.md', [
      '---',
      'name: Explorer',
      'description: Finds things',
      'role: quick',
      'usage: subagent',
      'profile: search',
      'x-team: research',
      '---',
      'Explore body.',
    ].join('\n'));
    const agents = new AgentCatalog(dir);
    await agents.refresh(catalog);
    expect(agents.get('explorer')).toEqual({
      id: 'explorer',
      name: 'Explorer',
      description: 'Finds things',
      role: 'quick',
      usage: 'subagent',
      profile: 'search',
      body: 'Explore body.',
      sourcePath: join(dir, 'explorer.md'),
    });
  });

  it('reports frontmatter, usage, path, and role/profile errors without rejecting the directory', async () => {
    const { dir } = await fixture();
    await agent(dir, 'unknown-field.md', '---\nname: X\nbogus: 1\n---\n');
    await agent(dir, 'bad-usage.md', '---\nusage: root\n---\n');
    await agent(dir, 'unknown-role.md', '---\nrole: missing\n---\n');
    await agent(dir, 'unknown-profile.md', '---\nprofile: missing\n---\n');
    await agent(dir, 'BadName.md', '---\n---\n');
    await agent(dir, 'good.md', '---\nusage: primary\n---\nGood');
    const agents = new AgentCatalog(dir);
    const snapshot = await agents.refresh(catalog);
    expect(snapshot.agents.map((entry) => entry.id).sort()).toEqual(['default', 'good']);
    expect(snapshot.errors.map((entry) => entry.id).sort())
      .toEqual(['BadName', 'bad-usage', 'unknown-field', 'unknown-profile', 'unknown-role']);
    expect(snapshot.errors.find((entry) => entry.id === 'unknown-field')?.error).toMatch(/unknown agent frontmatter/i);
    expect(snapshot.errors.find((entry) => entry.id === 'bad-usage')?.error).toMatch(/usage must be/i);
    expect(snapshot.errors.find((entry) => entry.id === 'unknown-role')?.error).toMatch(/unknown role/i);
    expect(snapshot.errors.find((entry) => entry.id === 'unknown-profile')?.error).toMatch(/unknown profile/i);
    expect(snapshot.errors.find((entry) => entry.id === 'BadName')?.error).toMatch(/invalid agent file name/i);
  });

  it('does not fall back to the built-in default when default.md is invalid', async () => {
    const { dir } = await fixture();
    await agent(dir, 'default.md', '---\nusage: nope\n---\n');
    const agents = new AgentCatalog(dir);
    const snapshot = await agents.refresh(catalog);
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.errors).toEqual([expect.objectContaining({ id: 'default' })]);
  });

  it('skips symlinks and rejects oversized agent files', async () => {
    const { root, dir } = await fixture();
    const outside = join(root, 'outside.md');
    await writeFile(outside, '---\nname: Outside\n---\n');
    await symlink(outside, join(dir, 'linked.md'));
    await agent(dir, 'large.md', `${'x'.repeat(MAX_AGENT_BYTES + 1)}`);
    const agents = new AgentCatalog(dir);
    const snapshot = await agents.refresh(catalog);
    expect(snapshot.agents.map((entry) => entry.id)).toEqual(['default']);
    expect(snapshot.errors).toEqual([expect.objectContaining({ id: 'large', error: expect.stringMatching(/exceeds/) })]);
  });

  it('produces a subagent-facing catalog without prompt bodies', async () => {
    const { dir } = await fixture();
    await agent(dir, 'explorer.md', '---\nname: Explorer\ndescription: Finds things\nusage: subagent\n---\nSECRET BODY');
    await agent(dir, 'root.md', '---\nname: Root\nusage: primary\n---\nROOT BODY');
    const agents = new AgentCatalog(dir);
    const snapshot = await agents.refresh(catalog);
    const rendered = renderAgentCatalog(snapshot.agents);
    expect(rendered).toContain('explorer');
    expect(rendered).toContain('Finds things');
    expect(rendered).toContain('default');
    expect(rendered).not.toContain('root');
    expect(rendered).not.toContain('SECRET BODY');
  });

  it('parses flat Markdown frontmatter and body', () => {
    expect(parseMarkdown('---\nname: X\n---\n\nBody\n')).toEqual({ frontmatter: { name: 'X' }, body: 'Body' });
    expect(parseMarkdown('Body only')).toEqual({ frontmatter: {}, body: 'Body only' });
  });
});
