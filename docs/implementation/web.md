# Web 实现

Web 由一个本地 Node HTTP Host（`packages/web/src`）和一个 React 工作台（`packages/web/ui`）组成。Host 负责工作区、会话、SSE、审批和设置；UI 负责呈现和交互。

实现位置：

| 路径 | 职责 |
| --- | --- |
| `packages/web/src/main.ts` | 进程装配、服务初始化、Session 组装 |
| `packages/web/src/server.ts` | 路由、HTTP 安全、认证、SSE / follow、会话缓存 |
| `packages/web/src/approval.ts` | 审批 / 计划审阅代理 |
| `packages/web/src/attachments.ts` | 附件解析、大小限制与工作区外存储 |
| `packages/web/src/permissions.ts` | 默认权限设置 |
| `packages/web/src/config-file.ts` | 配置文件的原子读-改-写公共层 |
| `packages/web/src/model-settings.ts` | 模型来源与角色编辑 |
| `packages/web/src/catalog-settings.ts` | 角色设置 |
| `packages/web/src/mcp-settings.ts` | MCP 设置 |
| `packages/web/src/agent-settings...`（`server.ts` + core authoring） | 智能体定义编辑 |
| `packages/web/src/workspaces.ts` | 工作区注册表（含默认工作区） |
| `packages/web/src/live-sessions.ts` | 跨请求共享 Session |
| `packages/web/src/schedule-host.ts` | 计划任务投递宿主 |
| `packages/web/src/trajectory.ts` | 轨迹投影 |
| `packages/web/src/trace-projection.ts` | trace 投影 |
| `packages/web/src/session-metrics.ts` | 会话指标投影 |
| `packages/web/src/session-export.ts` | 会话导出 |
| `packages/web/src/audit.ts` | Web 审计 |
| `packages/web/src/workspace-files.ts` | 工作区文件搜索、目录浏览与预览 |
| `packages/web/ui/src` | React 工作台（含认证、Context Meter、工作区文件树） |

## 1. 启动流程

`packages/web/src/main.ts`：

1. `prepareLinuxSandbox()`（Linux 上探测 / 安装 bubblewrap，失败只报告，不阻断启动）；
2. 打开 `ConfigStore`（`~/.omniagent/config.json`），读取 `web.host` / `web.port` / `web.auth`；
3. `PermissionSettings`（与 config 共用文件，独立编辑默认权限）；
4. `RoleSettings`、`ModelSettings`；
5. `McpService` + `McpSettings`；
6. `AgentCatalog`；
7. `ModeStore`（`~/.omniagent/modes.json`）；
8. `AgentAuthoringService`；
9. `RuntimeResolver`；
10. `SessionStore`；
11. `WorkspaceRegistry`；
12. `ApprovalBroker`；
13. `FakeModel` 兜底（没有 provider 时）；
14. `SubagentManager`；
15. `LiveSessionRegistry`；
16. `ScheduleService` + `SessionScheduleHost`；
17. `ensureDefault(~/.omniagent/default-workspace)`，再注册当前工作目录（canonical path 相同时复用记录）；
18. `startWebHost(...)`，使用配置的 host / port / auth；`OMNIAGENT_PORT` 覆盖端口。

`composeSession()` 是唯一的 Session 组装点：

- 前台：`approve = approvals.handler(...)`，`reviewPlan = approvals.planHandler(...)`；
- 非交互（计划任务）：`approve` 一律 deny，`reviewPlan` 返回 `{ approved: false }`；
- `creator` agent 额外注入 `agentAuthoring`。

退出时依次关闭 schedules、mcp、subagents、host。

## 2. 路由地图

完整请求 / 响应格式见 [web-api.md](../web-api.md)。这里是按功能分组的路由图。

### 2.1 基础设施

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/health` | `{ ok: true }` |
| `GET/HEAD` | 非 `/api/*` | 静态资源与 SPA fallback |
| `GET` | `/api/auth/status` | 认证是否启用、当前 cookie 是否已登录 |
| `POST` | `/api/auth/login` | 校验账号密码，设置 12 小时 HttpOnly cookie |
| `POST` | `/api/auth/logout` | 撤销当前登录 cookie |

### 2.2 目录

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/models` | 模型目录 |
| `GET` | `/api/agents` | 智能体目录（不含正文） |
| `GET` | `/api/roles` | 角色目录 |
| `GET` | `/api/modes` | 模式列表 |
| `GET` | `/api/modes/options` | 模式编辑器的工具 / skill 选项 |
| `GET` | `/api/sessions/recent` | 跨工作区 root 会话搜索 |

### 2.3 设置

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET/PUT` | `/api/settings/permissions` | 全局默认 DSH 预设 |
| `GET/PUT` | `/api/settings/default-mode` | 默认模式 |
| `PUT/DELETE` | `/api/modes/:id` | 保存 / 删除模式 |
| `GET` | `/api/settings/model-sources` | 模型来源 |
| `PUT/DELETE` | `/api/settings/model-sources/:id` | 保存 / 删除来源 |
| `POST` | `/api/settings/model-sources/discover` | 拉取模型列表 |
| `GET` | `/api/settings/roles` | 可编辑角色 |
| `PUT/DELETE` | `/api/settings/roles/:id` | 保存 / 删除角色 |
| `GET` | `/api/settings/mcp-servers` | MCP 服务器 + 运行时状态 |
| `PUT/DELETE` | `/api/settings/mcp-servers/:id` | 保存 / 删除 |
| `POST` | `/api/settings/mcp-servers/test` | 连接探测 |
| `GET` | `/api/settings/agents` | 智能体编辑器列表 |
| `GET/PUT/DELETE` | `/api/settings/agents/:id` | 读取 / 写入 / 删除定义 |

### 2.4 工作区与会话

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET/POST` | `/api/workspaces` | 列出 / 注册工作区 |
| `DELETE` | `/api/workspaces/:id` | 取消注册 |
| `GET` | `/api/workspaces/:id/files` | 工作区文件搜索（`@` 菜单） |
| `GET` | `/api/workspaces/:id/files/tree?path=` | 目录浏览（文件树） |
| `GET` | `/api/workspaces/:id/files/content?path=` | 文本文件预览 |
| `GET/HEAD` | `/api/workspaces/:id/files/raw?path=&download=1` | 原始字节（Range、类型白名单、inline / attachment） |
| `POST` | `/api/workspaces/:id/files/rename` | 重命名（`{ path, name }`） |
| `POST` | `/api/workspaces/:id/files/move` | 移动到文件夹（`{ path, directory }`） |
| `DELETE` | `/api/workspaces/:id/files?path=` | 删除文件或文件夹 |
| `GET/POST` | `/api/workspaces/:id/sessions` | 列出 / 创建会话 |
| `GET/PATCH/DELETE` | `/api/workspaces/:id/sessions/:sid` | 详情 / 改名 / 删除 |
| `POST` | `.../pin` | pin / unpin |
| `POST` | `.../fork` | fork |
| `GET` | `.../messages` | 重新读取公开消息 |
| `POST` | `.../messages` | 发送消息（SSE / steer / respond-async） |
| `POST` | `.../permission` | 切换预设 |
| `POST` | `.../agent` | 切换智能体 |
| `POST` | `.../model` | 切换模型 |
| `POST` | `.../plan` | 切换 plan 模式 |
| `POST` | `.../plan-review` | 审批计划 |
| `POST` | `.../approvals` | 审批工具调用 |
| `POST` | `.../compact` | 安排手动压缩 |
| `POST` | `.../interrupt` | 中断当前回合 |
| `GET` | `.../context` | Context Meter 估算 |
| `GET` | `.../follow` | 以 `run.snapshot` 加入正在运行的回合 |
| `GET` | `.../events` | trace 投影 |
| `GET` | `.../audit` | 审计投影 |
| `GET` | `.../export` | Markdown / JSON 导出 |

### 2.5 计划任务

| 方法 | 路径 |
| --- | --- |
| `GET/POST` | `/api/schedules` |
| `GET` | `/api/schedules/limits` |
| `GET/PATCH/PUT/DELETE` | `/api/schedules/:id` |
| `POST` | `/api/schedules/:id/run` |
| `GET` | `/api/schedules/:id/history` |
| `POST` | `/api/schedules/clear-ended` |

## 3. HTTP 安全与限制

### 3.1 监听、Host 与认证

- 默认监听 `127.0.0.1:4317`；`web.host` / `web.port` 可配置，`OMNIAGENT_PORT` 覆盖端口；
- `Host` 必须解析为实际监听端口，并且 hostname 等于配置的监听地址；loopback 配置允许 `127.0.0.1` / `localhost` / `[::1]` 互换；通配监听只接受实际本地地址；
- 如果存在 `Origin`，必须与规范化后的 Host 同源；`localhost` 和 `127.0.0.1` 不互换；
- `sec-fetch-site: cross-site` 一律拒绝；
- Host / Origin 检查是浏览器侧保护，不是本地用户认证。

认证：

- 默认关闭；`web.auth.enabled` 为 true 时必须提供非空 `username` / `password`，否则启动失败；
- 登录使用 `POST /api/auth/login`，账号密码用 SHA-256 + `timingSafeEqual` 比较；同一客户端 60 秒内最多 5 次失败，超限返回 `429` 和 `retry-after`；
- 成功登录设置 `omniagent_session` cookie：`HttpOnly`、`SameSite=Strict`、12 小时过期；令牌是 32 字节随机 hex；
- 认证开启后，所有 `/api/*` 业务路由（包括 SSE / follow）都要求有效 cookie，只有 `status` / `login` / `logout` 例外；
- 认证开启时，非 GET / HEAD / OPTIONS 请求必须带 `Origin`；
- 登录状态会按会话记录并主动销毁该会话的所有活动响应；服务端最多保存 10,000 个登录会话；
- 账号密码明文保存在 `config.json`，HTTP 不加密传输；认证不能隔离同 OS 用户的其他进程。

### 3.2 请求体

- JSON 请求必须 `Content-Type: application/json`，否则 415；
- 普通 JSON 最大 64 KiB；
- 消息体最大 32 MiB；
- 附件最多 8 个；
- 图片 MIME 只允许 png / jpeg / webp / gif，单张 base64 数据最大 8 MiB；
- 文本附件最大 256 KiB；
- 附件总大小最大 24 MiB；
- 超限返回 413，并排空请求体。

`parseSendAttachments()` 只接受 `kind: 'image' | 'file' | 'text'`，校验名称、MIME 和 base64 往返一致性。附件随后由 `storeAttachments()` 写入工作区外的私有批次目录（见 [persistence-and-observation.md](../design/persistence-and-observation.md) 的「附件存储」）。文本 / 文件附件生成一条带 `attachment` 元数据的文本 part，图片再附加 image part；元数据明确标记为不可信输入。用户消息持久化失败时批次会被清理。

### 3.3 响应头

统一设置：

- `cache-control: no-store`（API）；
- `x-content-type-options: nosniff`；
- `x-frame-options: DENY`；
- `referrer-policy: no-referrer`；
- `permissions-policy`；
- HTML 文档附加 CSP：`default-src 'none'`、`script-src 'self'`、`style-src 'self' 'unsafe-inline'`、`img-src 'self' data: blob:`、`connect-src 'self'`、`frame-ancestors 'none'`。

### 3.4 错误与脱敏

- 500 一律返回 `{ error: 'Internal server error' }`；
- SSE 内的错误只返回固定文案；
- 未知 workspace / session 返回 404；
- 非法 URL 编码返回 400；
- 路径静态文件服务拒绝 `\0`、`..`、绝对路径，并校验 resolve 后仍在 root 下。

### 3.5 并发保护

server 维护：

- `running`：正在执行的 turn；
- `creating`：正在创建会话；
- `removing`：正在删除工作区；
- `permissionDefaultUpdates`：正在更新默认权限；
- `compactRequests`：待执行的手动压缩。

以下操作在任意 turn 运行时返回 409：

- 修改默认权限、agent、model、plan；
- fork；
- 删除工作区。

新建会话不受运行中 turn 的限制：新会话只快照当前全局默认权限，而该默认值在 turn 运行期间不可变，不同会话的回合可以并行执行。只有默认权限更新进行中时，新建会话才返回 409，避免快照到未完成的默认值。

上述限制是为了防止运行中的沙盒命令通过 Web 控制面改变后续回合的授权。它是竞态保护，不替代认证；即使启用了 Web 认证，这些 409 仍然生效。

## 4. SSE 回合流

`POST /api/workspaces/:id/sessions/:sid/messages`：

1. 解析 `text` + `attachments`；空消息 400。
2. `mode: 'steer'` 且会话运行中：
   - 等待 `active.ready`（最多 10 秒）；
   - `session.deliverUserMessage(content)`；
   - 返回 `202 { accepted, delivery: 'queued' }`。
3. 非 steer 且已有运行回合 → 409。
4. 创建 `RunningTurn { cancelled, ready }`，放入 `running`。
5. 客户端断开：
   - 当前 turn 已绑定 Session → `interrupt()`；
   - 否则删除 running；
   - 关闭 approval。
6. 在权限锁内：
   - 打开会话；
   - 校验 `permission` 为 ready；
   - 校验 agent / model 选择；
   - `runtime.resolve()`；
   - `getSession()` 取 / 建运行时；
   - 消费 compact 请求；
   - 标记 ready；
   - 启动 approval turn。
7. 写 SSE 头：
   - `text/event-stream; charset=utf-8`
   - `cache-control: no-cache, no-transform`
   - `nosniff`
   - `keep-alive`
8. `source = session.send(content)`；如果有 approval turn，用 `approval.stream(source)` 交错事件。
9. 每个事件经 `publicAgentEvent()`：
   - `error` → 固定文案；
   - `assistant.message` → `safePublicMessages`；
   - `turn.end.history`（如果有）→ schema 校验 + 脱敏；
   - 其他原样。
10. 帧格式：`data: <json>\n\n`；写阻塞时等待 drain。
11. 异常：
    - headers 已发送 → 写 `error` + `turn.end(error)`；
    - finally 中关闭 approval、删除 running、结束响应。

### 4.1 同步、异步与 follow

默认 `POST .../messages` 返回 SSE，连接断开时：

- 当前 turn 已绑定 Session → `interrupt()`；
- 尚未绑定 → 删除 running；
- 关闭 approval。

客户端可以发送 `Prefer: respond-async`：

- 服务端照常建立 `RunningTurn`，但在第一个模型事件到达后返回 `202 { accepted: true }`，而不是保持 SSE；
- 如果启动在第一个事件前失败，返回 `500 { error, code: 'turn_start_failed_message_may_be_saved' }`，提示消息可能已经持久化；
- 异步回合由服务端继续执行，客户端断开不影响它。

`GET .../follow` 用于加入正在运行的回合：

- 没有活动回合 → `204`；
- 等待 baseline 就绪后返回 SSE，第一帧是 `run.snapshot`：`{ baseline: { messages, metrics }, events, truncated? }`；
- baseline 在权限 / 运行时校验之后、写入用户消息之前捕获，因此 follower 可以从同一基线重放；
- snapshot 里的 `events` 是已经发生的 live 事件（过滤掉 live-only 的审批请求，再补上当前未决的审批 / 计划请求）；超过 replay 上限时 `truncated: true`，回合继续；
- 之后 follower 收到与主 SSE 相同的实时事件；所有 follower 在 `turn.end` 后关闭；
- 多个标签页可以同时 follow 同一个回合，steering 消息也会广播为 `run.user.message`。

### 4.2 事件交错

`ApprovalBroker` 的 `stream()` 用 `Promise.race(source.next(), wake)`：

- 优先发送待处理的 `permission.requested`；
- 再发送 `plan.review.requested`；
- 再发送 `plan.review.decided`；
- 否则转发模型事件。

因此浏览器看到的事件顺序可能是：

```text
tool.call
permission.requested
permission.decided
tool.result
```

审批提示不会进入会话 trace。

## 5. 审批与计划审阅

`packages/web/src/approval.ts`：

- 每个 `(workspace, sessionId)` 一个 `ApprovalTurn`；
- `start()` 重复启动抛错；
- 没有活动 turn 时：
  - `approve` → deny；
  - `reviewPlan` → `{ approved: false }`；
- `request()`：
  - 克隆参数，保证可序列化；
  - `approvalReason()` 只识别 DSH 升级原因，其他 reason 折叠为固定文案；
  - 剥离控制字符，截断 500 字符；
  - 默认超时 120 秒；
  - abort 即 deny；
- `requestPlanReview()`：
  - plan 非空且 ≤200,000 字符；
  - 同样 120 秒超时；
  - 取消返回 `{ approved: false, feedback: 'Plan review was cancelled.' }`；
- `respond()` / `respondPlan()`：
  - requestId 必须匹配；
  - plan feedback 截断 4,000 字符；
  - 生成 `plan.review.decided` 事件；
- `close()` / 客户端断开：
  - 所有未决请求 settle 为 deny / 拒绝。

## 6. 会话运行时缓存

`getSession()` 的缓存维度：

```text
(workspace, sessionId)
  + permission preset
  + JSON.stringify(modelBinding)
  + resolver.revision
```

流程：

1. 先查 `LiveSessionRegistry`；
2. 再查本地 `sessions` Map；
3. 未命中 → `createSession` / `createRuntimeSession`；
4. 写入 live 和本地；
5. 超过 64 个时按插入序淘汰，跳过当前 key 和 running 中的 key。

失效点：

- 切换权限；
- 切换 agent；
- 切换 model；
- 切换 plan；
- 删除会话。

`LiveSessionRegistry` 默认上限 128，用于让计划任务和 Web 标签页共享同一个 Session，避免两个实例写同一日志。运行中的 `RunningTurn` 独立于 Session 缓存：它保存 baseline、事件 replay buffer 和 follower 集合，在 POST 连接断开后仍继续执行，直到回合结束或显式 interrupt。

## 7. 设置服务

### 7.1 ConfigFile

`config-file.ts` 是所有配置写入的公共层：

- `ConfigFile.open({ trustedHome })` 要求配置在 home 内；
- `assertNoSymlinkParents()` 禁止父目录 symlink（例外 `/tmp`、`/var`）；
- 读取 `O_NOFOLLOW | O_NONBLOCK`，必须是普通文件；
- 写入同目录临时文件 + `O_EXCL | O_NOFOLLOW` + fsync + rename；
- `withFileLock()` 按路径串行化读-改-写。

### 7.2 PermissionSettings

- 独立于 ConfigFile，有自己的 revision；
- 读取 `dsh.permission.defaultPreset`；
- 空 / 非法 → `{ defaultPreset: null, requiresSelection: true }`；
- 写入前比较 `lastText`，检测外部修改并拒绝覆盖；
- 原子替换。

### 7.3 ModelSettings

- 把 `config.providers` 投影为模型来源；
- legacy 顶层 `provider` 第一次保存时迁移到 `providers.openai`；
- API key 只写不回传，只返回 `apiKeyConfigured`；
- 删除来源时检查：
  - 是否为当前默认来源；
  - 是否为内置来源；
  - 是否仍被有效角色引用；
- 模型列表可以从 OpenAI 兼容 `/models` 或 Anthropic `/v1/models` 拉取；
- 拉取失败不修改配置。

### 7.4 RoleSettings

- 编辑 `config.roles`；
- 同时列出 `catalog.roleErrors`，方便修复；
- 写入走 ConfigFile 的串行化锁；
- 不提供 `lastText` 外部修改检测，最后写入者获胜。

### 7.5 McpSettings

- 服务器 CRUD；
- 空 secret 表示保留已存值；
- `clearEnv` / `clearHeaders` 删除键；
- 切换 transport 清空另一种 shape 的字段；
- 保存后触发 `mcp.sync()`；
- 测试连接返回 tools / resources / prompts。

### 7.6 智能体定义

- 通过 core 的 `AgentAuthoringService`；
- 内置 `default` / `creator` 只读；
- 写入使用 `0600`，拒绝 symlink；
- 正文只由单 agent 设置端点返回，不出现在 `GET /api/agents`。

## 8. 投影与导出

- `projectMessages()` + `safePublicMessages()`：会话详情和 SSE 的 assistant 消息；
- `projectPublicHistory()`：在消息上追加稳定的 `messageId`（身份 + 事件哈希）和 `timestamp`，供复制和显示时间；
- `projectTraceEvents()`：只保留元数据；
- `projectTrajectory()`：轨迹图数据；
- `projectSessionMetrics()`：runs / steps / requests / usage / cache / throughput 聚合；
- `exportSession()`：Markdown / JSON；
- `recordWorkspaceAudit()` / `readWorkspaceAudit()`：Web 审计；
- `searchWorkspaceFiles()`：`@` 菜单文件搜索，最多 50,000 条，跳过 `.git` / `node_modules` / `dist` 等；
- `browseWorkspaceDirectory()` / `readWorkspaceFile()`：工作区文件树和预览，逐段拒绝 symlink、校验物理路径，单文件预览上限 1 MiB，拒绝 binary / 非 UTF-8。

## 9. Web UI 架构

### 9.1 组件树

```text
AuthGate
├─ 登录 / 检查 / 重试界面（认证启用时）
└─ App
   ├─ Sidebar（或 WorkspaceFileTree 文件浏览）
   │   ├─ WorkspaceDialog
   │   ├─ RemoveWorkspaceDialog
   │   ├─ RenameSessionDialog
   │   ├─ DeleteSessionDialog
   │   └─ Toast
   ├─ Header
   │   ├─ 导出 / 退出登录菜单
   │   └─ 面板切换
   ├─ main
   │   ├─ AutomationPage
   │   ├─ SettingsPage
   │   │   ├─ SettingsGeneral
   │   │   ├─ SettingsModels
   │   │   ├─ SettingsMcp
   │   │   ├─ SettingsModes
   │   │   └─ SettingsAgents
   │   ├─ ConversationView
   │   │   ├─ TurnView → ToolView / ReasoningView / MarkdownText / CompactionView / NoticeView
   │   │   ├─ PlanReviewCard（等待审阅时作为 AI 回复卡片，点击在右栏打开计划）
   │   │   ├─ ApprovalView
   │   │   └─ Composer → PlanReviewComposer（等待计划审阅时替换输入区）
   │   │       ├─ ContextMeter（5 秒轮询 .../context）
   │   │       └─ SessionStats（runs / steps / tok/s / usage / cache）
   │   └─ TrajectoryView
   ├─ RightPanel（guide / plan / files / preview / terminal）
   └─ NewSessionDialog
```

认证启用时 `AuthGate` 先检查 `/api/auth/status`；登录成功后才渲染 `App`。`authFetch()` 统一携带 cookie，遇到 401 会把状态切回登录界面并清空当前 store。工作区行菜单的「查看文件列表」把左栏切成 `WorkspaceFileTree`，选中文件后在右栏预览；右栏 tab 显示「文件预览｜<文件名>」，预览由 `WorkspaceFilePreview`（薄壳）委托给 `preview/PreviewSurface`，后者按扩展名分派到具体 viewer。

等待计划审阅时不再弹出遮挡式对话框：会话末尾显示计划卡片，点击卡片或输入区里的「查看计划」把完整计划以 Markdown 形式放到右栏 `plan` 视图；输入区同时切换为计划审阅模式，可直接批准，或输入反馈后继续规划。右栏保留最后一次审阅的计划，审阅结束后仍可查看。

响应式：

- `max-width: 900px` 切换移动布局；
- `viewportWidth >= 1000` 才显示右侧栏；
- 右栏宽度在 300 和 45% 视口之间，且至少给主区留 680px。

### 9.2 状态仓库

`packages/web/ui/src/lib/store.ts`：

- 单一 `AppStore` + `AppState`；
- 每个会话一个 `SessionEntry`，含 `metrics`、`running`、queue 和 live `run`；
- 工作区按 `sessionsByWorkspace` 分开保存会话列表，侧栏可以展开多个工作区；
- `useSyncExternalStore(store.subscribe, store.getSnapshot)`；
- `emit()` 用 `requestAnimationFrame` + 32ms 超时批量通知；
- 请求用自增序号防止竞态；
- 同一会话的发送 / 队列 / steer 用 `navigator.locks` 串行化；
- 持久化键：
  - `omniagent.theme`
  - `omniagent.locale`
  - `omniagent.processDisplay`
  - `omniagent.defaultAgent`
  - `omniagent.defaultBinding`
  - `omniagent.activeWorkspace`
  - `omniagent.activeSessions`
  - `omniagent.busySend`
  - `omniagent.queue:<ws>:<sid>`

关键行为：

- `bootstrap()`：加载工作区、会话、catalog、权限；
- `loadDetail()`：一次 patch 全部字段（含 metrics），重建 transcript / turns；
- `startDraftSession()`：UI-only draft，不落库；
- `persistDraftSession()`：第一条消息时创建真实会话，再补权限 / plan；
- `startTurn()`：乐观把用户消息插入 transcript，发送 `Prefer: respond-async`，然后进入 follow 或直接消费 SSE；失败时回滚；
- `followRun()`：消费 `run.snapshot` 的 baseline（消息 + metrics）和后续事件；断线后重连会重新 follow；
- `consumeStream()`：逐事件 `applyAgentEvent`，同时用 `applyMetricsEvent` 增量维护 metrics；
- `stopTurn()`：先置 stopping，再 `POST interrupt`；
- `resolveApproval()` / `resolvePlanReview()`：HTTP 回填；
- `compactSession()`、`queueMessage()`、`steerMessage()`、`renameSession()`、`setSessionPinned()`、`forkSession()`、`deleteSession()`、`exportSession()`。

### 9.3 事件 reducer

`lib/events.ts` 的 `applyAgentEvent(turn, event, now)`：

- `turn.start`：建 / 推进 TurnMeta；
- `assistant.reasoning.delta`：懒建 ReasoningItem 并累加；
- `assistant.delta`：懒建 AssistantItem；
- `assistant.message`：替换流式文本，补 tool calls，结束 reasoning；
- `tool.call`：去重 / 合并 ToolItem；
- `permission.requested`：写入 `turn.approval`；
- `permission.decided`：标记 denied，清除 approval；
- `plan.review.requested/decided`；
- `tool.result`：补 ToolItem result；
- `context.compacted`：追加 CompactionItem；
- `error`：写 error + Notice，清 approval / planReview；
- `turn.end`：填结束时间、reason、outcome，清流式状态。

`hydrateTranscript()` 从 `PublicMessage[]` 重建 transcript / turns；`groupTurns()` 把扁平消息折叠成显示 turn：

- 每个 turn 最后一个非空 assistant 且其后无 tool 的文本作为 `final`；
- 其余进入 `process`；
- notice 进入 `extras`；
- 最后一个 running turn 标记为 live。

### 9.4 SSE 解析

`createSSEParser()`：

- 处理 `\r\n`、`\n`、`\r`；
- 忽略 `:` 注释；
- 多行 `data:` 拼接；
- 保留末尾半帧；
- 测试复用。

### 9.5 Composer 触发器

`lib/composer-trigger.ts`：

- `@` → 文件 / 目录；
- `#` → 近期会话；
- `/` → 内置命令；
- `$` → 当前 agent 可调用的 skill。

细节：

- token 必须在词边界，避免 `a@b`、`C#`、`US$` 误触发；
- 支持带引号路径 `@"my folder/file.ts"`；
- 排除 `//`、`${`、`##`；
- 目录引用保留尾部 `/`，支持逐级浏览；
- `rankLike()` 按 exact → prefix → word prefix → substring → 子序列打分，字段越靠前权重越高。

命令表：

`plan`、`init`、`goal`、`compact`。会话控制类指令（新建会话、权限、智能体、模型、设置、导出、清空、帮助）在 Web 端都有对应按钮，不再进入指令菜单。

plan 模式没有常驻开关：只有输入 `/plan` 开启后，输入框才出现计划标签，鼠标悬浮时标签图标切换为关闭叉，点击即退出计划模式。

二级选择器：

`file`、`session`、`skill`。

- 输入框内的权限下拉选择 `danger-full-access` 前仍弹出风险确认；
- 智能体下拉过滤 `usage !== 'subagent'`；模型下拉只列具体模型 + 默认 effort；
- 忙碌发送模式：`queue` 或 `steer`。

附件：

- 最多 8 个；
- 图片 8 MB，文本 256 KB；
- 图片 base64 预览；
- 文本 `file.text()`；
- 支持直接粘贴剪贴板中的截图和文件，无文件名时按 MIME 生成名称。

### 9.6 设置页

| 页面 | 内容 |
| --- | --- |
| General | 默认权限（danger 需二次确认）、主题、语言、过程显示模式、About |
| Models | 模型来源、角色、协议、Base URL、API Key、模型目录、思考等级、发现模型 |
| MCP | 服务器 CRUD、transport、env / headers、测试连接 |
| Modes | 模式 CRUD、agent、模型绑定、tools / skills、设为默认、进入创造模式 |
| Agents | 内置 / 自定义 agent 列表、编辑、删除、创造模式入口 |

### 9.7 i18n 与样式

- `Locale = 'zh' | 'en'`，默认中文；
- 英文源串即 key，中文表约 780 条；
- `translate()` / `interpolate()` / `translator(locale)`；
- 工具块标签集中在 `lib/labels.ts`；
- 组件样式全部 CSS Modules；
- Vite 配置 `localsConvention: 'camelCaseOnly'`；
- 主题通过 `body[data-ds-dark-theme]` 和 `html[data-theme]` 双属性切换；
- Markdown 使用 vendor 的 `MarkdownText`：流式时只重解析尾部 2 个不稳定块，其余缓存；shiki 高亮按需加载；支持 KaTeX 和代码复制。

### 9.8 文件预览

`WorkspaceFilePreview` 已退化成薄壳，实际实现在 `ui/src/components/preview/`：

| 文件 | 职责 |
| --- | --- |
| `path.ts` | 纯函数：扩展名 → `PreviewKind`、`sourceForPath()`（text / bytes / url / none）、`formatBytes()`、`resolveRelativePath()`。分派顺序在这里固定，`svg` 先于 code、`csv` 先于 code、`ipynb` 归 JSON |
| `resource.ts` | `usePreviewResource()`：文本走 `files/content`，二进制走 `files/raw`，图片/音视频/PDF 直接用 `files/raw` URL；`AbortController` 取消 + 8 项 / 32 MiB LRU |
| `registry.ts` | kind → viewer 的一张表；禁用某类型只需删一行，未知 kind 落到 `UnsupportedViewer` |
| `PreviewChrome.tsx` | 预览内没有标题栏：dock 的 tab 已经写着「文件预览｜文件名」，工作区由会话决定。这里只提供 viewer 工具条、骨架 / 失败 / 不支持三种状态 |
| `PreviewSurface.tsx` | 判定 → 取字节 → 组装外壳与 viewer |
| `viewers/*` | 每种类型一个组件 |
| `office/*` | 零依赖 OOXML 解析：`zip.ts`（中央目录 + `DecompressionStream('deflate-raw')`）、`docx.ts`（段落/标题/列表/表格）、`xlsx.ts`（sharedStrings + sheetData + A1 定位）、`csv.ts`（RFC 4180 引号、分隔符探测） |
| `html/sanitize.ts` | HTML 白名单净化：丢 script/style/iframe/form/object，剥事件属性与危险 URL |

类型与渲染方式：

| 类型 | 数据来源 | 渲染 |
| --- | --- | --- |
| `md` | content | vendor `MarkdownText`（与转录同一渲染器），标题打 id 生成目录，相对图片与 `path:line` 链接接上预览 |
| 代码 / 文本 | content | shiki 懒加载高亮 + 行号 + soft wrap；超过 3,000 行关闭高亮 |
| `json` | content | vendor `JsonTree`，解析失败退回原文 |
| `png/jpg/...`、`svg` | raw URL | `<img>` + `ImageLightbox`，fit / 1:1 |
| `mp4/...`、`mp3/...` | raw URL | 原生 `<video>` / `<audio>`，靠 Range 拖动 |
| `pdf` | raw URL | 同源 `<iframe>`，交给浏览器自带 PDF 阅读器；需要 CSP `frame-src 'self'` |
| `docx` | raw bytes | `office/docx.ts` 解析成块模型，用应用排版渲染 |
| `csv/tsv`、`xlsx` | content / raw bytes | 同一个表格组件，吸顶表头 + 行号 + 工作表标签 |
| `html` | content | 默认源码；「渲染」走 `html/sanitize.ts` 的净化视图 |
| 其它 | 无 | 下载卡片 + 新窗口打开 |

文件树与右栏文件列表都支持右键菜单：重命名、移动到文件夹、复制相对路径、复制绝对路径、删除。菜单与三个确认对话框在 `components/FileTreeMenu.tsx`，请求封装在 `lib/file-ops.ts`；操作完成后由 `App` 递增 `refreshToken` 让所有已展开目录重新拉取，并按 `from → to` 跟随正在预览的文件（删除则关闭预览）。服务端拒绝 `.git` 与 `.omniagent` 段，避免误删仓库元数据或宿主状态。

刻意不做的事：

- **不引第三方预览库**：PDF 交给浏览器，Office 用平台 `DecompressionStream` 自行解包。代价是 Word 只保留结构、不还原版式（页边距、浮动图形、主题），收益是主包不增加、没有供应链面。
- **不用 sandbox iframe 渲染 HTML**：`srcdoc` 与 `blob:` 文档都继承本文档 CSP，在 `default-src 'none'` 下渲染不出任何样式，除非整体放宽策略；净化后内联渲染既保留主题，也保持惰性。
- **不内联 SVG**：一律走 `<img>`，避免文件里的脚本进入文档上下文。

## 10. 如何扩展

### 加一个 API 路由

1. 在 `server.ts` 的路由分支中加处理；
2. 用 `readJson()` / `json()` 统一解析和响应；
3. 如果修改配置，走对应 Settings 服务，不要直接写文件；
4. 如果涉及运行中会话，考虑 `running` / `withPermissionLock` / 409；
5. 更新 [web-api.md](../web-api.md)。

### 加一个设置页

1. 在 `SettingsPage.tsx` 的 rail 加 tab；
2. 新建 `Settings<X>.tsx`；
3. 在 `store.ts` 加加载 / 保存 action；
4. 样式放 `styles/settings.module.css`；
5. 文案加到 `i18n.ts`。

### 加一个 Composer 触发器

1. 改 `composer-trigger.ts` 的 `detectTrigger()`；
2. 在 `Composer.tsx` 加菜单和选择器；
3. 加 `composer-trigger.test.ts` 覆盖边界。

### 加一个会话事件展示

1. 在 `events.ts` 的 `applyAgentEvent()` 处理类型；
2. 在 `events.ts` 的 `LiveTurnState` 加字段；
3. 在 `ConversationView.tsx` / `TurnView` 渲染；
4. 加 `ui-protocol.test.ts` / `ui-store.test.ts`。

## 11. 已知偏差与限制

- `packages/web/src` 没有独立的 `ui-store.ts`；`ui-store.test.ts` 直接测试 `packages/web/ui/src/lib/store.ts`。
- Web 认证默认关闭；启用后也只保护 HTTP 访问，不能隔离同 OS 用户的其他进程。`409` 是防运行中权限竞态，认证开启后仍然生效。
- 认证账号密码明文保存在 `config.json`，HTTP 不提供传输加密。
- 子代理的完成通知不会进入父回合的原始 SSE；需要重新加载父会话。
- Web 子代理没有 live approval handler；一次性沙盒升级会被拒绝，plan review 不可用。
- `RoleSettings` / `ModelSettings` 走 `ConfigFile` 的进程内锁，但没有 `PermissionSettings` 那样的 `lastText` 外部修改检测；多进程同时编辑时最后写入者获胜。
- 模式保存不接受 MCP 工具名（见 [configuration-agents-modes.md](../design/configuration-agents-modes.md) 的实现备注）。
- 文本预览仍限制在 1 MiB UTF-8（`files/content`）；二进制、图片、PDF、Office、音视频走 `files/raw`，单文件上限 256 MiB。PDF 由浏览器渲染，样式随浏览器而定；Word 只还原结构与表格，不还原版式；Excel 只读单元格原值，不做数字格式与公式计算；HTML 渲染视图是白名单净化后的近似效果。
- Context Meter 的 `projectedTokens` 是基于字节数 / 4 和图片固定成本的近似值；切换模型或历史后可能先显示估算，直到出现新的真实 usage。
- 实时 SSE、`follow` 的 `run.snapshot` 和原始会话记录不是脱敏导出格式；assistant 文本、工具参数和结果都可能含敏感内容。
- `run.snapshot` 的 replay 有上限；溢出时 `truncated: true`，UI 会提示实时历史不完整，并在回合结束后通过会话详情对账。
