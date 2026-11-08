/**
 * Shared registry of live session runtimes.
 *
 * The web server creates a Session object per open tab; the schedule runtime
 * delivers background turns into the same Session object so two instances
 * never append divergent histories to one session log.
 */

import type { AgentEvent } from '@omniagent/core';
import type { DshPermissionSnapshot } from '../../core/src/permissions/dsh-permissions';

/** Operations the schedule runtime needs from a live session. */
export interface LiveSession {
  send(input: string | readonly unknown[]): AsyncGenerator<AgentEvent>;
  interrupt(): void;
  deliverExternalMessage?(text: string, source?: string): Promise<'queued' | 'started'>;
}

/** One live session plus the runtime keys that created it. */
export interface LiveSessionEntry {
  readonly session: LiveSession;
  readonly preset: DshPermissionSnapshot['preset'];
  readonly modelKey: string;
  readonly runtimeKey?: string;
}

/** Bounded least-recently-used registry; delivery is always more recent than a read. */
export class LiveSessionRegistry {
  private readonly entries = new Map<string, LiveSessionEntry>();
  private readonly limit: number;

  constructor(limit = 128) {
    this.limit = limit;
  }

  get(key: string): LiveSessionEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: LiveSessionEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Session-key form shared by the web host and the schedule delivery host. */
export function liveSessionKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath}\0${sessionId}`;
}
