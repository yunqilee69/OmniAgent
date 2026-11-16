import { ASK_USER_DEFAULT_TIMEOUT_SEC, ASK_USER_MAX_TIMEOUT_SEC } from '../tools/builtin/ask-user';

export interface AskUserSettings {
  /** -1 waits until an answer. A positive value is seconds. */
  timeoutSec: number;
  /** True when the stored value is missing or illegal and the default is in force. */
  requiresSelection: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A legal wait: -1, or a whole number of seconds up to one day. */
export function isAskUserTimeout(value: unknown): value is number {
  return value === -1 || (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= 1
    && value <= ASK_USER_MAX_TIMEOUT_SEC
  );
}

/**
 * Read `askUser.timeoutSec` from a config object.
 *
 * A missing section uses the five-minute default. A present but illegal value
 * also falls back, and `requiresSelection` tells the settings page to show it
 * as unset so the user can repair it.
 */
export function resolveAskUserTimeout(config: unknown): AskUserSettings {
  if (!isRecord(config) || !Object.hasOwn(config, 'askUser')) {
    return { timeoutSec: ASK_USER_DEFAULT_TIMEOUT_SEC, requiresSelection: false };
  }
  const section = config.askUser;
  if (!isRecord(section) || !Object.hasOwn(section, 'timeoutSec') || !isAskUserTimeout(section.timeoutSec)) {
    return { timeoutSec: ASK_USER_DEFAULT_TIMEOUT_SEC, requiresSelection: true };
  }
  return { timeoutSec: section.timeoutSec, requiresSelection: false };
}
