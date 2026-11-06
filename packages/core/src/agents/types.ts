import type { AgentUsage } from '../session/agent-selection';

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  role: string;
  usage: AgentUsage;
  profile: string;
  body: string;
  sourcePath: string;
}

export interface AgentError {
  id: string;
  path?: string;
  error: string;
}

export interface AgentCatalogSnapshot {
  agents: AgentDefinition[];
  errors: AgentError[];
  revision: string;
}
