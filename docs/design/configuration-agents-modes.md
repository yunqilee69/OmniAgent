# 配置、模型、智能体与模式

本文说明 OmniAgent 的配置分层，以及一次会话如何从配置解析成可运行的模型、工具、skill 和 system prompt。实现位置：

- 配置 schema 与加载：`packages/core/src/config/load.ts`、`store.ts`、`models.ts`
- 模型适配：`packages/core/src/providers/`
- 智能体目录：`packages/core/src/agents/`
- 模式存储：`packages/core/src/modes/store.ts`
- skill 发现：`packages/core/src/skills/filesystem.ts`
- MCP 配置：`packages/core/src/mcp/`
- 运行时解析：`packages/core/src/session/runtime.ts`

## 1. 五层配置

```text
providers / models  →  连到哪里、模型元数据、能力、思考字段映射
roles               →  一组 provider + model + reasoningEffort
agentProfiles       →  一个智能体可见的工具和 skill（config.json）
agents/*.md         →  身份、说明、角色、usage、profile、system prompt
modes.json          →  Web 新会话的 agent + 模型 + tools + skills 组合
```

每层只回答一个问题，避免「一个字段同时决定模型、权限和工具」。

## 2. ConfigStore

`ConfigStore` 是 `~/.omniagent/config.json` 的读穿式存储（`config/store.ts`）：

- 每次 `refresh()` 重新读取文件；
- 打开方式：`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`；
- 必须是普通文件，否则 `ConfigError`；
- 文件不存在 → 空字符串 → 按默认配置解析；
- 内容不变 → 直接复用上次解析结果；
- 内容变化 → 重新解析并构建 catalog；
- `revision = sha256(raw)`；
- JSON / schema 非法 → 抛 `ConfigError`，不回退旧快照；
- schema 错误信息只暴露允许的字段名和 issue code，其他路径折叠为 `*`，避免把敏感值带进错误消息。

运行中的 turn 持有自己开始时拿到的 snapshot；修改从下一回合生效。Web / TUI 用 `resolver.revision` 判断是否需要重建 `Session`。Web 的 `web.host` / `web.port` / `web.auth` 是例外：它们在启动时读取，修改后需要重启 Host。

## 3. config.json schema

### 3.1 顶层字段

| 字段 | 默认 / 规则 |
| --- | --- |
| `web` | Web Host 配置：`host`（默认 `127.0.0.1`）、`port`（默认 4317）、`auth`（`enabled` / `username` / `password`） |
| `model` | 非空，默认 `fake`（演示模式） |
| `provider` | 字符串（DSH/pi-ai）或对象（legacy OpenAI） |
| `providers` | provider route 表 |
| `roles` | 角色表 |
| `agentProfiles` | 工具 / skill allowlist |
| `mcpServers` | 故意为 `unknown`，逐条解析，单条坏配置不拖垮全局 |
| `reasoningEffort` | canonical effort |
| `maxTokens` / `contextWindowTokens` / `retainContextTokens` | 正整数 |
| `dsh` | 保留给显式权限默认值修复 |
| `maxSteps` | 默认 300（仅作无限循环兜底） |
| `subagents.maxDepth` | 默认 1 |
| `subagents.maxActive` | 默认 8 |
| `todo.allowParallelInProgress` | 默认 `false` |
| `system` | 可选全局 system prompt 前缀 |

顶层使用 `.passthrough()`，未知字段保留；嵌套的关键结构（web、provider route、role、profile、模型 reasoning）是 strict 的。旧的 `mode` / `permissions` 字段已不再参与解析，也不会转成 DSH 授权；它们只会作为未知字段保留在原始文件中。

`web.auth` 启用时必须同时提供非空 `username` 和 `password`，否则 schema 校验失败。Web 监听与认证配置只在进程启动时读取；修改后必须重启 Web 服务。其他配置仍按内容哈希在新回合生效。

注意：`host` 允许配置为 loopback 或具体监听地址；`0.0.0.0` / `::` 会被 Host 校验按通配监听处理，只接受实际本地地址。认证使用 HTTP + 登录 cookie，不提供传输加密。

### 3.2 Provider route

```ts
{
  api?: 'deepseek-messages' | 'openai-completions' | 'openai-responses' | 'anthropic-messages',
  auth?: 'ambient',
  baseURL?: URL,
  apiKey?: string,
  apiKeyEnv?: string,
  headers?: Record<string, string>,
  models?: RouteModel[],
  timeoutMs?: number,
  streamIdleTimeoutMs?: number,
  maxRetries?: number,
  reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  reasoningEffort?: ReasoningEffort,
  maxTokens?: number,
  systemPromptUpdate?: 'in-history' | 'latest'
}
```

`RouteModel`：

```ts
{
  id: string,
  name?: string,
  contextWindow?: number,
  maxTokens?: number,
  input: ('text' | 'image')[],
  reasoning?: boolean | ModelReasoning,
  capabilities?: { imageInput?: boolean }
}
```

`ModelReasoning`：

```ts
{
  efforts?: Partial<Record<ReasoningEffort, string | number | null>>,
  budgets?: Partial<Record<ReasoningEffort, number>>,
  default?: ReasoningEffort,
  wire?: {
    enableField?, enableValue?,
    disableField?, disableValue?,
    effortField?, budgetField?
  }
}
```

### 3.3 reasoning wire 的安全校验

`wire` 使用点分路径写入请求体。以下情况直接拒绝：

- 空路径段；
- `__proto__`、`constructor`、`prototype`；
- 顶层保留字段：`model`、`messages`、`stream`、`tools`；
- 路径段或总长度超限。

运行时 `setWireField` 会再次执行同样的检查，防止程序化绕过。

### 3.4 Role 与 profile

```ts
type Role = {
  name?: string;
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
};

type AgentProfile = {
  tools: '*' | string[];
  skills?: '*' | string[];
};
```

规则：

- `role.provider` / `role.model` 必须存在于模型目录；
- `role.reasoningEffort` 必须是该模型支持的 effort；
- `agentProfiles` 未配置时，隐式提供 `default: { tools: '*', skills: '*' }`；
- 一旦显式配置 `agentProfiles`，就**不再**隐式合并 default；引用不存在的 profile 的 agent 会失效；
- `skills` 省略等价于 `[]`；
- `tools` 未知名称是配置错误（`subagent` 组会展开）。

## 4. 模型目录与默认角色

`buildConfigCatalog(config)`（`config/models.ts:220-282`）生成：

```ts
{
  providers: Map<providerId, ModelDescriptor[]>,
  roles: Map<roleId, Role>,
  roleErrors: Map<roleId, string>,
  profiles: Map<profileId, AgentProfile>,
  warnings: string[]
}
```

### 4.1 provider 分支

| 配置 | 行为 |
| --- | --- |
| `provider` 是对象（legacy） | 只注册一个 `provider: 'openai'`、`protocol: 'legacy-openai'` 的模型；忽略 `providers` |
| `model === 'fake'` | 不注册任何 provider，走演示模式 |
| `provider` 是字符串且 `providers` 中没有 | 插入空 route，交给 pi-ai builtin 解析 |
| `deepseek-official` 或 `api: 'deepseek-messages'` | 只有 provider id 为 `deepseek-official` 才允许；使用内置模型列表（`deepseek-flash`、`deepseek-v4-pro`） |
| 其他 | `resolvePiAiRoute()`，读取 pi-ai builtin catalog 或自定义 route |

### 4.2 默认角色

`defaultRole(config)` 的优先级：

1. 显式 `roles.default`；
2. legacy provider 对象 + `model !== 'fake'` → `provider: 'openai'`；
3. 字符串 provider + `model !== 'fake'` → `provider` + 顶层 `reasoningEffort`；
4. 否则没有默认模型（demo）。

`roles.default` 不进入普通 role 循环，因为它已经由上述逻辑处理。

### 4.3 角色校验

`validateRole()`：

- provider 存在；
- model 存在于该 provider；
- 指定 effort 时，该 effort 在模型的 `reasoning.efforts` 中。

非法角色不进入 `roles`，但错误保留在 `roleErrors`。`resolveModelBinding()` 会抛出具体错误，而不是静默跳过。

唯一的例外是第 4 条 demo 情况：`default` 角色既不在 `roles` 也不在 `roleErrors` 时，跟随 agent 角色的绑定（`kind: "agent"`）会解析成「没有模型」而不是报错。这样全新安装（还没有配置任何模型）时，内置模式的 `valid` 保持为 `true`，Web 端可以直接新建会话、模型槽位显示为空并提示用户去「设置 → 模型配置」添加模型，而不是抛出 `Unknown role "default"` 的告警。显式引用 `role: "default"` 的绑定仍然报错。

## 5. Provider 适配

### 5.1 路由选择

`createConfiguredModel(input, descriptor?)`（`providers/create.ts:14-110`）：

```text
没有 config.provider          → 返回 undefined（调用方注入 FakeModel）
config.provider 是对象        → legacy OpenAI
provider === 'deepseek-official' → DeepSeek Messages
有 provider 且 model === 'fake' → 报错（要求真实模型）
其他                          → pi-ai
```

### 5.2 协议对照

| 协议 | 客户端 | 端点 | 说明 |
| --- | --- | --- | --- |
| `deepseek-messages` | `DeepSeekMessagesModel` | `baseURL` + `/v1/messages` | Anthropic Messages 风格；`x-api-key`、`anthropic-version`；支持 thinking / tool_use / 自定义 wire |
| `openai-completions` | pi-ai / legacy OpenAI | `/chat/completions` | OpenAI Chat Completions；legacy 使用官方 `openai` SDK |
| `openai-responses` | pi-ai | `/responses` | OpenAI Responses API |
| `anthropic-messages` | pi-ai | `/v1/messages` | Anthropic Messages API |

### 5.3 DeepSeek Messages

- 默认 base URL：`https://api.deepseek.com/anthropic`；
- 默认模型：`deepseek-flash`；
- `max_tokens` 默认 256,000；
- 请求头：`x-api-key`、`anthropic-version: 2023-06-01`；
- `redirect: 'error'`；
- SSE 解析严格校验事件顺序、block index、块类型和 stop reason；
- `max_tokens` 且包含 tool_use → `TRUNCATED_TOOL_CALL`；
- 错误分类：`AUTH`、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`、`HTTP_<status>`；
- 支持 `systemPromptUpdate: 'in-history' | 'latest'`；
- 返回 `dshReplay` 元数据，用于精确重放 thinking / tool_use block。

### 5.4 pi-ai

- 支持内置 pi-ai provider 或自定义 route；
- 自定义 provider 必须同时提供 `api` 和 `baseURL`；
- `auth: 'ambient'` 使用内置 provider 的环境凭证；
- `apiKey` 优先，其次 `apiKeyEnv`；
- 支持 `openai-completions`、`openai-responses`、`anthropic-messages`；
- 通过 `onPayload` 注入自定义 reasoning wire；
- assistant 历史的 `providerReplay` 会校验 provider / model / api / endpoint hash / 可见文本 / tool calls；不匹配时降级为普通 assistant，不转发别家的 thinking/signature。

### 5.5 Legacy OpenAI

- 使用官方 `openai` SDK；
- `baseURL` 可替换，兼容 OpenAI 兼容服务；
- API key 来自配置或 `OPENAI_API_KEY`；
- 流式解析 `reasoning_content` / `reasoning` 为 reasoning delta；
- tool_calls 按 index 累积；
- 坏 JSON 参数不抛错，返回 `{ __invalid_json: raw }`，交给工具 schema 校验。

### 5.6 凭据边界

- API key、endpoint、headers 只存在于 provider 配置和进程环境；
- 模型目录、API 响应、会话事件和日志都不包含凭据；
- Web 的模型设置只返回 `apiKeyConfigured: boolean`，不返回 key 本身；
- `apiKeyEnv` 显式配置但环境变量为空时，构造模型会失败，而不是静默使用空 key。

## 6. 智能体目录

### 6.1 扫描

`AgentCatalog` 扫描 `~/.omniagent/agents/*.md`：

- 文件名（去掉 `.md`）就是 agent id；
- 只接受普通文件，拒绝 symlink；
- 文件最大 512 KiB；
- id 必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`；
- 单文件校验失败只记录错误，不影响其他 agent。

### 6.2 Frontmatter

只支持扁平 YAML 子集：

```markdown
---
name: Explorer
description: 只读搜索、代码探索和资料定位
role: quick
usage: subagent
profile: search-only
---

你是一个探索型智能体。
```

| 字段 | 规则 |
| --- | --- |
| `name` | 可选，默认 id；1–120 字符 |
| `description` | 可选，最多 2,000 字符 |
| `role` | 可选，默认 `default`；必须存在 |
| `usage` | `primary` / `subagent` / `both`，默认 `both` |
| `profile` | 可选，默认 `default`；必须存在 |

- 未知字段报错；
- `x-` 前缀字段忽略，留给未来扩展；
- 正文就是 system prompt；
- 正文为空时使用全局 `system`；两者都为空时使用内置默认提示；
- agent 文件不能设置模型、工具、skill、权限或沙盒。

### 6.3 内置 agent

- `default`：默认智能体，role `default`，usage `both`，profile `default`；
- `creator`：创造智能体，role `default`，usage `primary`，profile `default`；
  - 用于通过对话调整 OmniAgent；
  - 可使用 `schedule_*`、`list_agent_definitions`、`write_agent_definition`；
  - 禁止覆盖 `default` / `creator`，禁止手写配置文件。

如果目录中存在 `default.md` / `creator.md` 但校验失败，**不会**回退到内置定义。这是 fail-closed 设计。

### 6.4 usage

- `primary`：只能作为主智能体；
- `subagent`：只能被子代理调用；
- `both`：两边都可以。

根会话、子代理启动和懒恢复都会重新校验 usage；不匹配时失败，不降级到其他 agent。

## 7. 模式预设

### 7.1 文件

`~/.omniagent/modes.json`：

```json
{
  "version": 1,
  "defaultMode": "standard",
  "modes": {
    "my-mode": {
      "name": "我的模式",
      "description": "可选说明",
      "agent": "default",
      "model": { "version": 2, "kind": "role", "role": "quick" },
      "tools": ["read_file", "grep"],
      "skills": ["docs"]
    }
  }
}
```

规则：

- `name` 必填，最多 120 字符；
- `description` 可选，最多 2,000 字符；
- `agent` 必须是可作为主智能体的有效 id；
- `model` 省略等价于 `{ "version": 2, "kind": "agent" }`；
- `tools` / `skills` 可以是 `"*"` 或字符串数组；
- 未知工具让模式无效；
- 未知 skill 只产生 warning；
- 内置 id `standard` / `creator` 可以被覆盖，删除覆盖项恢复内置定义；
- `defaultMode` 只影响新会话选择器的默认项。

### 7.2 内置模式

**standard**

- agent `default`；
- 跟随智能体角色；
- tools `*`；
- skills `*`。

**creator**

- agent `creator`；
- tools 显式列表：`read_file`、`list_dir`、`glob`、`grep`、`web_fetch`、`skill`、`todo_write`、`exit_plan_mode`、`get_goal`、`create_goal`、`update_goal`、`schedule_create`、`schedule_list`、`schedule_view`、`schedule_edit`、`list_agent_definitions`、`write_agent_definition`；
- 故意不包含 `write_file`、`edit_file`、`bash`；
- skills `*`。

### 7.3 快照语义

创建 Web 会话时写入 `mode/selected`：

```json
{
  "version": 1,
  "mode": "standard",
  "agent": "default",
  "model": { "version": 2, "kind": "agent" },
  "tools": "*",
  "skills": "*"
}
```

- 模式快照不可变；
- 修改 `modes.json` 只影响新会话；
- 会话内仍可切换模型，但 agent / tools / skills 由模式固定；
- 需要不同组合时只能新建会话。

### 7.4 实现备注

`ModeStore` 的工具名校验只使用 `KNOWN_TOOL_NAMES`，不识别 `mcp__*` 名称；而 `RuntimeResolver` 允许 `isMcpToolName()`。因此把 MCP 工具名写进模式会在保存时被判无效，尽管运行时解析器本身接受这种写法。需要组合 MCP 工具时，目前应使用 `"*"` 或在 agent profile 中授权。

## 8. Skills

### 8.1 根目录

默认顺序：

1. `<workspace>/.agents/skills`（如果提供了 workspace）；
2. `~/.agents/skills`。

同名 skill 先出现的根获胜。

### 8.2 形式

- 目录形式：`<skill>/SKILL.md`；
- 扁平形式：`<skill>.md`；
- 文件最大 1 MiB；
- 只接受普通文件；symlink 会被跳过；
- frontmatter 可选，支持 `name`、`description`；
- `description` 缺省取正文第一段。

### 8.3 渐进加载

- 系统提示只注入 `<available_skills>` 的 name + description；
- 完整正文必须通过 `skill` 工具按名称加载；
- `RuntimeResolver` 按 agent profile / mode 的 skill allowlist 过滤；
- 缺失的 skill 只产生 warning，不授予额外能力；
- `skill` 工具每次加载都会重新检查 allowlist。

## 9. MCP

### 9.1 配置

`config.mcpServers` 按 server id 保存：

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

- 标准传输：stdio、Streamable HTTP；
- 兼容旧配置：`sse`、`ws` / `websocket`；
- 未写 `type` 时，`command` 推断 stdio，`url` 推断 http；
- HTTP 连接失败会回退到旧版 HTTP+SSE；
- `${VAR}` 从宿主环境展开；变量缺失时 server 不可用，不静默替换为空串；
- `enabled` 默认 `true`，`disabled: true` 是反向别名；
- `timeoutMs` 默认 60 秒。

### 9.2 生命周期

- 启用的 server 在 Web 启动时连接；
- 设置写入后重新 `sync()`；
- 单个 server 失败不影响其他 server 或 turn；
- 连接指纹由 `JSON.stringify(server)` 决定：删除、禁用或配置变化会关闭旧连接；
- 调用失败会丢弃连接，下次调用重连。

### 9.3 工具暴露

- 名称：`mcp__<server-id>__<tool-name>`；
- 只允许 `[A-Za-z0-9_-]`，总长 ≤ 64；
- 超长时截断并追加短哈希；
- 只有 live 连接的工具才会注册；
- 参数 schema 从 MCP `inputSchema` 转换；失败时退化为 `record<string, unknown>`；
- 结果扁平化为文本；
- MCP 工具不受本地沙盒约束，必须显式信任服务器。

## 10. RuntimeResolver

`RuntimeResolver.resolve()`（`session/runtime.ts:86-197`）是 Web、TUI、子代理共用的唯一解析入口。

输入：

```ts
{
  cwd: string,
  agentId: string,
  binding?: ModelBinding,
  isRoot: boolean,
  mode?: { id: string, tools: ..., skills: ... }
}
```

输出：

```ts
{
  agent, sessionAgent, skills,
  model?, modelId?, modelBinding, modelDescriptor?, reasoningEffort?,
  capabilities, todoAllowParallelInProgress,
  system, contextWindowTokens?, warnings, revision
}
```

解析顺序：

1. `configStore.refresh()`；
2. `agents.refresh(catalog)`；
3. 按 id 查找 agent；优先返回 catalog 中的具体错误；
4. 校验 usage（root / subagent）；
5. 查找 profile；不存在直接抛错；
6. 决定 tools：
   - 有 mode override → 用 mode.tools；
   - 否则用 profile.tools；
   - 展开 `subagent` 组；
   - 未知名称检查允许 `KNOWN_TOOL_NAMES` 或 `isMcpToolName`；
7. 决定 skills：
   - mode override 优先；
   - 否则 profile.skills；
8. `discoverSkills({ workspace: cwd })`，按 allowlist 过滤；
9. 解析模型绑定：
   - 默认 `{ version: 2, kind: 'agent' }`；
   - `kind: 'agent'` → agent.role；
   - `kind: 'role'` → 指定角色；
   - `kind: 'model'` → 指定 provider/model + effort；
   - effort 顺序：binding 显式 → role → 模型默认；
10. 构造 `ModelClient`；没有模型时由调用方注入 FakeModel；
11. 组合 system prompt：
    - `config.system` + agent body；
    - 只有工具表包含 `skill` 时注入 skill catalog；
    - 只有工具表包含 `subagent` 时注入 agent catalog；
    - 工作区根 `AGENTS.md` 不在这里读取，而由 `Session.systemText()` 每次请求时追加（32 KiB 上限，symlink / 非法编码跳过）。
12. 决定上下文窗口：`config.contextWindowTokens ?? model.contextWindow`；
13. 决定 todo 策略；
14. 计算 revision 哈希：
    - config revision；
    - agent catalog revision；
    - agent id / role / profile；
    - mode id；
    - 模型绑定；
    - reasoning effort；
    - 排序后的 tools / skills；
    - 可用 skill 名称；
    - todo 策略；
15. 返回结果。

## 11. 失败关闭矩阵

| 情况 | 行为 |
| --- | --- |
| config JSON 非法 | 启动 / 刷新失败，不用旧配置 |
| role 引用未知 provider/model | catalog 记录错误，解析时抛错 |
| effort 不被模型支持 | 解析时抛错 |
| agent 文件非法 | 保留在 catalog errors，不可选择 |
| agent usage 不匹配 | 解析时抛错 |
| profile 不存在 | 解析时抛错 |
| skill 缺失 | warning + 空项，不授权 |
| 模式引用未知 agent / 工具 | 模式无效；保存时拒绝 |
| 模型不支持图片但历史含图片 | 请求期把图片替换为文本占位，不失败、不丢历史 |
| 没有可用默认模式 | `resolveDefault()` 抛错 |
| 没有任何 provider | demo 模式，调用方注入 FakeModel |

## 12. 扩展配方

**新增一个 provider 协议**

1. 在 `config/load.ts` 的 `api` 枚举中加入协议名。
2. 在 `providers/create.ts` 中增加分支。
3. 实现 `ModelClient`（`complete` + 可选 `stream`）。
4. 处理 reasoning effort、tool calls、replay 元数据和错误分类。
5. 在 `config/models.ts` 中生成 descriptor，补充 catalog 测试。

**新增一个智能体**

1. 在 `~/.omniagent/agents/` 写 `<id>.md`。
2. 设置 `role`、`profile`、`usage`。
3. 正文写 system prompt。
4. 用 `GET /api/agents` 或 TUI `/agent` 验证；非法文件会显示错误。

**新增一个模式**

1. 在 `modes.json` 添加条目，或在 Web「设置 → 模式」中创建。
2. 选择 agent、模型绑定、tools、skills。
3. 用模式创建新会话；模式快照会固化到 `mode/selected`，后续修改只影响新会话。
