/**
 * Host-provided capabilities for the built-in Creator agent.
 *
 * The model-facing tools live in core so every host can reuse their schemas and
 * safety rules. The actual configuration stores stay in the host: the Web
 * composition root implements this port over the existing settings services.
 *
 * @module @omniagent/core/creator/types
 */

import type { ArchiveSettings } from '../config/archive';
import type { AskUserSettings } from '../config/ask-user';
import type { McpTransport } from '../mcp/config';
import type { McpProbeResult } from '../mcp/client';
import type { McpServerRuntimeStatus } from '../mcp/service';
import type { ModeSummary } from '../modes/store';
import type { DshPermissionSettings } from '../permissions/dsh-permissions';
import type { ReasoningEffort } from '../protocol/reasoning';

export interface CreatorModeOptions {
  tools: string[];
  skills: string[];
}

/** Mode presets are read and written through the host's ModeStore. */
export interface CreatorModeService {
  list(): Promise<readonly ModeSummary[]>;
  save(id: string, input: unknown): Promise<ModeSummary>;
  remove(id: string): Promise<boolean>;
  defaultId(): Promise<string>;
  setDefault(id: string): Promise<string>;
  /** Tool and skill names accepted by write_mode for one workspace. */
  options(cwd: string): Promise<CreatorModeOptions>;
}

export interface CreatorRoleWrite {
  name?: string;
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

/** A role row as returned by the host, including invalid explicit entries. */
export interface CreatorRoleEntry {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  builtIn?: boolean;
  valid: boolean;
  error?: string;
}

export interface CreatorRoleService {
  list(): Promise<CreatorRoleEntry[]>;
  save(id: string, input: CreatorRoleWrite): Promise<CreatorRoleEntry>;
  remove(id: string): Promise<boolean>;
}

export interface CreatorModelReasoning {
  efforts: Partial<Record<ReasoningEffort, string | number | null>>;
  default?: ReasoningEffort;
  wire?: Record<string, unknown>;
}

export interface CreatorModelSourceModelWrite {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ('text' | 'image')[];
  reasoning?: false | CreatorModelReasoning;
}

/**
 * A credential-free model source write. API keys are deliberately absent:
 * the Creator may configure endpoints and apiKeyEnv names, while literal keys
 * remain a Settings-page concern.
 */
export interface CreatorModelSourceWrite {
  name?: string;
  api?: string;
  baseURL?: string;
  clearBaseURL?: boolean;
  apiKeyEnv?: string;
  clearApiKeyEnv?: boolean;
  auth?: 'ambient' | false;
  maxRetries?: number | null;
  models?: CreatorModelSourceModelWrite[];
}

export interface CreatorModelSourceModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input: ('text' | 'image')[];
  reasoning?: CreatorModelReasoning;
  inherited: boolean;
}

export interface CreatorModelSourceSummary {
  id: string;
  name: string;
  api?: string;
  baseURL?: string;
  apiKeyConfigured: boolean;
  apiKeyEnv?: string;
  auth?: 'ambient';
  maxRetries?: number;
  models: CreatorModelSourceModel[];
  builtIn: boolean;
  legacy: boolean;
  active: boolean;
  removable: boolean;
  valid: boolean;
  error?: string;
}

export interface CreatorModelSourceList {
  sources: CreatorModelSourceSummary[];
  defaultSource?: string;
  defaultModel?: string;
  protocols: readonly string[];
  catalogProviders: string[];
}

export interface CreatorDiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ('text' | 'image')[];
}

export interface CreatorDiscoveryRequest {
  provider?: string;
  api?: string;
  baseURL?: string;
  apiKeyEnv?: string;
}

export interface CreatorModelSourceService {
  list(): Promise<CreatorModelSourceList>;
  save(id: string, input: CreatorModelSourceWrite): Promise<CreatorModelSourceSummary>;
  remove(id: string): Promise<boolean>;
  discover(input: CreatorDiscoveryRequest): Promise<{ models: CreatorDiscoveredModel[] }>;
}

/** Presets the Creator may select without the Settings-page risk confirmation. */
export type CreatorPermissionPreset = 'read-only' | 'workspace-write';

export interface CreatorGeneralSettings {
  permissions: DshPermissionSettings;
  archive: ArchiveSettings;
  askUser: AskUserSettings;
  defaultMode: string;
}

export interface CreatorGeneralSettingsService {
  read(): Promise<CreatorGeneralSettings>;
  updatePermission(input: { defaultPreset: CreatorPermissionPreset }): Promise<DshPermissionSettings>;
  updateArchive(input: { enabled: boolean; retentionMs: number }): Promise<ArchiveSettings>;
  updateAskUser(input: { timeoutSec: number }): Promise<AskUserSettings>;
}

export interface CreatorMcpServerWrite {
  type?: string;
  enabled?: boolean;
  timeoutMs?: number | null;
  command?: string;
  args?: string[];
  /** Values must be environment references, never literal secrets. */
  env?: Record<string, string>;
  clearEnv?: string[];
  cwd?: string | null;
  url?: string;
  /** Values must be environment references, never literal secrets. */
  headers?: Record<string, string>;
  clearHeaders?: string[];
}

export interface CreatorMcpServerSummary {
  id: string;
  transport: McpTransport;
  enabled: boolean;
  timeoutMs?: number;
  command?: string;
  args: string[];
  envKeys: string[];
  cwd?: string;
  url?: string;
  headerKeys: string[];
  valid: boolean;
  error?: string;
  runtime?: McpServerRuntimeStatus;
}

export interface CreatorMcpServerList {
  servers: CreatorMcpServerSummary[];
  transports: readonly string[];
}

export interface CreatorMcpService {
  list(): Promise<CreatorMcpServerList>;
  save(id: string, input: CreatorMcpServerWrite): Promise<CreatorMcpServerSummary>;
  remove(id: string): Promise<boolean>;
  /** Probe a stored server; drafts must be saved first. */
  test(id: string): Promise<McpProbeResult>;
}

/**
 * Everything the Creator tools may touch. The host passes this object only to
 * interactive Creator sessions; ordinary sessions never see these tools.
 */
export interface CreatorServices {
  modes: CreatorModeService;
  roles: CreatorRoleService;
  modelSources: CreatorModelSourceService;
  settings: CreatorGeneralSettingsService;
  /** Optional: hosts without MCP configuration simply omit these tools. */
  mcp?: CreatorMcpService;
}
