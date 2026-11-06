import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConfigSchema, defaultConfigPath } from './load';
import type { Config } from './load';
import { buildConfigCatalog } from './models';
import type { ConfigCatalog } from './models';

export interface ConfigSnapshot {
  config: Config;
  catalog: ConfigCatalog;
  revision: string;
  path: string;
  configDir: string;
}

export class ConfigError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'ConfigError';
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: string }).code === 'ENOENT';
}

/** Read the final config path without following a symlink. */
async function readConfigFile(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isNotFound(error)) return '';
    throw new ConfigError('Unable to read config.json', error);
  }
  try {
    if (!(await file.stat()).isFile()) throw new ConfigError('config.json must be a regular file');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

/**
 * Read-through config store. The file is re-read for every new turn; running
 * turns keep the snapshot they started with. Invalid JSON/schema fails closed.
 */
export class ConfigStore {
  private current: ConfigSnapshot;
  private raw: string | undefined;

  private constructor(private readonly path: string, current: ConfigSnapshot) {
    this.current = current;
  }

  static async open(path: string = defaultConfigPath()): Promise<ConfigStore> {
    const store = new ConfigStore(path, {
      config: ConfigSchema.parse({}),
      catalog: buildConfigCatalog(ConfigSchema.parse({})),
      revision: 'unloaded',
      path,
      configDir: dirname(path),
    });
    await store.refresh();
    return store;
  }

  get snapshot(): ConfigSnapshot {
    return this.current;
  }

  async refresh(): Promise<ConfigSnapshot> {
    const raw = await readConfigFile(this.path);
    if (this.raw === raw) return this.current;
    try {
      const config = raw === '' ? ConfigSchema.parse({}) : ConfigSchema.parse(JSON.parse(raw));
      this.current = {
        config,
        catalog: buildConfigCatalog(config),
        revision: hash(raw),
        path: this.path,
        configDir: dirname(this.path),
      };
      this.raw = raw;
      return this.current;
    } catch (error) {
      throw new ConfigError(
        error instanceof Error ? `Invalid config.json: ${error.message}` : 'Invalid config.json',
        error,
      );
    }
  }
}
