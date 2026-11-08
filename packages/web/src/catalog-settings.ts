/**
 * Web-side editor for the role table in config.json.
 *
 * Provider credentials and routes stay in the file; this service only exposes
 * the safe subset needed by Settings → Model configuration: named roles that
 * point at one configured provider/model pair, with optional reasoning effort.
 */

import { ConfigSchema, REASONING_EFFORTS, buildConfigCatalog } from '@omniagent/core';
import type { Config, ReasoningEffort, RoleDefinition } from '@omniagent/core';
import { ConfigFile, isObject } from './config-file';

const ROLE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface RoleWrite {
  name?: string;
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

function parseRoleWrite(input: unknown): RoleWrite {
  if (!isObject(input)) throw new InvalidRoleSettings('role must be an object');
  const allowed = new Set(['name', 'provider', 'model', 'reasoningEffort']);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new InvalidRoleSettings(`unknown role field "${unknown}"`);
  const readText = (key: 'name' | 'provider' | 'model', max: number): string | undefined => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new InvalidRoleSettings(`${key} must be a string`);
    const text = value.trim();
    if (text === '' || text.length > max) throw new InvalidRoleSettings(`${key} must be 1-${max} characters`);
    return text;
  };
  const provider = readText('provider', 256);
  const model = readText('model', 256);
  if (provider === undefined || model === undefined) throw new InvalidRoleSettings('provider and model are required');
  const effort = input.reasoningEffort;
  if (effort !== undefined && (typeof effort !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(effort))) {
    throw new InvalidRoleSettings('invalid reasoning effort');
  }
  const name = readText('name', 120);
  return {
    ...(name === undefined ? {} : { name }),
    provider,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort as ReasoningEffort }),
  };
}

export interface RoleEntry extends Partial<RoleDefinition> {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  reasoningEffort?: RoleDefinition['reasoningEffort'];
  builtIn?: boolean;
  valid: boolean;
  error?: string;
}

export interface RoleList {
  roles: RoleEntry[];
}

export class InvalidRoleSettings extends Error {}

function entriesFor(config: Config): RoleEntry[] {
  const catalog = buildConfigCatalog(config);
  const roles: RoleEntry[] = [];
  const explicit = isObject(config.roles) ? config.roles : {};
  const ids = new Set<string>([
    ...catalog.roles.keys(),
    ...catalog.roleErrors.keys(),
    ...Object.keys(explicit),
  ]);
  for (const id of ids) {
    const role = catalog.roles.get(id);
    if (role !== undefined) {
      roles.push({
        ...role,
        builtIn: id === 'default' && !Object.hasOwn(explicit, 'default'),
        valid: true,
      });
      continue;
    }
    const raw = isObject(explicit[id]) ? explicit[id] as Record<string, unknown> : {};
    roles.push({
      id,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
      ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}),
      ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
      ...(typeof raw.reasoningEffort === 'string' ? { reasoningEffort: raw.reasoningEffort as RoleDefinition['reasoningEffort'] } : {}),
      valid: false,
      error: catalog.roleErrors.get(id) ?? 'Invalid role definition',
    });
  }
  const order = (id: string): number => id === 'default' ? 0 : 1;
  return roles.sort((left, right) => order(left.id) - order(right.id) || left.name.localeCompare(right.name));
}

export class RoleSettings {
  private constructor(private readonly file: ConfigFile) {}

  static async open(path: string, options: { trustedHome?: string } = {}): Promise<RoleSettings> {
    return new RoleSettings(await ConfigFile.open(path, options));
  }

  async list(): Promise<RoleList> {
    const { config } = await this.file.read();
    return { roles: entriesFor(config) };
  }

  async save(id: string, input: unknown): Promise<RoleEntry> {
    if (!ROLE_ID.test(id)) throw new InvalidRoleSettings('role id must match [a-z0-9][a-z0-9._-]{0,63}');
    const parsed = parseRoleWrite(input);
    return this.file.mutate(async ({ raw }) => {
      const roles = isObject(raw.roles) ? raw.roles : {};
      const next = {
        ...raw,
        roles: {
          ...roles,
          [id]: {
            ...(parsed.name === undefined ? {} : { name: parsed.name }),
            provider: parsed.provider,
            model: parsed.model,
            ...(parsed.reasoningEffort === undefined ? {} : { reasoningEffort: parsed.reasoningEffort }),
          },
        },
      };
      const config = ConfigSchema.parse(next);
      const catalog = buildConfigCatalog(config);
      const error = catalog.roleErrors.get(id);
      if (error !== undefined) throw new InvalidRoleSettings(error);
      const role = entriesFor(config).find((entry) => entry.id === id);
      if (role === undefined) throw new InvalidRoleSettings(`Unknown role "${id}"`);
      return { raw: next, result: role };
    });
  }

  async remove(id: string): Promise<boolean> {
    if (!ROLE_ID.test(id)) throw new InvalidRoleSettings('invalid role id');
    return this.file.mutate(async ({ raw }) => {
      const roles = isObject(raw.roles) ? { ...raw.roles } : {};
      if (!Object.hasOwn(roles, id)) return { raw, result: false };
      delete roles[id];
      return { raw: { ...raw, roles }, result: true };
    });
  }
}
