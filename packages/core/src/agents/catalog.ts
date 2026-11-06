import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ConfigCatalog } from '../config/models';
import { AGENT_USAGES } from '../session/agent-selection';
import type { AgentUsage } from '../session/agent-selection';
import { parseMarkdown } from './frontmatter';
import type { AgentCatalogSnapshot, AgentDefinition, AgentError } from './types';

export const MAX_AGENT_BYTES = 512 * 1024;
const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KNOWN_FIELDS = new Set(['name', 'description', 'role', 'usage', 'profile']);

const BUILTIN_DEFAULT: AgentDefinition = {
  id: 'default',
  name: 'Default',
  description: '默认智能体',
  role: 'default',
  usage: 'both',
  profile: 'default',
  body: '',
  sourcePath: 'builtin:default',
};

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: string }).code === 'ENOENT';
}

async function readAgentFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('agent path must be a regular file');
    if (info.size > MAX_AGENT_BYTES) throw new Error(`agent file exceeds ${MAX_AGENT_BYTES} bytes`);
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

function validateUsage(value: string | undefined): AgentUsage {
  if (value === undefined) return 'both';
  if (!AGENT_USAGES.includes(value as AgentUsage)) {
    throw new Error(`usage must be one of ${AGENT_USAGES.join(', ')}`);
  }
  return value as AgentUsage;
}

function validateAgent(
  id: string,
  path: string,
  source: string,
  catalog: ConfigCatalog | undefined,
): AgentDefinition {
  if (!AGENT_ID.test(id)) throw new Error('agent id must match [a-z0-9][a-z0-9._-]{0,63}');
  const { frontmatter, body } = parseMarkdown(source);
  for (const key of Object.keys(frontmatter)) {
    if (!KNOWN_FIELDS.has(key) && !key.startsWith('x-')) {
      throw new Error(`unknown agent frontmatter field "${key}"`);
    }
  }
  const name = frontmatter.name ?? id;
  if (name.length === 0 || name.length > 120) throw new Error('name must be 1-120 characters');
  const description = frontmatter.description ?? '';
  if (description.length > 2_000) throw new Error('description must be at most 2000 characters');
  if (Buffer.byteLength(body, 'utf8') > MAX_AGENT_BYTES) throw new Error('agent body is too large');
  const role = frontmatter.role ?? 'default';
  const profile = frontmatter.profile ?? 'default';
  if (catalog !== undefined) {
    if (role !== 'default' && !catalog.roles.has(role)) {
      throw new Error(catalog.roleErrors.get(role) ?? `unknown role "${role}"`);
    }
    if (!catalog.profiles.has(profile)) throw new Error(`unknown profile "${profile}"`);
  }
  return {
    id,
    name,
    description,
    role,
    usage: validateUsage(frontmatter.usage),
    profile,
    body,
    sourcePath: path,
  };
}

export class AgentCatalog {
  private snapshot: AgentCatalogSnapshot = { agents: [], errors: [], revision: '' };
  private loaded = false;

  constructor(private readonly dir: string) {}

  get revision(): string {
    return this.snapshot.revision;
  }

  get errors(): readonly AgentError[] {
    return this.snapshot.errors;
  }

  list(): AgentDefinition[] {
    return this.snapshot.agents.map((agent) => ({ ...agent }));
  }

  get(id: string): AgentDefinition | undefined {
    const agent = this.snapshot.agents.find((entry) => entry.id === id);
    return agent === undefined ? undefined : { ...agent };
  }

  /** Re-read the directory; the caller supplies the current config catalog for role/profile validation. */
  async refresh(catalog?: ConfigCatalog): Promise<AgentCatalogSnapshot> {
    const agents: AgentDefinition[] = [];
    const errors: AgentError[] = [];
    const hashes: string[] = [];
    let defaultFile = false;

    let entries: Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      entries = [];
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const id = basename(entry.name, entry.name.slice(-3));
      if (!AGENT_ID.test(id)) {
        errors.push({ id, path: join(this.dir, entry.name), error: 'invalid agent file name' });
        continue;
      }
      if (id === 'default') defaultFile = true;
      const path = join(this.dir, entry.name);
      try {
        const source = await readAgentFile(path);
        hashes.push(`${id}\0${source}`);
        agents.push(validateAgent(id, path, source, catalog));
      } catch (error) {
        errors.push({ id, path, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (!defaultFile) agents.push({ ...BUILTIN_DEFAULT });

    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const sorted = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
    const revision = createHash('sha256')
      .update(hashes.join('\n'))
      .update(`\0${defaultFile}`)
      .digest('hex');
    this.snapshot = { agents: sorted, errors, revision };
    this.loaded = true;
    return { agents: this.list(), errors: [...errors], revision };
  }

  get isLoaded(): boolean {
    return this.loaded;
  }
}
