import { useSyncExternalStore } from 'react';
import { auth, authFetch } from './auth.ts';
import {
  api as wireApi,
  isPermissionPreset,
  jsonOptions,
  messageBodyFits,
  restoreSendAttachment,
  toWireAttachments,
  normalizePlan,
  normalizeTodos,
  permissionPresets,
  sessionApiPath,
  validateAgent,
  validateAgentDefinition,
  validateAgentProfiles,
  validateAgentSkills,
  validateBinding,
  validateModeOptions,
  validateModeSelection,
  validateModeSummary,
  validateModelSourceList,
  validateModelSummary,
  validateMcpProbeResult,
  validateMcpServerList,
  validateDiscoveredModels,
  validatePermissionSettings,
  validateResolvedModel,
  validateRole,
  validateRoleEntry,
  validateScheduleEntry,
  validateScheduleHistory,
  responseError,
  type AgentDefinitionDetail,
  type AgentDefinitionWrite,
  type AgentSkill,
  type AgentSummary,
  type ModeOptions,
  type ModeSelection,
  type ModeSummary,
  type DiscoveredModel,
  type McpProbeResult,
  type McpServerSummary,
  type McpServerWrite,
  type ModelBinding,
  type ModelSourceList,
  type ModelSourceSummary,
  type ModelSourceWrite,
  type ModelSummary,
  type PermissionPreset,
  type PermissionSettings,
  type PlanState,
  type ResolvedModel,
  type RoleEntry,
  type RoleSummary,
  type ScheduleCatalogEntry,
  type ScheduleCreateRequest,
  type ScheduleDeliveryHistoryPage,
  type SchedulePatch,
  type SendAttachment,
  type SessionSummary,
  type TodoItem,
  type Workspace,
} from './wire.ts';
import { DEFAULT_LOCALE, normalizeLocale, translator, type Locale, type Translate } from './i18n.ts';
import { emptyMetrics, validateSessionMetrics, type SessionMetrics } from './session-metrics.ts';
import {
  applyAgentEvent,
  createLiveState,
  hydrateTranscript,
  type LiveTurnState,
  type TranscriptItem,
  type TurnMeta,
} from './events.ts';

export type Theme = 'light' | 'dark';
export type ProcessDisplay = 'collapsed' | 'expanded';
export type BusySendMode = 'queue' | 'steer';
export type Tab = 'conversation' | 'automation' | 'settings';

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: SendAttachment[];
  createdAt: number;
  delivery?: 'uncertain';
}

export interface SessionEntry {
  header: Record<string, unknown> | null;
  title: string | null;
  blank: boolean;
  /** A UI-only new session that is not persisted until its first message. */
  draft: boolean;
  permission: PermissionPreset | null;
  permissionSaving: boolean;
  permissionError: string;
  mode: ModeSelection | null;
  agent: AgentSummary | null;
  agentSaving: boolean;
  agentError: string;
  agentWarnings: string[];
  /** Skills the current agent may load; null when the host did not report them. */
  agentSkills: AgentSkill[] | null;
  binding: ModelBinding | null;
  resolvedModel: ResolvedModel | null;
  modelSaving: boolean;
  modelError: string;
  plan: PlanState;
  planSaving: boolean;
  planError: string;
  todos: TodoItem[] | null;
  transcript: TranscriptItem[];
  turns: TurnMeta[];
  events: unknown[];
  audit: unknown[];
  trajectory: unknown;
  metrics: SessionMetrics | null;
  loaded: boolean;
  loading: boolean;
  error: string;
  request: number;
  outcome: '' | 'error' | 'interrupted';
  /** The server reports an active turn even when this tab is not streaming it. */
  running: boolean;
  queued: QueuedMessage[];
  run?: LiveTurnState;
}

export interface AppState {
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string;
  workspaceId: string | null;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  sessionError: string;
  sessionsByWorkspace: Record<string, { sessions: SessionSummary[]; loading: boolean; error: string; loaded: boolean }>;
  sessionId: string | null;
  selectedByWorkspace: Record<string, string>;
  entries: Record<string, SessionEntry>;
  creatingSession: boolean;
  alert: string;
  tab: Tab;
  theme: Theme;
  locale: Locale;
  processDisplay: ProcessDisplay;
  busySend: BusySendMode;
  permissions: PermissionSettings | null;
  permissionsLoading: boolean;
  permissionsSaving: boolean;
  permissionsError: string;
  models: ModelSummary[];
  modelsLoading: boolean;
  modelsError: string;
  agents: AgentSummary[];
  agentsLoading: boolean;
  agentsError: string;
  roles: RoleSummary[];
  rolesLoading: boolean;
  rolesError: string;
  /** Full role table for Settings → Model configuration (invalid rows included). */
  roleEntries: RoleEntry[];
  /** Editable provider/model sources and their protocol/endpoint metadata. */
  modelSources: ModelSourceSummary[];
  modelSourcesLoading: boolean;
  modelSourcesError: string;
  modelSourceList: ModelSourceList | null;
  /** Configured MCP servers plus their live runtime status. */
  mcpServers: McpServerSummary[];
  mcpServersLoading: boolean;
  mcpServersError: string;
  mcpTransports: string[];
  modes: ModeSummary[];
  modesLoading: boolean;
  modesError: string;
  defaultMode: string;
  modeOptions: ModeOptions;
  newSessionOpen: boolean;
  creationAgent: string;
  creationBinding: ModelBinding;
  defaultAgent: string;
  defaultBinding: ModelBinding;
  schedules: ScheduleCatalogEntry[];
  schedulesLoading: boolean;
  schedulesError: string;
  scheduleSaving: boolean;
  scheduleHistory: Record<string, ScheduleDeliveryHistoryPage>;
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort.
  }
}

export function sessionKey(workspaceId: string, sessionId: string): string {
  return JSON.stringify([workspaceId, sessionId]);
}

function queueStorageKey(workspaceId: string, sessionId: string): string {
  return `omniagent.queue:${workspaceId}:${sessionId}`;
}

function readQueued(workspaceId: string, sessionId: string, strict = false): QueuedMessage[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(queueStorageKey(workspaceId, sessionId)) ?? '[]');
    if (!Array.isArray(parsed)) throw new Error('Invalid queue data');
    return parsed.flatMap((item): QueuedMessage[] => {
      if (typeof item !== 'object' || item === null) return [];
      const record = item as { id?: unknown; text?: unknown; attachments?: unknown; createdAt?: unknown; delivery?: unknown };
      if (typeof record.id !== 'string' || typeof record.text !== 'string') return [];
      const attachments = Array.isArray(record.attachments)
        ? record.attachments.flatMap((entry): SendAttachment[] => {
          const attachment = restoreSendAttachment(entry);
          return attachment === null ? [] : [attachment];
        })
        : [];
      return [{
        id: record.id,
        text: record.text,
        attachments: attachments.map((entry) => ({ ...entry })),
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        ...(record.delivery === 'uncertain' ? { delivery: 'uncertain' as const } : {}),
      }];
    });
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

function writeQueued(workspaceId: string, sessionId: string, items: readonly QueuedMessage[]): boolean {
  try {
    localStorage.setItem(queueStorageKey(workspaceId, sessionId), JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

/** Pinned sessions lead the sidebar; within each group the newest activity wins. */
function sortSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.slice().sort((left, right) =>
    Number(right.pinned === true) - Number(left.pinned === true)
    || (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0));
}

function emptyEntry(): SessionEntry {
  return {
    header: null,
    title: null,
    blank: true,
    draft: false,
    permission: null,
    permissionSaving: false,
    permissionError: '',
    mode: null,
    agent: null,
    agentSaving: false,
    agentError: '',
    agentWarnings: [],
    agentSkills: null,
    binding: null,
    resolvedModel: null,
    modelSaving: false,
    modelError: '',
    plan: { active: false },
    planSaving: false,
    planError: '',
    todos: null,
    transcript: [],
    turns: [],
    events: [],
    audit: [],
    trajectory: null,
    metrics: null,
    loaded: false,
    loading: false,
    error: '',
    request: 0,
    outcome: '',
    running: false,
    queued: [],
  };
}

function initialTheme(): Theme {
  const saved = storageGet('omniagent.theme');
  if (saved === 'dark' || saved === 'light') return saved;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function initialLocale(): Locale {
  return normalizeLocale(storageGet('omniagent.locale')) ?? DEFAULT_LOCALE;
}

function initialSelection(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storageGet('omniagent.activeSessions') ?? '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
    }
  } catch {
    // Ignore malformed persisted selection.
  }
  return {};
}

function initialDefaultAgent(): string {
  const saved = storageGet('omniagent.defaultAgent')?.trim() ?? '';
  return saved === '' ? 'default' : saved;
}function initialDefaultBinding(): ModelBinding {
  const saved = storageGet('omniagent.defaultBinding');
  if (saved !== null && saved !== '') {
    try {
      const parsed = validateBinding(JSON.parse(saved));
      if (parsed !== null) return parsed;
    } catch {
      // Fall through to the agent-following binding.
    }
  }
  return { version: 2, kind: 'agent' };
}

/**
 * Resolve the concrete model a binding will run with. Modes usually follow an
 * agent role, so the seat shows the model and effort that role resolves to
 * rather than just the binding.
 */
function resolveBindingModel(
  binding: ModelBinding,
  agentId: string | undefined,
  agents: readonly AgentSummary[],
  roles: readonly RoleSummary[],
  models: readonly ModelSummary[],
): ResolvedModel | null {
  let provider: string | undefined;
  let modelId: string | undefined;
  let effort: RoleSummary['reasoningEffort'];
  if (binding.kind === 'agent') {
    const agent = agents.find((item) => item.id === agentId);
    const role = roles.find((item) => item.id === agent?.role);
    provider = role?.provider;
    modelId = role?.model;
    effort = role?.reasoningEffort;
  } else if (binding.kind === 'role') {
    const role = roles.find((item) => item.id === binding.role);
    provider = role?.provider;
    modelId = role?.model;
    effort = role?.reasoningEffort;
  } else {
    provider = binding.provider;
    modelId = binding.model;
    effort = binding.reasoningEffort;
  }
  if (provider === undefined || modelId === undefined) return null;
  const summary = models.find((item) => item.provider === provider && item.model === modelId);
  effort ??= summary?.defaultReasoningEffort;
  return {
    provider,
    model: modelId,
    name: summary?.name ?? `${provider}/${modelId}`,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(summary?.contextWindow === undefined ? {} : { contextWindow: summary.contextWindow }),
    ...(summary?.maxTokens === undefined ? {} : { maxTokens: summary.maxTokens }),
    ...(summary?.capabilities === undefined ? {} : { capabilities: summary.capabilities }),
  };
}

function resolveDraftModel(
  mode: ModeSelection,
  agents: readonly AgentSummary[],
  roles: readonly RoleSummary[],
  models: readonly ModelSummary[],
): ResolvedModel | null {
  return resolveBindingModel(mode.model, mode.agent, agents, roles, models);
}

export class AppStore {
  private state: AppState = {
    workspaces: [],
    workspacesLoading: true,
    workspaceError: '',
    workspaceId: null,
    sessions: [],
    sessionsLoading: false,
    sessionError: '',
    sessionsByWorkspace: {},
    sessionId: null,
    selectedByWorkspace: initialSelection(),
    entries: {},
    creatingSession: false,
    alert: '',
    tab: 'conversation',
    theme: initialTheme(),
    locale: initialLocale(),
    processDisplay: storageGet('omniagent.processDisplay') === 'expanded' ? 'expanded' : 'collapsed',
    busySend: storageGet('omniagent.busySend') === 'steer' ? 'steer' : 'queue',
    permissions: null,
    permissionsLoading: true,
    permissionsSaving: false,
    permissionsError: '',
    models: [],
    modelsLoading: true,
    modelsError: '',
    agents: [],
    agentsLoading: true,
    agentsError: '',
    roles: [],
    rolesLoading: true,
    rolesError: '',
    roleEntries: [],
    modelSources: [],
    modelSourcesLoading: true,
    modelSourcesError: '',
    modelSourceList: null,
    mcpServers: [],
    mcpServersLoading: true,
    mcpServersError: '',
    mcpTransports: ['stdio', 'http'],
    modes: [],
    modesLoading: true,
    modesError: '',
    defaultMode: 'standard',
    modeOptions: { tools: [], skills: [] },
    newSessionOpen: false,
    creationAgent: initialDefaultAgent(),
    creationBinding: initialDefaultBinding(),
    defaultAgent: initialDefaultAgent(),
    defaultBinding: initialDefaultBinding(),
    schedules: [],
    schedulesLoading: false,
    schedulesError: '',
    scheduleSaving: false,
    scheduleHistory: {},
  };

  private listeners = new Set<() => void>();
  private notifyScheduled = false;
  private workspaceRequest = 0;
  private readonly sessionRequests = new Map<string, number>();
  private permissionRequest = 0;
  private subagentsRefreshedAt = 0;
  private draftSequence = 0;
  private draftRequest = 0;
  private readonly runningPolls = new Map<string, ReturnType<typeof setTimeout>>();
  private discoveryTimer?: ReturnType<typeof setTimeout>;
  private readonly observers = new Map<string, AbortController>();
  private readonly followBases = new Map<string, { transcript: TranscriptItem[]; turns: TurnMeta[]; metrics?: SessionMetrics }>();
  private readonly followEvents = new Map<string, unknown[]>();
  private readonly flushingQueues = new Set<string>();
  private readonly liveRuns = new Map<string, LiveTurnState>();
  private disposed = false;

  constructor(private readonly restoreQueued = true) {
    if (typeof window !== 'undefined') window.addEventListener('storage', this.onQueueStorage);
  }

  private readonly onQueueStorage = (event: StorageEvent): void => {
    if (event.key !== null && !event.key.startsWith('omniagent.queue:')) return;
    for (const key of Object.keys(this.state.entries)) {
      const [workspaceId, sessionId] = JSON.parse(key) as [string, string];
      if (event.key !== null && event.key !== queueStorageKey(workspaceId, sessionId)) continue;
      try {
        const queued = readQueued(workspaceId, sessionId, true);
        this.patchEntry(key, { queued });
        if (queued.length > 0) void this.flushQueue(workspaceId, sessionId);
      } catch {
        // Never replace a usable snapshot with an unreadable storage value.
      }
    }
  };

  private async queueLock<T>(workspaceId: string, sessionId: string, kind: 'data' | 'delivery', action: () => Promise<T> | T): Promise<T> {
    if (typeof navigator === 'undefined' || navigator.locks === undefined || typeof navigator.locks.request !== 'function') {
      throw new Error('Queue unavailable: browser locking is not supported.');
    }
    return navigator.locks.request(`omniagent.queue.${kind}:${sessionKey(workspaceId, sessionId)}`, async () => {
      if (this.disposed) throw new Error('Workspace closed.');
      return action();
    });
  }

  private async updateQueue<T>(workspaceId: string, sessionId: string, update: (items: QueuedMessage[]) => { items: QueuedMessage[]; result: T; write?: boolean }): Promise<T> {
    return this.queueLock(workspaceId, sessionId, 'data', () => {
      const current = readQueued(workspaceId, sessionId, true);
      const { items, result, write = true } = update(current);
      if (write && !writeQueued(workspaceId, sessionId, items)) throw new Error('Could not save the queue. Browser storage may be full.');
      this.patchEntry(sessionKey(workspaceId, sessionId), { queued: items });
      return result;
    });
  }

  private queueError(error: unknown): void {
    if (!this.disposed) this.showAlert((error as Error).message || 'Queue unavailable.');
  }

  dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('storage', this.onQueueStorage);
    this.disposed = true;
    for (const timer of this.runningPolls.values()) clearTimeout(timer);
    this.runningPolls.clear();
    if (this.discoveryTimer !== undefined) clearTimeout(this.discoveryTimer);
    for (const observer of this.observers.values()) observer.abort();
    this.observers.clear();
    this.followBases.clear();
    this.followEvents.clear();
    this.liveRuns.clear();
    this.listeners.clear();
  }

  private api<T>(path: string, init?: RequestInit): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Workspace closed.'));
    return wireApi<T>(path, init);
  }

  private fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.disposed) return Promise.reject(new Error('Workspace closed.'));
    return authFetch(input, init);
  }

  getSnapshot = (): AppState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private emit(): void {
    this.state = { ...this.state };
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    let flushed = false;
    const flush = (): void => {
      if (flushed) return;
      flushed = true;
      this.notifyScheduled = false;
      for (const listener of [...this.listeners]) listener();
    };
    // Batched UI notifications must not depend on requestAnimationFrame alone:
    // background tabs, embedded webviews and occluded windows may stop frames,
    // which would leave every in-flight load visibly stuck on its initial state.
    if (typeof requestAnimationFrame === 'function') {
      const fallback = setTimeout(flush, 32);
      requestAnimationFrame(() => {
        clearTimeout(fallback);
        flush();
      });
    } else {
      queueMicrotask(flush);
    }
  }

  private patch(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private setWorkspaceSessions(workspaceId: string, patch: Partial<AppState['sessionsByWorkspace'][string]>): void {
    const previous = this.state.sessionsByWorkspace[workspaceId] ?? { sessions: [], loading: false, error: '', loaded: false };
    const next = { ...previous, ...patch };
    this.patch({
      sessionsByWorkspace: { ...this.state.sessionsByWorkspace, [workspaceId]: next },
      ...(this.state.workspaceId === workspaceId
        ? { sessions: next.sessions, sessionsLoading: next.loading, sessionError: next.error }
        : {}),
    });
  }

  private updateWorkspaceSessions(workspaceId: string, update: (sessions: SessionSummary[]) => SessionSummary[]): void {
    this.sessionRequests.set(workspaceId, (this.sessionRequests.get(workspaceId) ?? 0) + 1);
    const previous = this.state.sessionsByWorkspace[workspaceId];
    const sessions = previous?.sessions ?? [];
    this.setWorkspaceSessions(workspaceId, { sessions: update(sessions), loading: false });
    if (previous?.loading && this.state.workspaces.some((workspace) => workspace.id === workspaceId)) {
      void this.loadSessions(workspaceId, this.state.workspaceId === workspaceId && this.state.sessionId === null);
    }
  }

  private patchEntry(key: string, patch: Partial<SessionEntry>): void {
    const entry = this.state.entries[key];
    if (entry === undefined) return;
    this.state = {
      ...this.state,
      entries: { ...this.state.entries, [key]: { ...entry, ...patch } },
    };
    this.emit();
  }

  private patchSessionTitle(key: string, workspaceId: string, sessionId: string, title: string): void {
    const entry = this.state.entries[key];
    if (entry === undefined) return;
    this.state = {
      ...this.state,
      entries: { ...this.state.entries, [key]: { ...entry, title, blank: false } },
    };
    this.updateWorkspaceSessions(workspaceId, (sessions) => sessions.map((session) =>
      session.id === sessionId ? { ...session, title, blank: false } : session));
  }

  private getEntry(workspaceId: string, sessionId: string): SessionEntry {
    const key = sessionKey(workspaceId, sessionId);
    let entry = this.state.entries[key];
    if (entry === undefined) {
      entry = { ...emptyEntry(), queued: this.restoreQueued ? readQueued(workspaceId, sessionId) : [] };
      this.state = { ...this.state, entries: { ...this.state.entries, [key]: entry } };
    }
    return entry;
  }

  private isCurrent(workspaceId: string, sessionId: string): boolean {
    return this.state.workspaceId === workspaceId && this.state.sessionId === sessionId;
  }

  private persistSelection(): void {
    storageSet('omniagent.activeWorkspace', this.state.workspaceId ?? '');
    storageSet('omniagent.activeSessions', JSON.stringify(this.state.selectedByWorkspace));
  }

  currentEntry(): SessionEntry | null {
    const { workspaceId, sessionId, entries } = this.state;
    if (workspaceId === null || sessionId === null) return null;
    return entries[sessionKey(workspaceId, sessionId)] ?? null;
  }

  currentWorkspace(): Workspace | undefined {
    return this.state.workspaces.find((workspace) => workspace.id === this.state.workspaceId);
  }

  showAlert(message: string): void {
    this.patch({ alert: message });
  }

  dismissAlert(): void {
    this.patch({ alert: '' });
  }

  setTab(tab: Tab): void {
    this.patch({ tab });
    if (tab === 'automation' && !this.state.schedulesLoading) void this.loadSchedules();
  }

  async loadSchedules(silent = false): Promise<void> {
    if (!silent) this.patch({ schedulesLoading: true, schedulesError: '' });
    try {
      const body = await this.api<{ schedules?: unknown[] }>('/api/schedules?limit=500');
      const schedules = (Array.isArray(body.schedules) ? body.schedules : []).map(validateScheduleEntry);
      this.patch({ schedules, schedulesLoading: false, schedulesError: '' });
    } catch (error) {
      const message = (error as Error).message;
      this.patch({ schedulesLoading: false, schedulesError: message });
      if (!silent) this.showAlert(translator(this.state.locale)('Could not load automation tasks: {message}', { message }));
    }
  }

  private scheduleFailed(message: string): void {
    this.showAlert(message);
  }

  async createSchedule(request: ScheduleCreateRequest): Promise<ScheduleCatalogEntry | null> {
    if (this.state.scheduleSaving) return null;
    this.patch({ scheduleSaving: true });
    try {
      const body = await this.api<{ schedule?: unknown }>('/api/schedules', jsonOptions('POST', request));
      const created = validateScheduleEntry(body.schedule);
      this.patch({
        scheduleSaving: false,
        schedules: [created, ...this.state.schedules.filter((item) => item.id !== created.id)],
      });
      return created;
    } catch (error) {
      this.patch({ scheduleSaving: false });
      this.scheduleFailed(translator(this.state.locale)('Could not create automation task: {message}', { message: (error as Error).message }));
      return null;
    }
  }

  async editSchedule(id: string, patch: SchedulePatch, expectedUpdatedAt?: string | null): Promise<ScheduleCatalogEntry | null> {
    if (this.state.scheduleSaving) return null;
    this.patch({ scheduleSaving: true });
    try {
      const body = await this.api<{ schedule?: unknown }>(`/api/schedules/${encodeURIComponent(id)}`, jsonOptions('PATCH', {
        patch,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      }));
      const updated = validateScheduleEntry(body.schedule);
      this.patch({
        scheduleSaving: false,
        schedules: this.state.schedules.map((item) => item.id === updated.id ? updated : item),
      });
      return updated;
    } catch (error) {
      this.patch({ scheduleSaving: false });
      this.scheduleFailed(translator(this.state.locale)('Could not save automation task: {message}', { message: (error as Error).message }));
      return null;
    }
  }

  async deleteSchedule(id: string, expectedUpdatedAt?: string | null): Promise<boolean> {
    if (this.state.scheduleSaving) return false;
    this.patch({ scheduleSaving: true });
    try {
      const query = expectedUpdatedAt === undefined || expectedUpdatedAt === null
        ? ''
        : `?expectedUpdatedAt=${encodeURIComponent(expectedUpdatedAt)}`;
      await this.api(`/api/schedules/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
      this.patch({ scheduleSaving: false, schedules: this.state.schedules.filter((item) => item.id !== id) });
      return true;
    } catch (error) {
      this.patch({ scheduleSaving: false });
      this.scheduleFailed(translator(this.state.locale)('Could not delete automation task: {message}', { message: (error as Error).message }));
      return false;
    }
  }

  async runSchedule(id: string): Promise<ScheduleCatalogEntry | null> {
    if (this.state.scheduleSaving) return null;
    this.patch({ scheduleSaving: true });
    try {
      const body = await this.api<{ schedule?: unknown }>(`/api/schedules/${encodeURIComponent(id)}/run`, jsonOptions('POST', {}));
      const updated = validateScheduleEntry(body.schedule);
      this.patch({
        scheduleSaving: false,
        schedules: this.state.schedules.map((item) => item.id === updated.id ? updated : item),
      });
      return updated;
    } catch (error) {
      this.patch({ scheduleSaving: false });
      this.scheduleFailed(translator(this.state.locale)('Could not run automation task: {message}', { message: (error as Error).message }));
      return null;
    }
  }

  async clearEndedSchedules(): Promise<number> {
    try {
      const body = await this.api<{ deleted?: number }>('/api/schedules/clear-ended', jsonOptions('POST', {}));
      await this.loadSchedules(true);
      return typeof body.deleted === 'number' ? body.deleted : 0;
    } catch (error) {
      this.scheduleFailed(translator(this.state.locale)('Could not clear ended tasks: {message}', { message: (error as Error).message }));
      return 0;
    }
  }

  async loadScheduleHistory(id: string, limit = 20, before?: string): Promise<ScheduleDeliveryHistoryPage | null> {
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (before !== undefined) params.set('before', before);
      const body = await this.api<{ history?: unknown }>(`/api/schedules/${encodeURIComponent(id)}/history?${params.toString()}`);
      const page = validateScheduleHistory(body.history);
      this.patch({ scheduleHistory: { ...this.state.scheduleHistory, [id]: page } });
      return page;
    } catch (error) {
      this.scheduleFailed(translator(this.state.locale)('Could not load delivery records: {message}', { message: (error as Error).message }));
      return null;
    }
  }

  /** Show the settings page in the main area and refresh its catalogs. */
  openSettings(): void {
    this.patch({ tab: 'settings' });
    void this.loadPermissions();
    void this.loadCatalogs();
    void this.loadModes();
    void this.loadRoleEntries();
  }

  setTheme(theme: Theme): void {
    storageSet('omniagent.theme', theme);
    document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark');
    document.documentElement.dataset.theme = theme;
    this.patch({ theme });
  }

  toggleTheme(): void {
    this.setTheme(this.state.theme === 'dark' ? 'light' : 'dark');
  }

  setLocale(locale: Locale): void {
    storageSet('omniagent.locale', locale);
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    this.patch({ locale });
  }

  setProcessDisplay(display: ProcessDisplay): void {
    storageSet('omniagent.processDisplay', display);
    this.patch({ processDisplay: display });
  }

  setBusySend(mode: BusySendMode): void {
    storageSet('omniagent.busySend', mode);
    this.patch({ busySend: mode });
  }

  /** Choose the agent a new session starts from. */
  setDefaultAgent(agent: string): void {
    const candidate = this.state.agents.find((entry) =>
      entry.id === agent && entry.valid && entry.usage !== 'subagent');
    if (candidate === undefined || agent === this.state.defaultAgent) return;
    storageSet('omniagent.defaultAgent', agent);
    this.patch({ defaultAgent: agent, creationAgent: agent });
  }

  /** Choose the model source a new session starts from. */
  setDefaultBinding(binding: ModelBinding): void {
    storageSet('omniagent.defaultBinding', JSON.stringify(binding));
    this.patch({ defaultBinding: binding, creationBinding: binding });
  }

  /** Open the mode picker used before a new root session is created. */
  openNewSessionPicker(): void {
    if (this.state.workspaceId === null) return;
    this.patch({ newSessionOpen: true });
    void this.loadModes();
    void this.loadModeOptions();
  }

  closeNewSessionPicker(): void {
    this.patch({ newSessionOpen: false });
  }

  async loadModes(): Promise<void> {
    this.patch({ modesLoading: true, modesError: '' });
    try {
      const body = await this.api<{ modes?: unknown[]; defaultMode?: unknown }>('/api/modes');
      const modes = (body.modes ?? []).map(validateModeSummary);
      this.patch({
        modes,
        modesLoading: false,
        modesError: '',
        defaultMode: typeof body.defaultMode === 'string' && body.defaultMode !== '' ? body.defaultMode : 'standard',
      });
    } catch (error) {
      this.patch({ modesLoading: false, modesError: (error as Error).message });
    }
  }

  async loadModeOptions(): Promise<void> {
    const workspaceId = this.state.workspaceId;
    try {
      const query = workspaceId === null ? '' : `?workspaceId=${encodeURIComponent(workspaceId)}`;
      const body = await this.api<unknown>(`/api/modes/options${query}`);
      this.patch({ modeOptions: validateModeOptions(body) });
    } catch {
      this.patch({ modeOptions: { tools: [], skills: [] } });
    }
  }

  async saveMode(id: string, input: unknown): Promise<string | null> {
    try {
      await this.api(`/api/modes/${encodeURIComponent(id)}`, jsonOptions('PUT', input));
      await this.loadModes();
      return null;
    } catch (error) {
      const message = (error as Error).message;
      this.showAlert(translator(this.state.locale)('Could not save mode: {message}', { message }));
      return message;
    }
  }

  async deleteMode(id: string): Promise<string | null> {
    try {
      await this.api(`/api/modes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await this.loadModes();
      return null;
    } catch (error) {
      const message = (error as Error).message;
      this.showAlert(translator(this.state.locale)('Could not delete mode: {message}', { message }));
      return message;
    }
  }

  async setDefaultMode(id: string): Promise<string | null> {
    try {
      await this.api('/api/settings/default-mode', jsonOptions('PUT', { mode: id }));
      await this.loadModes();
      return null;
    } catch (error) {
      const message = (error as Error).message;
      this.showAlert(translator(this.state.locale)('Could not set the default mode: {message}', { message }));
      return message;
    }
  }

  async loadModelSources(): Promise<void> {
    this.patch({ modelSourcesLoading: true, modelSourcesError: '' });
    try {
      const body = await this.api<unknown>('/api/settings/model-sources');
      const list = validateModelSourceList(body);
      this.patch({
        modelSources: list.sources,
        modelSourceList: list,
        modelSourcesLoading: false,
        modelSourcesError: '',
      });
    } catch (error) {
      this.patch({
        modelSources: [],
        modelSourceList: null,
        modelSourcesLoading: false,
        modelSourcesError: (error as Error).message,
      });
    }
  }

  async saveModelSource(id: string, input: ModelSourceWrite): Promise<string | null> {
    try {
      await this.api(`/api/settings/model-sources/${encodeURIComponent(id)}`, jsonOptions('PUT', input));
      await Promise.all([
        this.loadModelSources(),
        this.loadCatalogs(),
        this.loadRoleEntries(),
        this.loadModes(),
      ]);
      return null;
    } catch (error) {
      const message = (error as Error).message;
      this.showAlert(translator(this.state.locale)('Could not save model source: {message}', { message }));
      return message;
    }
  }

  async deleteModelSource(id: string): Promise<string | null> {
    try {
      await this.api(`/api/settings/model-sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await Promise.all([
        this.loadModelSources(),
        this.loadCatalogs(),
        this.loadRoleEntries(),
        this.loadModes(),
      ]);
      return null;
    } catch (error) {
      const message = (error as Error).message;
      this.showAlert(translator(this.state.locale)('Could not delete model source: {message}', { message }));
      return message;
    }
  }

  async discoverModels(input: Record<string, unknown>): Promise<DiscoveredModel[]> {
    const body = await this.api<unknown>('/api/settings/model-sources/discover', jsonOptions('POST', input));
    return validateDiscoveredModels(body);
  }

  async loadMcpServers(): Promise<void> {
    this.patch({ mcpServersLoading: true, mcpServersError: '' });
    try {
      const body = await this.api<unknown>('/api/settings/mcp-servers');
      const list = validateMcpServerList(body);
      this.patch({
        mcpServers: list.servers,
        mcpTransports: list.transports,
        mcpServersLoading: false,
        mcpServersError: '',
      });
    } catch (error) {
      this.patch({
        mcpServers: [],
        mcpServersLoading: false,
        mcpServersError: (error as Error).message,
      });
    }
  }

  async saveMcpServer(id: string, input: McpServerWrite): Promise<string | null> {
    try {
      await this.api(`/api/settings/mcp-servers/${encodeURIComponent(id)}`, jsonOptions('PUT', input));
      await this.loadMcpServers();
      void this.loadModeOptions();
      return null;
    } catch (error) {
      const message = (error as Error).message;
      this.showAlert(translator(this.state.locale)('Could not save MCP server: {message}', { message }));
      return message;
    }
  }

  async deleteMcpServer(id: string): Promise<string | null> {
    try {
      await this.api(`/api/settings/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await this.loadMcpServers();
      void this.loadModeOptions();
      return null;
    } catch (error) {
      const message = (error as Error).message;
      this.showAlert(translator(this.state.locale)('Could not delete MCP server: {message}', { message }));
      return message;
    }
  }

  async testMcpServer(id: string, server?: McpServerWrite): Promise<McpProbeResult> {
    const body = await this.api<unknown>('/api/settings/mcp-servers/test', jsonOptions('POST', {
      id,
      ...(server === undefined ? {} : { server }),
    }));
    return validateMcpProbeResult(body);
  }

  async loadRoleEntries(): Promise<void> {
    try {
      const body = await this.api<{ roles?: unknown[] }>('/api/settings/roles');
      this.patch({ roleEntries: (body.roles ?? []).map(validateRoleEntry), rolesError: '' });
    } catch (error) {
      this.patch({ roleEntries: [], rolesError: (error as Error).message });
    }
  }

  async saveRole(id: string, input: unknown): Promise<boolean> {
    try {
      await this.api(`/api/settings/roles/${encodeURIComponent(id)}`, jsonOptions('PUT', input));
      await Promise.all([this.loadRoleEntries(), this.loadCatalogs()]);
      return true;
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not save role: {message}', { message: (error as Error).message }));
      return false;
    }
  }

  async deleteRole(id: string): Promise<boolean> {
    try {
      await this.api(`/api/settings/roles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await Promise.all([this.loadRoleEntries(), this.loadCatalogs()]);
      return true;
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not delete role: {message}', { message: (error as Error).message }));
      return false;
    }
  }

  /**
   * Load one editable agent definition plus the profile ids the editor may
   * assign. A null id opens a blank editor backed by the same option list.
   */
  async loadAgentDefinition(id: string | null): Promise<{ agent: AgentDefinitionDetail | null; profiles: string[] } | null> {
    try {
      if (id === null) {
        const body = await this.api<{ profiles?: unknown }>('/api/settings/agents');
        return { agent: null, profiles: validateAgentProfiles(body.profiles) };
      }
      const body = await this.api<{ agent?: unknown; profiles?: unknown }>(
        `/api/settings/agents/${encodeURIComponent(id)}`,
      );
      return {
        agent: validateAgentDefinition(body.agent),
        profiles: validateAgentProfiles(body.profiles),
      };
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not load agent definition: {message}', { message: (error as Error).message }));
      return null;
    }
  }

  async saveAgentDefinition(id: string, input: AgentDefinitionWrite): Promise<boolean> {
    try {
      await this.api(`/api/settings/agents/${encodeURIComponent(id)}`, jsonOptions('PUT', input));
      await this.loadCatalogs();
      return true;
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not save agent: {message}', { message: (error as Error).message }));
      return false;
    }
  }

  async deleteAgentDefinition(id: string): Promise<boolean> {
    try {
      await this.api(`/api/settings/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await this.loadCatalogs();
      return true;
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not delete agent: {message}', { message: (error as Error).message }));
      return false;
    }
  }

  /**
   * Start a new session in Creator mode. The creator mode is built in, so this
   * is also the path the Mode presets settings page uses for its entry button.
   */
  async startCreatorSession(): Promise<string | null> {
    const t = translator(this.state.locale);
    if (this.state.workspaceId === null) {
      this.showAlert(t('Select a workspace before starting Creator mode.'));
      return t('Select a workspace before starting Creator mode.');
    }
    if (!this.state.modes.some((mode) => mode.id === 'creator' && mode.valid)) {
      await this.loadModes();
    }
    const creator = this.state.modes.find((mode) => mode.id === 'creator');
    if (creator === undefined || !creator.valid) {
      const detail = creator === undefined
        ? t('Creator mode is not available in the current mode catalog.')
        : t('Creator mode is unavailable: {message}', { message: creator.warnings.join('; ') });
      this.showAlert(detail);
      return detail;
    }
    return this.startDraftSession('creator');
  }

  async bootstrap(): Promise<void> {
    void this.loadPermissions();
    void this.loadCatalogs();
    void this.loadModelSources();
    void this.loadMcpServers();
    void this.loadModes();
    await this.loadWorkspaces();
    this.scheduleDiscovery();
  }

  private scheduleDiscovery(): void {
    if (this.disposed || this.discoveryTimer !== undefined) return;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = undefined;
      const { workspaceId, sessionId } = this.state;
      if (workspaceId !== null && sessionId !== null) {
        const entry = this.state.entries[sessionKey(workspaceId, sessionId)];
        if (entry?.loaded && !entry.draft && !entry.loading && entry.run === undefined) {
          void this.loadDetail(workspaceId, sessionId, false, true);
        }
      }
      this.scheduleDiscovery();
    }, 3000);
    (this.discoveryTimer as { unref?: () => void }).unref?.();
  }

  async loadWorkspaces(preferredId?: string): Promise<void> {
    const request = ++this.workspaceRequest;
    this.patch({ workspacesLoading: true, workspaceError: '' });
    try {
      const body = await this.api<{ workspaces?: Workspace[] }>('/api/workspaces');
      if (request !== this.workspaceRequest) return;
      const workspaces = Array.isArray(body.workspaces) ? body.workspaces : [];
      const saved = storageGet('omniagent.activeWorkspace');
      const preferred = preferredId ?? this.state.workspaceId ?? (saved !== '' ? saved : null);
      const next = workspaces.find((workspace) => workspace.id === preferred) ?? workspaces[0];
      this.state = { ...this.state, workspaces, workspacesLoading: false };
      this.emit();
      if (next !== undefined && (this.state.workspaceId !== next.id || this.state.sessions.length === 0)) {
        await this.selectWorkspace(next.id);
      } else if (next === undefined) {
        this.state = {
          ...this.state,
          workspaceId: null,
          sessionId: null,
          sessions: [],
          sessionsLoading: false,
          workspacesLoading: false,
        };
        this.persistSelection();
        this.emit();
      }
    } catch (error) {
      if (request !== this.workspaceRequest) return;
      const message = (error as Error).message;
      this.patch({ workspacesLoading: false, workspaceError: message });
      this.showAlert(translator(this.state.locale)('Could not load workspaces: {message}', { message }));
    }
  }

  async selectWorkspace(id: string): Promise<void> {
    if (!this.state.workspaces.some((workspace) => workspace.id === id)) return;
    this.draftRequest += 1;
    this.discardDraft();
    const cached = this.state.sessionsByWorkspace[id];
    this.patch({
      workspaceId: id,
      sessionId: null,
      sessions: cached?.sessions ?? [],
      sessionsLoading: cached?.loading ?? false,
      sessionError: cached?.error ?? '',
      alert: '',
      tab: 'conversation',
      permissionsError: '',
    });
    this.persistSelection();
    await this.loadSessions(id, true);
  }

  async loadSessions(workspaceId: string, restore: boolean): Promise<void> {
    const request = (this.sessionRequests.get(workspaceId) ?? 0) + 1;
    this.sessionRequests.set(workspaceId, request);
    const draftRequest = this.draftRequest;
    this.setWorkspaceSessions(workspaceId, { loading: true, error: '' });
    try {
      const body = await this.api<{ sessions?: SessionSummary[] }>(sessionApiPath(workspaceId));
      if (this.disposed || request !== this.sessionRequests.get(workspaceId)) return;
      if (!Array.isArray(body.sessions)) throw new Error('The server did not return a session list.');
      const sessions = sortSessions(body.sessions);
      this.setWorkspaceSessions(workspaceId, { sessions, loading: false, loaded: true });
      if (restore && this.state.workspaceId === workspaceId) {
        const current = this.state.sessionId;
        if (draftRequest !== this.draftRequest || current !== null) return;
        const wanted = this.state.selectedByWorkspace[workspaceId];
        const found = sessions.find((item) => item.id === wanted) ?? sessions[0];
        if (found !== undefined) this.selectSession(found.id);
        else {
          const selected = { ...this.state.selectedByWorkspace };
          delete selected[workspaceId];
          this.state = { ...this.state, sessionId: null, selectedByWorkspace: selected };
          this.persistSelection();
          this.emit();
          await this.createDraftSession({ workspaceId }, () =>
            !this.disposed && request === this.sessionRequests.get(workspaceId) && this.state.workspaceId === workspaceId
            && this.state.sessionId === null && this.state.sessions.length === 0);
        }
      }
    } catch (error) {
      if (this.disposed || request !== this.sessionRequests.get(workspaceId)) return;
      const message = (error as Error).message;
      this.setWorkspaceSessions(workspaceId, { loading: false, error: message });
      if (this.state.workspaceId === workspaceId) this.showAlert(translator(this.state.locale)('Could not load sessions: {message}', { message }));
    }
  }

  selectSession(id: string, workspaceId = this.state.workspaceId): void {
    if (workspaceId === null || !this.state.workspaces.some((workspace) => workspace.id === workspaceId)) return;
    if (this.state.entries[sessionKey(workspaceId, id)]?.draft === true) return;
    this.draftRequest += 1;
    this.discardDraft();
    const key = sessionKey(workspaceId, id);
    const entry = this.getEntry(workspaceId, id);
    this.state = {
      ...this.state,
      workspaceId,
      sessions: this.state.sessionsByWorkspace[workspaceId]?.sessions ?? [],
      sessionsLoading: this.state.sessionsByWorkspace[workspaceId]?.loading ?? false,
      sessionError: this.state.sessionsByWorkspace[workspaceId]?.error ?? '',
      sessionId: id,
      selectedByWorkspace: { ...this.state.selectedByWorkspace, [workspaceId]: id },
      tab: 'conversation',
      alert: '',
    };
    this.persistSelection();
    this.emit();
    if (entry.run === undefined) void this.loadDetail(workspaceId, id);
  }

  /** Open a session referenced by the composer `#` menu, switching workspace when needed. */
  async openRecentSession(workspaceId: string, sessionId: string): Promise<void> {
    if (this.state.workspaceId !== workspaceId) {
      if (!this.state.workspaces.some((workspace) => workspace.id === workspaceId)) return;
      await this.selectWorkspace(workspaceId);
      if (this.state.workspaceId !== workspaceId) return;
    }
    if (this.state.sessionId === sessionId) return;
    this.selectSession(sessionId);
  }

  async renameSession(id: string, title: string, workspaceId = this.state.workspaceId): Promise<boolean> {
    const trimmed = title.trim();
    if (workspaceId === null || trimmed === '') return false;
    try {
      const body = await this.api<{ title?: unknown }>(
        sessionApiPath(workspaceId, id),
        jsonOptions('PATCH', { title: trimmed }),
      );
      if (typeof body.title !== 'string' || body.title.trim() === '') {
        throw new Error(translator(this.state.locale)('The server returned an empty session title.'));
      }
      const normalized = body.title.trim();
      const key = sessionKey(workspaceId, id);
      const entry = this.state.entries[key];
      this.state = {
        ...this.state,
        ...(entry === undefined ? {} : { entries: { ...this.state.entries, [key]: { ...entry, title: normalized } } }),
      };
      this.updateWorkspaceSessions(workspaceId, (sessions) => sessions.map((session) => session.id === id
        ? { ...session, title: normalized, titleSource: { kind: 'user' }, blank: false }
        : session));
      return true;
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not rename session: {message}', { message: (error as Error).message }));
      return false;
    }
  }

  async setSessionPinned(id: string, pinned: boolean, workspaceId = this.state.workspaceId): Promise<boolean> {
    if (workspaceId === null) return false;
    try {
      const body = await this.api<{ pinned?: unknown }>(
        sessionApiPath(workspaceId, id, 'pin'),
        jsonOptions('POST', { pinned }),
      );
      if (body.pinned !== pinned) throw new Error(translator(this.state.locale)('The server returned a different pin state.'));
      this.updateWorkspaceSessions(workspaceId, (sessions) => sortSessions(sessions.map((session) => session.id === id
        ? { ...session, pinned }
        : session)));
      return true;
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not update session pin: {message}', { message: (error as Error).message }));
      return false;
    }
  }

  async forkSession(id: string, workspaceId = this.state.workspaceId): Promise<string | null> {
    if (workspaceId === null) return null;
    const selection = { workspaceId: this.state.workspaceId, sessionId: this.state.sessionId };
    const entry = this.state.entries[sessionKey(workspaceId, id)];
    if (entry?.run !== undefined || entry?.running === true) {
      this.showAlert(translator(this.state.locale)('Stop the active turn before forking this session.'));
      return null;
    }
    try {
      const body = await this.api<{ session?: SessionSummary }>(
        sessionApiPath(workspaceId, id, 'fork'),
        jsonOptions('POST', {}),
      );
      const session = body.session;
      if (typeof session?.id !== 'string' || session.id === '') {
        throw new Error(translator(this.state.locale)('The server did not return a session ID.'));
      }
      this.updateWorkspaceSessions(workspaceId, (sessions) => sortSessions([session, ...sessions.filter((item) => item.id !== session.id)]));
      if (this.state.workspaceId === selection.workspaceId && this.state.sessionId === selection.sessionId) {
        this.selectSession(session.id, workspaceId);
      }
      return session.id;
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not fork session: {message}', { message: (error as Error).message }));
      return null;
    }
  }

  async deleteSession(id: string, workspaceId = this.state.workspaceId): Promise<boolean> {
    if (workspaceId === null) return false;
    const key = sessionKey(workspaceId, id);
    const entry = this.state.entries[key];
    if (entry?.run !== undefined || entry?.running === true) {
      this.showAlert(translator(this.state.locale)('Stop the active turn before deleting this session.'));
      return false;
    }
    try {
      await this.queueLock(workspaceId, id, 'delivery', async () => {
        await this.api(sessionApiPath(workspaceId, id), { method: 'DELETE' });
        await this.queueLock(workspaceId, id, 'data', () => {
          if (typeof localStorage !== 'undefined') localStorage.removeItem(queueStorageKey(workspaceId, id));
        });
      });
      const sessions = (this.state.sessionsByWorkspace[workspaceId]?.sessions ?? []).filter((session) => session.id !== id);
      const entries = { ...this.state.entries };
      delete entries[key];
      this.clearRunningPoll(key);
      this.liveRuns.delete(key);
      const selected = { ...this.state.selectedByWorkspace };
      if (selected[workspaceId] === id) {
        if (sessions[0] === undefined) delete selected[workspaceId];
        else selected[workspaceId] = sessions[0].id;
      }
      const wasSelected = this.state.workspaceId === workspaceId && this.state.sessionId === id;
      const nextId = wasSelected ? selected[workspaceId] ?? null : this.state.sessionId;
      this.state = {
        ...this.state,
        entries,
        selectedByWorkspace: selected,
        ...(wasSelected ? { sessionId: nextId } : {}),
      };
      this.persistSelection();
      this.updateWorkspaceSessions(workspaceId, () => sessions);
      if (wasSelected && nextId !== null) this.selectSession(nextId);
      return true;
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not delete session: {message}', { message: (error as Error).message }));
      return false;
    }
  }

  async loadDetail(workspaceId: string, sessionId: string, reconcile = false, silent = false): Promise<boolean> {
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.getEntry(workspaceId, sessionId);
    if (entry.draft || (entry.run !== undefined && !reconcile) || entry.permissionSaving || entry.agentSaving || entry.modelSaving) return false;
    const request = ++entry.request;
    if (!silent) this.patchEntry(key, { loading: true, error: '' });
    try {
      const body = await this.api<Record<string, unknown>>(sessionApiPath(workspaceId, sessionId));
      if (this.state.entries[key]?.request !== request || (silent && this.state.entries[key]?.run !== undefined)) return false;
      if (typeof body.permission !== 'object' || body.permission === null
        || !Object.hasOwn(body.permission, 'preset')
        || ((body.permission as { preset?: unknown }).preset !== null
          && !isPermissionPreset((body.permission as { preset?: unknown }).preset))) {
        throw new Error(translator(this.state.locale)('Invalid session permission response.'));
      }
      const preset = (body.permission as { preset: PermissionPreset | null }).preset;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const events = Array.isArray(body.events) ? body.events : [];
      const hydrated = hydrateTranscript(messages as never, events);
      this.patchEntry(key, {
        header: typeof body.header === 'object' && body.header !== null ? body.header as Record<string, unknown> : null,
        title: typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : null,
        blank: body.blank === true,
        permission: preset,
        permissionError: '',
        mode: validateModeSelection(body.mode),
        agent: validateAgent(body.agent),
        agentError: typeof body.agentError === 'string' ? body.agentError : '',
        agentWarnings: Array.isArray(body.agentWarnings)
          ? body.agentWarnings.filter((item): item is string => typeof item === 'string')
          : [],
        agentSkills: validateAgentSkills(body.agentSkills),
        binding: validateBinding(body.model),
        resolvedModel: validateResolvedModel(body.resolvedModel),
        modelError: '',
        plan: normalizePlan(body.plan),
        planError: '',
        todos: normalizeTodos(body.todos),
        transcript: hydrated.transcript,
        turns: hydrated.turns,
        events,
        audit: Array.isArray(body.audit) ? body.audit : [],
        trajectory: body.trajectory ?? null,
        metrics: validateSessionMetrics(body.metrics),
        loaded: true,
        loading: false,
        error: '',
        outcome: '',
        running: body.running === true,
      });
      if (body.running === true) {
        if (this.state.entries[key]?.run === undefined) this.followRun(workspaceId, sessionId);
      } else {
        this.clearRunningPoll(key);
        void this.flushQueue(workspaceId, sessionId);
      }
      return true;
    } catch (error) {
      if (this.state.entries[key]?.request !== request) return false;
      if (silent) return false;
      const message = (error as Error).message;
      this.patchEntry(key, {
        error: message,
        loading: false,
        ...(entry.loaded ? { permissionError: 'Could not refresh session permission. Choose a permission or reload the session.' } : {}),
      });
      if (!reconcile && this.isCurrent(workspaceId, sessionId)) this.showAlert(translator(this.state.locale)('Could not load session: {message}', { message }));
      return false;
    }
  }

  /**
   * Show a new root session in the main area without persisting anything. The
   * server-side session is created from the first message, which is also when
   * its mode, permission and plan settings are written.
   */
  async startDraftSession(options?: string | { modeId?: string; workspaceId?: string }): Promise<string | null> {
    return this.createDraftSession(options);
  }

  private async createDraftSession(
    options?: string | { modeId?: string; workspaceId?: string },
    isStillWanted: () => boolean = () => true,
  ): Promise<string | null> {
    const draftRequest = ++this.draftRequest;
    const t = translator(this.state.locale);
    const request = typeof options === 'string' ? { modeId: options } : options ?? {};
    if (this.state.modes.length === 0) await this.loadModes();
    if (this.state.permissions === null) await this.loadPermissions();
    if (this.disposed || draftRequest !== this.draftRequest || !isStillWanted()) return null;
    if (this.state.permissions === null) {
      const message = t('Could not create session: {message}', { message: this.state.permissionsError || 'Permission settings are unavailable.' });
      this.showAlert(message);
      return message;
    }
    const workspaceId = request.workspaceId ?? this.state.workspaceId ?? this.state.workspaces[0]?.id;
    if (workspaceId === undefined || !this.state.workspaces.some((workspace) => workspace.id === workspaceId)) {
      const message = t('Could not create session: no workspace is selected.');
      this.showAlert(message);
      return message;
    }
    const modes = this.state.modes.filter((item) => item.valid);
    const requested = request.modeId ?? (this.state.defaultMode || 'standard');
    const mode = modes.find((item) => item.id === requested) ?? modes[0];
    if (mode === undefined) {
      const message = t('Could not create session: {message}', { message: t('No usable modes are configured.') });
      this.showAlert(message);
      return message;
    }
    this.discardDraft();
    this.draftSequence += 1;
    const draftId = `draft-${Date.now().toString(36)}-${this.draftSequence}`;
    const settings = this.state.permissions;
    const permission = settings !== null && !settings.requiresSelection ? settings.defaultPreset : null;
    const selection: ModeSelection = {
      version: 1,
      mode: mode.id,
      agent: mode.agent,
      model: mode.model,
      tools: mode.tools,
      skills: mode.skills,
    };
    const switched = this.state.workspaceId !== workspaceId;
    this.state = {
      ...this.state,
      ...(switched ? {
        workspaceId,
        sessions: this.state.sessionsByWorkspace[workspaceId]?.sessions ?? [],
        sessionsLoading: this.state.sessionsByWorkspace[workspaceId]?.loading ?? false,
        sessionError: this.state.sessionsByWorkspace[workspaceId]?.error ?? '',
        permissionsError: '',
      } : {}),
      sessionId: draftId,
      entries: {
        ...this.state.entries,
        [sessionKey(workspaceId, draftId)]: {
          ...emptyEntry(),
          draft: true,
          loaded: true,
          mode: selection,
          agent: this.state.agents.find((item) => item.id === mode.agent) ?? null,
          binding: mode.model,
          resolvedModel: resolveDraftModel(selection, this.state.agents, this.state.roles, this.state.models),
          permission,
        },
      },
      newSessionOpen: false,
      tab: 'conversation',
      alert: '',
    };
    this.persistSelection();
    this.emit();
    if (switched) void this.loadSessions(workspaceId, false);
    return null;
  }

  /** Change the mode of the current new-session draft before it is persisted. */
  selectDraftMode(modeId: string): void {
    const { workspaceId, sessionId, entries } = this.state;
    if (workspaceId === null || sessionId === null) return;
    const key = sessionKey(workspaceId, sessionId);
    const entry = entries[key];
    if (entry?.draft !== true || entry.mode?.mode === modeId) return;
    const mode = this.state.modes.find((item) => item.id === modeId && item.valid);
    if (mode === undefined) return;
    const selection: ModeSelection = {
      version: 1,
      mode: mode.id,
      agent: mode.agent,
      model: mode.model,
      tools: mode.tools,
      skills: mode.skills,
    };
    this.patchEntry(key, {
      mode: selection,
      agent: this.state.agents.find((item) => item.id === mode.agent) ?? null,
      binding: mode.model,
      resolvedModel: resolveDraftModel(selection, this.state.agents, this.state.roles, this.state.models),
    });
  }

  /** Move the current draft to another workspace, keeping its mode and settings. */
  selectDraftWorkspace(workspaceId: string): void {
    const { workspaceId: current, sessionId, entries } = this.state;
    if (current === null || sessionId === null || current === workspaceId) return;
    const entry = entries[sessionKey(current, sessionId)];
    if (entry?.draft !== true || entry.run !== undefined || entry.running) return;
    if (!this.state.workspaces.some((workspace) => workspace.id === workspaceId)) return;
    this.draftRequest += 1;
    const oldKey = sessionKey(current, sessionId);
    const nextKey = sessionKey(workspaceId, sessionId);
    const nextEntries = { ...entries, [nextKey]: entry };
    delete nextEntries[oldKey];
    const cached = this.state.sessionsByWorkspace[workspaceId];
    this.state = {
      ...this.state,
      workspaceId,
      sessions: cached?.sessions ?? [],
      sessionsLoading: cached?.loading ?? false,
      sessionError: cached?.error ?? '',
      permissionsError: '',
      entries: nextEntries,
    };
    this.persistSelection();
    this.emit();
    void this.loadSessions(workspaceId, false);
  }

  /** Drop the UI-only draft session without touching persisted sessions. */
  private discardDraft(): void {
    const { workspaceId, sessionId, entries } = this.state;
    const drafts = Object.entries(entries).filter(([, entry]) => entry.draft === true);
    if (drafts.length === 0) return;
    const currentIsDraft = workspaceId !== null && sessionId !== null
      && entries[sessionKey(workspaceId, sessionId)]?.draft === true;
    const next = { ...entries };
    for (const [key] of drafts) delete next[key];
    this.state = {
      ...this.state,
      entries: next,
      ...(currentIsDraft
        ? { sessionId: workspaceId === null ? null : this.state.selectedByWorkspace[workspaceId] ?? null }
        : {}),
    };
    this.emit();
  }

  /**
   * Persist a draft with its mode plus any model, permission and plan chosen
   * before sending.
   */
  private async persistDraftSession(
    workspaceId: string,
    entry: SessionEntry,
  ): Promise<{ session: SessionSummary; setupError: Error | null }> {
    const mode = entry.mode;
    if (mode === null) throw new Error(translator(this.state.locale)('The session mode is unavailable.'));
    // The mode supplies the default model. A binding the user changed in the
    // draft is sent with creation so the session starts with that model.
    const override = entry.binding !== null && JSON.stringify(entry.binding) !== JSON.stringify(mode.model)
      ? entry.binding
      : undefined;
    this.patch({ creatingSession: true });
    try {
      const body = await this.api<{ session?: SessionSummary }>(
        sessionApiPath(workspaceId),
        jsonOptions('POST', {
          mode: mode.mode,
          ...(override === undefined ? {} : { model: override }),
        }),
      );
      if (typeof body.session?.id !== 'string') {
        throw new Error(translator(this.state.locale)('The server did not return a session ID.'));
      }
      const session = body.session;
      let setupError: Error | null = null;
      if (isPermissionPreset(entry.permission)) {
        try {
          await this.api(
            sessionApiPath(workspaceId, session.id, 'permission'),
            jsonOptions('POST', { preset: entry.permission }),
          );
        } catch (error) {
          setupError = error as Error;
        }
      }
      if (setupError === null && entry.plan.active) {
        try {
          await this.api(
            sessionApiPath(workspaceId, session.id, 'plan'),
            jsonOptions('POST', { active: true }),
          );
        } catch (error) {
          setupError = error as Error;
        }
      }
      return { session, setupError };
    } finally {
      this.patch({ creatingSession: false });
    }
  }

  /**
   * Start a turn. Resolves true once the server accepted the request; the
   * stream then continues in the background and updates the session entry.
   */
  async sendMessage(text: string, attachments: readonly SendAttachment[] = [], onAccepted?: () => void): Promise<boolean> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return false;
    return this.startTurn(workspaceId, sessionId, text, attachments, onAccepted);
  }

  /**
   * Deliver a message into the turn that is already running. The server adds it
   * to the session history and the model sees it at its next step.
   */
  async steerMessage(text: string, attachments: readonly SendAttachment[] = []): Promise<boolean> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return false;
    return this.steerForSession(workspaceId, sessionId, text, attachments);
  }

  private async steerForSession(workspaceId: string, sessionId: string, text: string, attachments: readonly SendAttachment[], onUncertain?: () => void): Promise<boolean> {
    if (text.trim() === '' && attachments.length === 0) return false;
    if (!messageBodyFits(text, attachments, true)) {
      this.showAlert(translator(this.state.locale)('Message and attachments exceed the 32 MiB request limit.'));
      return false;
    }
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.getEntry(workspaceId, sessionId);
    if (!entry.loaded || entry.loading || entry.permissionSaving || entry.agentSaving || entry.modelSaving
      || !isPermissionPreset(entry.permission) || entry.agent === null || entry.binding === null) return false;
    let posting = false;
    let responseReceived = false;
    try {
      posting = true;
      const response = await this.fetch(sessionApiPath(workspaceId, sessionId, 'messages'), jsonOptions('POST', {
        text,
        ...(attachments.length === 0 ? {} : { attachments: toWireAttachments(attachments) }),
        mode: 'steer',
      }));
      responseReceived = true;
      if (!response.ok) {
        if (response.status >= 500) onUncertain?.();
        if (response.status === 409) {
          await this.loadDetail(workspaceId, sessionId, true);
          const current = this.state.entries[key];
          if (current?.running !== true) {
            this.observers.get(key)?.abort();
            this.observers.delete(key);
            this.clearRunningPoll(key);
            this.followBases.delete(key);
            this.liveRuns.delete(key);
            if (current?.run !== undefined) this.patchEntry(key, { run: undefined });
            this.followEvents.delete(key);
            return this.startTurn(workspaceId, sessionId, text, attachments, undefined, onUncertain);
          }
        }
        throw new Error(await responseError(response));
      }
      let broadcast = false;
      try {
        broadcast = (await response.json() as { broadcast?: unknown }).broadcast === true;
      } catch {
        // Older servers may not return a JSON response.
      }
      const current = this.state.entries[key];
      const live = this.liveRuns.get(key) ?? current?.run;
      if (live !== undefined && !broadcast) {
        const turn = live.turns.at(-1)?.index ?? 0;
        live.transcript.push({
          kind: 'user',
          id: `user-${Date.now()}`,
          turn,
          timestamp: Date.now(),
          text,
          ...(attachments.length === 0 ? {} : { attachments: toWireAttachments(attachments).map((item) => ({ ...item })) }),
        });
        this.patchEntry(key, { run: { ...live } });
      } else {
        this.scheduleRunningPoll(workspaceId, sessionId);
      }
      return true;
    } catch (error) {
      if (posting && !responseReceived) onUncertain?.();
      this.showAlert(translator(this.state.locale)('Could not send message: {message}', { message: (error as Error).message }));
      return false;
    }
  }

  /** Keep a message for the next turn instead of interrupting the active reply. */
  async queueMessage(text: string, attachments: readonly SendAttachment[] = []): Promise<boolean> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return false;
    if (text.trim() === '' && attachments.length === 0) return false;
    if (!messageBodyFits(text, attachments, true)) {
      this.showAlert(translator(this.state.locale)('Message and attachments exceed the 32 MiB request limit.'));
      return false;
    }
    this.getEntry(workspaceId, sessionId);
    try {
      await this.updateQueue(workspaceId, sessionId, (items) => ({
        items: [...items, {
          id: `queued-${crypto.randomUUID()}`,
          text,
          attachments: attachments.map((item) => ({ ...item })),
          createdAt: Date.now(),
        }],
        result: true,
      }));
      void this.flushQueue(workspaceId, sessionId);
      return true;
    } catch (error) {
      this.queueError(error);
      return false;
    }
  }

  private async deliverQueued(workspaceId: string, sessionId: string, id: string | undefined, steer: boolean): Promise<boolean> {
    const key = sessionKey(workspaceId, sessionId);
    try {
      return await this.queueLock(workspaceId, sessionId, 'delivery', async () => {
        const entry = this.state.entries[key];
        if (entry === undefined || !entry.loaded || entry.loading || entry.draft
          || (steer ? entry.run === undefined && !entry.running : entry.run !== undefined || entry.running)) return false;
        if (!steer) {
          const detail = await this.api<Record<string, unknown>>(sessionApiPath(workspaceId, sessionId));
          if (typeof detail.running !== 'boolean') throw new Error('Could not verify the session run state.');
          if (detail.running) {
            this.patchEntry(key, { running: true });
            this.followRun(workspaceId, sessionId);
            return false;
          }
        }
        const item = await this.updateQueue(workspaceId, sessionId, (items) => {
          const selected = id === undefined ? items[0] : items.find((candidate) => candidate.id === id);
          if (selected === undefined || selected.delivery === 'uncertain') return { items, result: undefined, write: false };
          return {
            items: items.map((candidate) => candidate.id === selected.id ? { ...candidate, delivery: 'uncertain' as const } : candidate),
            result: selected,
          };
        });
        if (item === undefined) return false;
        let uncertain = false;
        const markUncertain = (): void => { uncertain = true; };
        const accepted = steer
          ? await this.steerForSession(workspaceId, sessionId, item.text, item.attachments, markUncertain)
          : await this.startTurn(workspaceId, sessionId, item.text, item.attachments, undefined, markUncertain);
        await this.updateQueue(workspaceId, sessionId, (items) => ({
          items: accepted ? items.filter((candidate) => candidate.id !== item.id)
            : uncertain ? items : items.map((candidate) => {
              if (candidate.id !== item.id) return candidate;
              const { delivery: _delivery, ...rest } = candidate;
              return rest;
            }),
          result: undefined,
        }));
        return accepted;
      });
    } catch (error) {
      this.queueError(error);
      return false;
    }
  }

  async steerQueuedMessage(id: string): Promise<boolean> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return false;
    return this.deliverQueued(workspaceId, sessionId, id, true);
  }

  async steerQueuedMessages(): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return;
    let ids: string[];
    try {
      ids = await this.updateQueue(workspaceId, sessionId, (items) => ({ items, result: items.map((item) => item.id), write: false }));
    } catch (error) {
      this.queueError(error);
      return;
    }
    for (const id of ids) {
      if (this.state.workspaceId !== workspaceId || this.state.sessionId !== sessionId || !await this.steerQueuedMessage(id)) break;
    }
  }

  async removeQueuedMessage(id: string): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return;
    try {
      await this.queueLock(workspaceId, sessionId, 'delivery', async () => {
        await this.updateQueue(workspaceId, sessionId, (items) => ({ items: items.filter((item) => item.id !== id), result: undefined }));
      });
      void this.flushQueue(workspaceId, sessionId);
    } catch (error) {
      this.queueError(error);
    }
  }

  private async startTurn(
    workspaceId: string,
    sessionId: string,
    text: string,
    attachments: readonly SendAttachment[],
    onAccepted?: () => void,
    onUncertain?: () => void,
  ): Promise<boolean> {
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.getEntry(workspaceId, sessionId);
    if (!entry.loaded || entry.loading || entry.permissionSaving || entry.agentSaving || entry.modelSaving
      || !isPermissionPreset(entry.permission) || entry.agent === null || entry.binding === null
      || entry.run !== undefined || entry.running) return false;
    if (text.trim() === '' && attachments.length === 0) return false;
    if (!messageBodyFits(text, attachments)) {
      this.showAlert(translator(this.state.locale)('Message and attachments exceed the 32 MiB request limit.'));
      return false;
    }
    let baseTurn = -1;
    for (const item of entry.transcript) baseTurn = Math.max(baseTurn, item.turn);
    for (const turn of entry.turns) baseTurn = Math.max(baseTurn, turn.index);
    baseTurn += 1;
    const run = createLiveState();
    run.metrics = entry.metrics === null ? emptyMetrics() : structuredClone(entry.metrics);
    run.turns.push({ index: baseTurn, startedAt: Date.now() });
    run.transcript = [
      ...entry.transcript,
      {
        kind: 'user',
        id: `user-${Date.now()}`,
        turn: baseTurn,
        timestamp: Date.now(),
        text,
        ...(attachments.length === 0 ? {} : { attachments: toWireAttachments(attachments).map((item) => ({ ...item })) }),
      },
    ];
    entry.request += 1;
    this.patchEntry(key, { run, outcome: '', todos: null, transcript: run.transcript, turns: run.turns });
    let accepted = false;
    let posting = false;
    let rejected = false;
    let targetId = sessionId;
    let targetKey = key;
    try {
      if (entry.draft === true) {
        const created = await this.persistDraftSession(workspaceId, entry);
        targetId = created.session.id;
        targetKey = sessionKey(workspaceId, targetId);
        const current = this.state.entries[key] ?? entry;
        const entries = { ...this.state.entries };
        delete entries[key];
        entries[targetKey] = {
          ...current,
          draft: false,
          request: 0,
          ...(created.setupError === null
            ? {}
            : {
              permission: null,
              permissionError: translator(this.state.locale)('Could not change permission: {message}', {
                message: created.setupError.message,
              }),
            }),
        };
        this.state = {
          ...this.state,
          entries,
          ...(this.state.workspaceId === workspaceId && this.state.sessionId === sessionId
            ? {
              sessionId: targetId,
              selectedByWorkspace: { ...this.state.selectedByWorkspace, [workspaceId]: targetId },
            }
            : {}),
        };
        if (this.state.workspaceId === workspaceId && this.state.sessionId === targetId) this.persistSelection();
        this.updateWorkspaceSessions(workspaceId, (sessions) => sortSessions([created.session, ...sessions.filter((item) => item.id !== targetId)]));
        if (created.setupError !== null) throw created.setupError;
      }
      posting = true;
      const response = await this.fetch(sessionApiPath(workspaceId, targetId, 'messages'), {
        ...jsonOptions('POST', {
          text,
          ...(attachments.length === 0 ? {} : { attachments: toWireAttachments(attachments) }),
        }),
        headers: { 'content-type': 'application/json', prefer: 'respond-async' },
      });
      if (!response.ok) {
        let uncertainStart = false;
        try {
          const body = await response.clone().json() as { code?: unknown };
          uncertainStart = body.code === 'turn_start_failed_message_may_be_saved';
        } catch {
          // An unreadable error response cannot establish the special error code.
        }
        rejected = response.status < 500 && !uncertainStart;
        const message = await responseError(response);
        throw new Error(response.status === 409 ? translator(this.state.locale)('Another turn is already running. {message}', { message }) : message);
      }
      accepted = true;
      onAccepted?.();
      if (response.status === 202 || response.headers.get('content-type')?.includes('application/json')) {
        this.followRun(workspaceId, targetId, run);
      } else if (response.body !== null) {
        void this.consumeStream(workspaceId, targetId, targetKey, run, response.body);
      } else {
        this.followRun(workspaceId, targetId, run);
      }
      return true;
    } catch (error) {
      const uncertain = posting && !rejected && !accepted;
      this.patchEntry(targetKey, { run: undefined, transcript: entry.transcript, turns: entry.turns, outcome: uncertain ? '' : 'error' });
      this.showAlert(translator(this.state.locale)('Could not complete turn: {message}', { message: (error as Error).message }));
      if (uncertain) {
        onUncertain?.();
        void this.loadDetail(workspaceId, targetId, true);
      }
      return accepted;
    }
  }

  /** Send the oldest queued message once the session is no longer running. */
  private async flushQueue(workspaceId: string, sessionId: string): Promise<void> {
    const key = sessionKey(workspaceId, sessionId);
    if (this.disposed || this.flushingQueues.has(key)) return;
    const entry = this.state.entries[key];
    if (entry === undefined || !entry.loaded || entry.loading || entry.draft
      || entry.run !== undefined || entry.running || entry.queued.length === 0) return;
    this.flushingQueues.add(key);
    try {
      await this.deliverQueued(workspaceId, sessionId, undefined, false);
    } finally {
      this.flushingQueues.delete(key);
    }
  }

  /** Refresh a turn that another tab owns until it settles, then drain the queue. */
  private scheduleRunningPoll(workspaceId: string, sessionId: string): void {
    const key = sessionKey(workspaceId, sessionId);
    if (this.disposed || this.runningPolls.has(key) || this.state.entries[key]?.run !== undefined) return;
    const timer = setTimeout(() => {
      this.runningPolls.delete(key);
      const entry = this.state.entries[key];
      if (entry === undefined || entry.running !== true || entry.run !== undefined) return;
      void this.loadDetail(workspaceId, sessionId, true);
    }, 1500);
    (timer as { unref?: () => void }).unref?.();
    this.runningPolls.set(key, timer);
  }

  private clearRunningPoll(key: string): void {
    const timer = this.runningPolls.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.runningPolls.delete(key);
  }

  /** Observe an active run independently of the request that started it. */
  private followRun(workspaceId: string, sessionId: string, existing?: LiveTurnState): void {
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.state.entries[key];
    if (this.disposed || entry === undefined || this.observers.has(key)) return;
    const run = existing ?? createLiveState();
    if (existing === undefined) {
      run.transcript = entry.transcript.slice();
      run.turns = entry.turns.map((turn) => ({ ...turn }));
    }
    let base = this.followBases.get(key);
    if (base === undefined) {
      const lastUser = run.transcript.findLastIndex((item) => item.kind === 'user');
      base = {
        transcript: lastUser < 0 ? run.transcript.slice() : run.transcript.slice(0, lastUser + 1),
        turns: run.turns.filter((turn) => lastUser < 0 || turn.index <= run.transcript[lastUser]!.turn).map((turn) => ({ ...turn })),
        metrics: existing?.metrics === undefined ? undefined : structuredClone(existing.metrics),
      };
      this.followBases.set(key, base);
    }
    const snapshotBase = base;
    const controller = new AbortController();
    this.observers.set(key, controller);
    this.liveRuns.set(key, run);
    this.patchEntry(key, { run: { ...run }, running: true });
    let finished = false;
    void (async () => {
      try {
        const response = await this.fetch(sessionApiPath(workspaceId, sessionId, 'follow'), { signal: controller.signal });
        if (response.status === 204) {
          finished = await this.finishObservedRun(workspaceId, sessionId, key, run);
        } else {
          if (!response.ok || response.body === null) throw new Error('Unable to follow run');
          finished = await this.consumeStream(workspaceId, sessionId, key, run, response.body, (baseline) => {
            const stopping = this.state.entries[key]?.run?.stopping;
            const fresh = createLiveState();
            const hydrated = baseline === undefined ? undefined : hydrateTranscript(baseline.messages as never);
            fresh.transcript = hydrated?.transcript ?? snapshotBase.transcript.slice();
            fresh.turns = hydrated?.turns ?? snapshotBase.turns.map((turn) => ({ ...turn }));
            if (hydrated !== undefined && fresh.turns.length > 0) fresh.turns[fresh.turns.length - 1]!.endedAt = 0;
            const metrics = baseline === undefined ? snapshotBase.metrics : validateSessionMetrics(baseline.metrics) ?? undefined;
            fresh.metrics = metrics === undefined ? undefined : structuredClone(metrics);
            fresh.stopping = stopping;
            Object.assign(run, fresh, {
              approval: undefined, planReview: undefined, outcome: undefined, error: undefined,
              streamAssistantId: undefined, streamReasoningId: undefined, finishing: false,
              metricsStepsSeen: undefined, metricsLastStep: undefined, metricsRunEnded: undefined,
            });
          }, true);
        }
      } catch {
        // An observer failure says nothing about the server-side run.
      } finally {
        if (this.observers.get(key) !== controller) return;
        this.observers.delete(key);
        if (finished) void this.flushQueue(workspaceId, sessionId);
        if (!finished && !this.disposed && this.state.entries[key]?.run !== undefined) {
          const timer = setTimeout(() => {
            this.runningPolls.delete(key);
            this.followRun(workspaceId, sessionId, run);
          }, 1500);
          (timer as { unref?: () => void }).unref?.();
          this.runningPolls.set(key, timer);
        }
      }
    })();
  }

  private async finishObservedRun(workspaceId: string, sessionId: string, key: string, run: LiveTurnState): Promise<boolean> {
    if (run.outcome !== undefined) this.patchEntry(key, { run: { ...run, finishing: true } });
    const reconciled = await this.loadDetail(workspaceId, sessionId, true);
    const current = this.state.entries[key];
    if (!reconciled || current === undefined || current.running) {
      if (current?.run !== undefined && run.outcome !== undefined) this.patchEntry(key, { run: { ...run, finishing: false } });
      return false;
    }
    const lastInput = current.events.findLastIndex((event) => typeof event === 'object' && event !== null
      && ['message/user', 'user/message'].includes(String((event as { type?: unknown }).type)));
    const lastEndIndex = current.events.findLastIndex((event) => typeof event === 'object' && event !== null
      && (event as { type?: unknown }).type === 'trace/turn.end');
    const lastEnd = lastInput >= 0 && lastEndIndex > lastInput ? current.events[lastEndIndex] as { data?: { reason?: unknown } } : undefined;
    const reason = run.outcome ?? lastEnd?.data?.reason;
    this.patchEntry(key, {
      run: undefined,
      outcome: reason === 'interrupted' ? 'interrupted' : reason === 'error' || run.error !== undefined ? 'error' : '',
    });
    this.liveRuns.delete(key);
    this.followBases.delete(key);
    this.followEvents.delete(key);
    if (!this.observers.has(key)) void this.flushQueue(workspaceId, sessionId);
    if (this.state.workspaceId === workspaceId) {
      void this.loadSessions(workspaceId, false);
      void this.refreshSubagentSessions(workspaceId);
    }
    return true;
  }

  private async consumeStream(
    workspaceId: string,
    sessionId: string,
    key: string,
    run: LiveTurnState,
    body: ReadableStream<Uint8Array>,
    resetSnapshot?: (baseline?: { messages: unknown[]; metrics?: unknown }) => void,
    observed = false,
  ): Promise<boolean> {
    this.liveRuns.set(key, run);
    const decoder = new TextDecoder();
    const { createSSEParser } = await import('./events.ts');
    const parser = createSSEParser((event) => {
      const snapshot = event as { type?: unknown; events?: unknown; truncated?: unknown; baseline?: unknown } | null;
      if (snapshot?.type === 'run.snapshot') {
        if (!Array.isArray(snapshot.events) || resetSnapshot === undefined) throw new Error('Invalid run snapshot');
        const snapshotEvents = snapshot.events;
        const previous = this.followEvents.get(key);
        const prefixMatches = previous !== undefined && previous.length <= snapshotEvents.length
          && previous.every((item, index) => JSON.stringify(item) === JSON.stringify(snapshotEvents[index]));
        if ((snapshot.truncated === true || previous !== undefined) && !prefixMatches) {
          this.showAlert(snapshot.truncated === true
            ? 'Live history is incomplete because the run snapshot was truncated.'
            : 'Live history could not be reconciled after reconnecting.');
          throw new Error('Unrecoverable run snapshot');
        }
        if (prefixMatches) {
          for (const item of snapshot.events.slice(previous.length)) applyAgentEvent(run, item as never);
        } else {
          const baseline = snapshot.baseline;
          if (baseline !== undefined && (typeof baseline !== 'object' || baseline === null
            || !Array.isArray((baseline as { messages?: unknown }).messages))) throw new Error('Invalid run baseline');
          resetSnapshot(baseline as { messages: unknown[]; metrics?: unknown } | undefined);
          for (const item of snapshot.events) applyAgentEvent(run, item as never);
        }
        this.followEvents.set(key, snapshot.events.slice());
      } else {
        applyAgentEvent(run, event as never);
        const events = this.followEvents.get(key);
        if (observed && events !== undefined) events.push(event);
      }
      const type = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined;
      if (type === 'session.title') {
        const title = typeof (event as { title?: unknown }).title === 'string'
          ? (event as { title: string }).title.trim()
          : '';
        if (title !== '') this.patchSessionTitle(key, workspaceId, sessionId, title);
      }
      if (type === 'tool.result') {
        const result = (event as { result?: { name?: unknown } }).result;
        if (typeof result?.name === 'string') {
          if (result.name === 'todo_write' || result.name === 'exit_plan_mode') {
            void this.refreshSessionBrief(workspaceId, sessionId);
          }
          if (['subagent', 'send_message', 'interrupt_agent'].includes(result.name)) {
            void this.refreshSubagentSessions(workspaceId);
          }
          if (result.name === 'write_agent_definition') {
            void this.loadCatalogs();
          }
        }
      }
      // Immutable snapshot so React sees a new run object for every event batch.
      const entry = this.state.entries[key];
      if (entry !== undefined && entry.run !== undefined) {
        this.state = { ...this.state, entries: { ...this.state.entries, [key]: { ...entry, run: { ...run } } } };
        this.emit();
      }
    });
    try {
      const reader = body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          parser.push(decoder.decode(part.value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.finish();
      } finally {
        reader.releaseLock();
      }
      if (run.outcome === undefined) {
        if (!observed) this.followRun(workspaceId, sessionId, run);
        return false;
      }
      if (run.error !== undefined) {
        this.showAlert(translator(this.state.locale)(run.error));
      }
    } catch {
      if (!observed && !this.disposed) this.followRun(workspaceId, sessionId, run);
    } finally {
      if (this.disposed || run.outcome === undefined) return false;
      const finished = await this.finishObservedRun(workspaceId, sessionId, key, run);
      if (!finished && !observed && !this.disposed && this.state.entries[key]?.run !== undefined) {
        this.followRun(workspaceId, sessionId, run);
      }
      return finished;
    }
  }

  async stopTurn(): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return;
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.state.entries[key];
    const run = entry?.run;
    const running = entry?.running === true;
    if (entry?.draft === true || (run === undefined && !running)
      || (run !== undefined && (run.stopping === true || run.finishing === true))) return;
    if (run !== undefined) {
      run.stopping = true;
      const live = this.liveRuns.get(key);
      if (live !== undefined) live.stopping = true;
      this.patchEntry(key, { run: { ...run } });
    }
    try {
      await this.api(sessionApiPath(workspaceId, sessionId, 'interrupt'), jsonOptions('POST', {}));
      if (run === undefined) this.scheduleRunningPoll(workspaceId, sessionId);
    } catch (error) {
      if (run !== undefined) {
        const live = this.liveRuns.get(key);
        if (live !== undefined) live.stopping = false;
        const latest = this.state.entries[key]?.run;
        if (latest !== undefined) this.patchEntry(key, { run: { ...latest, stopping: false } });
      }
      this.showAlert(translator(this.state.locale)('Could not stop turn: {message}', { message: (error as Error).message }));
    }
  }

  /** Ask the host to compact older context before the next turn. */
  async compactSession(): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return;
    const entry = this.state.entries[sessionKey(workspaceId, sessionId)];
    if (entry?.draft === true || entry?.running === true || entry?.run !== undefined) return;
    const t = translator(this.state.locale);
    try {
      await this.api(sessionApiPath(workspaceId, sessionId, 'compact'), jsonOptions('POST', {}));
      this.showAlert(t('Older context will be compacted before your next message.'));
    } catch (error) {
      this.showAlert(t('Could not compact context: {message}', { message: (error as Error).message }));
    }
  }

  async resolveApproval(decision: 'allow' | 'deny'): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return;
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.state.entries[key];
    const run = entry?.run;
    const approval = run?.approval;
    if (run === undefined || approval === undefined || approval.pending === true || run.stopping === true || run.finishing === true) return;
    this.patchEntry(key, { run: { ...run, approval: { ...approval, pending: true, error: '' } } });
    try {
      await this.api(sessionApiPath(workspaceId, sessionId, 'approvals'), jsonOptions('POST', {
        requestId: approval.requestId,
        decision,
      }));
      const latest = this.state.entries[key]?.run;
      const live = this.liveRuns.get(key);
      if (live?.approval?.requestId === approval.requestId) live.approval = undefined;
      if (latest?.approval?.requestId === approval.requestId) {
        this.patchEntry(key, { run: { ...latest, approval: undefined } });
      }
    } catch (error) {
      const latest = this.state.entries[key]?.run;
      if (latest?.approval?.requestId === approval.requestId) {
        this.patchEntry(key, {
          run: { ...latest, approval: { ...approval, pending: false, error: translator(this.state.locale)('Could not submit decision: {message}', { message: (error as Error).message }) } },
        });
      }
    }
  }

  async resolvePlanReview(approved: boolean, feedback: string): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return;
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.state.entries[key];
    const run = entry?.run;
    const review = run?.planReview;
    if (run === undefined || review === undefined || review.pending === true || run.stopping === true || run.finishing === true) return;
    const trimmed = feedback.trim().slice(0, 4000);
    this.patchEntry(key, { run: { ...run, planReview: { ...review, pending: true, error: '', feedback: trimmed } } });
    try {
      await this.api(sessionApiPath(workspaceId, sessionId, 'plan-review'), jsonOptions('POST', {
        requestId: review.requestId,
        approved,
        ...(trimmed === '' ? {} : { feedback: trimmed }),
      }));
      const latest = this.state.entries[key]?.run;
      const live = this.liveRuns.get(key);
      if (live?.planReview?.requestId === review.requestId) live.planReview = undefined;
      if (latest?.planReview?.requestId === review.requestId) {
        this.patchEntry(key, { run: { ...latest, planReview: undefined } });
      }
      if (approved) setTimeout(() => { void this.refreshSessionBrief(workspaceId, sessionId); }, 250);
    } catch (error) {
      const latest = this.state.entries[key]?.run;
      if (latest?.planReview?.requestId === review.requestId) {
        this.patchEntry(key, {
          run: { ...latest, planReview: { ...review, pending: false, error: translator(this.state.locale)('Could not submit plan review: {message}', { message: (error as Error).message }) } },
        });
      }
    }
  }

  async togglePlan(): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return;
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.state.entries[key];
    if (entry === undefined || !entry.loaded || entry.loading || entry.run !== undefined || entry.planSaving) return;
    const active = !entry.plan.active;
    if (entry.draft === true) {
      this.patchEntry(key, { plan: { active }, planError: '' });
      return;
    }
    this.patchEntry(key, { planSaving: true, planError: '' });
    try {
      const body = await this.api<{ plan?: unknown }>(sessionApiPath(workspaceId, sessionId, 'plan'), jsonOptions('POST', { active }));
      this.patchEntry(key, { plan: normalizePlan(body.plan), planSaving: false });
    } catch (error) {
      this.patchEntry(key, { planSaving: false, planError: translator(this.state.locale)('Could not change plan mode: {message}', { message: (error as Error).message }) });
    }
  }

  async refreshSessionBrief(workspaceId: string, sessionId: string): Promise<void> {
    try {
      const body = await this.api<{ plan?: unknown; todos?: unknown }>(sessionApiPath(workspaceId, sessionId));
      const key = sessionKey(workspaceId, sessionId);
      const entry = this.state.entries[key];
      if (entry === undefined) return;
      this.patchEntry(key, { plan: normalizePlan(body.plan), todos: normalizeTodos(body.todos) });
    } catch {
      // A transient refresh failure leaves the previous brief in place.
    }
  }

  async refreshSubagentSessions(workspaceId: string): Promise<void> {
    if (Date.now() - this.subagentsRefreshedAt < 750) return;
    this.subagentsRefreshedAt = Date.now();
    try {
      await this.loadSessions(workspaceId, false);
    } catch {
      // Keep the existing list.
    }
  }

  async loadPermissions(): Promise<void> {
    if (this.state.permissionsSaving) return;
    const request = ++this.permissionRequest;
    this.patch({ permissionsLoading: true, permissionsError: '' });
    try {
      const body = await this.api<{ settings?: unknown }>('/api/settings/permissions');
      if (request !== this.permissionRequest) return;
      this.patch({ permissions: validatePermissionSettings(body.settings), permissionsLoading: false });
    } catch (error) {
      if (request !== this.permissionRequest) return;
      const message = (error as Error).message;
      this.patch({ permissionsLoading: false, permissionsError: message });
    }
  }

  async saveDefaultPermission(preset: PermissionPreset): Promise<void> {
    if (!isPermissionPreset(preset) || this.state.permissionsLoading || this.state.permissionsSaving
      || this.state.permissions === null || this.state.permissionsError !== '') return;
    this.permissionRequest += 1;
    this.patch({ permissionsSaving: true });
    try {
      const body = await this.api<{ settings?: unknown }>('/api/settings/permissions', jsonOptions('PUT', { defaultPreset: preset }));
      this.patch({ permissions: validatePermissionSettings(body.settings), permissionsSaving: false });
      this.showAlert('');
    } catch (error) {
      this.patch({ permissionsSaving: false, permissionsError: (error as Error).message });
      this.showAlert(translator(this.state.locale)('Could not save permissions: {message}', { message: (error as Error).message }));
    }
  }

  async saveSessionPermission(preset: PermissionPreset): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null || !isPermissionPreset(preset)) return;
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.state.entries[key];
    if (entry === undefined || !entry.loaded || entry.loading || entry.permissionSaving || entry.run !== undefined) return;
    if (entry.draft === true) {
      this.patchEntry(key, { permission: preset, permissionError: '' });
      return;
    }
    this.patchEntry(key, { permissionSaving: true, permissionError: '' });
    try {
      const body = await this.api<{ permission?: { preset?: unknown } }>(
        sessionApiPath(workspaceId, sessionId, 'permission'),
        jsonOptions('POST', { preset }),
      );
      if (!isPermissionPreset(body.permission?.preset)) throw new Error(translator(this.state.locale)('Invalid session permission response.'));
      this.patchEntry(key, { permission: body.permission.preset, permissionSaving: false });
    } catch (error) {
      this.patchEntry(key, { permissionSaving: false, permissionError: translator(this.state.locale)('Could not change permission: {message}', { message: (error as Error).message }) });
    }
  }

  async loadCatalogs(): Promise<void> {
    this.patch({ modelsLoading: true, agentsLoading: true, rolesLoading: true, modelsError: '', agentsError: '', rolesError: '' });
    const [modelsResult, agentsResult, rolesResult] = await Promise.allSettled([
      this.api<{ models?: unknown[] }>('/api/models'),
      this.api<{ agents?: unknown[] }>('/api/agents'),
      this.api<{ roles?: unknown[] }>('/api/roles'),
    ]);
    let models: ModelSummary[] = [];
    let modelsError = '';
    if (modelsResult.status === 'fulfilled' && Array.isArray(modelsResult.value.models)) {
      try {
        models = modelsResult.value.models.map(validateModelSummary);
      } catch (error) {
        modelsError = (error as Error).message;
      }
    } else {
      modelsError = modelsResult.status === 'rejected' ? (modelsResult.reason as Error).message : 'The server did not return a model catalog.';
    }
    let agents: AgentSummary[] = [];
    let agentsError = '';
    if (agentsResult.status === 'fulfilled' && Array.isArray(agentsResult.value.agents)) {
      try {
        agents = agentsResult.value.agents.map((agent) => {
          const parsed = validateAgent(agent);
          if (parsed === null) throw new Error('Invalid agent catalog response.');
          return parsed;
        });
      } catch (error) {
        agentsError = (error as Error).message;
      }
    } else {
      agentsError = agentsResult.status === 'rejected' ? (agentsResult.reason as Error).message : 'The server did not return an agent catalog.';
    }
    let roles: RoleSummary[] = [];
    let rolesError = '';
    if (rolesResult.status === 'fulfilled' && Array.isArray(rolesResult.value.roles)) {
      try {
        roles = rolesResult.value.roles.map(validateRole);
      } catch (error) {
        rolesError = (error as Error).message;
      }
    } else {
      rolesError = rolesResult.status === 'rejected' ? (rolesResult.reason as Error).message : 'The server did not return a role catalog.';
    }
    const selectable = agents.filter((agent) => agent.valid && agent.usage !== 'subagent');
    const defaultAgent = selectable.some((agent) => agent.id === this.state.defaultAgent)
      ? this.state.defaultAgent
      : 'default';
    const creationAgent = selectable.some((agent) => agent.id === this.state.creationAgent)
      ? this.state.creationAgent
      : defaultAgent;
    const bindingAvailable = (binding: ModelBinding): boolean => {
      if (binding.kind === 'agent') return true;
      if (binding.kind === 'role') return roles.some((role) => role.id === binding.role);
      return models.some((model) => model.provider === binding.provider && model.model === binding.model);
    };
    const defaultBinding = bindingAvailable(this.state.defaultBinding)
      ? this.state.defaultBinding
      : { version: 2 as const, kind: 'agent' as const };
    const creationBinding = bindingAvailable(this.state.creationBinding)
      ? this.state.creationBinding
      : defaultBinding;
    if (defaultAgent !== this.state.defaultAgent) storageSet('omniagent.defaultAgent', defaultAgent);
    if (defaultBinding !== this.state.defaultBinding) storageSet('omniagent.defaultBinding', JSON.stringify(defaultBinding));
    this.patch({
      models, modelsLoading: false, modelsError,
      agents, agentsLoading: false, agentsError,
      roles, rolesLoading: false, rolesError,
      defaultAgent, defaultBinding, creationAgent, creationBinding,
    });
    // Catalogs may arrive after a draft was opened; keep its model seat current.
    const drafts = Object.entries(this.state.entries).filter(([, entry]) => entry.draft === true);
    if (drafts.length > 0) {
      const entries = { ...this.state.entries };
      for (const [key, entry] of drafts) {
        const mode = entry.mode;
        if (mode === null) continue;
        entries[key] = {
          ...entry,
          agent: agents.find((item) => item.id === mode.agent) ?? null,
          resolvedModel: resolveBindingModel(entry.binding ?? mode.model, mode.agent, agents, roles, models),
        };
      }
      this.state = { ...this.state, entries };
      this.emit();
    }
  }

  setCreationAgent(agent: string): void {
    this.patch({ creationAgent: agent });
  }

  setCreationBinding(binding: ModelBinding): void {
    this.patch({ creationBinding: binding });
  }

  async saveSessionAgent(value: string): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) {
      if (value !== '') this.setCreationAgent(value);
      return;
    }
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.state.entries[key];
    if (entry === undefined || entry.draft === true || entry.loading || entry.permissionSaving || entry.agentSaving || entry.modelSaving || entry.run !== undefined) return;
    if (entry.agent?.id === value) return;
    if (!this.state.agents.some((agent) => agent.id === value && agent.valid && agent.usage !== 'subagent')) return;
    this.patchEntry(key, { agentSaving: true, agentError: '' });
    try {
      const body = await this.api<{ agent?: unknown }>(sessionApiPath(workspaceId, sessionId, 'agent'), jsonOptions('POST', { agent: value }));
      const agent = validateAgent(body.agent);
      if (agent === null || agent.id !== value) throw new Error('The server returned a different agent selection.');
      this.patchEntry(key, {
        agent,
        agentWarnings: agent.warnings.slice(),
        agentSaving: false,
      });
      await this.loadDetail(workspaceId, sessionId, true);
    } catch (error) {
      this.patchEntry(key, { agentSaving: false, agentError: translator(this.state.locale)('Could not change agent: {message}', { message: (error as Error).message }) });
    }
  }

  async saveSessionModel(binding: ModelBinding): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) {
      this.setCreationBinding(binding);
      return;
    }
    const key = sessionKey(workspaceId, sessionId);
    const entry = this.state.entries[key];
    if (entry === undefined) return;
    if (entry.draft === true) {
      if (JSON.stringify(entry.binding) === JSON.stringify(binding)) return;
      const mode = entry.mode;
      this.patchEntry(key, {
        binding,
        resolvedModel: resolveBindingModel(
          binding,
          mode?.agent,
          this.state.agents,
          this.state.roles,
          this.state.models,
        ),
        modelError: '',
      });
      return;
    }
    if (entry.loading || entry.permissionSaving || entry.agentSaving || entry.modelSaving || entry.run !== undefined) return;
    if (JSON.stringify(entry.binding) === JSON.stringify(binding)) return;
    this.patchEntry(key, { modelSaving: true, modelError: '' });
    try {
      const body = await this.api<{ model?: unknown; resolvedModel?: unknown }>(
        sessionApiPath(workspaceId, sessionId, 'model'),
        jsonOptions('POST', binding),
      );
      const selected = validateBinding(body.model);
      if (JSON.stringify(selected) !== JSON.stringify(binding)) throw new Error('The server returned a different model binding.');
      this.patchEntry(key, {
        binding: selected,
        resolvedModel: validateResolvedModel(body.resolvedModel),
        modelSaving: false,
      });
    } catch (error) {
      this.patchEntry(key, { modelSaving: false, modelError: translator(this.state.locale)('Could not change model: {message}', { message: (error as Error).message }) });
    }
  }

  async exportSession(format: 'markdown' | 'json'): Promise<void> {
    const { workspaceId, sessionId } = this.state;
    if (workspaceId === null || sessionId === null) return;
    if (this.state.entries[sessionKey(workspaceId, sessionId)]?.draft === true) return;
    try {
      const response = await this.fetch(`${sessionApiPath(workspaceId, sessionId, 'export')}?format=${format}`);
      if (!response.ok) throw new Error(await responseError(response));
      if (format === 'markdown') {
        const text = await response.text();
        if (navigator.clipboard?.writeText === undefined) throw new Error(translator(this.state.locale)('Clipboard access is unavailable.'));
        await navigator.clipboard.writeText(text);
      } else {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'omniagent-session-transcript.json';
        link.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not export session: {message}', { message: (error as Error).message }));
    }
  }

  async addWorkspace(path: string, name: string): Promise<boolean> {
    try {
      const body = await this.api<{ workspace?: Workspace }>('/api/workspaces', jsonOptions('POST', {
        path,
        ...(name === '' ? {} : { name }),
      }));
      if (typeof body.workspace?.id !== 'string') throw new Error(translator(this.state.locale)('The server did not return a workspace.'));
      await this.loadWorkspaces(body.workspace.id);
      return true;
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not add workspace: {message}', { message: (error as Error).message }));
      return false;
    }
  }

  async removeWorkspace(workspaceId: string): Promise<boolean> {
    try {
      await this.api(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
      const selected = { ...this.state.selectedByWorkspace };
      delete selected[workspaceId];
      const entries = { ...this.state.entries };
      for (const key of Object.keys(entries)) {
        try {
          if ((JSON.parse(key) as [string])[0] === workspaceId) delete entries[key];
        } catch {
          // Ignore malformed keys.
        }
      }
      const sessionsByWorkspace = { ...this.state.sessionsByWorkspace };
      delete sessionsByWorkspace[workspaceId];
      this.sessionRequests.set(workspaceId, (this.sessionRequests.get(workspaceId) ?? 0) + 1);
      this.state = { ...this.state, selectedByWorkspace: selected, entries, sessionsByWorkspace };
      if (this.state.workspaceId === workspaceId) {
        this.state = { ...this.state, workspaceId: null, sessionId: null, sessions: [], sessionsLoading: false, sessionError: '' };
      }
      this.persistSelection();
      this.emit();
      await this.loadWorkspaces();
      return true;
    } catch (error) {
      this.showAlert(translator(this.state.locale)('Could not remove workspace: {message}', { message: (error as Error).message }));
      return false;
    }
  }
}

export let store = new AppStore();

export function resetStore(): void {
  store.dispose();
  store = new AppStore(false);
}

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useSessionEntry(): SessionEntry | null {
  const state = useApp();
  if (state.workspaceId === null || state.sessionId === null) return null;
  return state.entries[sessionKey(state.workspaceId, state.sessionId)] ?? null;
}

export function useT(): Translate {
  const app = useApp();
  return translator(app.locale);
}

export { permissionPresets };
