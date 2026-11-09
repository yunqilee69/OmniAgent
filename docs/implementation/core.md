# core 实现地图

本文从代码结构角度说明 `packages/core/src`。设计意图见 [design/](../design/)，这里回答「哪个文件负责什么、依赖朝哪走、从哪开始读」。

## 1. 包边界

```text
packages/core
  ├─ 不依赖 TUI / Web / HTTP / React / readline
  ├─ 只有 src/index.ts 做 barrel 导出
  ├─ 模块之间使用相对路径直接引用
  └─ 通过 @omniagent/core 暴露给 tui / web
```

`packages/core/package.json` 的 exports：

```json
{
  ".": "./src/index.ts",
  "./*": "./src/*.ts"
}
```

TypeScript 路径别名：

```json
"@omniagent/core": "./packages/core/src/index.ts",
"@omniagent/core/*": "./packages/core/src/*.ts"
```

## 2. 依赖方向

```text
domain ← protocol ← providers / tools / permissions / sandbox
                         ↑
config ← session/runtime ← session.ts ← loop
                         ↑
agents / modes / skills / mcp / subagents / schedule
                         ↑
store / context / exec
```

实际约束：

- `domain` 只描述数据，不依赖任何运行时模块；
- `protocol` 只依赖 domain；
- `loop` 依赖 providers / tools / exec / context / store 的接口，不依赖 Session；
- `session.ts` 是组合根，依赖几乎所有模块；
- 外围模块（subagents / schedule / modes / mcp）通过接口注入 Session，不反向依赖 Session 的具体实现。

## 3. 模块表

### 3.1 `domain/`

| 文件 | 内容 |
| --- | --- |
| `message.ts` | `Message`、`AssistantMessage`、`ToolCall`、`ToolResult`、`Usage`、content part、provider replay schema |
| `tool.ts` | `Tool`、`ToolSpec`、`ToolContext`、`ToolOutput` |
| `subagent.ts` | 子代理状态、摘要、通知类型 |

特征：只描述数据形状，不包含行为；是持久化和 provider 请求的单位。

### 3.2 `protocol/`

| 文件 | 内容 |
| --- | --- |
| `events.ts` | `AgentEvent`、`StopReason`、`AgentError`、`AgentCommand`、`isTerminalEvent` |
| `permission.ts` | `PermissionMode`、`Decision`、`Rule`、`PermissionRequest`、`PermissionGate`、`ApprovalHandler` |
| `reasoning.ts` | `REASONING_EFFORTS` |

这是 core 与 UI 的唯一契约层。

### 3.3 `config/`

| 文件 | 内容 |
| --- | --- |
| `load.ts` | `ConfigSchema`、provider route / model / role / profile schema、`loadConfig()`、默认路径 |
| `models.ts` | `buildConfigCatalog()`、模型 descriptor、默认角色合成、role 校验、pi-ai 默认 reasoning |
| `store.ts` | `ConfigStore` 读穿式热加载、内容哈希 revision、fail-closed |

### 3.4 `agents/`

| 文件 | 内容 |
| --- | --- |
| `types.ts` | `AgentDefinition`、`AgentSummary`、`AgentUsage` |
| `frontmatter.ts` | 扁平 YAML 子集解析 |
| `catalog.ts` | 扫描 `agents/*.md`、校验、内置 default / creator、revision |
| `prompt.ts` | `<available_agents>` 目录渲染 |
| `authoring.ts` | 智能体定义的读写服务 + `list_agent_definitions` / `write_agent_definition` 工具 |
| `index.ts` | 目录导出 |

### 3.5 `modes/`

| 文件 | 内容 |
| --- | --- |
| `store.ts` | `modes.json` 读写、内置 standard / creator、合并 / 校验 / 默认模式 |
| `index.ts` | 目录导出 |

### 3.6 `skills/`

| 文件 | 内容 |
| --- | --- |
| `filesystem.ts` | 发现 `<workspace>/.agents/skills` 和 `~/.agents/skills`、1 MiB 上限、按名称加载、目录渲染 |

### 3.7 `providers/`

| 文件 | 内容 |
| --- | --- |
| `types.ts` | `ModelClient`、`ModelRequest`、`ModelResponse`、`ModelStreamDelta` |
| `create.ts` | `createConfiguredModel()`、路由选择、凭据 / effort / maxTokens 校验 |
| `fake.ts` | `FakeModel`、`textResponse()`、`toolCallResponse()` |
| `dsh-deepseek.ts` | DeepSeek Messages 客户端、端点、请求头、错误分类 |
| `dsh-messages-types.ts` | DSH schema、默认值、replay 类型 |
| `dsh-messages-serialize.ts` | 消息 → Anthropic Messages 请求体、reasoning wire |
| `dsh-messages-stream.ts` | SSE 解析、事件翻译、严格校验 |
| `dsh-registry.ts` | 可选的兼容 registry（配置文件路径不使用） |
| `openai.ts` | legacy OpenAI Chat Completions |
| `pi-model.ts` | pi-ai 封装、dispatch、replay 降级、reasoning payload |
| `pi-catalog.ts` | pi-ai route 解析、内置 provider、默认值 |
| `wire.ts` | 点分路径写入 + 原型污染防护 |
| `replay-identity.ts` | provider replay 的 provenance 哈希 |

### 3.8 `loop/` 与 `exec/`

| 文件 | 内容 |
| --- | --- |
| `loop/agent-loop.ts` | 主循环、事件发射、工具批处理、审计 |
| `exec/executor.ts` | `ToolExecutor`：未知工具 / 参数错误 / 异常 → `ok:false` |

### 3.9 `tools/`

| 路径 | 内容 |
| --- | --- |
| `tool.ts` | `toSpec()`、`truncateOutput()` |
| `registry.ts` | `ToolRegistry` |
| `names.ts` | 工具名常量、`KNOWN_TOOL_NAMES`、`expandToolSelector()` |
| `paths.ts` | `resolveInside()` / `resolveInsidePhysical()` |
| `fs-io.ts` | 原子写、字面量编辑、binary / UTF-8 检查、路径锁 |
| `ripgrep.ts` | glob / grep 的 ripgrep 传输、限额、超时、采样 |
| `limits.ts` | 输出 / 目录条目上限 |
| `index.ts` | `createDefaultRegistry()` |
| `builtin/*.ts` | 各内置工具 |

### 3.10 `permissions/`

| 文件 | 内容 |
| --- | --- |
| `dsh-permissions.ts` | 三个预设、bundle、事件投影、快照 |
| `dsh-escalation.ts` | 独立的一次性升级 helper（与 Session 内逻辑等价） |
| `gate.ts` | `RuleBasedGate`（legacy 规则引擎，Session 不使用） |
| `evaluate.ts` | 规则决策、模式默认 |
| `rules.ts` | 规则解析、命令拆分、路径匹配、glob |
| `modes.ts` | legacy 模式、编辑工具、受保护路径 |
| `bash.ts` | shell 命令拆分 |

### 3.11 `sandbox/`

| 文件 | 内容 |
| --- | --- |
| `dsh-policy.ts` | `DshSandboxPolicy`、可写根、物理目录校验 |
| `dsh-fs.ts` | 文件围栏、symlink / hardlink 检查 |
| `dsh-hardlinks.ts` | shell 可写根硬链接预检 |
| `dsh-sandbox.ts` | Seatbelt / bwrap / Landlock 探测与 argv 包装 |
| `runner.ts` | 较早的独立 sandbox helper（Session 的 bash 不使用） |

### 3.12 `session/`

| 文件 | 内容 |
| --- | --- |
| `runtime.ts` | `RuntimeResolver`：配置 + agent + mode + binding + skills → 运行参数 |
| `agent-selection.ts` | `agent/selected` 投影、切换、usage 校验 |
| `model-binding.ts` | v2 模型绑定、role → model、effort 优先级 |
| `mode-selection.ts` | `mode/selected` 投影与快照 |
| `projection.ts` | 事件 → `Message[]`、公开消息脱敏 |
| `todo.ts` | todo 校验与投影 |
| `plan.ts` | plan/mode 投影、guidance |
| `goal.ts` | goal schema、fold、投影、round 重放 |
| `goal-controller.ts` | goal 状态机与事件提交 |
| `title.ts` | 标题清洗、fallback、消息收集、列表时间 |
| `pin.ts` | pin 投影 |
| `fork.ts` | fork 事件 |
| `store.ts` | SessionStore、SessionLog、JSONL 持久化 |
| `file-lock.ts` | 跨进程 PID 锁 |
| `types.ts` | header / event / summary schema |
| `index.ts` | 目录导出 |

### 3.13 `store/`

| 文件 | 内容 |
| --- | --- |
| `audit.ts` | `AuditEntry`、`AuditLog`、`digestArgs()` |
| `transcript.ts` | 早期整份 `Message[]` 存储，当前主流程不使用 |

### 3.14 `subagents/`

| 文件 | 内容 |
| --- | --- |
| `manager.ts` | `SubagentManager`：启动、消息、list、wait、interrupt、通知、懒恢复 |

### 3.15 `schedule/`

| 文件 | 内容 |
| --- | --- |
| `types.ts` | 时间规则、目标、错误码 |
| `domain.ts` | 时间解析 / 规范化、record 编解码、提醒文本 |
| `store.ts` | `schedules.json` 读写与校验 |
| `service.ts` | CRUD、CAS、排序、历史 |
| `runtime.ts` | timer、drive、错过的触发、投递 |
| `delivery-history.ts` | 历史裁剪与分页 |
| `update.ts` | 编辑时重新计算 timing |
| `tools.ts` | `schedule_create/list/view/edit` 模型工具 |
| `time/` | duration、instant、cron、rrule |

### 3.16 `mcp/`

| 文件 | 内容 |
| --- | --- |
| `config.ts` | transport 解析、`${VAR}` 展开、工具名生成 |
| `client.ts` | MCP Client、stdio / SSE / Streamable HTTP / WS、分页、probe、结果扁平化 |
| `service.ts` | 连接生命周期、sync、工具注册、状态 |
| `index.ts` | 目录导出 |

### 3.17 `context/` 与 `eval/`

| 文件 | 内容 |
| --- | --- |
| `context/compaction.ts` | token 估算、压缩算法 |
| `eval/harness.ts` | case 运行、fixture、断言 |
| `eval/run.ts` | CLI 入口 |
| `eval/suites/basic.ts` | 内置能力 / 权限用例 |

### 3.18 `prompts.ts` 与 `index.ts`

- `prompts.ts`：`DEFAULT_SYSTEM_PROMPT`，中文的默认行为约束。
- `index.ts`：包边界 barrel，汇总 domain / protocol / providers / tools / permissions / loop / session / sandbox / schedule / subagents / mcp 的公共导出。

barrel 只放在包边界；模块之间不要 `export *` 满天飞。

## 4. 关键类型速查

### 4.1 消息

```ts
type Message =
  | { role: 'user'; content: UserContent[] }
  | { role: 'assistant'; content: AssistantContent[]; toolCalls: ToolCall[]; usage?: Usage; dshReplay?; providerReplay? }
  | { role: 'tool'; results: ToolResult[] };
```

`AssistantContent` 目前只含 text；reasoning 通过流式事件展示，不进入可见正文。

### 4.2 工具

```ts
interface ToolOutput {
  content: string;
  ok?: boolean;
  truncated?: boolean;
}
```

### 4.3 模型客户端

```ts
interface ModelClient {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncGenerator<ModelStreamDelta, ModelResponse>;
}
```

### 4.4 运行解析结果

`ResolvedSessionRuntime` 是前端交给 Session 的全部上下文：

```ts
{
  agent, sessionAgent, skills,
  model?, modelId?, modelBinding, modelDescriptor?, reasoningEffort?,
  capabilities, todoAllowParallelInProgress,
  system, contextWindowTokens?, warnings, revision
}
```

## 5. 组合根

`Session` 是唯一的组合根，构造顺序大致是：

```text
1. 解析 session id / header / 事件
2. 冻结 DSH 权限快照
3. 投影 history / plan / todos / goal
4. 创建 GoalController
5. 注册工具
   ├─ 默认注册表
   ├─ 按 agent allowlist 过滤
   ├─ 替换 write_file / edit_file 为沙盒版本
   ├─ 替换 skill 为 allowlist 版本
   └─ 追加会话工具 / MCP / subagent / schedule / authoring
6. 创建 AgentLoop
   ├─ model
   ├─ system（动态）
   ├─ toolSpecs（动态）
   ├─ takeQueuedMessages
   ├─ takeForceCompact
   └─ prepareToolCall
7. 准备 title / background event
```

前端只负责：

```text
ConfigStore + AgentCatalog + ModeStore + RuntimeResolver
  → resolve()
  → new Session(resolved + handle + callbacks)
  → session.send()
```

## 6. 按任务找文件

| 我想…… | 先看 |
| --- | --- |
| 改主循环行为 | `loop/agent-loop.ts`、`session.ts` 的 `runTurn` |
| 改工具参数 / 输出 | `tools/builtin/<tool>.ts`、`tools/tool.ts` |
| 加权限规则 | `permissions/dsh-permissions.ts`、`session.ts` 的 `prepareToolCall` |
| 改沙盒 | `sandbox/dsh-*.ts` |
| 加模型协议 | `providers/create.ts`、`providers/*` |
| 改配置 schema | `config/load.ts`、`config/models.ts` |
| 改 agent 文件格式 | `agents/catalog.ts`、`frontmatter.ts` |
| 改会话日志 | `session/store.ts`、`session/types.ts` |
| 改标题 / pin / fork | `session/title.ts`、`pin.ts`、`fork.ts` |
| 改 goal | `session/goal.ts`、`goal-controller.ts`、`tools/builtin/goal.ts` |
| 改 plan | `session/plan.ts`、`tools/builtin/exit-plan-mode.ts` |
| 改子代理 | `subagents/manager.ts`、`tools/builtin/subagent.ts` |
| 改计划任务 | `schedule/` |
| 改 MCP | `mcp/` |
| 改 eval | `eval/harness.ts`、`eval/suites/` |

## 7. 测试与类型检查

- 测试：`packages/*/src/**/*.test.ts`，Vitest。
- 类型检查：`pnpm typecheck`（根 `tsconfig.json`，strict + `noUncheckedIndexedAccess`）。
- core 的测试与源码同目录；集成测试在 `packages/core/src/dsh-runtime.integration.test.ts`。
- 详细测试策略见 [../implementation/testing.md](../implementation/testing.md)。
