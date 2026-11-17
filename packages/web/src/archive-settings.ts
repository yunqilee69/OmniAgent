import { ConfigSchema, isArchiveRetention, resolveArchiveSettings } from '@omniagent/core';
import type { ArchiveSettings } from '@omniagent/core';
import type { PermissionSettings } from './permissions';

export type { ArchiveSettings };
export class InvalidArchiveSettings extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Persist `archive.enabled` and `archive.retentionMs` without dropping the rest
 * of the configuration. The permission settings service owns the file write.
 */
export class ArchiveConfigSettings {
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly permissions: PermissionSettings,
    private value: ArchiveSettings,
  ) {}

  static async open(permissions: PermissionSettings): Promise<ArchiveConfigSettings> {
    return new ArchiveConfigSettings(permissions, resolveArchiveSettings(permissions.configSnapshot()));
  }

  async read(): Promise<ArchiveSettings> {
    await this.pending;
    return { ...this.value };
  }

  snapshot(): ArchiveSettings & { revision: number } {
    return { ...this.value, revision: this.revision };
  }

  async update(input: unknown): Promise<ArchiveSettings> {
    const body = record(input);
    if (body === undefined
      || Object.keys(body).length !== 2
      || typeof body.enabled !== 'boolean'
      || !isArchiveRetention(body.retentionMs)) {
      throw new InvalidArchiveSettings();
    }
    const enabled = body.enabled;
    const retentionMs = body.retentionMs;
    const operation = this.pending.then(async () => {
      const current = this.permissions.configSnapshot() as unknown as Record<string, unknown>;
      const previous = record(current.archive) ?? {};
      const config = { ...current, archive: { ...previous, enabled, retentionMs } };
      ConfigSchema.parse(config);
      await this.permissions.replaceConfig(config);
      this.value = { enabled, retentionMs, requiresSelection: false };
      this.revision += 1;
      return { ...this.value };
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
