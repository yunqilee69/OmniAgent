/**
 * Shared, symlink-safe access to `~/.omniagent/config.json`.
 *
 * Settings pages that edit different sections of the same file (roles, model
 * sources) must serialize their read-modify-write cycles or one page can
 * overwrite the other's update. `mutate` provides that serialization per file
 * and writes atomically; readers still take a fresh snapshot every time so an
 * edit made by hand is picked up on the next call.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigSchema } from '@omniagent/core';
import type { Config } from '@omniagent/core';

export interface TrustedHome {
  path: string;
  target: string;
  configPath: string;
}

export interface ConfigFileSnapshot {
  text?: string;
  raw: Record<string, unknown>;
  config: Config;
}

export class ConfigFileError extends Error {}

const trustedDarwinAliases = new Set(['/tmp', '/var']);
const locks = new Map<string, Promise<void>>();

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
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
      if (allowMissingFinal && isNotFound(error)) continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      if (!trustedDarwinAliases.has(current)) throw new ConfigFileError('Configuration parent must be a real directory');
      continue;
    }
    if (!info.isDirectory()) throw new ConfigFileError('Configuration parent must be a real directory');
  }
}

async function assertTrustedHome(home: TrustedHome | undefined): Promise<void> {
  if (home !== undefined && await realpath(home.path) !== home.target) {
    throw new ConfigFileError('Trusted home path changed');
  }
}

async function readSnapshot(path: string, home?: TrustedHome): Promise<ConfigFileSnapshot> {
  await assertTrustedHome(home);
  await assertNoSymlinkParents(path, true);
  let text: string | undefined;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new ConfigFileError('Configuration must be a regular file');
      text = await file.readFile('utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (text === undefined || text.trim() === '') {
    return { raw: {}, config: ConfigSchema.parse({}) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigFileError('Invalid configuration');
  }
  if (!isObject(raw)) throw new ConfigFileError('Invalid configuration');
  return { text, raw, config: ConfigSchema.parse(raw) };
}

async function writeSnapshot(path: string, raw: Record<string, unknown>, home?: TrustedHome): Promise<Config> {
  await assertTrustedHome(home);
  await assertNoSymlinkParents(path, true);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const config = ConfigSchema.parse(raw);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return config;
}

/** Serialize one read-modify-write cycle per resolved file path. */
async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = previous.then(() => gate, () => gate);
  locks.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(path) === tail) locks.delete(path);
  }
}

export class ConfigFile {
  private constructor(
    readonly path: string,
    private readonly home: TrustedHome | undefined,
  ) {}

  static async open(path: string, options: { trustedHome?: string } = {}): Promise<ConfigFile> {
    if (!path) throw new ConfigFileError('Configuration path is required');
    const absolute = resolve(path);
    let home: TrustedHome | undefined;
    if (options.trustedHome !== undefined) {
      if (!options.trustedHome || !isAbsolute(options.trustedHome)) {
        throw new ConfigFileError('Trusted home must be absolute');
      }
      const homePath = resolve(options.trustedHome);
      const suffix = relative(homePath, absolute);
      if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
        throw new ConfigFileError('Configuration must be inside the trusted home');
      }
      const target = await realpath(homePath);
      home = { path: homePath, target, configPath: join(target, suffix) };
    }
    const filePath = home?.configPath ?? absolute;
    await readSnapshot(filePath, home);
    return new ConfigFile(filePath, home);
  }

  read(): Promise<ConfigFileSnapshot> {
    return readSnapshot(this.path, this.home);
  }

  /** Read, edit, validate and atomically replace the file under one lock. */
  mutate<T>(
    operation: (snapshot: ConfigFileSnapshot) => Promise<{ raw: Record<string, unknown>; result: T }>,
  ): Promise<T> {
    return withFileLock(this.path, async () => {
      const snapshot = await readSnapshot(this.path, this.home);
      const { raw, result } = await operation(snapshot);
      await writeSnapshot(this.path, raw, this.home);
      return result;
    });
  }
}
