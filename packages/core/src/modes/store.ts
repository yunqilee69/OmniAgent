/**
 * Durable mode presets for root sessions.
 *
 * A mode fixes the agent, model binding, tool allowlist and skill allowlist a
 * new session starts with. The selection is copied into `mode/selected` when
 * the session is created, so later edits only affect future sessions.
 *
 * Built-in modes live in code. `~/.omniagent/modes.json` may override either
 * built-in id or add custom modes, plus the default for the new-session picker.
 *
 * @module @omniagent/core/modes/store
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ConfigStore } from '../config/store';
import type { ConfigCatalog } from '../config/models';
import { resolveModelBinding, defaultModelBinding, ModelBindingSchema } from '../session/model-binding';
import type { ModelBinding } from '../session/model-binding';
import { usageAllowsRoot } from '../session/agent-selection';
import { KNOWN_TOOL_NAMES, expandToolSelector } from '../tools/names';
import type { AgentCatalog } from '../agents/catalog';
import { LIST_AGENT_DEFINITIONS_TOOL_NAME, WRITE_AGENT_DEFINITION_TOOL_NAME } from '../agents/authoring';
import {
  CREATE_GOAL_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LIST_DIR_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SKILL_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  UPDATE_GOAL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
} from '../tools/names';
import {
  SCHEDULE_CREATE_TOOL_NAME,
  SCHEDULE_EDIT_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  SCHEDULE_VIEW_TOOL_NAME,
} from '../schedule/tools';

export const MODE_FILE_VERSION = 1;
const MODE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const nonEmpty = z.string().trim().min(1).max(256);

export class ModeConfigError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'ModeConfigError';
  }
}

export const ModeSelectorSchema = z.union([
  z.literal('*'),
  z.array(nonEmpty).max(256),
]);
export type ModeSelector = z.infer<typeof ModeSelectorSchema>;

export interface ModeDefinition {
  id: string;
  name: string;
  description: string;
  agent: string;
  model: ModelBinding;
  tools: ModeSelector;
  skills: ModeSelector;
  builtIn: boolean;
  customized: boolean;
}

export interface ModeSummary extends ModeDefinition {
  valid: boolean;
  warnings: string[];
}

const ModeWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).optional(),
  agent: nonEmpty,
  model: ModelBindingSchema.optional(),
  tools: ModeSelectorSchema.optional(),
  skills: ModeSelectorSchema.optional(),
}).strict();

export type ModeWrite = z.infer<typeof ModeWriteSchema>;

const ModeFileSchema = z.object({
  version: z.literal(MODE_FILE_VERSION).default(MODE_FILE_VERSION),
  defaultMode: nonEmpty.optional(),
  modes: z.record(
    z.string(),
    z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().max(2_000).optional().default(''),
      agent: nonEmpty,
      model: ModelBindingSchema.optional().default(defaultModelBinding()),
      tools: ModeSelectorSchema.optional().default('*'),
      skills: ModeSelectorSchema.optional().default('*'),
    }).strict(),
  ).optional().default({}),
}).strict();

type ModeFile = z.infer<typeof ModeFileSchema>;

function cloneBinding(binding: ModelBinding): ModelBinding {
  return structuredClone(binding);
}

function builtinModes(): ModeDefinition[] {
  return [
    {
      id: 'standard',
      name: '标准模式',
      description: '处理日常任务：编码、文件修改、调研和执行命令。适合大多数会话。',
      agent: 'default',
      model: defaultModelBinding(),
      tools: '*',
      skills: '*',
      builtIn: true,
      customized: false,
    },
    {
      id: 'creator',
      name: '创造模式',
      description: '通过对话创建自动化任务、智能体定义并调整 OmniAgent 配置。',
      agent: 'creator',
      model: defaultModelBinding(),
      tools: [
        READ_FILE_TOOL_NAME,
        LIST_DIR_TOOL_NAME,
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        SKILL_TOOL_NAME,
        TODO_WRITE_TOOL_NAME,
        EXIT_PLAN_MODE_TOOL_NAME,
        GET_GOAL_TOOL_NAME,
        CREATE_GOAL_TOOL_NAME,
        UPDATE_GOAL_TOOL_NAME,
        SCHEDULE_CREATE_TOOL_NAME,
        SCHEDULE_LIST_TOOL_NAME,
        SCHEDULE_VIEW_TOOL_NAME,
        SCHEDULE_EDIT_TOOL_NAME,
        LIST_AGENT_DEFINITIONS_TOOL_NAME,
        WRITE_AGENT_DEFINITION_TOOL_NAME,
      ],
      skills: '*',
      builtIn: true,
      customized: false,
    },
  ];
}

function normalizeSelector(selector: ModeSelector): ModeSelector {
  if (selector === '*') return '*';
  return [...new Set(selector.map((item) => item.trim()).filter(Boolean))];
}

function unknownTools(selector: ModeSelector): string[] {
  const expanded = expandToolSelector(selector);
  if (expanded === '*') return [];
  return expanded.filter((name) => !KNOWN_TOOL_NAMES.has(name));
}

function withModeFile(value: unknown): ModeFile {
  try {
    return ModeFileSchema.parse(value);
  } catch (error) {
    throw new ModeConfigError(
      error instanceof Error ? `Invalid modes.json: ${error.message}` : 'Invalid modes.json',
      error,
    );
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

async function readModeFile(path: string): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) throw new ModeConfigError('modes.json must be a regular file');
    return await file.readFile('utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (error instanceof ModeConfigError) throw error;
    throw new ModeConfigError('Unable to read modes.json', error);
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export interface ModeStoreOptions {
  path: string;
  configStore: ConfigStore;
  agents: AgentCatalog;
}

/**
 * Read, validate and persist mode presets. All writes are serialized and
 * atomic; a session never observes a partially written file.
 */
export class ModeStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: ModeStoreOptions) {}

  private async read(): Promise<ModeFile> {
    const text = await readModeFile(this.options.path);
    if (text === undefined || text.trim() === '') {
      return { version: MODE_FILE_VERSION, modes: {} };
    }
    try {
      return withModeFile(JSON.parse(text));
    } catch (error) {
      if (error instanceof ModeConfigError) throw error;
      throw new ModeConfigError('Invalid modes.json', error);
    }
  }

  private merged(file: ModeFile): ModeDefinition[] {
    const modes = new Map<string, ModeDefinition>();
    for (const builtin of builtinModes()) modes.set(builtin.id, builtin);
    for (const [id, value] of Object.entries(file.modes)) {
      const base = modes.get(id);
      modes.set(id, {
        id,
        name: value.name,
        description: value.description ?? '',
        agent: value.agent,
        model: cloneBinding(value.model ?? defaultModelBinding()),
        tools: normalizeSelector(value.tools ?? '*'),
        skills: normalizeSelector(value.skills ?? '*'),
        builtIn: base !== undefined,
        customized: true,
      });
    }
    const order = (id: string): number => id === 'standard' ? 0 : id === 'creator' ? 1 : 2;
    return [...modes.values()].sort((left, right) =>
      order(left.id) - order(right.id) || (left.name.localeCompare(right.name) || left.id.localeCompare(right.id)));
  }

  private async snapshot(): Promise<{ file: ModeFile; modes: ModeSummary[] }> {
    const file = await this.read();
    const config = await this.options.configStore.refresh();
    const agentSnapshot = await this.options.agents.refresh(config.catalog);
    const modes = this.merged(file).map((mode) => this.validate(mode, config.catalog, agentSnapshot.agents));
    return { file, modes };
  }

  private validate(
    mode: ModeDefinition,
    catalog: ConfigCatalog,
    agents: readonly { id: string; role: string; profile: string; usage: 'primary' | 'subagent' | 'both' }[],
  ): ModeSummary {
    const warnings: string[] = [];
    const agent = agents.find((entry) => entry.id === mode.agent);
    if (agent === undefined) {
      warnings.push(`Unknown agent "${mode.agent}"`);
    } else if (!usageAllowsRoot(agent.usage)) {
      warnings.push(`Agent "${mode.agent}" is not available as a main agent`);
    }
    if (agent !== undefined) {
      try {
        resolveModelBinding(catalog, agent.role, mode.model);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    const unknown = unknownTools(mode.tools);
    if (unknown.length > 0) warnings.push(`Unknown tool(s): ${unknown.join(', ')}`);
    if (mode.skills !== '*') {
      for (const skill of mode.skills) {
        if (skill.trim().length === 0) warnings.push('Skill names must not be empty');
      }
    }
    return { ...mode, valid: warnings.length === 0, warnings };
  }

  async list(): Promise<ModeSummary[]> {
    return (await this.snapshot()).modes.map((mode) => ({ ...mode, model: cloneBinding(mode.model) }));
  }

  async get(id: string): Promise<ModeSummary | undefined> {
    return (await this.list()).find((mode) => mode.id === id);
  }

  async defaultId(): Promise<string> {
    const { file, modes } = await this.snapshot();
    const selected = file.defaultMode ?? 'standard';
    return modes.some((mode) => mode.id === selected && mode.valid) ? selected : 'standard';
  }

  async resolveDefault(): Promise<ModeSummary> {
    const modes = await this.list();
    const id = await this.defaultId();
    const mode = modes.find((entry) => entry.id === id && entry.valid);
    if (mode === undefined) throw new ModeConfigError('No usable default mode is configured');
    return { ...mode, model: cloneBinding(mode.model) };
  }

  private async write(file: ModeFile): Promise<void> {
    const text = `${JSON.stringify(withModeFile(file), null, 2)}\n`;
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    let current;
    try {
      current = await lstat(this.options.path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (current !== undefined && (!current.isFile() || current.isSymbolicLink())) {
      throw new ModeConfigError('modes.json must be a regular file');
    }
    const temporary = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.options.path);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  private mutate(operation: (file: ModeFile) => ModeFile | Promise<ModeFile>): Promise<void> {
    const next = this.pending.then(async () => {
      const file = await this.read();
      const updated = await operation(file);
      await this.write(updated);
    });
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  async save(id: string, input: unknown): Promise<ModeSummary> {
    if (!MODE_ID.test(id)) throw new ModeConfigError('mode id must match [a-z0-9][a-z0-9._-]{0,63}');
    let parsed: ModeWrite;
    try {
      parsed = ModeWriteSchema.parse(input);
    } catch (error) {
      throw new ModeConfigError(error instanceof Error ? `Invalid mode: ${error.message}` : 'Invalid mode', error);
    }
    let saved: ModeSummary | undefined;
    await this.mutate(async (file) => {
      const updated: ModeFile = {
        ...file,
        modes: {
          ...file.modes,
          [id]: {
            name: parsed.name,
            description: parsed.description ?? '',
            agent: parsed.agent,
            model: parsed.model ?? defaultModelBinding(),
            tools: normalizeSelector(parsed.tools ?? '*'),
            skills: normalizeSelector(parsed.skills ?? '*'),
          },
        },
      };
      const config = await this.options.configStore.refresh();
      const agentSnapshot = await this.options.agents.refresh(config.catalog);
      const mode = this.merged(updated).find((entry) => entry.id === id);
      if (mode === undefined) throw new ModeConfigError(`Mode "${id}" was not saved`);
      const summary = this.validate(mode, config.catalog, agentSnapshot.agents);
      if (!summary.valid) {
        throw new ModeConfigError(`Mode "${id}" is invalid: ${summary.warnings.join('; ')}`);
      }
      saved = summary;
      return updated;
    });
    if (saved === undefined) throw new ModeConfigError(`Mode "${id}" was not saved`);
    return { ...saved, model: cloneBinding(saved.model) };
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.mutate((file) => {
      const modes = { ...file.modes };
      if (Object.hasOwn(modes, id)) {
        delete modes[id];
        removed = true;
      }
      return {
        ...file,
        modes,
        ...(file.defaultMode === id ? { defaultMode: 'standard' } : {}),
      };
    });
    return removed;
  }

  async setDefault(id: string): Promise<string> {
    const modes = await this.list();
    const mode = modes.find((entry) => entry.id === id && entry.valid);
    if (mode === undefined) throw new ModeConfigError(`Unknown or invalid mode "${id}"`);
    await this.mutate((file) => ({ ...file, defaultMode: id }));
    return id;
  }
}
