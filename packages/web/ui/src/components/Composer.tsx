import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import clsx from 'clsx';
import {
  Button,
  IconAgentPresetOutlineRegular,
  IconBrowseOutlineRegular,
  IconCheckOutlineRegular,
  IconChecklistOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconClockOutlineRegular,
  IconCloseOutlineRegular,
  IconCompactOutlineRegular,
  IconDownloadOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconGoalOutlineRegular,
  IconNewChatOutlineRegular,
  IconPaperclipOutlineRegular,
  IconPlanOutlineRegular,
  IconPlusOutlineMedium,
  IconQueueOutlineRegular,
  IconSendOutlineRegular,
  IconSettingsOutlineRegular,
  IconSkillOutlineRegular,
  IconSparkleRegular,
  IconStopFillRegular,
  IconTrashOutlineRegular,
  IconUsersOutlineRegular,
  RiskConfirmation,
  StateDot,
  type MenuEntry,
} from '../../vendor/primitives/index.ts';
import {
  attachmentLimitError,
  isPermissionPreset,
  MAX_ATTACHMENTS,
  permissionPresets,
  validateRecentSessions,
  workspaceApiPath,
  type AgentSkill,
  type PermissionPreset,
  type RecentSessionSummary,
  type SendAttachment,
  type WorkspaceFileEntry,
} from '../lib/wire.ts';
import { authFetch } from '../lib/auth.ts';
import { store, useApp, useSessionEntry, sessionKey } from '../lib/store.ts';
import type { BusySendMode, SessionEntry } from '../lib/store.ts';
import {
  detectTrigger,
  directoryReference,
  enterGesture,
  fileReference,
  replaceRange,
  skillReference,
} from '../lib/composer-trigger.ts';
import { attachmentFileName, clipboardFiles } from '../lib/clipboard.ts';
import { rankLike } from '../lib/matcher.ts';
import { relativeDate } from '../lib/trajectory.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { SelectMenu } from './SelectMenu.tsx';
import { concreteModelBinding, ModelPicker } from './ModelPicker.tsx';
import { ContextMeter } from './ContextMeter.tsx';
import { SessionStats } from './SessionStats.tsx';
import { permissionIcon } from './permission-icon.tsx';
import { PlanReviewComposer } from './PlanReview.tsx';
import css from '../styles/dsh/input-bar.module.css';
import menuCss from '../styles/dsh/composer-menu.module.css';
import attachmentCss from '../styles/dsh/composer-attachments.module.css';
import planCss from '../styles/dsh/plan-mode.module.css';
import todoCss from '../styles/dsh/todo-panel.module.css';
import heroCss from '../styles/dsh/hero-shell.module.css';
import appCss from '../styles/app.module.css';

type Attachment = Exclude<SendAttachment, { kind: 'text' }> & { id: string; size: number; preview?: string };
interface Option {
  id: string;
  label: string;
  description?: string;
  alias?: string;
  group?: string;
  icon?: ReactNode;
  disabled?: boolean;
  keepOpen?: boolean;
  current?: boolean;
  run: () => void;
}
type Picker = 'permission' | 'agent' | 'model' | 'export';
interface Command {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  available: boolean;
  picker?: Picker;
  /** Text inserted instead of removing the /token, for commands that need an argument. */
  insert?: string;
  run?: () => void | Promise<void>;
}

function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function imageMediaType(file: File): string | undefined {
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) return file.type;
  const extension = extensionOf(file.name);
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  return undefined;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const comma = value.indexOf(',');
      if (comma < 0) reject(new Error('read failed'));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function TodoDock({ entry, t }: { entry: Pick<SessionEntry, 'todos' | 'run' | 'running'> | null; t: Translate }): ReactNode {
  const [collapsed, setCollapsed] = useState(true);
  const todos = entry?.todos ?? null;
  if ((entry?.run === undefined && entry?.running !== true) || todos === null || todos.length === 0) return null;
  const done = todos.filter((item) => item.status === 'completed').length;
  const active = todos.filter((item) => item.status === 'in_progress').length;
  const pending = todos.length - done - active;
  return (
    <section className={todoCss.root} aria-label={t('Task list')}>
      <div className={todoCss.body}>
        <button type="button" className={todoCss.header} aria-expanded={!collapsed} onClick={() => { setCollapsed((value) => !value); }}>
          <span className={todoCss.lead} aria-hidden><IconChecklistOutlineRegular /></span>
          <span className={todoCss.title}>{t('Tasks')}</span>
          <span className={todoCss.progress}>
            {[done > 0 ? t('{count} done', { count: done }) : '',
              active > 0 ? t('{count} active', { count: active }) : '',
              pending > 0 ? t('{count} pending', { count: pending }) : ''].filter(Boolean).join('\u2002·\u2002')}
          </span>
          <span className={todoCss.chevron} aria-hidden>
            {collapsed ? <IconChevronDownOutlineRegular /> : <IconChevronUpOutlineRegular />}
          </span>
        </button>
        {!collapsed && (
          <ul className={todoCss.list}>
            {todos.map((item) => (
              <li key={item.content} className={todoCss.item} data-status={item.status}>
                <span className={todoCss.glyph} aria-hidden>
                  <StateDot state={item.status === 'completed' ? 'done' : item.status === 'in_progress' ? 'ongoing' : 'idle'} />
                </span>
                <span className={todoCss.content}>{item.content}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function Composer({ hero = false, onOpenPlanPreview }: { hero?: boolean; onOpenPlanPreview?: () => void }): ReactNode {
  const app = useApp();
  const entry = useSessionEntry();
  const t = useMemo(() => translator(app.locale), [app.locale]);
  const draftSession = entry?.draft === true;
  const draftMode = draftSession ? entry?.mode?.mode ?? null : null;
  const draftModeName = draftMode === null
    ? ''
    : app.modes.find((item) => item.id === draftMode)?.name ?? draftMode;
  const workspace = app.workspaces.find((item) => item.id === app.workspaceId);
  const workspaceName = workspace?.name || workspace?.path || workspace?.id || '';
  // Draft sessions have no runtime yet, so their catalog comes from the mode
  // selector. Live sessions report the exact skills the agent may load.
  const availableSkills = useMemo<AgentSkill[]>(() => {
    if (!draftSession) {
      if (entry === null || entry.loaded !== true) return [];
      return entry.agentSkills ?? [];
    }
    const selector = app.modes.find((item) => item.id === draftMode)?.skills ?? '*';
    return selector === '*'
      ? app.modeOptions.skills
      : app.modeOptions.skills.filter((skill) => selector.includes(skill.name));
  }, [draftSession, draftMode, entry, app.modes, app.modeOptions.skills]);
  const key = draftSession && app.sessionId !== null
    ? app.sessionId
    : app.workspaceId !== null && app.sessionId !== null ? sessionKey(app.workspaceId, app.sessionId) : 'new';
  const drafts = useRef(new Map<string, string>());
  const currentKey = useRef(key);
  currentKey.current = key;
  const [draft, setDraft] = useState(drafts.current.get(key) ?? '');
  const [caret, setCaret] = useState(0);
  const [risk, setRisk] = useState<{ preset: PermissionPreset; acknowledged: boolean } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [readingFiles, setReadingFiles] = useState(false);
  const readingFilesRef = useRef(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState('');
  const [recentSessions, setRecentSessions] = useState<RecentSessionSummary[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState('');
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const busySend = app.busySend;
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const card = useRef<HTMLDivElement | null>(null);
  const plusButton = useRef<HTMLButtonElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const recentCache = useRef<{ workspaceId: string; query: string; at: number; sessions: RecentSessionSummary[] } | null>(null);

  const trigger = detectTrigger(draft, caret);
  const triggerKey = trigger === null ? '' : `${trigger.kind}:${trigger.start}:${trigger.end}:${trigger.query}`;
  const triggerVisible = trigger !== null && triggerKey !== dismissed;
  const mode: Picker | 'file' | 'command' | 'session' | 'skill' | 'plus' | null = picker ?? (triggerVisible && trigger !== null ? trigger.kind : plusOpen ? 'plus' : null);
  const menuOpen = mode !== null;
  const menuKey = `${mode ?? 'none'}:${picker === null && triggerVisible ? triggerKey : ''}`;

  useEffect(() => {
    setDraft(drafts.current.get(key) ?? '');
    setAttachments([]);
    setAttachmentError('');
  }, [key]);

  useEffect(() => {
    // A dismissal belongs to one trigger; once the trigger leaves the draft,
    // typing the same shortcut again should reopen the menu.
    if (trigger === null && dismissed !== null) setDismissed(null);
  }, [trigger, dismissed]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 336)}px`;
  }, [draft, key]);

  useEffect(() => {
    if (mode === 'model') {
      const resolved = entry?.resolvedModel;
      setActive(Math.max(0, app.models.findIndex((model) =>
        model.provider === resolved?.provider && model.model === resolved.model)));
    } else {
      setActive(0);
    }
  }, [menuKey, mode, app.models, entry?.resolvedModel]);

  useEffect(() => {
    if (mode === 'skill' && draftSession && app.modeOptions.skills.length === 0) void store.loadModeOptions();
  }, [mode, draftSession, app.modeOptions.skills.length]);

  useEffect(() => {
    if (mode !== 'file' || trigger === null || app.workspaceId === null) {
      setFiles([]);
      setFilesError('');
      setFilesLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setFilesLoading(true);
      setFilesError('');
      const query = new URLSearchParams({ query: trigger.query, limit: '24' });
      void authFetch(workspaceApiPath(app.workspaceId!, `files?${query.toString()}`), { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(t('Request failed ({status}).', { status: response.status }));
          return await response.json() as { entries?: unknown };
        })
        .then((body) => {
          if (controller.signal.aborted) return;
          setFiles(Array.isArray(body.entries)
            ? body.entries.filter((item): item is WorkspaceFileEntry =>
              typeof item === 'object' && item !== null
              && typeof (item as WorkspaceFileEntry).path === 'string'
              && typeof (item as WorkspaceFileEntry).name === 'string'
              && ((item as WorkspaceFileEntry).kind === 'file' || (item as WorkspaceFileEntry).kind === 'directory'))
            : []);
          setFilesLoading(false);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setFiles([]);
          setFilesLoading(false);
          setFilesError((error as Error).message);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mode, trigger?.query, app.workspaceId, t]);

  useEffect(() => {
    if (mode !== 'session' || app.workspaceId === null) {
      setRecentLoading(false);
      setRecentError('');
      return;
    }
    const workspaceId = app.workspaceId;
    const query = trigger?.query ?? '';
    const cached = recentCache.current;
    if (cached !== null && cached.workspaceId === workspaceId && cached.query === query
      && Date.now() - cached.at < 15_000) {
      setRecentSessions(cached.sessions);
      setRecentLoading(false);
      setRecentError('');
      return;
    }
    const controller = new AbortController();
    setRecentLoading(true);
    setRecentError('');
    const timer = window.setTimeout(() => {
      const search = new URLSearchParams({ workspaceId, query, limit: '50' });
      void authFetch(`/api/sessions/recent?${search.toString()}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(t('Request failed ({status}).', { status: response.status }));
          return await response.json() as { sessions?: unknown };
        })
        .then((body) => {
          if (controller.signal.aborted) return;
          const sessions = validateRecentSessions(body.sessions);
          recentCache.current = { workspaceId, query, at: Date.now(), sessions };
          setRecentSessions(sessions);
          setRecentLoading(false);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setRecentSessions([]);
          setRecentLoading(false);
          setRecentError((error as Error).message);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mode, trigger?.query, app.workspaceId, t]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (plusButton.current?.contains(target) === true) return;
      const menu = card.current?.querySelector('#composer-menu');
      if (menu?.contains(target) === true) return;
      setPlusOpen(false);
      setPicker(null);
      if (trigger !== null) setDismissed(triggerKey);
    };
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('pointerdown', close); };
  }, [menuOpen, trigger, triggerKey]);

  const available = app.workspaceId !== null && app.sessionId !== null && entry?.loaded === true && entry.loading !== true;
  const creating = app.workspaceId !== null && app.sessionId === null && app.creatingSession !== true;
  const run = entry?.run;
  const busy = run !== undefined || entry?.running === true;
  const saving = entry?.permissionSaving === true || entry?.agentSaving === true || entry?.modelSaving === true || entry?.planSaving === true;
  const selectedPermission = isPermissionPreset(entry?.permission) ? entry.permission : null;
  const canSend = available && !saving && !sending && !readingFiles && selectedPermission !== null
    && entry?.agent !== null && entry?.binding !== null && (draft.trim() !== '' || attachments.length > 0)
    && (run === undefined || (run.stopping !== true && run.finishing !== true));
  const locked = !available || busy || saving;
  const attachLocked = !available || saving || sending || readingFiles;
  const placeholder = app.workspaceId === null ? t('Select a workspace')
    : creating ? t('Create a session to begin')
      : app.sessionId === null ? t('Select a session to begin')
        : !entry?.loaded ? t('Loading session…')
          : busy
            ? busySend === 'queue'
              ? t('Agent is working… Your message will be queued for the next turn.')
              : t('Agent is working… Your message will be sent into the current reply.')
            : selectedPermission === null ? t('Choose permission before sending')
              : entry.plan.active ? t('Describe what to research, then the agent will propose a plan…')
                : t('Send a message…');

  const setDraftValue = (value: string): void => {
    setDraft(value);
    drafts.current.set(key, value);
  };

  const focusCaret = (position: number): void => {
    window.requestAnimationFrame(() => {
      const element = textarea.current;
      if (element === null) return;
      element.focus();
      element.setSelectionRange(position, position);
      setCaret(position);
    });
  };

  const replace = (start: number, end: number, value: string): void => {
    const next = replaceRange(draft, start, end, value);
    setDraftValue(next.value);
    setCaret(next.caret);
    focusCaret(next.caret);
  };

  const choosePermission = (value: string): void => {
    if (!isPermissionPreset(value) || entry === null) return;
    if (value === 'danger-full-access') {
      setRisk({ preset: value, acknowledged: false });
      return;
    }
    void store.saveSessionPermission(value);
  };

  const commands = useMemo<Command[]>(() => [
    { id: 'new', label: t('New session'), description: t('Create a new session in this workspace.'), icon: <IconNewChatOutlineRegular />, available: app.workspaceId !== null, run: () => { void store.startDraftSession(); } },
    { id: 'plan', label: t('Toggle plan mode'), description: t('Toggle plan mode for this session.'), icon: <IconPlanOutlineRegular />, available: app.sessionId !== null && entry?.plan.active !== undefined, run: () => store.togglePlan() },
    { id: 'init', label: t('Initialize workspace instructions'), description: t('Create or update AGENTS.md for this workspace.'), icon: <IconBrowseOutlineRegular />, available: app.sessionId !== null && app.workspaceId !== null, insert: '/init ' },
    {
      id: 'goal',
      label: t('Set a goal'),
      description: t('Ask the agent to create a session goal for an objective you type next.'),
      icon: <IconGoalOutlineRegular />,
      available: app.sessionId !== null,
      insert: t('Create a session goal for this objective, then start working on it: '),
    },
    {
      id: 'compact',
      label: t('Compact context'),
      description: t('Compact older conversation before the next reply.'),
      icon: <IconCompactOutlineRegular />,
      available: app.sessionId !== null && entry?.draft !== true,
      run: () => void store.compactSession(),
    },
    { id: 'permission', label: t('Choose permission'), description: t('Choose the permission preset for this session.'), icon: permissionIcon(selectedPermission), available: app.sessionId !== null, picker: 'permission' },
    { id: 'agent', label: t('Choose agent'), description: t('Choose the agent for this session.'), icon: <IconUsersOutlineRegular />, available: app.sessionId !== null && entry?.mode == null, picker: 'agent' },
    { id: 'model', label: t('Choose model'), description: t('Choose the model source for this session.'), icon: <IconSparkleRegular />, available: app.sessionId !== null, picker: 'model' },
    { id: 'settings', label: t('Settings'), description: t('Open the settings page.'), icon: <IconSettingsOutlineRegular />, available: true, run: () => store.openSettings() },
    { id: 'export', label: t('Export session'), description: t('Copy the session transcript as Markdown.'), icon: <IconDownloadOutlineRegular />, available: app.sessionId !== null, picker: 'export' },
    { id: 'clear', label: t('Clear draft'), description: t('Clear the composer draft.'), icon: <IconTrashOutlineRegular />, available: true, run: () => { setDraftValue(''); setAttachments([]); setAttachmentError(''); } },
    { id: 'help', label: t('Show commands'), description: t('Available commands: /new, /plan, /init, /goal, /compact, /permission, /agent, /model, /settings, /export, /clear'), icon: <IconBrowseOutlineRegular />, available: true, run: () => store.showAlert(t('Available commands: /new, /plan, /init, /goal, /compact, /permission, /agent, /model, /settings, /export, /clear')) },
  ], [app.workspaceId, app.sessionId, entry?.mode, entry?.plan.active, entry?.draft, selectedPermission, t]);

  const selectCommand = (command: Command): void => {
    if (trigger !== null) {
      replace(trigger.start, trigger.end, command.insert ?? '');
    } else if (command.insert !== undefined) {
      const separator = draft === '' || /\s$/u.test(draft) ? '' : ' ';
      const next = draft + separator + command.insert;
      setDraftValue(next);
      focusCaret(next.length);
    }
    setPlusOpen(false);
    setPicker(command.picker ?? null);
    setDismissed(triggerKey);
    if (command.picker === undefined && command.insert === undefined) void command.run?.();
  };

  const selectFile = (item: WorkspaceFileEntry): void => {
    if (trigger === null) return;
    if (item.kind === 'directory') {
      replace(trigger.start, trigger.end, directoryReference(item.path));
      setDismissed(null);
      setActive(0);
    } else {
      replace(trigger.start, trigger.end, fileReference(item.path));
      setDismissed(null);
    }
  };

  const selectSkill = (skill: AgentSkill): void => {
    if (trigger === null) return;
    replace(trigger.start, trigger.end, skillReference(skill.name));
    setDismissed(null);
  };

  const selectRecentSession = (session: RecentSessionSummary): void => {
    if (trigger !== null) {
      const next = replaceRange(draft, trigger.start, trigger.end, '');
      setDraftValue(next.value);
      setCaret(next.caret);
    }
    void store.openRecentSession(session.workspaceId, session.id);
  };

  const options = useMemo<Option[]>(() => {
    if (mode === 'file') {
      return files.map((item) => ({
        id: `file:${item.path}`,
        label: item.name,
        description: item.kind === 'directory' ? t('Open folder') : item.path,
        group: item.kind === 'directory' ? t('Folders') : t('Files'),
        icon: item.kind === 'directory' ? <IconFolderCloseRegular /> : <IconPaperclipOutlineRegular />,
        keepOpen: item.kind === 'directory',
        run: () => selectFile(item),
      }));
    }
    if (mode === 'command' || mode === 'plus') {
      const query = mode === 'command' && trigger !== null ? trigger.query : '';
      const matched = rankLike(commands, query, (command) => [command.id, command.label]);
      const commandOptions: Option[] = matched.map((command) => ({
        id: `command:${command.id}`,
        label: command.label,
        alias: `/${command.id}`,
        group: t('Commands'),
        icon: command.icon,
        disabled: !command.available,
        run: () => selectCommand(command),
      }));
      return mode === 'plus'
        ? [{
          id: 'attach-files',
          label: t('Add files'),
          description: t('Attach files to the next message.'),
          group: t('Files'),
          icon: <IconPaperclipOutlineRegular />,
          run: () => fileInput.current?.click(),
        }, ...commandOptions]
        : commandOptions;
    }
    if (mode === 'session') {
      const query = trigger?.query ?? '';
      const decorate = (session: RecentSessionSummary, group: string): Option => ({
        id: `session:${session.workspaceId}:${session.id}`,
        label: session.title ?? t('Untitled session'),
        description: group === t('Current workspace')
          ? relativeDate(session.updatedAt, app.locale)
          : `${session.workspaceName} · ${relativeDate(session.updatedAt, app.locale)}`,
        group,
        icon: <IconClockOutlineRegular />,
        run: () => selectRecentSession(session),
      });
      const current = recentSessions.filter((session) => session.workspaceId === app.workspaceId);
      const others = recentSessions.filter((session) => session.workspaceId !== app.workspaceId);
      return [
        ...rankLike(current, query, (session) => [session.title ?? '', session.workspaceName, session.id])
          .map((session) => decorate(session, t('Current workspace'))),
        ...rankLike(others, query, (session) => [session.title ?? '', session.workspaceName, session.id])
          .map((session) => decorate(session, t('Other workspaces'))),
      ];
    }
    if (mode === 'skill') {
      return rankLike(availableSkills, trigger?.query ?? '', (skill) => [skill.name, skill.description])
        .map((skill) => ({
          id: `skill:${skill.name}`,
          label: skill.name,
          description: skill.description,
          group: t('Skills'),
          icon: <IconSkillOutlineRegular />,
          run: () => selectSkill(skill),
        }));
    }
    if (mode === 'permission') {
      return Object.entries(permissionPresets).map(([value, preset]) => ({
        id: `permission:${value}`,
        label: t(preset.label),
        description: t(preset.description),
        group: t('Permissions'),
        icon: permissionIcon(value as PermissionPreset),
        run: () => choosePermission(value),
      }));
    }
    if (mode === 'agent') {
      return app.agents.filter((agent) => agent.usage !== 'subagent').map((agent) => ({
        id: `agent:${agent.id}`,
        label: agent.name,
        description: agent.role,
        group: t('Agent'),
        icon: <IconUsersOutlineRegular />,
        disabled: !agent.valid,
        run: () => {
          if (app.sessionId === null) store.setCreationAgent(agent.id);
          else void store.saveSessionAgent(agent.id);
        },
      }));
    }
    if (mode === 'model') {
      const items: Option[] = [];
      for (const model of app.models) {
        const resolved = entry?.resolvedModel ?? null;
        const binding = concreteModelBinding(model, resolved);
        const effort = binding.kind === 'model' ? binding.reasoningEffort : undefined;
        items.push({
          id: `model:${model.provider}/${model.model}`,
          current: resolved?.provider === model.provider && resolved.model === model.model,
          label: model.name,
          description: `${model.provider}/${model.model}${effort === undefined ? '' : ` · ${effort}`}`,
          group: t('Models'),
          icon: <IconSparkleRegular />,
          run: () => {
            if (app.sessionId === null) store.setCreationBinding(binding);
            else void store.saveSessionModel(binding);
          },
        });
      }
      return items;
    }
    if (mode === 'export') {
      return [
        { id: 'export:markdown', label: t('Export as Markdown'), description: t('Copy the session transcript as Markdown.'), group: t('Export session'), icon: <IconDownloadOutlineRegular />, run: () => void store.exportSession('markdown') },
        { id: 'export:json', label: t('Export as JSON'), description: t('Download the session transcript as JSON.'), group: t('Export session'), icon: <IconDownloadOutlineRegular />, run: () => void store.exportSession('json') },
      ];
    }
    return [];
  }, [mode, files, commands, trigger?.query, trigger?.start, trigger?.end, recentSessions, availableSkills,
    app.agents, app.models, app.sessionId, app.workspaceId, app.locale, entry?.resolvedModel, selectedPermission, t]);

  const bounded = Math.min(active, Math.max(0, options.length - 1));
  const choose = (option: Option): void => {
    if (option.disabled) return;
    if (!option.keepOpen) {
      setPlusOpen(false);
      setPicker(null);
      if (trigger !== null) setDismissed(triggerKey);
      setActive(0);
    }
    option.run();
  };

  const submit = async (complementary = false): Promise<void> => {
    const text = draft.trim();
    if ((text === '' && attachments.length === 0) || !canSend || sendingRef.current) return;
    const payload: SendAttachment[] = attachments.map(({ kind, name, mimeType, data }) => ({ kind, name, mimeType, data }));
    const sendMode: BusySendMode = complementary ? (busySend === 'queue' ? 'steer' : 'queue') : busySend;
    sendingRef.current = true;
    setSending(true);
    try {
      const accepted = busy
        ? sendMode === 'queue'
          ? await store.queueMessage(text, payload)
          : await store.steerMessage(text, payload)
        : await store.sendMessage(text, payload);
      if (accepted) {
        drafts.current.delete(key);
        if (currentKey.current === key) {
          setDraft('');
          setAttachments([]);
          setAttachmentError('');
          setCaret(0);
        }
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
    textarea.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const gesture = enterGesture(event);
    if (event.key === 'Enter' && gesture === null && (event.altKey || event.getModifierState('AltGraph')
      || (event.ctrlKey && event.metaKey) || (event.shiftKey && (event.ctrlKey || event.metaKey)))) return;
    if (menuOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPlusOpen(false);
        setPicker(null);
        if (trigger !== null) setDismissed(triggerKey);
        return;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length > 0) {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setActive((current) => (Math.min(current, options.length - 1) + delta + options.length) % options.length);
        return;
      }
      if (event.key === 'Tab' && options[bounded]?.keepOpen === true) {
        event.preventDefault();
        choose(options[bounded]!);
        return;
      }
      if (gesture === 'plain' && options.length > 0) {
        event.preventDefault();
        choose(options[bounded]!);
        return;
      }
    }
    if (gesture !== null) {
      event.preventDefault();
      const complementary = gesture === 'complementary';
      if (complementary && busy && draft.trim() === '' && attachments.length === 0) {
        void store.steerQueuedMessages();
      } else {
        void submit(complementary);
      }
    }
  };

  const addFiles = async (picked: readonly File[]): Promise<void> => {
    if (picked.length === 0 || readingFilesRef.current) return;
    readingFilesRef.current = true;
    setReadingFiles(true);
    setAttachmentError('');
    const next: Attachment[] = [];
    const errors: string[] = [];
    let total = attachments.reduce((sum, item) => sum + item.size, 0);
    try {
      for (const [index, file] of picked.entries()) {
        const limit = attachmentLimitError(file.size, total, attachments.length + next.length);
        if (limit === 'count') {
          errors.push(t('Attachments are limited to {count} files.', { count: MAX_ATTACHMENTS }));
          break;
        }
        if (limit === 'size') {
          errors.push(t('Each file must be at most {size} MiB.', { size: 8 }));
          continue;
        }
        if (limit === 'total') {
          errors.push(t('Attachments must total at most {size} MiB.', { size: 20 }));
          continue;
        }
        try {
          const imageType = imageMediaType(file);
          if (imageType !== undefined && file.size === 0) {
            errors.push(t('Images cannot be empty.'));
            continue;
          }
          const mimeType = imageType ?? (file.type || 'application/octet-stream');
          const data = await readBase64(file);
          next.push({ id: `${Date.now()}-${next.length}`, kind: imageType === undefined ? 'file' : 'image', name: attachmentFileName(file, index), mimeType, data,
            ...(imageType === undefined ? {} : { preview: `data:${mimeType};base64,${data}` }), size: file.size });
          total += file.size;
        } catch (error) {
          errors.push(t('Attachment failed: {message}', { message: (error as Error).message }));
        }
      }
      if (currentKey.current === key) {
        if (next.length > 0) setAttachments((current) => [...current, ...next]);
        if (errors.length > 0) setAttachmentError([...new Set(errors)].join(' '));
      }
    } finally {
      readingFilesRef.current = false;
      setReadingFiles(false);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = clipboardFiles(event.clipboardData);
    if (files.length === 0) return;
    // Only file pastes are intercepted; text pastes keep the textarea default.
    event.preventDefault();
    if (!attachLocked) void addFiles(files);
  };

  const agentValue = entry?.agent?.id ?? (creating ? app.creationAgent : '');
  const binding = entry?.binding ?? (creating ? app.creationBinding : null);
  const agents = useMemo(() => app.agents.filter((agent) => agent.usage !== 'subagent'), [app.agents]);
  const selectedAgent = entry?.agent ?? agents.find((agent) => agent.id === agentValue) ?? null;
  const agentLabel = selectedAgent === null ? (agentValue === '' ? t('Select agent') : t('Unavailable · {agent}', { agent: agentValue })) : selectedAgent.name;
  const agentItems: MenuEntry[] = [
    ...(agentValue === '' ? [{ id: '', label: t('Select agent'), disabled: true }] : []),
    ...agents.map((agent) => ({ id: agent.id, label: `${agent.name}${agent.role === '' ? '' : ` · ${agent.role}`}`, disabled: !agent.valid })),
    ...(agentValue !== '' && !agents.some((agent) => agent.id === agentValue)
      ? [{ id: agentValue, label: t('Unavailable · {agent}', { agent: agentValue }), disabled: true }] : []),
  ];
  const permissionLabel = selectedPermission === null ? t('Select permission') : t(permissionPresets[selectedPermission].label);
  const menuLabel = mode === 'file' ? t('File reference')
    : mode === 'session' ? t('Recent sessions') : mode === 'skill' ? t('Skills')
      : mode === 'permission' ? t('Choose permission') : mode === 'agent' ? t('Choose agent')
        : mode === 'model' ? t('Choose model') : mode === 'export' ? t('Export session')
          : mode === 'plus' ? t('Add files or run commands') : t('Command menu');

  // A waiting plan review replaces the draft controls but keeps this component
  // mounted, so a draft typed before the review survives the detour.
  if (run?.planReview !== undefined) {
    return (
      <div className={clsx(css.root, hero && css.hero)}>
        <PlanReviewComposer
          review={run.planReview}
          stopping={run.stopping === true || run.finishing === true}
          onOpenPreview={onOpenPlanPreview ?? (() => {})}
        />
      </div>
    );
  }

  return (
    <div className={clsx(css.root, hero && css.hero)}>
      {hero && app.workspaceId !== null && (
        <div className={clsx(heroCss.workspaceRow, appCss.heroChips)}>
          <SelectMenu
            value={app.workspaceId}
            disabled={draftSession && (entry?.run !== undefined || entry?.running === true)}
            items={app.workspaces.map((item) => ({
              id: item.id,
              label: item.name || item.path || item.id,
              icon: <IconFolderOpenRegular size={14} />,
            }))}
            onSelect={(id) => {
              if (draftSession) store.selectDraftWorkspace(id);
              else void store.selectWorkspace(id);
            }}
            ariaLabel={t('Choose workspace')}
            title={t('Workspace for this session')}
            triggerClassName={heroCss.workspace}
            labelClassName={heroCss.workspaceLabel}
            chevronClassName={heroCss.chevron}
            leading={<IconFolderOpenRegular size={14} />}
          >
            {workspaceName}
          </SelectMenu>
          {draftSession && draftMode !== null && (
            <div className={appCss.heroOptions}>
              <SelectMenu
                value={draftMode}
                items={app.modes.filter((item) => item.valid).map((item) => ({
                  id: item.id,
                  label: item.name,
                  icon: <IconAgentPresetOutlineRegular size={14} />,
                }))}
                onSelect={(id) => { store.selectDraftMode(id); }}
                ariaLabel={t('Mode for this session')}
                title={t('Mode for this session')}
                triggerClassName={heroCss.workspace}
                labelClassName={heroCss.workspaceLabel}
                chevronClassName={heroCss.chevron}
                leading={<IconAgentPresetOutlineRegular size={14} />}
                align="end"
              >
                {draftModeName}
                {draftMode === app.defaultMode && (
                  <span className={appCss.modeStar} title={t('Default mode')} aria-label={t('Default mode')}>
                    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
                      <path d="M6 .9l1.57 3.18 3.51.51-2.54 2.48.6 3.5L6 8.92 2.86 10.57l.6-3.5L.92 4.59l3.51-.51z" fill="currentColor" />
                    </svg>
                  </span>
                )}
              </SelectMenu>
            </div>
          )}
        </div>
      )}
      <TodoDock entry={entry} t={t} />
      <div className={css.card} ref={card}>
        <div className={css.overlayAnchor} aria-hidden />
        {menuOpen && (
          <div id="composer-menu" className={menuCss.menu} role="listbox" aria-label={menuLabel}
            onMouseDown={(event) => { event.preventDefault(); }}>
            <div className={menuCss.viewport}>
              {mode === 'file' && filesLoading && options.length === 0 && <div className={menuCss.loading} role="status">{t('Loading files…')}</div>}
              {mode === 'file' && !filesLoading && filesError !== '' && <div className={menuCss.empty}>{filesError}</div>}
              {mode === 'file' && !filesLoading && filesError === '' && options.length === 0 && <div className={menuCss.empty}>{t('No matching files')}</div>}
              {mode === 'session' && recentLoading && options.length === 0 && <div className={menuCss.loading} role="status">{t('Loading sessions…')}</div>}
              {mode === 'session' && !recentLoading && recentError !== '' && <div className={menuCss.empty}>{recentError}</div>}
              {mode === 'session' && !recentLoading && recentError === '' && options.length === 0 && <div className={menuCss.empty}>{t('No matching sessions')}</div>}
              {mode === 'skill' && options.length === 0 && <div className={menuCss.empty}>{availableSkills.length === 0 ? t('No skills are available to this agent') : t('No matching skills')}</div>}
              {mode === 'command' && options.length === 0 && <div className={menuCss.empty}>{t('No matching commands')}</div>}
              {mode !== null && mode !== 'file' && mode !== 'session' && mode !== 'skill' && mode !== 'command' && options.length === 0 && <div className={menuCss.empty}>{t('No results')}</div>}
              {options.map((option, index) => {
                const previous = options[index - 1];
                return (
                  <div key={option.id} role="presentation">
                    {option.group !== undefined && option.group !== previous?.group && <div className={menuCss.sectionTitle}>{option.group}</div>}
                    <button type="button" role="option" aria-selected={index === bounded}
                      aria-disabled={option.disabled === true || undefined}
                      className={clsx(menuCss.item, index === bounded && menuCss.active)}
                      onMouseEnter={() => { setActive(index); }} onClick={() => { choose(option); }}>
                      {option.icon !== undefined && <span className={menuCss.itemIcon} aria-hidden>{option.icon}</span>}
                      <span className={menuCss.itemName}>{option.label}</span>
                      {option.alias !== undefined && <span className={menuCss.itemAlias}>{option.alias}</span>}
                      {option.description !== undefined && <span className={menuCss.itemDescription}>{option.description}</span>}
                      {option.current === true && <span className={menuCss.trailing}><IconCheckOutlineRegular aria-hidden /></span>}
                      {option.keepOpen === true && <span className={menuCss.trailing} aria-hidden><IconChevronRightOutlineRegular /></span>}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className={menuCss.footer}>
              <kbd>↑</kbd><kbd>↓</kbd><span>{t('Use ↑↓ to navigate, Enter to choose, Esc to close.')}</span>
            </div>
          </div>
        )}
        {attachments.length > 0 && (
          <div className={clsx(css.accessory, attachmentCss.rail)} aria-label={t('Files')}>
            {attachments.map((attachment) => (
              <div key={attachment.id} className={attachmentCss.item}>
                {attachment.kind === 'image' && attachment.preview !== undefined ? (
                  <div className={attachmentCss.thumbnail}><img src={attachment.preview} alt={attachment.name} /></div>
                ) : (
                  <div className={attachmentCss.card}>
                    <span className={attachmentCss.icon} aria-hidden><IconPaperclipOutlineRegular /></span>
                    <span className={attachmentCss.body}>
                      <span className={attachmentCss.name}>{attachment.name}</span>
                      <span className={attachmentCss.meta}>{fileSize(attachment.size)}</span>
                    </span>
                  </div>
                )}
                <button type="button" className={attachmentCss.remove}
                  aria-label={`${t('Remove attachment')}: ${attachment.name}`}
                  onClick={() => { setAttachments((current) => current.filter((item) => item.id !== attachment.id)); }}>
                  <IconCloseOutlineRegular size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className={css.grow}>
          {draft === '' && attachments.length === 0 && <span className={css.placeholder}>{placeholder}</span>}
          <textarea ref={textarea} className={clsx(css.input, appCss.composerInput)} value={draft} rows={1}
            disabled={!available && !creating} readOnly={sending} placeholder="" aria-label={placeholder}
            aria-autocomplete="list" aria-expanded={menuOpen} aria-controls={menuOpen ? 'composer-menu' : undefined}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              setDraftValue(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setPlusOpen(false);
            }}
            onClick={(event) => { setCaret(event.currentTarget.selectionStart ?? draft.length); }}
            onSelect={(event) => { setCaret(event.currentTarget.selectionStart ?? draft.length); }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        <div className={css.row}>
          <div className={css.tools}>
            <button ref={plusButton} type="button" className={css.add} aria-label={t('Add files or run commands')}
              aria-haspopup="listbox" aria-expanded={plusOpen} disabled={attachLocked}
              onMouseDown={(event) => { event.preventDefault(); }}
              onClick={() => {
                setPlusOpen((current) => !current);
                setPicker(null);
                setDismissed(triggerKey);
              }}>
              <IconPlusOutlineMedium size={14} />
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(event) => {
              const picked = event.target.files === null ? [] : [...event.target.files];
              event.target.value = '';
              void addFiles(picked);
            }} />
            <div className={css.modes}>
              {app.sessionId !== null && (
                <SelectMenu value={selectedPermission ?? ''}
                  items={Object.entries(permissionPresets).map(([value, preset]) => ({
                    id: value, label: t(preset.label), icon: permissionIcon(value as PermissionPreset),
                  }))}
                  onSelect={choosePermission} ariaLabel={t('Session permission')}
                  title={selectedPermission === null ? t('Choose a permission for this session.') : t(permissionPresets[selectedPermission].description)}
                  disabled={locked} side="top"
                  leading={selectedPermission === null ? undefined : permissionIcon(selectedPermission)}
                  listClassName={appCss.selectMenuList}>
                  {permissionLabel}
                </SelectMenu>
              )}
              {app.sessionId !== null && (
                <button type="button" className={entry?.plan.active === true ? planCss.chip : appCss.modeChip}
                  aria-pressed={entry?.plan.active === true} disabled={locked}
                  title={entry?.plan.active === true
                    ? t('Plan mode is on: the agent researches and submits a plan before editing.')
                    : t('Turn on plan mode: research first, then submit a plan for approval.')}
                  onClick={() => { void store.togglePlan(); }}>
                  <span className={planCss.glyph} aria-hidden><IconPlanOutlineRegular /></span>
                  {entry?.plan.active === true ? t('Planning') : t('Plan')}
                </button>
              )}
            </div>
            {entry?.planError !== undefined && entry.planError !== '' && <span className={appCss.composerError}>{entry.planError}</span>}
            {attachmentError !== '' && <span className={appCss.composerError}>{attachmentError}</span>}
          </div>
          <div className={css.trailing}>
            <div className={css.standardControls}>
              {app.sessionId !== null && (
                <>
                  {entry?.mode == null && (
                    <SelectMenu value={agentValue} items={agentItems}
                      onSelect={(id) => {
                        if (app.sessionId === null) store.setCreationAgent(id);
                        else void store.saveSessionAgent(id);
                      }}
                      ariaLabel={t('Agent')}
                      title={entry?.agent !== undefined && entry?.agent !== null
                        ? t('Agent for this session: {agent} · role {role}', { agent: entry.agent.name, role: entry.agent.role })
                        : t('Agent for the next session')}
                      disabled={busy || saving || (!available && !creating)}
                      side="top" align="end" listClassName={appCss.selectMenuList}>
                      {agentLabel}
                    </SelectMenu>
                  )}
                  <ContextMeter workspaceId={app.workspaceId} sessionId={app.sessionId}
                    draft={draftSession} busy={busy} refreshing={entry?.loading === true}
                    revision={entry?.request ?? 0} modelSaving={entry?.modelSaving === true}
                    modelKey={JSON.stringify(binding)} locale={app.locale} />
                  <ModelPicker
                    binding={binding}
                    models={app.models}
                    roles={app.roles}
                    resolved={entry?.resolvedModel ?? null}
                    allowRoles={false}
                    concreteOnly
                    onSelect={(next) => {
                      if (app.sessionId === null) store.setCreationBinding(next);
                      else void store.saveSessionModel(next);
                    }}
                    ariaLabel={t('Model source')}
                    title={draftSession || creating
                      ? t('Model source for the next session')
                      : t('Model source for this session')}
                    disabled={busy || saving || (!available && !creating)}
                    side="top"
                    align="end"
                  />
                </>
              )}
            </div>
            {busy ? (
              <>
                {canSend && (
                  <SelectMenu value={busySend}
                    items={[
                      { id: 'queue', label: t('Queue for the next turn'), icon: <IconQueueOutlineRegular /> },
                      { id: 'steer', label: t('Send into the current reply'), icon: <IconSendOutlineRegular /> },
                    ]}
                    onSelect={(id) => {
                      store.setBusySend(id === 'steer' ? 'steer' : 'queue');
                    }}
                    ariaLabel={t('Send behavior')}
                    title={busySend === 'queue'
                      ? t('Queued messages are sent after the current reply finishes.')
                      : t('Your message is added to the current reply at the next step.')}
                    leading={busySend === 'queue' ? <IconQueueOutlineRegular /> : <IconSendOutlineRegular />}
                    side="top" align="end" listClassName={appCss.selectMenuList}>
                    {busySend === 'queue' ? t('Queue') : t('Send now')}
                  </SelectMenu>
                )}
                <button type="button" className={canSend ? css.stopSecondary : css.primary}
                  aria-label={t('Stop')}
                  disabled={run?.stopping === true || run?.finishing === true}
                  onClick={() => { void store.stopTurn(); }}>
                  <IconStopFillRegular />
                </button>
                {canSend && (
                  <button type="button" className={css.primary}
                    aria-label={busySend === 'queue' ? t('Queue message') : t('Send message now')}
                    onClick={() => { void submit(); }}>
                    {busySend === 'queue'
                      ? <IconQueueOutlineRegular />
                      : (
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                          <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                        </svg>
                      )}
                  </button>
                )}
              </>
            ) : creating ? (
              <Button variant="primary" size="sm" disabled={app.agentsLoading || app.modelsLoading || app.creatingSession}
                onClick={() => { void store.startDraftSession(); }}>
                {t('New session')}
              </Button>
            ) : (
              <button type="button" className={css.primary} aria-label={t('Send')} disabled={!canSend}
                onClick={() => { void submit(); }}>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {(entry?.permissionError !== undefined && entry.permissionError !== '')
          || (entry?.agentError !== undefined && entry.agentError !== '')
          || (entry?.modelError !== undefined && entry.modelError !== '') ? (
            <div className={appCss.composerErrors}>
              {entry?.permissionError !== undefined && entry.permissionError !== '' && <p>{entry.permissionError}</p>}
              {entry?.agentError !== undefined && entry.agentError !== '' && <p>{entry.agentError}</p>}
              {entry?.modelError !== undefined && entry.modelError !== '' && <p>{entry.modelError}</p>}
            </div>
          ) : null}
      </div>
      <div className={clsx(css.dock, appCss.composerDock)}>
        {entry !== null && entry.queued.length > 0 && (
          <div className={appCss.queueDock} aria-label={t('Queued messages')}>
            <div className={appCss.queueHeader}>
              <IconQueueOutlineRegular />
              <span>{t('{count} queued', { count: entry.queued.length })}</span>
            </div>
            <ul className={appCss.queueList}>
              {entry.queued.map((item) => (
                <li key={item.id} className={appCss.queueItem}>
                  <span className={appCss.queueText} title={item.delivery === 'uncertain' ? t('Delivery status unknown. Check the conversation before removing this message.') : item.text}>
                    {item.text.trim() === '' ? item.attachments.map((attachment) => attachment.name).join(', ') : item.text}
                    {item.delivery === 'uncertain' ? ` (${t('Delivery status unknown')})` : ''}
                  </span>
                  <button type="button" className={appCss.queueRemove}
                    aria-label={t('Steer queued message')} title={t('Steer queued message')}
                    disabled={item.delivery === 'uncertain' || !busy || run?.stopping === true || run?.finishing === true}
                    onClick={() => { void store.steerQueuedMessage(item.id); }}>
                    <IconSendOutlineRegular size={12} />
                  </button>
                  <button type="button" className={appCss.queueRemove}
                    aria-label={t('Remove queued message')}
                    onClick={() => { store.removeQueuedMessage(item.id); }}>
                    <IconCloseOutlineRegular size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <SessionStats entry={entry} />
      </div>
      <RiskConfirmation
        open={risk !== null}
        title={t('Enable full access?')}
        description={t('Full access lets this session modify files without file sandbox restrictions or approval prompts, including sensitive files and external commands. Only use it when you trust the current task.')}
        acknowledgeLabel={t('I understand the risks')}
        cancelLabel={t('Cancel')}
        closeLabel={t('Close')}
        confirmLabel={t('Enable full access')}
        acknowledged={risk?.acknowledged === true}
        onAcknowledgedChange={(acknowledged) => { setRisk((current) => current === null ? null : { ...current, acknowledged }); }}
        onCancel={() => { setRisk(null); }}
        onConfirm={() => {
          if (risk === null) return;
          const preset = risk.preset;
          setRisk(null);
          void store.saveSessionPermission(preset);
        }}
      />
    </div>
  );
}
