# Web 实现

Web 由一个本地 Node HTTP Host（`packages/web/src`）和一个 React 工作台（`packages/web/ui`）组成。Host 负责工作区、会话、SSE、审批和设置；UI 负责呈现和交互。

实现位置：

| 路径 | 职责 |
| --- | --- |
| `packages/web/src/main.ts` | 进程装配、服务初始化、Session 组装 |
| `packages/web/src/server.ts` | 路由、HTTP 安全、SSE、会话缓存 |
| `packages/web/src/approval.ts` | 审批 / 计划审阅代理 |
| `packages/web/src/permissions.ts` | 默认权限设置 |
| `packages/web/src/model-settings.ts` | 模型来源与角色编辑 |
| `packages/web/src/catalog-settings.ts` | 角色设置 |
| `packages/web/src/mcp-settings.ts` | MCP 设置 |
| `packages/web/src/agent-settings...`（`server.ts` + core authoring） | 智能体定义编辑 |
| `packages/web/src/workspaces.ts` | 工作区注册表 |
| `packages/web/src/live-sessions.ts` | 跨请求共享 Session |
| `packages/web/src/schedule-host.ts` | 计划任务投递宿主 |
| `packages/web/src/trajectory.ts` | 轨迹投影 |
| `packages/web/src/trace-projection.ts` | trace 投影 |
| `packages/web/src/session-export.ts` | 会话导出 |
| `packages/web/src/audit.ts` | Web 审计 |
| `packages/web/src/workspace-files.ts` | 工作区文件搜索 |
| `packages/web/ui/src` | React 工作台 |

## 1. 启动流程

`packages/web/src/main.ts`：

1. 打开 `ConfigStore`（`~/.omniagent/config.json`）；
2. `PermissionSettings`（与 config 共用文件，独立编辑默认权限）；
3. `RoleSettings`、`ModelSettings`；
4. `McpService` + `McpSettings`；
5. `AgentCatalog`；
6. `ModeStore`（`~/.omniagent/modes.json`）；
7. `AgentAuthoringService`；
8. `RuntimeResolver`；
9. `SessionStore`；
10. `WorkspaceRegistry`；
11. `ApprovalBroker`；
12. `FakeModel` 兜底（没有 provider 时）；
13. `SubagentManager`；
14. `LiveSessionRegistry`；
15. `ScheduleService` + `SessionScheduleHost`；
16. 注册当前工作目录；
17. `startWebHost(...)`，默认端口 4317，可用 `OMNIAGENT_PORT` 覆盖。

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
| `GET` | `/api/workspaces/:id/files` | 工作区文件搜索 |
| `GET/POST` | `/api/workspaces/:id/sessions` | 列出 / 创建会话 |
| `GET/PATCH/DELETE` | `/api/workspaces/:id/sessions/:sid` | 详情 / 改名 / 删除 |
| `POST` | `.../pin` | pin / unpin |
| `POST` | `.../fork` | fork |
| `POST` | `.../messages` | 发送消息（SSE 或 steer） |
| `POST` | `.../permission` | 切换预设 |
| `POST` | `.../agent` | 切换智能体 |
| `POST` | `.../model` | 切换模型 |
| `POST` | `.../plan` | 切换 plan 模式 |
| `POST` | `.../plan-review` | 审批计划 |
| `POST` | `.../approvals` | 审批工具调用 |
| `POST` | `.../compact` | 安排手动压缩 |
| `POST` | `.../interrupt` | 中断当前回合 |
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

### 3.1 监听与 Origin

- 只监听 `127.0.0.1`；
- `Host` 必须匹配监听地址和端口；
- 如果存在 `Origin`，必须与规范化后的 Host 同源；
- `localhost` 和 `127.0.0.1` 不互换；
- Host / Origin 检查是浏览器侧保护，不是本地用户认证。

### 3.2 请求体

- JSON 请求必须 `Content-Type: application/json`，否则 415；
- 普通 JSON 最大 64 KiB；
- 消息体最大 32 MiB；
- 附件最多 8 个；
- 图片 MIME 只允许 png / jpeg / webp / gif，单张 base64 数据最大 8 MiB；
- 文本附件最大 256 KiB；
- 超限返回 413，并排空请求体。

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

以下操作在任意 turn 运行或创建会话时返回 409：

- 新建会话；
- 修改默认权限、agent、model、plan；
- fork；
- 删除工作区。

这是为了防止运行中的沙盒命令通过未认证控制面改变后续回合的授权。它不是身份认证。

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

### 4.1 事件交错

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

`LiveSessionRegistry` 默认上限 128，用于让计划任务和 Web 标签页共享同一个 Session，避免两个实例写同一日志。

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
- `projectTraceEvents()`：只保留元数据；
- `projectTrajectory()`：轨迹图数据；
- `exportSession()`：Markdown / JSON；
- `recordWorkspaceAudit()` / `readWorkspaceAudit()`：Web 审计；
- `searchWorkspaceFiles()`：`@` 菜单文件搜索，最多 50,000 条，跳过 `.git` / `node_modules` / `dist` 等。

## 9. Web UI 架构

### 9.1 组件树

```text
App
├─ Sidebar
│   ├─ WorkspaceDialog
│   ├─ RemoveWorkspaceDialog
│   ├─ RenameSessionDialog
│   ├─ DeleteSessionDialog
│   └─ Toast
├─ Header
│   ├─ 导出菜单
│   └─ Conversation / Observe tabs
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
│   │   ├─ ApprovalView
│   │   └─ Composer
│   └─ TrajectoryView
├─ RightPanel（guide / files / terminal）
├─ PlanReviewDialog
└─ NewSessionDialog
```

响应式：

- `max-width: 900px` 切换移动布局；
- `viewportWidth >= 1000` 才显示右侧栏；
- 右栏宽度在 300 和 45% 视口之间，且至少给主区留 680px。

### 9.2 状态仓库

`packages/web/ui/src/lib/store.ts`：

- 单一 `AppStore` + `AppState`；
- 每个会话一个 `SessionEntry`；
- `useSyncExternalStore(store.subscribe, store.getSnapshot)`；
- `emit()` 用 `requestAnimationFrame` + 32ms 超时批量通知；
- 请求用自增序号防止竞态；
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
- `loadDetail()`：一次 patch 全部字段，重建 transcript / turns；
- `startDraftSession()`：UI-only draft，不落库；
- `persistDraftSession()`：第一条消息时创建真实会话，再补权限 / plan；
- `startTurn()`：乐观把用户消息插入 transcript，失败回滚；
- `consumeStream()`：逐事件 `applyAgentEvent`，用不可变快照触发 React；
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

`new`、`plan`、`goal`、`compact`、`permission`、`agent`、`model`、`settings`、`export`、`clear`、`help`。

二级选择器：

`file`、`session`、`skill`、`permission`、`agent`、`model`、`export`。

- permission 选择 `danger-full-access` 前弹出风险确认；
- agent 过滤 `usage !== 'subagent'`；
- model 支持「跟随智能体」和具体模型 + 默认 effort；
- 忙碌发送模式：`queue` 或 `steer`。

附件：

- 最多 8 个；
- 图片 8 MB，文本 256 KB；
- 图片 base64 预览；
- 文本 `file.text()`。

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
- Web 不认证本地用户；`409` 只是防运行中权限竞态，不是鉴权。
- 子代理的完成通知不会进入父回合的原始 SSE；需要重新加载父会话。
- Web 子代理没有 live approval handler；一次性沙盒升级会被拒绝，plan review 不可用。
- `RoleSettings` / `ModelSettings` 走 `ConfigFile` 的进程内锁，但没有 `PermissionSettings` 那样的 `lastText` 外部修改检测；多进程同时编辑时最后写入者获胜。
- 模式保存不接受 MCP 工具名（见 [configuration-agents-modes.md](../design/configuration-agents-modes.md) 的实现备注）。
- 实时 SSE 不是脱敏导出格式；assistant 文本、工具参数和结果都可能含敏感内容。
