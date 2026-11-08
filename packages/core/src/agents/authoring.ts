/**
 * Authoring for `~/.omniagent/agents/*.md`.
 *
 * The regular file tools are fenced to the session workspace, so neither the
 * creator agent nor the web UI can write the agent catalog through
 * `write_file`. This service owns the narrow capability instead: validate one
 * definition, write it with symlink-safe flags, and expose the catalog as two
 * model-facing tools plus read/remove helpers for the manual web editor.
 *
 * @module @omniagent/core/agents/authoring
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ConfigStore } from '../config/store';
import type { Tool } from '../domain/tool';
import { AGENT_USAGES } from '../session/agent-selection';
import type { AgentUsage } from '../session/agent-selection';
import { MAX_AGENT_BYTES } from './catalog';
import type { AgentCatalog } from './catalog';
import type { AgentDefinition } from './types';

export const LIST_AGENT_DEFINITIONS_TOOL_NAME = 'list_agent_definitions';
export const WRITE_AGENT_DEFINITION_TOOL_NAME = 'write_agent_definition';

const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED_IDS = new Set(['default', 'creator']);

export interface AgentDefinitionSummary {
  id: string;
  name: string;
  description: string;
  role: string;
  usage: AgentUsage;
  profile: string;
  builtIn: boolean;
}

export interface AgentDefinitionDetail extends AgentDefinitionSummary {
  instructions: string;
}

/** Rejection surfaced to manual editors and Creator-mode tools alike. */
export class InvalidAgentSettings extends Error {}

export interface AgentDefinitionWrite {
  id: string;
  name: string;
  description: string;
  role?: string;
  usage?: AgentUsage;
  profile?: string;
  instructions: string;
  overwrite?: boolean;
}

export interface AgentDefinitionWriteResult {
  id: string;
  path: string;
  created: boolean;
}

export interface AgentAuthoringServiceOptions {
  dir: string;
  catalog: AgentCatalog;
  configStore: ConfigStore;
}

function oneLine(value: string, field: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) throw new InvalidAgentSettings(`${field} must not be empty`);
  if (normalized.length > max) throw new InvalidAgentSettings(`${field} must be at most ${max} characters`);
  return normalized;
}

function optionalOneLine(value: string, field: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length > max) throw new InvalidAgentSettings(`${field} must be at most ${max} characters`);
  return normalized;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: string }).code === code;
}

function renderDefinition(input: AgentDefinitionWrite): string {
  const name = oneLine(input.name, 'name', 120);
  const description = optionalOneLine(input.description, 'description', 2_000);
  const frontmatter = [
    '---',
    `name: ${name}`,
    ...(description === '' ? [] : [`description: ${description}`]),
    `role: ${input.role ?? 'default'}`,
    `usage: ${input.usage ?? 'both'}`,
    `profile: ${input.profile ?? 'default'}`,
    '---',
  ];
  const body = input.instructions.trim();
  return `${frontmatter.join('\n')}\n${body === '' ? '' : `\n${body}\n`}`;
}

function summary(agent: AgentDefinition): AgentDefinitionSummary {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    role: agent.role,
    usage: agent.usage,
    profile: agent.profile,
    builtIn: agent.sourcePath.startsWith('builtin:'),
  };
}

/**
 * Read and write agent definition files for Creator mode and the manual web
 * editor. Every operation refreshes the catalog first so role/profile
 * validation and duplicate checks see the latest config.
 */
export class AgentAuthoringService {
  constructor(private readonly options: AgentAuthoringServiceOptions) {}

  async list(): Promise<AgentDefinitionSummary[]> {
    const snapshot = await this.options.configStore.refresh();
    const agents = await this.options.catalog.refresh(snapshot.catalog);
    return agents.agents.map(summary);
  }

  /** Profile ids accepted by the `profile` field, including the implicit default. */
  async listProfiles(): Promise<string[]> {
    const snapshot = await this.options.configStore.refresh();
    return [...snapshot.catalog.profiles.keys()].sort((left, right) => {
      const order = (id: string): number => id === 'default' ? 0 : 1;
      return order(left) - order(right) || left.localeCompare(right);
    });
  }

  /** Load one definition, including its system-prompt body, for editing. */
  async read(id: string): Promise<AgentDefinitionDetail> {
    if (!AGENT_ID.test(id)) throw new InvalidAgentSettings('invalid agent id');
    const snapshot = await this.options.configStore.refresh();
    await this.options.catalog.refresh(snapshot.catalog);
    const agent = this.options.catalog.get(id);
    if (agent === undefined) throw new InvalidAgentSettings(`unknown agent "${id}"`);
    return { ...summary(agent), instructions: agent.body };
  }

  async write(input: AgentDefinitionWrite): Promise<AgentDefinitionWriteResult> {
    if (!AGENT_ID.test(input.id)) {
      throw new InvalidAgentSettings('agent id must match [a-z0-9][a-z0-9._-]{0,63}');
    }
    if (RESERVED_IDS.has(input.id)) {
      throw new InvalidAgentSettings(`agent id "${input.id}" is reserved by a built-in agent`);
    }
    if (input.usage !== undefined && !AGENT_USAGES.includes(input.usage)) {
      throw new InvalidAgentSettings(`usage must be one of ${AGENT_USAGES.join(', ')}`);
    }
    const snapshot = await this.options.configStore.refresh();
    await this.options.catalog.refresh(snapshot.catalog);
    const role = input.role ?? 'default';
    if (role !== 'default' && !snapshot.catalog.roles.has(role)) {
      throw new InvalidAgentSettings(`unknown role "${role}"`);
    }
    const profile = input.profile ?? 'default';
    if (!snapshot.catalog.profiles.has(profile)) {
      throw new InvalidAgentSettings(`unknown profile "${profile}"`);
    }
    if (Buffer.byteLength(input.instructions, 'utf8') > MAX_AGENT_BYTES) {
      throw new InvalidAgentSettings(`agent body exceeds ${MAX_AGENT_BYTES} bytes`);
    }

    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.options.dir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new InvalidAgentSettings('agent directory must be a real directory');
    }
    const path = join(this.options.dir, `${input.id}.md`);
    const created = input.overwrite !== true;
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK
      | (created ? constants.O_EXCL : constants.O_TRUNC);
    let file: FileHandle;
    try {
      file = await open(path, flags, 0o600);
    } catch (error) {
      if (created && isErrorCode(error, 'EEXIST')) {
        throw new InvalidAgentSettings(`agent id "${input.id}" already exists`);
      }
      throw error;
    }
    try {
      if (!(await file.stat()).isFile()) throw new InvalidAgentSettings('agent path must be a regular file');
      await file.writeFile(renderDefinition(input), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    return { id: input.id, path, created };
  }

  /** Delete one custom definition. Built-in ids and symlinks are refused. */
  async remove(id: string): Promise<boolean> {
    if (!AGENT_ID.test(id)) throw new InvalidAgentSettings('invalid agent id');
    if (RESERVED_IDS.has(id)) {
      throw new InvalidAgentSettings(`agent id "${id}" is reserved by a built-in agent`);
    }
    let directory;
    try {
      directory = await lstat(this.options.dir);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return false;
      throw error;
    }
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new InvalidAgentSettings('agent directory must be a real directory');
    }
    const path = join(this.options.dir, `${id}.md`);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return false;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new InvalidAgentSettings('agent path must be a regular file');
    }
    await unlink(path);
    return true;
  }
}

const ListParams = z.object({}).strict();

/** Strict request schema shared by the Creator tool and the web editor route. */
export const AgentDefinitionWriteSchema = z.object({
  id: z.string().describe('Agent id used as the Markdown file name; lowercase letters, digits, dots, dashes or underscores, at most 64 characters.'),
  name: z.string().describe('Human-facing agent name, 1-120 characters.'),
  description: z.string().describe('Short description shown in the agent picker and subagent catalog, at most 2000 characters.'),
  role: z.string().describe('Model role id from config.json roles, or "default".').optional(),
  usage: z.enum(AGENT_USAGES).describe('primary for main-agent only, subagent for delegation only, both for either.').optional(),
  profile: z.string().describe('Agent profile id from config.json agentProfiles; defaults to "default".').optional(),
  instructions: z.string().describe('System prompt body for the agent. Describe identity, responsibilities, constraints and working style.'),
  overwrite: z.boolean().describe('Replace an existing agent definition with the same id. Defaults to false.').optional(),
}).strict();

/**
 * Build the Creator-mode catalog tools. They are only registered for a
 * Creator-mode session, so ordinary agents never see this capability.
 */
export function createAgentAuthoringTools(service: AgentAuthoringService): Tool[] {
  return [
    {
      name: LIST_AGENT_DEFINITIONS_TOOL_NAME,
      description: 'List the current agent definitions in ~/.omniagent/agents, including built-in agents, roles, usages and profiles. Call this before creating an agent to avoid duplicate ids.',
      parameters: ListParams,
      mutating: false,
      async execute() {
        return { content: JSON.stringify({ agents: await service.list() }) };
      },
    },
    {
      name: WRITE_AGENT_DEFINITION_TOOL_NAME,
      description: 'Create or update one custom agent definition in ~/.omniagent/agents/<id>.md. The agent id is reserved once written; pass overwrite: true only after the user explicitly agrees to replace an existing definition. Built-in default and creator ids cannot be overwritten.',
      parameters: AgentDefinitionWriteSchema,
      mutating: true,
      async execute(args) {
        const input = AgentDefinitionWriteSchema.parse(args);
        const result = await service.write(input);
        return {
          content: JSON.stringify({
            ...result,
            message: result.created ? 'Agent definition created.' : 'Agent definition updated.',
          }),
        };
      },
    },
  ];
}
