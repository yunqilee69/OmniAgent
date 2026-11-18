import { ConfigSchema } from '@omniagent/core';
import type { Config } from '@omniagent/core';
import { isDshPermissionPreset, resolveDshDefaultPreset } from '../../core/src/permissions/dsh-permissions';
import type { DshPermissionPreset, DshPermissionSettings } from '../../core/src/permissions/dsh-permissions';
import { ConfigFile, isObject } from './config-file';

export type { DshPermissionPreset };
export type PermissionSettingsValue = DshPermissionSettings;

export type PermissionRuntime = PermissionSettingsValue & { revision: number };

export interface PermissionSettingsOpenOptions {
  /** Absolute home path supplied by the trusted composition root, not by a workspace. */
  trustedHome?: string;
}

export class InvalidPermissionSettings extends Error {}

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

/**
 * Read and write the DSH permission section.
 *
 * All config.json writers share {@link ConfigFile}'s lock and trusted-text
 * guard, so a sequence of role, model-source and archive edits stays coherent
 * while a hand edit still fails the next write closed.
 */
export class PermissionSettings {
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: ConfigFile,
    private value: PermissionSettingsValue,
    private config: Config,
  ) {}

  static async open(path: string, options: PermissionSettingsOpenOptions = {}): Promise<PermissionSettings> {
    const file = await ConfigFile.open(path, options);
    const { raw, config } = await file.read();
    return new PermissionSettings(file, resolveSettings(raw), config);
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

  /**
   * Apply one read-modify-write cycle to config.json. Other settings services
   * (archive, ask-user) use this so their merges start from the latest raw
   * document instead of a stale permission snapshot.
   */
  mutate<T>(
    operation: (raw: Record<string, unknown>) => Promise<{ raw: Record<string, unknown>; result: T }>,
  ): Promise<T> {
    const next = this.pending.then(async () => {
      let written: Record<string, unknown> | undefined;
      const result = await this.file.mutate(async (snapshot) => {
        const outcome = await operation(snapshot.raw);
        written = outcome.raw;
        return outcome;
      });
      if (written !== undefined) {
        this.config = ConfigSchema.parse(written);
        this.value = resolveSettings(written);
      }
      this.revision += 1;
      return result;
    });
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  async update(input: unknown): Promise<PermissionSettingsValue> {
    const nextPreset = validateUpdate(input);
    return this.mutate(async (raw) => {
      const dsh = raw.dsh;
      if (dsh !== undefined && !isObject(dsh)) throw new Error('Invalid DSH configuration');
      const permission = dsh?.permission;
      if (permission !== undefined && !isObject(permission)) throw new Error('Invalid DSH permission configuration');
      return {
        raw: { ...raw, dsh: { ...dsh, permission: { ...permission, defaultPreset: nextPreset } } },
        result: { defaultPreset: nextPreset, requiresSelection: false },
      };
    });
  }
}
