# OmniAgent Architecture Notes

## Current runtime

OmniAgent is a Cordis-free TypeScript runtime built from DSH's core behavior without the DSH plugin runtime. The TUI and Web composition roots explicitly wire the selected model provider, persisted DSH permission snapshot, tools, session store, and audit sink. The built-in file and shell tools enforce the snapshot at execution time, while both frontends consume the same `AgentEvent` stream.

### Durable sessions

Sessions are stored as append-only JSONL files:

```text
~/.omniagent/sessions/<workspace-key>/<agent-id>/session.jsonl
```

The first line is a versioned session header. Later lines are typed events with contiguous `seq` values. Appends are persisted immediately; `flush()` remains available for repair checkpoints. Each append is staged, fsynced, and atomically renamed after identity and metadata checks. Invalid JSON, empty records, or non-contiguous sequences reject the log and preserve the original bytes; a valid final record without a newline can be normalized before a later append. Session identity is checked against both workspace and id. New session directories and files are created with private permissions, but existing files are not automatically changed. Writers of one session are serialized across OmniAgent processes by a sibling `wx` lock that records the holder PID and is taken over only when that process is gone; the existing file is re-read under the lock so an append never overwrites events committed by another process. The lock does not constrain non-cooperating external writers, which are still detected by the pre-rename metadata check. Workspace registry updates remain single-process and can lose concurrent changes. Existing sessions whose stored workspace spelling differs from the canonical registered path are not auto-matched or migrated.

The model history is a projection of current `message/user`, `message/assistant`, and `message/tool-result` events plus the older `user/message`, `assistant/message`, and `tool/result` aliases. The log is the source of truth, not a separately persisted message array. When an interrupted or failed batch is missing tool results, provider input is repaired with a result stating that execution status is unknown; duplicate calls and orphan results are omitted from that input only. The durable log and visible history are not rewritten. When such a repair is necessary, later turns may repeat context compaction because the compacted provider input is not substituted for the raw history.

### Runtime loop

`AgentLoop` keeps the DSH-shaped turn/step lifecycle: provider request, optional stream settlement, assistant message, per-call DSH preparation, tool execution, observation, and continuation. A `Session` captures an immutable `DshPermissionSnapshot` for the turn. Ordinary `workspace-write` calls do not require a prompt; a model-requested wider sandbox is approved once and is never persisted as a reusable grant. `danger-full-access` uses no DSH file sandbox and its approval policy is `never`. Before each provider request the loop can estimate pressure and compact history without splitting an assistant tool call from its result. Web and TUI derive the input budget from `contextWindowTokens` when configured, otherwise from the selected model's catalog context window; sessions without either budget do not auto-compact. The live `context.compacted` event exposes the before/after estimate to UIs.

The built-in `bash` capability is injected by `Session` with a policy rebuilt from the per-turn snapshot. The write and bash capabilities alone may request a one-shot wider sandbox. Other registered tools are trusted only in `danger-full-access`; confined presets deny arbitrary extension tools because the Session has no sandbox policy for them. `read_file`, `list_dir`, and `skill` remain trusted read-only capabilities.

The TUI renderer is presentation-only: it buffers complete Markdown lines for the assistant body, renders `assistant.reasoning.delta` through a dimmed reasoning block, and folds `tool.call`/`tool.result` pairs into one status row with a tool-specific summary and bounded output preview. Reasoning deltas are live-only and are not written to the session transcript. Tool arguments and results are sanitized for terminal control characters before display; verbose mode is an explicit user choice, not persisted in session data.

### Todo, plan mode, and subagents

`todo_write` is a model-facing whole-list replacement. Each call appends a `todo/write` event with the complete validated list; duplicate entries and multiple `in_progress` items are rejected. The standing projection is the latest well-formed write, retained across model steps and retired by the next user turn (or a `turn/start` event in a compatible log). TUI prints the list after each update, and Web includes it in session details and the live conversation footer.

Plan mode is a persisted `plan/mode { active }` session state, exposed through the TUI `/plan` command and the Web plan toggle. While active, the system prompt receives DSH-style planning guidance and `exit_plan_mode` is disclosed. The tool requires a Markdown heading, sends the complete plan to the host review callback, and only clears plan mode after approval; rejected plans return user feedback to the model. Plan mode is guidance and reviewed state, not a sandbox or permission preset: the standing preset still controls writes and command execution.

Subagents are independently persisted sessions with a `parentSessionId`, depth, and description. The `subagent` tool starts one asynchronously and returns immediately; `send_message` steers a running child or starts/continues an idle one, `list_agents` and `wait_agent` inspect the collaboration tree, and `interrupt_agent` can stop a descendant. A child inherits the creator's exact permission preset and workspace containment, may use an explicit catalog-validated model, and is subject to `maxDepth` and `maxActive`. Completion appends `subagent/end` and wakes a live parent through `receiveSubagentNotice`; if the parent is not live in this process, a `subagent/notice` event is persisted for its next turn. A message queued after the parent's final step triggers a background turn rather than remaining unread. Persisted children can be lazily reopened by `send_message` or `wait_agent` in a later process.

### Security boundaries

The DSH permission layer has three explicit presets: `read-only`, `workspace-write`, and `danger-full-access`. A session stores its choice as a `permission/dsh-preset` event; an empty, legacy, invalid, or unknown event history cannot authorize tools and requires explicit selection. `read_file` and `list_dir` apply a physical-path fence under `read-only` and `workspace-write`, including symlink-escape rejection; built-in writes reject hard-linked targets. The shell backend enforces writes through Seatbelt, bubblewrap, or configured Landlock, and workspace-write additionally fails closed when its writable roots contain a pre-existing hard-linked regular file. That preflight does not scan host temp roots, so a pre-existing hard link under `/tmp` or `$TMPDIR` remains a residual write-through path. These controls still have TOCTOU windows, and they constrain file writes and process execution, not network access or all reads; they are not a VM or complete OS security boundary.

### Web workspaces

The local Web host registers its starting directory in `~/.omniagent/workspaces.json`. A workspace is an existing directory identified by a stable ID and its canonical real path. Registering a second spelling of the same path reuses the existing workspace. Unregistering a workspace only removes it from the registry; it does not remove the directory or its saved sessions. A workspace may be registered again later.

Every Web session request includes the workspace ID. The host resolves that ID through the registry and uses the resulting workspace path and session ID together to find or create a session. Conversation history comes from the session log. Lifecycle, tool, permission and compaction trace events are available in the Observe view; Web audit records are stored under the application configuration directory, filtered by workspace and session, and omit both argument digests and permission rule source text from the API projection. Workspace-local audit files used by older versions or the TUI remain untouched and are not automatically imported. The TUI writes its audit log to `<workspace>/.omniagent/audit.jsonl`; arguments are hashed, a newly created directory is `0700` and a new file is `0600`, while pre-existing directory and file modes are left unchanged. A symlinked or non-regular audit target is rejected instead of followed. Another process running as the same OS user can still read the log. A trace does not duplicate tool arguments or full tool output. Session messages and raw audit logs can contain sensitive content, so both must be treated as private data.

The shell sandbox has the same boundary: it constrains writes and process execution, but a confined process can read any file the current OS user can read and may reach loopback services, including the local Web control plane. The Web host does not authenticate local users; active turns and session creation reject permission/default changes as a race guard, not as a substitute for authentication. The low-level exported `AgentLoop` also accepts a legacy `PermissionGate`; callers that bypass `Session` and its `prepareToolCall` hook do not automatically receive the DSH file/shell policy. Web/TUI composition roots use `Session`.

The trajectory projection derives Input / Model / Tools records from the persisted event order. It does not infer model latency or duplicate sensitive message text, tool arguments, output, or rule sources. Its recorded-time tool intervals represent the observed call-to-result event timestamps; explicitly recorded execution duration is a separate value. The Observe view offers Records and Events lists with filtered metadata details; live stream events appear there only after persisted session details are reloaded. DSH's timeline drag, zoom, and pan interactions are not implemented. The session menu exports a versioned JSON transcript or copies Markdown for one session, not a DSH ZIP archive with descendant logs or attachments. Exported message text and tool output may contain secrets and must be reviewed before sharing.

### Skills

The filesystem catalog discovers project `.agents/skills`, custom roots, and the user skill directory. It supports both `<skill>/SKILL.md` and flat `<skill>.md` files. Catalog entries load frontmatter and a short description; full instructions are read only through the model-facing `skill` tool. Earlier roots win on duplicate names, files above 1 MiB are rejected, and skill discovery is independent of the Cordis/DSH plugin runtime. Web and TUI inject the catalog into the session system prompt; the tool reads the same catalog on demand, so a skill cannot be loaded just by guessing a path.

### Known limitations

- The file fence resolves physical paths, rejects symlink escapes in `read_file`/`list_dir` and hard-linked built-in write targets, and still has TOCTOU limitations. Shell hard-link preflight covers workspace and additional writable roots, not host temp roots.
- Confined shell execution has been verified with Seatbelt on macOS. Linux bubblewrap/Landlock behavior is implemented but has not yet been exercised on a real Linux host; unsupported platforms fail closed.
- Session append uses a cross-process PID lock, fsync, and atomic rename; non-cooperating external writers can still race between metadata validation and rename, and each append copies the existing log.
- Context estimation and compaction use the selected model's catalog context window or explicit config; a model with no catalog window and no configuration does not auto-compact.
- Plan mode is persisted guidance, not enforcement. A model can still write or run commands while plan mode is active if the standing permission preset allows it.
- Subagent limits are in-process. `maxActive` counts work in one runtime, and a child lazily resumed by a new process uses the default system prompt rather than the original parent's dynamic system text; its persisted messages, permission, model, and workspace are preserved.
- A Web subagent runs as a background session and is not attached to the initiating turn's SSE approval stream. Its normal workspace operations still run under the inherited preset, but a one-shot sandbox escalation is denied because no live approval handler is bound, and child plan review is unavailable. The TUI passes its terminal approval callback to children. Background completion notices are persisted; the Web UI sees them when the parent session is reloaded or when a background turn produces new stored events, not through the original SSE response.

```bash
pnpm test
pnpm typecheck
pnpm dev       # interactive TUI with /sessions and /resume
pnpm web       # local UI at http://127.0.0.1:4317
```

The Web server accepts `OMNIAGENT_PORT` for a different loopback port. Providers and API keys remain outside session files and are read from the existing config/environment mechanism.
