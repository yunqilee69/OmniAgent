/**
 * Session delivery host for the shared Schedule service.
 *
 * Management reads never activate a session. Delivery opens (or creates) the
 * target session, reuses the live Web runtime when one is registered, and
 * starts a background turn with the framed reminder text.
 */

import { sep } from 'node:path';
import {
  DEFAULT_SESSION_TITLE_LIMITS,
  SESSION_TITLE_EVENT,
  createAgentSelectionEvent,
  createModeSelectionEvent,
  createModelSelectionEvent,
  defaultModelBinding,
  normalizeSessionTitle,
  projectAgentSelection,
  projectModeSelection,
  projectModelSelection,
} from '@omniagent/core';
import type {
  DshPermissionSnapshot,
  ModeStore,
  ResolvedSessionRuntime,
  RuntimeResolver,
  ScheduleDeliveredTarget,
  ScheduleDeliveryHost,
  ScheduleDeliveryRequest,
  ScheduleSessionCreateSpec,
  Session,
  SessionHandle,
  SessionStore,
  SubagentService,
} from '@omniagent/core';
import {
  createInitialDshPermissionEvent,
  DSH_DEFAULT_PRESET,
  projectDshPermissions,
  snapshotDshPermissions,
} from '../../core/src/permissions/dsh-permissions';
import type { PermissionSettings } from './permissions';
import type { LiveSessionRegistry } from './live-sessions';
import { liveSessionKey } from './live-sessions';
import type { WorkspaceRegistry } from './workspaces';

export interface ScheduleHostOptions {
  store: Pick<SessionStore, 'list' | 'create' | 'open'>;
  workspaces: Pick<WorkspaceRegistry, 'list'>;
  runtime: RuntimeResolver;
  subagents?: SubagentService;
  permissionSettings?: Pick<PermissionSettings, 'snapshot'>;
  /** Scheduled new sessions start from the configured default mode. */
  modes?: ModeStore;
  liveSessions?: LiveSessionRegistry;
  /** Compose one foreground-equivalent Session around an opened handle. */
  compose: (
    workspacePath: string,
    handle: SessionHandle,
    permissions: DshPermissionSnapshot,
    runtime: ResolvedSessionRuntime,
  ) => Session;
  log?: (message: string) => void;
}

/** Result of opening one delivery target. */
interface OpenedTarget {
  readonly workspace: string;
  readonly handle: SessionHandle;
}

/**
 * Schedule delivery host backed by the shared SessionStore.
 */
export class SessionScheduleHost implements ScheduleDeliveryHost {
  constructor(private readonly options: ScheduleHostOptions) {}

  async validateSession(sessionId: string): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: 'invalid_rule' | 'subagent_session'; readonly message: string }
  > {
    const summary = await this.findSession(sessionId);
    if (summary === undefined) {
      return { ok: false, code: 'invalid_rule', message: 'The target session does not exist.' };
    }
    if (summary.parentSessionId !== undefined || (summary.depth ?? 0) > 0) {
      return {
        ok: false,
        code: 'subagent_session',
        message: 'This session belongs to subagent routing, which never receives reminder delivery.',
      };
    }
    return { ok: true };
  }

  async deliver(request: ScheduleDeliveryRequest): Promise<ScheduleDeliveredTarget> {
    const target = request.target;
    switch (target.kind) {
      case 'session': {
        const summary = await this.findSession(target.sessionId);
        if (summary === undefined) throw new Error(`Scheduled target session ${target.sessionId} no longer exists`);
        if (summary.parentSessionId !== undefined || (summary.depth ?? 0) > 0) {
          throw new Error('Scheduled delivery refuses a subagent session');
        }
        const handle = await this.options.store.open(summary.workspace, target.sessionId);
        return this.deliverToHandle(summary.workspace, handle, request.text);
      }
      case 'new_once': {
        const opened = await this.createTargetSession(target.sessionId, target.create, request.title);
        return this.deliverToHandle(opened.workspace, opened.handle, request.text);
      }
      case 'new': {
        const opened = await this.createTargetSession(undefined, target.create, request.title);
        return this.deliverToHandle(opened.workspace, opened.handle, request.text);
      }
    }
  }

  private async findSession(sessionId: string): Promise<Awaited<ReturnType<SessionStore['list']>>[number] | undefined> {
    const sessions = await this.options.store.list();
    return sessions.find((session) => session.id === sessionId);
  }

  private async workspaceFor(cwd: string): Promise<string> {
    const workspaces = await this.options.workspaces.list();
    let best: string | undefined;
    for (const workspace of workspaces) {
      if (cwd === workspace.path || cwd.startsWith(`${workspace.path}${sep}`)) {
        if (best === undefined || workspace.path.length > best.length) best = workspace.path;
      }
    }
    return best ?? cwd;
  }

  private async createTargetSession(
    id: string | undefined,
    spec: ScheduleSessionCreateSpec,
    title?: string,
  ): Promise<OpenedTarget> {
    const cwd = spec.cwd ?? process.cwd();
    const workspace = await this.workspaceFor(cwd);
    const handle = await this.options.store.create({
      ...(id === undefined ? {} : { id }),
      workspace,
      cwd,
    });
    const settings = this.options.permissionSettings?.snapshot();
    const preset = settings?.requiresSelection === false && settings.defaultPreset !== null
      ? settings.defaultPreset
      : DSH_DEFAULT_PRESET;
    await handle.append(createInitialDshPermissionEvent(preset));
    const mode = this.options.modes === undefined ? undefined : await this.options.modes.resolveDefault();
    await handle.append(createAgentSelectionEvent(spec.agentPreset ?? mode?.agent ?? 'default'));
    await handle.append(createModelSelectionEvent(spec.agentPreset === undefined && mode !== undefined ? mode.model : defaultModelBinding()));
    if (spec.agentPreset === undefined && mode !== undefined) {
      await handle.append(createModeSelectionEvent({
        version: 1,
        mode: mode.id,
        agent: mode.agent,
        model: mode.model,
        tools: mode.tools,
        skills: mode.skills,
      }));
    }
    if (title !== undefined) {
      const normalized = normalizeSessionTitle(title, DEFAULT_SESSION_TITLE_LIMITS.maxTitleBytes);
      if (normalized.length > 0) {
        await handle.append({
          type: SESSION_TITLE_EVENT,
          data: { title: normalized, messageSeqs: [], source: { kind: 'user' } },
        });
      }
    }
    return { workspace, handle };
  }

  private async deliverToHandle(
    workspacePath: string,
    handle: SessionHandle,
    text: string,
  ): Promise<ScheduleDeliveredTarget> {
    if (handle.header.parentSessionId !== undefined || (handle.header.depth ?? 0) > 0) {
      throw new Error('Scheduled delivery refuses a subagent session');
    }
    const key = liveSessionKey(workspacePath, handle.id);
    const live = this.options.liveSessions?.get(key);
    if (live !== undefined) {
      const deliver = live.session.deliverExternalMessage;
      if (deliver === undefined) throw new Error('The live session runtime cannot receive external messages');
      await deliver.call(live.session, text, 'schedule');
      return { sessionId: handle.id };
    }
    const permissions = this.permissionsOf(handle);
    const agent = projectAgentSelection(handle.events);
    const binding = projectModelSelection(handle.events);
    if (agent.status !== 'selected') throw new Error('The target session has no selected agent');
    if (binding.status !== 'selected') throw new Error('The target session has no selected model');
    const selectedMode = projectModeSelection(handle.events);
    const runtime = await this.options.runtime.resolve({
      cwd: handle.header.cwd ?? workspacePath,
      workspace: workspacePath,
      agentId: agent.agent,
      binding: binding.binding,
      isRoot: true,
      ...(selectedMode.status === 'selected'
        ? { mode: { id: selectedMode.selection.mode, tools: selectedMode.selection.tools, skills: selectedMode.selection.skills } }
        : {}),
    });
    const session = this.options.compose(workspacePath, handle, permissions, runtime);
    this.options.liveSessions?.set(key, {
      session,
      preset: permissions.preset,
      modelKey: JSON.stringify(runtime.modelBinding),
      runtimeKey: runtime.revision,
    });
    await session.deliverExternalMessage(text, 'schedule');
    return { sessionId: handle.id };  }

  private permissionsOf(handle: SessionHandle): DshPermissionSnapshot {
    const projection = projectDshPermissions(handle.events);
    if (projection.status === 'ready') return snapshotDshPermissions(projection);
    // Legacy sessions without a preset inherit the configured default for this
    // unattended delivery; no event is appended, so the user still chooses later.
    const settings = this.options.permissionSettings?.snapshot();
    const preset = settings?.requiresSelection === false && settings.defaultPreset !== null
      ? settings.defaultPreset
      : DSH_DEFAULT_PRESET;
    return snapshotDshPermissions({ status: 'ready', preset });
  }
}
