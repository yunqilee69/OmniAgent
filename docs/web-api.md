# Local Web API

The Web server defaults to `127.0.0.1:4317`. Configure `web.host`, `web.port`, and `web.auth` in `~/.omniagent/config.json`; `OMNIAGENT_PORT` overrides `web.port`. Web settings are read at startup, so restart the server after changing them.

```json
{
  "web": {
    "host": "127.0.0.1",
    "port": 4317,
    "auth": { "enabled": false, "username": "", "password": "" }
  }
}
```

Authentication is disabled by default. To enable it, set `web.auth.enabled` to `true` and provide a non-empty `username` and `password`. The Web client supports login, login status, and logout. When authentication is enabled, every business API, including SSE endpoints, requires a valid login cookie; authentication operations must remain accessible to establish or inspect a login. Credentials are stored in plaintext: restrict the configuration file to `0600`, for example with `chmod 600 ~/.omniagent/config.json`. Other processes running as the same OS user may still read the configuration or sensitive data; authentication is not a security boundary against them. HTTP does not encrypt credentials, cookies, or business data in transit; use it only on trusted networks.

Authentication routes (always reachable):

- `GET /api/auth/status` returns `{ enabled, authenticated }`. When authentication is disabled, `authenticated` is `true`.
- `POST /api/auth/login` accepts `{ username, password }` and returns `{ enabled: true, authenticated: true }` plus a `Set-Cookie` for `omniagent_session`. The cookie is `HttpOnly`, `SameSite=Strict`, and expires after 12 hours. Invalid credentials return `401`; repeated failures from one client are limited to 5 per 60 seconds and then return `429` with `Retry-After`. The request body is limited to 4 KiB.
- `POST /api/auth/logout` revokes the current cookie and returns `{ enabled, authenticated }`; it also works when authentication is disabled.

When authentication is enabled, non-GET/HEAD/OPTIONS requests must include an `Origin` header matching the request origin.

The `Host` header must identify an allowed listening host and the actual listening port. Loopback hosts (`127.0.0.1`, `localhost`, and `[::1]`) are allowed, as is the configured concrete listening host; arbitrary Host names are not authorized merely because the service is reachable. If an `Origin` header is present, it must match the normalized request Host origin, including hostname and port; `localhost` and `127.0.0.1` are not interchangeable. JSON requests require `Content-Type: application/json` and are limited to 64 KiB. Errors have the form `{ "error": "..." }`.

## Workspaces

Web startup creates and registers `~/.omniagent/default-workspace` and also registers the process cwd. Canonical paths are deduplicated, preserving an existing record's ID and name. The default record has `isDefault: true`; ordinary records may omit this field.

- `GET /api/workspaces` returns `{ workspaces }`.
- `POST /api/workspaces` accepts `{ path, name? }` and returns `{ workspace }`. The path must be an absolute, existing directory; its real path is stored and duplicate paths resolve to the existing record.
- `DELETE /api/workspaces/:workspaceId` unregisters a workspace and returns `{ removed: true }`. It does not delete the directory or its sessions. It returns `403` for the default workspace and `409` while a turn or persistent session creation is active.

Workspace IDs are opaque. All session endpoints resolve the workspace ID through the registry rather than accepting a filesystem path from the caller.

Workspace file routes:

- `GET /api/workspaces/:workspaceId/files?query=...&limit=...` returns `{ entries }` for the composer `@` menu. Each entry is `{ path, name, kind: "file" | "directory" }`. `query` is at most 1,024 characters; `limit` is clamped to 1–50 (default 20). The scan is bounded to 50,000 entries and skips `.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `target`, `.next`, `.nuxt`, `.turbo`, `.venv`, `__pycache__`, and similar dependency / build trees. Paths are workspace-relative.
- `GET /api/workspaces/:workspaceId/files/tree?path=...` returns `{ entries, truncated }` for one directory (`path` empty means the workspace root). Entries are sorted directories first, then by name; at most 5,000 entries are returned and `truncated` reports overflow. Symlinks, non-regular files, absolute paths, `..`, and backslashes are rejected with `400` / `403`.
- `GET /api/workspaces/:workspaceId/files/content?path=...` returns `{ path, content }` for a UTF-8 text file. Missing files return `404`, directories return `400`, files larger than 1 MiB return `413`, binary or non-UTF-8 files return `415`. On Linux the opened descriptor is re-checked with `/proc/self/fd` so a replaced parent directory cannot escape the workspace.

## Permission Settings

- `GET /api/settings/permissions` returns `{ settings: { defaultPreset, requiresSelection } }`.
- `PUT /api/settings/permissions` accepts `{ defaultPreset }`, where the value is `read-only`, `workspace-write`, or `danger-full-access`; it returns the same envelope as GET.

This is a global default for genuinely new sessions, persisted under `dsh.permission.defaultPreset` in `~/.omniagent/config.json`. Existing sessions keep the preset recorded in their own event history. If no valid default is available, GET reports `{ defaultPreset: null, requiresSelection: true }` until a DSH preset is explicitly selected. A failed write or detected external change does not update the service's trusted snapshot. Workspace-provided configuration is not loaded by this API.

The presets are:

- `read-only`: file mutations are rejected by the file fence; shell commands run with a write-denying OS sandbox when a supported backend is available.
- `workspace-write`: file mutations are allowed inside the workspace and the configured temporary roots without per-call approval; shell runs with those write roots. A requested wider sandbox can be approved for one call.
- `danger-full-access`: no DSH file sandbox is applied and the approval policy is `never`. This does not mean that explicit approval requests are automatically approved.

The file fence resolves symlinks for `read_file`, `list_dir`, `glob`, and `grep` and rejects out-of-workspace physical targets; built-in `write_file`/`edit_file` mutations reject hard-linked targets. The shell preflight rejects pre-existing hard links in workspace and additional writable roots, but not under host temp roots. Path checks can race with hostile concurrent filesystem changes (TOCTOU). Seatbelt, bubblewrap, and Landlock constrain file writes only; they do not isolate network access, restrict all reads, or form a complete OS security boundary. A confined shell can still read files available to the current OS user, including configuration and credentials, and may be able to reach the loopback Web control plane. Clearing selected environment variables is not credential isolation. Confined shell execution fails closed if no usable supported backend is available.

## Agent, Role, and Model Catalogs

- `GET /api/agents` returns `{ agents }`. Each entry is `{ id, name, description, role, usage, profile, builtIn?, valid, warnings }`. Invalid agent files are also listed with `valid: false` and an error in `warnings`; catalog responses never include agent Markdown bodies. `builtIn: true` marks the built-in `default` and `creator` definitions.
- `GET /api/roles` returns `{ roles }`, each `{ id, name, provider, model, reasoningEffort? }`.
- `GET /api/models` returns `{ models }`, each `{ provider, model, name, contextWindow?, maxTokens?, capabilities: { imageInput }, reasoningEfforts, defaultReasoningEffort? }`.

These catalogs are refreshed from `~/.omniagent/config.json` and `~/.omniagent/agents/` on request. They contain no API keys, authorization headers, provider endpoints, or agent system prompts. `usage` is `primary`, `subagent`, or `both`.

### Manual agent definitions

The Settings → Agents editor writes and removes `~/.omniagent/agents/*.md` directly through the same validated authoring service used by Creator mode. These routes exist only when the host is configured with agent authoring.

- `GET /api/settings/agents` returns `{ agents, profiles }` for the manual editor. Each agent entry is `{ id, name, description, role, usage, profile, builtIn }`; `profiles` lists the profile ids accepted by `PUT`.
- `GET /api/settings/agents/:id` returns `{ agent, profiles }`, where `agent` additionally contains `instructions` (the Markdown body). Unknown ids return `404`; built-in definitions are readable but cannot be written or deleted.
- `PUT /api/settings/agents/:id` accepts `{ name, description, role?, usage?, profile?, instructions, overwrite? }`. Without `overwrite: true`, an existing definition returns `400`; reserved ids (`default`, `creator`), unknown roles/profiles, malformed bodies and extra fields also return `400`. Writes use restrictive permissions and refuse symlinked targets.
- `DELETE /api/settings/agents/:id` removes one custom definition and returns `{ removed }`; built-in ids are refused with `400`.

Because the editor must round-trip system prompts, agent bodies are returned only by the per-agent settings endpoint, not by `GET /api/agents`. Treat those bodies as sensitive: they are part of the model context, not trusted instructions for the host.

## Modes and Editable Roles

- `GET /api/modes` returns `{ modes, defaultMode }`. Each mode is `{ id, name, description, agent, model, tools, skills, builtIn, customized, valid, warnings }`; `tools` and `skills` are `"*"` or string arrays. Built-in `standard` and `creator` modes are always present; `modes.json` may override them or add custom modes.
- `GET /api/modes/options?workspaceId=...` returns `{ tools, skills }` for the mode editor. `tools` comes from the known tool registry plus the names of tools currently exposed by connected MCP servers; `skills` is discovered from the selected workspace (or the host cwd when omitted).
- `PUT /api/modes/:id` accepts `{ name, description?, agent, model?, tools?, skills? }` and atomically saves `~/.omniagent/modes.json`. Unknown agents, unknown tools, or unresolvable model bindings return `400` without modifying the file. `DELETE /api/modes/:id` removes a custom mode or a built-in override; removing an override restores the built-in definition.
- `GET /api/settings/default-mode` returns `{ defaultMode }`; `PUT` accepts exactly `{ mode }` and only selects a valid mode.
- `GET /api/settings/roles` returns the editable role table, including invalid entries and the implicit `default` role.
- `PUT /api/settings/roles/:id` accepts `{ name?, provider, model, reasoningEffort? }`; `DELETE /api/settings/roles/:id` removes an explicit role. Writes preserve unrelated `config.json` fields and use the same atomic write policy as permission settings. Invalid providers/models or malformed bodies return `400`; the implicit `default` role has no explicit entry and cannot be deleted.

### Model sources

Model sources are the routes in `config.providers`, plus the historical top-level `provider` object when present. The settings UI edits them through these endpoints; role and source writes share one serialized read-modify-write lock for `config.json`.

- `GET /api/settings/model-sources` returns `{ sources, defaultSource?, defaultModel?, protocols, catalogProviders }`.
  - Each source is `{ id, name, api?, baseURL?, apiKeyConfigured, apiKeyEnv?, auth?, models, builtIn, legacy, active, removable, valid, error? }`.
  - Each model is `{ id, name, contextWindow?, maxTokens?, input, reasoning?, inherited }`; `input` is a non-empty subset of `text` and `image`, and `reasoning.efforts` maps effort levels to their wire values.
  - `apiKeyConfigured` is a boolean derived from a stored key, a non-empty environment variable, or `auth: "ambient"`. The key value itself is never returned by this API.
  - `protocols` lists `deepseek-messages`, `openai-completions`, `openai-responses`, and `anthropic-messages`. `catalogProviders` lists built-in pi-ai provider ids the editor can adopt.
- `PUT /api/settings/model-sources/:id` accepts `{ name?, api?, baseURL?, clearBaseURL?, apiKey?, clearApiKey?, apiKeyEnv?, clearApiKeyEnv?, auth?, models? }`.
  - `models` replaces the list while merging fields the editor does not know for each matching model id. Each model accepts `{ id, name?, contextWindow?, maxTokens?, input?, reasoning? }`; `reasoning` is `false` or `{ efforts, default?, wire? }`.
  - The API key is write-only: set it with `apiKey`, remove it with `clearApiKey`. A blank `apiKey` is ignored rather than stored. `apiKeyEnv` is an optional fallback environment variable; use `clearApiKeyEnv` to remove it.
  - Built-in providers may omit `api` and `baseURL` to inherit their catalog values. Custom providers need both a protocol and an endpoint.
  - A historical top-level `provider` object appears as the `openai` source. Saving it migrates the route into `providers.openai` and sets `provider: "openai"` without changing the current model or roles.
  - Invalid ids, URLs, models, duplicate model ids, missing protocols for custom sources, or writes that would break an existing valid role return `400` without touching the file.
- `DELETE /api/settings/model-sources/:id` removes a custom source. The active default source, built-in sources, and sources referenced by any valid role are refused with `400`. `{ removed: false }` means the source did not exist.
- `POST /api/settings/model-sources/discover` accepts `{ provider?, api?, baseURL?, apiKey?, apiKeyEnv? }` and returns `{ models }` with `{ id, name?, contextWindow?, maxTokens?, input? }`. It fetches `<baseURL>/models` for OpenAI-compatible protocols and `<baseURL>/v1/models` for Anthropic Messages, sends at most a stored or supplied key, refuses redirects, and times out after 15 seconds. `deepseek-messages` has no model-list endpoint and returns `400`.

### MCP servers

MCP servers live under `mcpServers` in `config.json`, keyed by server id. The editor offers the two MCP-standard transports — stdio and Streamable HTTP — using the common Claude Desktop/Cursor shape:

```json
{
  "filesystem": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"],
    "env": { "LOG_LEVEL": "info" },
    "cwd": "/path/to/project",
    "timeoutMs": 60000
  },
  "remote": {
    "type": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
  }
}
```

- The settings UI offers `stdio` and `http`/`streamable-http`. The `transport` alias is also accepted, and legacy `sse` and `ws`/`websocket` entries remain parseable for compatibility. If the type is omitted, `command` implies stdio and `url` implies HTTP. HTTP connections fall back to the legacy HTTP+SSE transport when streamable HTTP fails, so an SSE-only server does not need an explicit `sse` type.
- stdio servers use `command`, `args`, `env`, and `cwd`. Remote servers use `url` and `headers`. WebSocket servers cannot send custom headers.
- `enabled` defaults to `true`; `disabled: true` is accepted as the inverse alias. `timeoutMs` defaults to 60 seconds and applies to connection and calls.
- `${VAR}` references in commands, arguments, environment values, URLs, headers, and `cwd` are expanded from the host environment. A missing variable makes the server unavailable instead of silently expanding to an empty string.

Runtime behavior:

- Enabled servers connect when the Web host starts and reconnect after a settings write. A failing server is reported in the list but never prevents other servers or turns from running.
- Each remote tool is exposed as `mcp__<server-id>__<tool-name>`, sanitized to the provider-safe `[A-Za-z0-9_-]` alphabet and at most 64 characters. Tools run outside the local filesystem sandbox and are therefore trusted by the DSH permission layer; the server entry is user-authored configuration. A restricted agent profile or mode must list the exact `mcp__...` name (or use `"*"`) to see it.
- Tool results are flattened to text: text content is preserved, images/audio/resources are summarized, and `structuredContent` is appended as JSON. MCP `isError` maps to `ok: false`.

Routes:

- `GET /api/settings/mcp-servers` returns `{ servers, transports }`, where `transports` lists the selectable transports (`stdio`, `http`); legacy entries still appear in `servers`. Each server is `{ id, transport, enabled, timeoutMs?, command?, args, envKeys, cwd?, url?, headerKeys, valid, error?, runtime? }`. Environment values and header values are never returned, only their keys. `runtime` is `{ state, toolCount, tools, serverName?, serverVersion?, error? }` with state `connected`, `disconnected`, `disabled`, or `invalid`.
- `PUT /api/settings/mcp-servers/:id` accepts `{ type?, enabled?, timeoutMs?, command?, args?, env?, clearEnv?, cwd?, url?, headers?, clearHeaders? }`.
  - A blank value for an existing `env` or `headers` key keeps the stored secret; `clearEnv` / `clearHeaders` remove keys. Switching transport removes fields that belong to the other shape.
  - `timeoutMs: null` removes the override. `cwd: null` removes the working directory.
  - Invalid ids, malformed shapes, missing commands/URLs, and credentials embedded in URLs return `400` without touching the file.
- `DELETE /api/settings/mcp-servers/:id` removes a server and returns `{ removed }`.
- `POST /api/settings/mcp-servers/test` accepts `{ id, server? }` and returns a probe result `{ ok, transport, durationMs, serverName?, serverVersion?, tools, resources, prompts, error? }`. When `server` is supplied it is merged over the stored row exactly like a save, so blank secret fields still use stored values. A failed connection is returned as `{ ok: false, error }`; a malformed draft returns `400`.

MCP tool availability follows the same snapshot rule as the rest of the runtime: a session registers the tools that were live when it was created. Editing servers affects new sessions and new subagents, not tools already bound to a running session.

Mode configuration affects new sessions only. A session stores a `mode/selected` snapshot when created, so later edits to the mode preset do not alter that session.

## Sessions

- `GET /api/sessions/recent?workspaceId=...&query=...&limit=...` returns `{ sessions }` for the composer `#` menu. It lists root sessions only (subagent children are excluded), keeps sessions whose workspace is still registered, filters case-insensitively on title, description, workspace name, and session id, and sorts the requested `workspaceId` first, then by `updatedAt` descending. Each entry is `{ id, title, workspaceId, workspaceName, updatedAt, blank, agent?, mode? }`. `limit` is clamped to 1–50 (default 30) and a query longer than 1,024 characters returns `400`; an unknown `workspaceId` returns `404`. The filter is a LIKE-style substring match per whitespace-separated term, not a SQL query.
- `GET /api/workspaces/:workspaceId/sessions` returns workspace-local `{ sessions }` summaries. A session summary includes `workspace`, `cwd`, timestamps, and `eventCount`; when an `agent/selected` event is present it also includes the projected `agent` id, and when a `mode/selected` event is present it includes the mode id. A subagent summary also includes `parentSessionId`, `depth`, and `description` when recorded in its header. `blank` is `true` until the first human message, `title` is the latest accepted `session/title` value when present, and `titleSource` identifies it as `fallback`, `provider`, or `user`. `pinned` is `true` when the latest `session/pinned` event pins the session. Pinned sessions sort first, then by `updatedAt`; title and pin updates do not change `updatedAt` or the activity ordering within either group.
- `POST /api/workspaces/:workspaceId/sessions` accepts either `{ mode, model? }` or the legacy `{ agent?, model? }` form when a configured runtime is available and returns `{ session }`. `mode` cannot be combined with `agent`. With a mode, the server resolves the mode's agent, tools, and skills, uses `model` when supplied or the mode's model binding otherwise, and writes explicit `agent/selected`, v2 `model/selected`, and `mode/selected` events; invalid or unknown modes return `409`. Without a mode, `agent` defaults to `default` and `model` defaults to `{ "version": 2, "kind": "agent" }`. The model binding must be one of:
  ```json
  { "version": 2, "kind": "agent" }
  { "version": 2, "kind": "role", "role": "quick" }
  { "version": 2, "kind": "model", "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "high" }
  ```
  The target agent must allow root usage. Unknown agents, roles, models, unsupported efforts, and invalid bindings return `409`; unknown fields or malformed values return `400`. A new session receives the configured global permission default. Without a configured runtime the body must be empty.
- `GET /api/workspaces/:workspaceId/sessions/:sessionId` returns `{ header, title, titleSource, blank, permission, mode, running, agent, model, resolvedModel, agentSkills, agentError, agentWarnings, plan, todos, messages, events, trajectory, metrics, audit }`. `mode` is the immutable `{ version, mode, agent, model, tools, skills }` snapshot or `null` for a session created without a mode. The snapshot's `model` is the session's initial binding; a later `model/selected` event replaces the binding used by subsequent turns while `mode` keeps its original composition. `running` is `true` while any client owns an active turn for the session. `metrics` is the numeric aggregate described below; `messages` entries carry `messageId` and `timestamp`.
  - `title` is the latest accepted `session/title` value or `null`; `titleSource` is `fallback`, `provider`, or `user`; `blank` is `true` until the first human message. Titles never enter model history or exported transcripts.
  - `permission` is `{ preset }`, where `preset` is one of the three DSH values or `null` for a legacy/invalid/unselected history.
  - `agent` is the projected agent summary (same shape as `GET /api/agents`) or `null`.
  - `model` is the persisted v2 binding or `null` when no valid selection exists.
  - `resolvedModel` is `{ provider, model, name, reasoningEffort?, contextWindow?, maxTokens?, capabilities }` or `null` when resolution fails.
  - `agentSkills` is the skill catalog the current agent may load, as `[{ name, description }]`. It is already filtered by the mode or agent profile (including `[]` when the allowlist is empty) and is the source for the composer `$` menu; without a configured runtime it is `[]`.
  - `agentError` explains a missing or invalid agent/model selection; `agentWarnings` reports unavailable skills and catalog warnings. The session remains readable even when it cannot run.
- `GET /api/workspaces/:workspaceId/sessions/:sessionId/messages` returns `{ messages }`, the same public history projection without reloading the full detail.
- `GET /api/workspaces/:workspaceId/sessions/:sessionId/context` returns the Context Meter estimate. Fields are optional: `{ estimatedMessageTokens?, projection?, modelWindow?, window? }`. `projection` is `{ breakdown: { systemTokens, toolsTokens, messageTokens }, projectedTokens, source: "usage" | "estimate", inputTokens? }`; `window` is `{ tokens, source }` for the compaction budget. During an active turn the live estimate is omitted rather than returning stale data. The route may resolve a live Session or a replay-only Session matching the current preset / model / resolver revision.
- `GET /api/workspaces/:workspaceId/sessions/:sessionId/follow` joins an active turn. It returns `204` when no turn is running; otherwise it starts an SSE stream whose first frame is `{ type: "run.snapshot", baseline: { messages, metrics }, events, truncated? }`, followed by the live events and approvals for that run. `baseline` is captured after permission / runtime validation and before the user message is persisted. Replay is bounded; `truncated: true` means earlier live events were dropped, not that the turn stopped. Disconnecting a follower does not stop the turn.
- `POST /api/workspaces/:workspaceId/sessions/:sessionId/permission` accepts `{ preset }` and persists a `permission/dsh-preset` event. It is idempotent for the current value. Legacy or invalid histories may be repaired only by this explicit selection. Workspace removal or a concurrent session creation can return `409`; a running turn continues with the immutable permission snapshot it captured at admission, and the updated choice applies to subsequent turns.
- `POST /api/workspaces/:workspaceId/sessions/:sessionId/agent` accepts exactly `{ agent }` and persists an `agent/selected` event. The agent must allow root usage. It validates the target against the current binding (or the default agent binding when no valid binding exists) but does not create a model selection. Unknown/subagent-only agents and invalid bindings return `409`; malformed input returns `400`; an active turn, workspace removal, missing runtime availability, or a session with a `mode/selected` snapshot returns `409`. It is idempotent for the current agent.
- `POST /api/workspaces/:workspaceId/sessions/:sessionId/plan` accepts exactly `{ active: boolean }` and persists a `plan/mode` event. It is idempotent. An active turn, workspace removal, or concurrent session creation returns `409`; malformed input returns `400`. Plan mode supplies planning guidance and the `exit_plan_mode` tool, but it does not change the permission preset or enforce read-only file access.
- `POST /api/workspaces/:workspaceId/sessions/:sessionId/plan-review` accepts `{ requestId, approved, feedback? }` and settles the live plan-review request. `feedback` is optional and bounded to 4,000 characters. Stale, duplicate, or wrong-session requests return `409`; malformed input returns `400`.
- `POST /api/workspaces/:workspaceId/sessions/:sessionId/model` accepts a v2 model binding and persists a `model/selected` event. The session must already have a valid agent selection. Unknown catalog members, unknown roles, unsupported reasoning efforts, an active turn, or workspace removal return `409`; malformed or extra fields return `400`. A session with a `mode/selected` snapshot may change its model; the mode's agent, tools, and skills stay fixed. It is idempotent for the current binding.
- `PATCH /api/workspaces/:workspaceId/sessions/:sessionId` accepts exactly `{ title }` and persists a user-sourced `session/title` event, stopping automatic title generation for that session. The title is sanitized, whitespace-normalized, and truncated to the 80-byte title budget; an empty result or a malformed body returns `400`. Renaming does not change `updatedAt`.
- `POST /api/workspaces/:workspaceId/sessions/:sessionId/pin` accepts exactly `{ pinned: boolean }` and persists a `session/pinned` event. It is idempotent. Pin state is UI metadata: it sorts the session into the pinned group but does not change `updatedAt`.
- `POST /api/workspaces/:workspaceId/sessions/:sessionId/fork` creates a new root session in the same workspace and returns `201 { session }`. The fork copies the source transcript and its agent, model, mode, and permission selection events, drops pin and title history, and records a `session/fork` marker with the new creation time. A user-sourced title derived from the source title with a `(fork)` suffix is added when the source has a title. The fork has no `parentSessionId` and starts unpinned; existing child sessions are not copied. Forking returns `409` while any turn or session creation is active or the workspace is being unregistered.
- `DELETE /api/workspaces/:workspaceId/sessions/:sessionId` removes that session's stored transcript and returns `{ deleted: true }`. Other sessions, including its former subagents, are untouched. The route returns `409` while the session's own turn is active or the workspace is being unregistered, and `404` for an unknown session.
- `GET /api/workspaces/:workspaceId/sessions/:sessionId/events` returns `{ events }` with the same allowlisted trace projection. Known trace types include lifecycle, tool, permission, compaction, and error events; unknown types and stored call IDs are omitted. Event details contain only validated metadata, not arguments, output, rules, or error text.
- `GET /api/workspaces/:workspaceId/sessions/:sessionId/audit` returns `{ audit }` for that session, without argument digests or permission rule source text. It can include tool names and call IDs.
- `GET /api/workspaces/:workspaceId/sessions/:sessionId/export?format=markdown|json` downloads a transcript for that session. JSON format is `omniagent-session-transcript`, version 1, not a resumable session log or DSH ZIP/JSONL archive. Both formats exclude system/injected context, tool arguments, permission and audit records, and image bytes, but include conversation text and stored tool output, which may contain secrets or paths. They do not include descendant sessions or attachments. Review exports before sharing.
- `POST /api/workspaces/:workspaceId/sessions/:sessionId/compact` accepts `{}` and schedules manual context compaction for the next turn. It returns `202 { ok: true, scheduled: true }`; the next message then emits a `context.compacted` event and continues from a summarized history. The request is consumed once. A session with an active turn returns `409` and an unknown session returns `404`.
- `POST /api/workspaces/:workspaceId/sessions/:sessionId/interrupt` accepts `{}` and interrupts an active turn. It returns `404` for an unknown session and `409` when a known session has no active turn.
- `POST /api/workspaces/:workspaceId/sessions/:sessionId/approvals` accepts `{ requestId, decision }`, with `decision` equal to `allow` or `deny`, and returns `{ ok: true }` for a current request. `allow` applies once. Stale, duplicate, or wrong-session requests return `409`; invalid input returns `400`.

`metrics` (version 1) is a numeric projection of the persisted log: `runs { started, completed, durationMs, knownDurationCount }`, `steps { started }`, `requests { count, durationMs, knownDurationCount }`, `usage { inputTokens, outputTokens, inputKnownCount, outputKnownCount }`, `throughput { outputTokens, durationMs, count }`, and `cache { inputTokens, cachedInputTokens, count }`. It is not stored separately and can be recomputed at any time. Public assistant messages include `usage.cachedInputTokens` and `requestDurationMs` when available; they do not expose the internal context sample.

Unknown workspaces and sessions return `404`. A session ID in one workspace does not select a session with the same ID in another workspace. Session files saved under a historical non-canonical workspace spelling are not guessed or migrated into a canonical workspace; the caller must continue using the original identity or perform an explicit migration.

`POST /api/workspaces/:workspaceId/sessions/:sessionId/messages` accepts `{ text, attachments?, mode? }`. At least one of `text` and `attachments` must be present. Each attachment is `{ kind: "image" | "file" | "text", name, mimeType? | mediaType?, data?, text? }`: at most 8 attachments, 8 MiB per binary attachment, 24 MiB total, 256 KiB per text attachment; images allow `image/png`, `image/jpeg`, `image/webp`, and `image/gif` and require valid base64 `data`; `file` also uses base64 `data`; `text` uses `text`. Attachments are stored outside the workspace and the persisted user message contains model-facing metadata plus image parts. Without `mode` it starts a new turn and responds with `Content-Type: text/event-stream`; a second concurrent turn for the same session returns `409`. The client may send `Prefer: respond-async` to receive `202 { accepted: true }` after the first event while the run continues server-side; use `.../follow` to observe it. If startup fails before the first event, the host returns `500` with `code: "turn_start_failed_message_may_be_saved"` because the user message may already be persisted. With `mode: "steer"` and an active turn it instead appends a human `message/user` event to that turn's history and returns `202 { accepted, delivery: "queued" }`; the running model sees the message at its next step. With `mode: "steer"` and no active turn it behaves like an ordinary message and starts a new turn. The Web client keeps `queue`-mode messages locally and submits the oldest one as a new turn after the current turn settles, so queued text survives a page reload. Before starting, the host requires a valid `agent/selected` projection and a valid v2 `model/selected` binding; missing or invalid selections, including a v1 model event, return `409` and are not replaced with defaults. The resolver then rebuilds the agent, model client, tools, skills, and system prompt from the current config/agent revision. Each frame is `data: <AgentEvent JSON>\n\n` in runtime order. A request needing human confirmation emits a live `permission.requested` event containing a random request ID, the tool call's ID, name, and arguments, and a sanitized one-call escalation reason showing the target preset and caller justification; it is not persisted as a trace. In plan mode, `exit_plan_mode` emits a live `plan.review.requested` event with a random request ID and the complete Markdown plan; it is not persisted as a trace, and the turn resumes only after `plan-review`. A successful review also emits a live `plan.review.decided` event with the request ID, decision, and optional feedback. A normal or interrupted turn ends with `turn.end`; failures after streaming starts include an `error` and `turn.end` with reason `error`. Cancellation, disconnection, interruption, timeout (normally 120 seconds), and errors deny an outstanding approval or plan review.

The default agent profile may expose these built-in tools: `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `web_fetch`, `skill`, `todo_write`, `exit_plan_mode`, `get_goal`, `create_goal`, `update_goal`, `subagent`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `schedule_create`, `schedule_list`, `schedule_view`, and `schedule_edit`. A Creator-mode (`creator`) session additionally receives `list_agent_definitions` and `write_agent_definition`, which read and write `~/.omniagent/agents/*.md`; ordinary sessions never see them. An `agentProfiles` entry may narrow this set and its skills; a narrower profile never grants DSH permissions. `create_goal` arms automatic continuation rounds; a goal turn's user message carries a `goal` source with the goal id, revision, and round. `update_goal` uses compare-and-set on `(goal_id, revision)` and requires a direct human turn for edit/pause/resume. An active armed goal keeps the same SSE response open across its automatic rounds until it completes, blocks, pauses, or hits the round cap; the browser receives every round's events in order. The `subagent` tool accepts `agent`, `role`, or an explicit provider/model pair. A child is a separate session in the same workspace, records its own `agent/selected` and v2 `model/selected` events, uses the target agent's role by default, and appears through the normal session list and detail endpoints. Its completion notice is persisted on the parent (`subagent/end` and, when the parent is not live in that process, `subagent/notice`). `list_agents` includes the root, the caller, and continuable descendants; `wait_agent` waits for the caller's next-step input and accepts only `timeout_ms` (10,000–3,600,000, default 30,000). A persisted child can only be resumed when both its agent and model selections are valid. Exports remain limited to the requested session and do not include descendant sessions.

Authentication is optional and disabled by default. Host/Origin checks are browser-origin protections, not an authorization boundary for other local processes; even with authentication enabled, processes running as the same OS user may read the plaintext credentials. During any active turn or session creation, new session creation and permission/agent/model/plan changes are rejected with `409`; this prevents a running sandboxed command from changing a later turn's persisted preset, agent, model, or plan guidance, but is not a substitute for authentication. Agent profiles and skill allowlists reduce exposure only; the DSH permission preset and sandbox remain the authorization boundary. The live stream is the runtime event protocol, not a redacted export: assistant and tool events may include conversation text, tool arguments, and tool results. Treat it as private session data. Trace records and the trajectory projection deliberately exclude tool arguments and full tool output. The conversation log itself may contain both, and no claim is made that the log is suitable for sharing without review. Web audit records are written to `~/.omniagent/web-audit/<workspace-hash>.jsonl` and are filtered for the selected session; responses include at most the latest 1,000 entries and read only the last 2 MiB of the file. New audit files are private and may contain argument digests and permission rule text; the API exposes neither. TUI audit files remain in the workspace at `.omniagent/audit.jsonl`; a newly created directory is `0700` and a new file is `0600`, but pre-existing modes are left unchanged. A symlinked or non-regular audit target is rejected rather than followed. Another process running as the same OS user can still read these files. Existing workspace-local audit files are not automatically read or migrated by Web.

## Schedules

Automation tasks are Host-scoped and persisted in `~/.omniagent/schedules.json`; they are not part of any session transcript.

- `GET /api/schedules?active=true|false&limit=&offset=` returns `{ schedules, total, limit, offset }`. The list is ordered active tasks first, then by next occurrence. Each entry includes its timing, prompt, target, `status` (`active`, `paused`, or `ended`), and delivery metadata.
- `POST /api/schedules` accepts `{ title, prompt, timing, target?, actorSessionId? }` and returns `201 { schedule }`. Omitting `target` creates the first target session on the first delivery (`{ "kind": "new_once" }`).
- `GET /api/schedules/limits` returns the delivery-history retention bounds.
- `GET /api/schedules/:scheduleId` returns `{ schedule }`.
- `PATCH` or `PUT /api/schedules/:scheduleId` accepts `{ patch, expectedUpdatedAt?, actorSessionId? }`; `patch` may contain `title`, `prompt`, `timing`, `target`, or `active`. `expectedUpdatedAt` implements compare-and-set and returns `409 schedule_conflict` when the task changed.
- `DELETE /api/schedules/:scheduleId?expectedUpdatedAt=` returns `{ deleted: true }`. Delivery history is removed with the task; target sessions are not deleted.
- `POST /api/schedules/:scheduleId/run` starts a delivery immediately and returns `{ schedule }`. A concurrent execution returns `409 schedule_execution_pending`.
- `GET /api/schedules/:scheduleId/history?limit=&before=` returns one newest-first page of saved deliveries.
- `POST /api/schedules/clear-ended` deletes tasks whose status is `ended` and returns `{ deleted }`.

Each `timing` value is exactly one of:

```json
{ "kind": "after", "after_seconds": 600 }
{ "kind": "at", "at": "2026-11-08T09:00:00Z" }
{ "kind": "at", "at": { "date": "2026-11-08", "time": "09:00:00", "time_zone": "Asia/Shanghai" } }
{ "kind": "every", "every_seconds": 3600 }
{ "kind": "daily", "daily": { "time": "09:00:00", "time_zone": "Asia/Shanghai" } }
{ "kind": "weekly", "weekly": { "time": "09:00:00", "time_zone": "Asia/Shanghai", "weekdays": [1, 3, 5] } }
{ "kind": "cron", "cron": { "expression": "0 9 * * 1-5", "time_zone": "Asia/Shanghai" } }
{ "kind": "rrule", "rrule": "DTSTART;TZID=Asia/Shanghai:20261108T090000\nRRULE:FREQ=DAILY" }
```

Weekdays use ISO numbering (Monday `1` through Sunday `7`). An `rrule` string contains exactly one `DTSTART` line and one `RRULE` line; a one-time delivery is `RRULE:FREQ=DAILY;COUNT=1`. Each `target` is one of `{ "kind": "session", "sessionId": "..." }`, `{ "kind": "new_once", "create"?: { "cwd"?: "...", "agentPreset"?: "..." } }`, or `{ "kind": "new", "create"?: { ... } }`. `session` targets must be root sessions; subagent sessions are rejected with `subagent_session`.

Management reads never activate a session. Delivery reuses a live Session instance in the same Web process when available, or opens the stored session and reconstructs its runtime. A one-time or per-delivery target creates a session with the configured global permission preset and the `default` agent unless `create` overrides them. Scheduled turns are unattended: approval requests are denied and plan review is unavailable. If the service was stopped across multiple occurrences, only the latest missed occurrence is delivered; a crash can cause a delivery to repeat. Errors carry a stable `code`; malformed input returns `400`, unknown tasks return `404 schedule_not_found`, and an update conflict returns `409 schedule_conflict`.
