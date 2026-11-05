import { z } from 'zod';

export const SESSION_FORMAT_VERSION = 1;

export const SessionHeaderSchema = z.object({
  type: z.literal('session'),
  version: z.literal(SESSION_FORMAT_VERSION),
  id: z.string().min(1),
  workspace: z.string().min(1),
  cwd: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  agentId: z.string().min(1).optional(),
  /** Direct creator session id for subagent sessions. */
  parentSessionId: z.string().min(1).optional(),
  /** Root agent is 0; direct children are 1. */
  depth: z.number().int().nonnegative().optional(),
  /** Short display description supplied when the child was started. */
  description: z.string().min(1).max(200).optional(),
});
export type SessionHeader = z.infer<typeof SessionHeaderSchema>;

export const SessionEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  type: z.string().min(1),
  data: z.unknown(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventInput = Omit<SessionEvent, 'seq' | 'ts'> & Partial<Pick<SessionEvent, 'seq' | 'ts'>>;

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}
