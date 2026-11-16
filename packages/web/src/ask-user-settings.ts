import { ConfigSchema, isAskUserTimeout, resolveAskUserTimeout } from '@omniagent/core';
import type { AskUserSettings } from '@omniagent/core';
import type { PermissionSettings } from './permissions';

export type { AskUserSettings };
export class InvalidAskUserSettings extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Persist `askUser.timeoutSec` without dropping the rest of the configuration.
 * The permission settings service owns the file write and the trusted-home checks.
 */
export class AskUserConfigSettings {
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly permissions: PermissionSettings,
    private value: AskUserSettings,
  ) {}

  static async open(permissions: PermissionSettings): Promise<AskUserConfigSettings> {
    return new AskUserConfigSettings(permissions, resolveAskUserTimeout(permissions.configSnapshot()));
  }

  async read(): Promise<AskUserSettings> {
    await this.pending;
    return { ...this.value };
  }

  snapshot(): AskUserSettings & { revision: number } {
    return { ...this.value, revision: this.revision };
  }

  async update(input: unknown): Promise<AskUserSettings> {
    const body = record(input);
    if (body === undefined || Object.keys(body).length !== 1 || !isAskUserTimeout(body.timeoutSec)) {
      throw new InvalidAskUserSettings();
    }
    const timeoutSec = body.timeoutSec;
    const operation = this.pending.then(async () => {
      const current = this.permissions.configSnapshot() as unknown as Record<string, unknown>;
      const previous = record(current.askUser) ?? {};
      const config = { ...current, askUser: { ...previous, timeoutSec } };
      ConfigSchema.parse(config);
      await this.permissions.replaceConfig(config);
      this.value = { timeoutSec, requiresSelection: false };
      this.revision += 1;
      return { ...this.value };
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
