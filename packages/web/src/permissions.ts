import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigSchema } from '@omniagent/core';
import type { Config } from '@omniagent/core';
import { isDshPermissionPreset, resolveDshDefaultPreset } from '../../core/src/permissions/dsh-permissions';
import type { DshPermissionPreset, DshPermissionSettings } from '../../core/src/permissions/dsh-permissions';

export type { DshPermissionPreset };
export type PermissionSettingsValue = DshPermissionSettings;

export type PermissionRuntime = PermissionSettingsValue & { revision: number };

export interface PermissionSettingsOpenOptions {
  /** Absolute home path supplied by the trusted composition root, not by a workspace. */
  trustedHome?: string;
}

interface TrustedHome {
  path: string;
  target: string;
  configPath: string;
}

export class InvalidPermissionSettings extends Error {}

const trustedDarwinAliases = new Set(['/tmp', '/var']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateUpdate(value: unknown): DshPermissionPreset {
  if (!isObject(value) || Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, 'defaultPreset') || !isDshPermissionPreset(value.defaultPreset)) {
    throw new InvalidPermissionSettings();
  }
  return value.defaultPreset;
}

/** Resolve only the persisted DSH setting. */
function resolveSettings(config: Record<string, unknown>): PermissionSettingsValue {
  if (Object.hasOwn(config, 'dsh')) {
    if (!isObject(config.dsh)) return resolveDshDefaultPreset(null);
    if (Object.hasOwn(config.dsh, 'permission')) {
      if (!isObject(config.dsh.permission)) return resolveDshDefaultPreset(null);
      if (Object.hasOwn(config.dsh.permission, 'defaultPreset')) {
        // An explicitly present but undefined value is invalid, not a fresh default.
        return resolveDshDefaultPreset(config.dsh.permission.defaultPreset ?? null);
      }
    }
  }
  return resolveDshDefaultPreset(undefined);
}

async function assertNoSymlinkParents(path: string, allowMissingFinal = false): Promise<void> {
  const absolute = resolve(path);
  const segments = absolute.split('/').filter(Boolean);
  let current = absolute.startsWith('/') ? '/' : '';
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissingFinal && isCode(error, 'ENOENT')) continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      if (!trustedDarwinAliases.has(current)) throw new Error('Configuration parent must be a real directory');
      continue;
    }
    if (!info.isDirectory()) throw new Error('Configuration parent must be a real directory');
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === code;
}

async function assertTrustedHome(home: TrustedHome | undefined): Promise<void> {
  if (home && await realpath(home.path) !== home.target) {
    throw new Error('Trusted home path changed');
  }
}

async function readConfig(path: string, home?: TrustedHome): Promise<{
  text: string | undefined; config: Record<string, unknown>; parsed: Config;
}> {
  await assertTrustedHome(home);
  await assertNoSymlinkParents(path, true);
  let text: string;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error('Configuration must be a regular file');
      text = await file.readFile('utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { text: undefined, config: {}, parsed: ConfigSchema.parse({}) };
    }
    throw error;
  }
  const config: unknown = JSON.parse(text);
  if (!isObject(config)) throw new Error('Invalid configuration');
  const parsed = ConfigSchema.parse(config);
  return { text, config, parsed };
}

export class PermissionSettings {
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly home: TrustedHome | undefined,
    private value: PermissionSettingsValue,
    private config: Config,
    private lastText: string | undefined,
  ) {}

  static async open(path: string, options: PermissionSettingsOpenOptions = {}): Promise<PermissionSettings> {
    if (!path) throw new Error('Configuration path is required');
    const absolute = resolve(path);
    let home: TrustedHome | undefined;
    if (options.trustedHome !== undefined) {
      if (!options.trustedHome || !isAbsolute(options.trustedHome)) throw new Error('Trusted home must be an absolute path');
      const homePath = resolve(options.trustedHome);
      const suffix = relative(homePath, absolute);
      if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
        throw new Error('Configuration must be inside the trusted home');
      }
      const target = await realpath(homePath);
      home = { path: homePath, target, configPath: join(target, suffix) };
    }
    const filePath = home?.configPath ?? absolute;
    const { config, parsed, text } = await readConfig(filePath, home);
    return new PermissionSettings(filePath, home, resolveSettings(config), parsed, text);
  }

  /** Trusted in-process configuration, including provider credentials; never expose over HTTP. */
  configSnapshot(): Config {
    return structuredClone(this.config);
  }

  async read(): Promise<PermissionSettingsValue> {
    return structuredClone(this.value);
  }

  snapshot(): PermissionRuntime {
    return { ...this.value, revision: this.revision };
  }

  /**
   * Snapshot taken after any queued write has landed, so a session started
   * while the default is being saved records the preset the user just chose
   * instead of the one it replaces. Reads never fail here: a rejected write
   * leaves the previous value in place.
   */
  async current(): Promise<PermissionRuntime> {
    await this.pending;
    return this.snapshot();
  }

  async update(input: unknown): Promise<PermissionSettingsValue> {
    const nextPreset = validateUpdate(input);
    const operation = this.pending.then(async () => {
      const current = await readConfig(this.filePath, this.home);
      if (current.text !== this.lastText) throw new Error('Configuration changed outside the settings service');
      const dsh = current.config.dsh;
      if (dsh !== undefined && !isObject(dsh)) throw new Error('Invalid DSH configuration');
      const permission = dsh?.permission;
      if (permission !== undefined && !isObject(permission)) throw new Error('Invalid DSH permission configuration');
      const config = {
        ...current.config,
        dsh: { ...dsh, permission: { ...permission, defaultPreset: nextPreset } },
      };
      const text = `${JSON.stringify(config, null, 2)}\n`;
      const parsed = ConfigSchema.parse(config);
      await this.write(text);
      this.lastText = text;
      this.value = { defaultPreset: nextPreset, requiresSelection: false };
      this.config = parsed;
      this.revision += 1;
      return structuredClone(this.value);
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async write(text: string): Promise<void> {
    await assertTrustedHome(this.home);
    await assertNoSymlinkParents(this.filePath, true);
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await assertTrustedHome(this.home);
    await assertNoSymlinkParents(this.filePath, true);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await file.writeFile(text, 'utf8');
      await file.close();
      file = undefined;
      await rename(temporary, this.filePath);
    } finally {
      await file?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}
