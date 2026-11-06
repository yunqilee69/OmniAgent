import type { ReasoningEffort } from '../protocol/reasoning';
import type { Session } from '../session';

export const SUBAGENT_START_EVENT = 'subagent/start';
export const SUBAGENT_END_EVENT = 'subagent/end';
export const SUBAGENT_NOTICE_EVENT = 'subagent/notice';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'idle';

export interface SubagentStartRequest {
  description: string;
  prompt: string;
  cwd?: string;
  /** Target configured agent. Defaults to the parent's agent. */
  agent?: string;
  /** Optional role override for the child model. */
  role?: string;
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
  agent?: string;
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

/** Activity state exposed by `list_agents`; it says nothing about success. */
export type SubagentListStatus = 'running' | 'inactive';

export type SubagentListEntry =
  | {
    kind: 'root';
    id: string;
    status: SubagentListStatus;
  }
  | {
    kind: 'child';
    id: string;
    label: string;
    status: SubagentListStatus;
    parent?: string;
    depth?: number;
  }
  | {
    kind: 'diagnostic';
    id: string;
    reason: 'corrupt' | 'unsupported' | 'unavailable';
    parent?: string;
    depth?: number;
  };

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
  list(caller: Session): Promise<SubagentListEntry[]>;
  wait(caller: Session, targetId: string, timeoutMs: number, signal: AbortSignal): Promise<SubagentOutcome>;
  /** Wait for the caller's next-step input, including messages and notices. */
  waitForInput(caller: Session, timeoutMs: number, signal: AbortSignal): Promise<{ timedOut: boolean }>;
  interrupt(caller: Session, targetId: string): Promise<boolean>;
  canStart(parent: Session): boolean;
}
