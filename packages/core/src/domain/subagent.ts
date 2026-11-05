import type { ReasoningEffort } from '../session/model-selection';
import type { Session } from '../session';

export const SUBAGENT_START_EVENT = 'subagent/start';
export const SUBAGENT_END_EVENT = 'subagent/end';
export const SUBAGENT_NOTICE_EVENT = 'subagent/notice';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'idle';

export interface SubagentStartRequest {
  description: string;
  prompt: string;
  cwd?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface SubagentStartResult {
  id: string;
  status: 'running';
}

export interface SubagentInfo {
  id: string;
  parentId?: string;
  depth: number;
  description?: string;
  status: SubagentStatus;
  createdAt: number;
  updatedAt: number;
  result?: string;
}

export interface SubagentOutcome {
  id: string;
  status: SubagentStatus;
  result?: string;
}

export interface SubagentNotice {
  childId: string;
  description?: string;
  status: Exclude<SubagentStatus, 'running'>;
  result?: string;
}

/**
 * The model-facing subagent tools depend on this seam rather than the concrete
 * manager, so tests can provide a deterministic child runtime.
 */
export interface SubagentService {
  start(parent: Session, request: SubagentStartRequest): Promise<SubagentStartResult>;
  send(caller: Session, targetId: string, message: string): Promise<{ messageId: string }>;
  list(caller: Session): Promise<SubagentInfo[]>;
  wait(caller: Session, targetId: string, timeoutMs: number, signal: AbortSignal): Promise<SubagentOutcome>;
  interrupt(caller: Session, targetId: string): Promise<boolean>;
  canStart(parent: Session): boolean;
}
