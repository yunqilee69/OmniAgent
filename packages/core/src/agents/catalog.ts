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
const KNOWN_FIELDS = new Set(['name', 'description', 'role', 'usage', 'tools', 'skills', 'mcp']);

const BUILTIN_DEFAULT: AgentDefinition = {
  id: 'default',
  name: '默认智能体',
  description: '处理日常任务、编码、调研与文件工作的通用智能体。',
  role: 'default',
  usage: 'both',
  tools: '*',
  skills: '*',
  mcp: '*',
  body: '',
  sourcePath: 'builtin:default',
};

/**
 * 创造模式是内置的第二套智能体预设：它通过对话接收用户的配置意图，
 * 借助 schedule_* 工具创建自定义任务，并借助 agent 定义工具把新的
 * 智能体写入 ~/.omniagent/agents。它只作为主智能体提供。
 */
const BUILTIN_CREATOR: AgentDefinition = {
  id: 'creator',
  name: '创造智能体',
  description: '通过对话创建任务、智能体、模式、模型、MCP 与通用设置。',
  role: 'default',
  usage: 'primary',
  tools: '*',
  skills: '*',
  mcp: '*',
  body: [
    '你是 OmniAgent 的创造模式（Creator mode）。',
    '',
    '你的职责是帮助用户通过对话配置 OmniAgent 本身，而不是完成普通的业务任务。常见工作包括：',
    '- 创建、查看、修改或暂停自定义自动化任务（schedule_create、schedule_list、schedule_view、schedule_edit）。',
    '- 创建或更新自定义智能体定义（list_agent_definitions、write_agent_definition）。',
    '- 创建或修改模式预设（list_modes、write_mode、delete_mode、set_default_mode、list_mode_options）。',
    '- 管理模型角色和模型来源（list_model_roles、write_model_role、delete_model_role、list_model_sources、write_model_source、delete_model_source、discover_models）。',
    '- 调整通用设置（get_omniagent_settings、update_permission_default、update_archive_settings、update_ask_user_timeout）。',
    '- 管理 MCP 服务器（list_mcp_servers、write_mcp_server、delete_mcp_server、test_mcp_server）。',
    '- 向用户解释配置会写入哪里、何时生效，以及如何验证结果。',
    '',
    '工作方式：',
    '1. 先确认用户真正想要的目标、触发条件和期望结果；信息不足时先问清楚，不要猜测。',
    '2. 修改前先读取当前状态（列出现有任务、智能体、模式、角色或服务器），避免覆盖同名内容。',
    '3. 执行写操作前向用户说明将要创建或修改的内容，得到明确同意后再调用工具。',
    '4. 完成后用简明中文汇报结果、标识符和生效方式。',
    '',
    '安全与限制：',
    '- 自定义任务必须使用 schedule_* 工具创建，不要手写 ~/.omniagent/schedules.json。',
    '- 智能体定义必须使用 write_agent_definition 工具写入。',
    '- 模式、模型、通用设置和 MCP 必须使用对应的工具修改，不要用 write_file 或 bash 直接编辑 ~/.omniagent/config.json 或 modes.json。',
    '- 不要在对话中接收或写入 API Key、MCP env/header 明文密钥。模型来源只使用 apiKeyEnv；MCP 只使用 ${VAR} 引用；其余密钥让用户在设置页或环境变量中配置。',
    '- update_permission_default 只接受 read-only 与 workspace-write；danger-full-access 需要用户在「设置 → 通用」中完成风险确认。',
    '- 内置的 default 与 creator 智能体不可覆盖；请为新智能体使用独立 id。',
    '- 配置改动通常只影响新回合或新会话：模式只影响新会话，模型角色从下一回合生效，MCP 变更只影响新会话/新子代理。',
  ].join('\n'),
  sourcePath: 'builtin:creator',
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

function parseSelector(value: string | undefined, field: string): '*' | string[] {
  if (value === undefined) return '*';
  const normalized = value.trim();
  if (normalized === '*') return '*';
  if (normalized === 'none') return [];
  const names = normalized.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (names.length === 0) throw new Error(`${field} must be "*" or a comma-separated list`);
  return names;
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
  const tools = parseSelector(frontmatter.tools, 'tools');
  const skills = parseSelector(frontmatter.skills, 'skills');
  const mcp = parseSelector(frontmatter.mcp, 'mcp');
  if (catalog !== undefined) {
    if (role !== 'default' && !catalog.roles.has(role)) {
      throw new Error(catalog.roleErrors.get(role) ?? `unknown role "${role}"`);
    }

  }
  return {
    id,
    name,
    description,
    role,
    usage: validateUsage(frontmatter.usage),
    tools: tools === '*' ? '*' : [...tools],
    skills: skills === '*' ? '*' : [...skills],
    mcp: mcp === '*' ? '*' : [...mcp],
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
    let creatorFile = false;

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
      if (id === 'creator') creatorFile = true;
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
    if (!creatorFile) agents.push({ ...BUILTIN_CREATOR });

    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const sorted = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
    const revision = createHash('sha256')
      .update(hashes.join('\n'))
      .update(`\0${defaultFile}\0${creatorFile}`)
      .digest('hex');
    this.snapshot = { agents: sorted, errors, revision };
    this.loaded = true;
    return { agents: this.list(), errors: [...errors], revision };
  }

  get isLoaded(): boolean {
    return this.loaded;
  }
}
