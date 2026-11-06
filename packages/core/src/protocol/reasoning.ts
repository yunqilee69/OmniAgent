import { z } from 'zod';

/** Canonical reasoning levels shared by config, roles, sessions, and providers. */
export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
