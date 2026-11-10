# 设计总览

## 1. 项目定位

OmniAgent 是一个本机运行的个人智能体。它不是为了再做一个「编码助手」，而是把 agent 的关键机制完整地实现一遍，并且让每一层都短到能单独阅读、单独测试：

- 主循环：模型请求、工具调用、权限决策、结果回灌。
- 上下文：历史投影、上下文预算、压缩、会话续轮。
- 安全：DSH 权限预设、一次性升级、文件围栏、OS 级 shell 沙盒。
- 扩展：skills、MCP、子代理、计划任务、智能体定义。
- 观测：TUI 和 Web 两个前端消费同一份事件协议与会话日志。

运行时行为以 DSH（DeepSeek Harness）为参考，但**不使用 Cordis，也不使用 DSH 的插件 / profile 运行时**。OmniAgent 自己重组了配置、权限、工具和会话层，边界说明见 [NOTICE](../../NOTICE)。

## 2. 非目标与明确边界

这些不是「还没做」，而是当前设计主动不承诺的能力：

| 非目标 | 含义 |
| --- | --- |
| 多用户服务 | Web 默认只监听 loopback；可选账号密码认证只保护 HTTP 访问，不是多用户隔离，也不能隔离同 OS 用户的其他进程 |
| 完整 OS 隔离 | 沙盒限制文件写入和 shell 执行，不隔离网络、不限制所有读取，也不是虚拟机 |
| 通用插件运行时 | 没有 DSH/Cordis 插件系统；MCP 和 skills 是受控扩展点 |
| 自动权限推断 | 旧 `mode` / `permissions` 字段不再解析，也不会转换成 DSH 授权；缺少显式选择时 fail closed |
| 无损压缩 | 自动压缩默认只生成一条条数占位摘要，不调用额外模型 |
| 云端同步 | 会话、配置、审计和计划任务都保存在本机 `~/.omniagent/` |

## 3. 设计原则

### 3.1 协议优先

`AgentEvent`（`packages/core/src/protocol/events.ts:25`）是 core 与所有前端之间唯一的实时契约。TUI、Web SSE、Web React store 都消费同一条事件流。前端是事件日志的投影，而不是运行时的第二套状态机。

### 3.2 单一组合根

`RuntimeResolver` 负责把「配置 + 智能体 + 模型绑定 + 模式快照 + 工作区 skills」解析成一次会话运行所需的全部参数；`Session` 负责把这些参数组合成模型客户端、工具表、权限快照、循环和持久化。

前端不自己解析配置文件，也不自己决定工具表。它们只调用 resolver，然后把结果交给 Session。

### 3.3 每回合快照

- 配置和 `agents/*.md` 在每个新回合开始时重新读取，内容哈希作为 revision。
- 运行中的回合保留启动时的快照；修改配置从下一回合生效。
- 权限预设、模式组合、子代理的模型与权限都在创建 / 准入时固化。
- 新的 revision 会让 Web / TUI 重建对应的 `Session` 实例。

### 3.4 显式选择，失败关闭

缺少 agent 选择、缺少 v2 模型绑定、角色引用不存在的模型、模型不支持所选 reasoning effort、配置 JSON 非法——这些情况都会明确失败，而不是回退到默认模型或旧配置。图片能力不足不再失败：不支持图片的模型会在请求期收到带文件名 / 路径的文本占位，历史中的图片保持不变。

### 3.5 事件日志是事实来源

会话不是把 `Message[]` 另存一份，而是把每个事件追加到 JSONL：

- 模型历史由 `projectMessages()` 从事件日志投影得到。
- TUI 的会话列表、Web 的详情页、轨迹图和导出都从同一份日志投影。
- 工具参数、权限决策、压缩元数据等分别以 `trace/*`、`todo/write`、`goal/change` 等事件持久化。
- 请求期投影（`/init` 展开、不支持图片时的文本占位、`contextSample` 回放）不修改日志；日志始终保存用户原始输入和原始图片。

### 3.6 allowlist 只减少暴露面，不授予权限

智能体 profile 和模式可以选择工具与 skill，但它们只是 allowlist。真正的授权来自 DSH 权限预设与沙盒；两者取交集。`tools: ["bash"]` 在 `read-only` 下仍然不能写文件。

### 3.7 模块小而单向

`packages/core` 不依赖 TUI / Web / 终端 / HTTP。包边界只在 `src/index.ts` 做 barrel 导出；模块之间用相对路径直接引用，避免循环依赖。

## 4. 运行时全景

```text
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ TUI (packages/tui)           │       │ Web UI (packages/web/ui)     │
│ readline REPL + 终端渲染      │       │ React 工作台                  │
└──────────────┬───────────────┘       └──────────────┬───────────────┘
               │ AgentEvent / 回调                     │ HTTP + SSE / HTTP 回填
               │                                       │
┌──────────────▼───────────────┐       ┌──────────────▼───────────────┐
│ TUI composition root         │       │ Web host (packages/web/src)  │
│ main.ts                      │       │ server.ts / main.ts          │
└──────────────┬───────────────┘       └──────────────┬───────────────┘
               │                                       │
               └───────────────┬───────────────────────┘
                               │
                 ┌─────────────▼─────────────┐
                 │ RuntimeResolver           │
                 │ config + agents + modes   │
                 │ + binding + skills        │
                 └─────────────┬─────────────┘
                               │ ResolvedSessionRuntime
                 ┌─────────────▼─────────────┐
                 │ Session                   │
                 │ history / inbox / tools   │
                 │ plan / todo / goal / title│
                 └──┬──────────┬──────────┬──┘
                    │          │          │
        ┌───────────▼──┐  ┌────▼─────┐  ┌─▼──────────────┐
        │ AgentLoop    │  │ ToolExec │  │ SubagentManager│
        │ turn / step  │  │ registry │  │ schedule tools │
        └──┬────────┬──┘  └────┬─────┘  └────────────────┘
           │        │          │
   ┌───────▼──┐ ┌───▼──────┐ ┌─▼──────────────────────┐
   │ModelClient│ │AuditSink │ │DSH permission + sandbox│
   │providers  │ │JSONL     │ │file fence / shell      │
   └───────────┘ └──────────┘ └────────────────────────┘

持久化：SessionStore(JSONL) · WorkspaceRegistry · ScheduleStore · ConfigStore · AgentCatalog
```

## 5. 包与目录

| 路径 | 职责 | 依赖方向 |
| --- | --- | --- |
| `packages/core/src` | 领域类型、事件协议、模型适配、主循环、工具、权限、沙盒、会话、子代理、计划任务、配置、MCP、skills、eval | 不依赖任何前端或 Web 框架 |
| `packages/tui/src` | REPL、终端渲染、审批问答、会话恢复 | 依赖 core |
| `packages/web/src` | 本地 HTTP Host、SSE、审批代理、设置服务、工作区与会话路由 | 依赖 core |
| `packages/web/ui/src` | React 工作台、状态仓库、事件 reducer、设置页、样式 | 通过 HTTP/SSE 依赖 Web Host |
| `docs/` | 设计、实现、规格、ADR、调研笔记 | — |

`packages/web/ui/vendor` 是从既有前端设计系统复制进来的 primitives（Markdown、主题、表单等）。它们属于展示层资产，不是运行时依赖。

## 6. 一条用户消息的生命周期

以 Web 为例，TUI 的差异只在「事件直接交给渲染器」而不是 SSE：

1. **选择会话**：UI 通过 workspace id + session id 打开会话；服务端用注册表解析真实路径。
2. **准入校验**：`GET /sessions/:id` 或发送消息前，服务端投影 `permission/dsh-preset`、`agent/selected`、v2 `model/selected` 和可选 `mode/selected`。缺失或非法返回 `409`，不回退默认值。
3. **解析运行时**：`RuntimeResolver.resolve()` 刷新配置和 agent 目录，校验 usage、profile、工具 / skill allowlist 和模型绑定，构造 `ModelClient`、system prompt、上下文窗口和 revision。
4. **获取 Session**：Web 按 `(workspace, session)` + 权限预设 + 模型 binding + resolver revision 缓存 `Session`；TUI 用相同维度懒创建。Web 可以用 `Prefer: respond-async` 立即返回 202，再用 `.../follow` 的 `run.snapshot` + 实时事件观察回合，断线不会停止服务端回合。
5. **写入用户消息**：附件先写到工作区外的私有批次目录，再合成为文本元数据 + 图片 part；`Session.send()` 追加 `message/user` 事件，更新内存历史，准备标题。`/init [notes]` 仍按原文持久化，只在请求期展开。
6. **进入循环**：`AgentLoop.run()` 每个 step 发 `turn.start`，按需压缩历史（当前用户消息和 steering 受保护），向 provider 请求；system prompt 由 `Session` 在每次请求时追加工作区 `AGENTS.md`。
7. **流式事件**：provider 的文本 / 思考增量转为 `assistant.delta` / `assistant.reasoning.delta`；完整消息以 `assistant.message` 发出，并带上耗时、usage（含 cache）和内部 context sample。
8. **工具批处理**：每个调用依次经过 `tool.call` → `prepareToolCall`（权限 / 审批 / 沙盒策略）→ `permission.decided` → 执行或拒绝 → `tool.result` → 审计。不支持图片的模型在这一步之前已把图片投影为文本占位。
9. **结果回灌**：本 step 的所有工具结果合并成一条 `role: 'tool'` 消息，进入下一个 step。
10. **回合结束**：`turn.end` 携带 `end_turn` / `max_tokens` / `max_steps` / `interrupted` / `error`。
11. **续轮**：如果存在 active + armed 的 goal，Session 自动追加一轮 goal 消息，继续循环；否则等待下一条用户消息或后台通知。
12. **对账**：Web UI 用服务端返回的 `messages`（含 messageId / timestamp）、`events`、`trajectory`、`metrics`、`audit` 重新投影，把流式视图收敛到持久化日志；Context Meter 通过 `.../context` 单独刷新。

## 7. 配置分层

五层配置，每层只回答一个问题：

```text
providers / models  →  连到哪里、模型有哪些元数据、能力与思考字段怎么映射
roles               →  一组 provider + model + reasoningEffort
agentProfiles       →  一个智能体可以看见哪些工具和 skill（config.json）
agents/*.md         →  身份、说明、角色、usage、profile 和 system prompt
modes.json          →  Web 新会话的 agent + 模型 + tools + skills 组合
```

解析链路：

```text
config.json
  ├─ ConfigStore.refresh() ──> config snapshot + catalog + revision
  ├─ AgentCatalog.refresh(catalog)
  ├─ ModeStore.snapshot()（Web 新会话 / 定时任务）
  └─ RuntimeResolver.resolve()
       ├─ agent → role → provider/model → reasoning effort
       ├─ mode/profile → tools + skills allowlist
       ├─ workspace → skills  catalog
       └─ system prompt + context window + revision
```

最终 reasoning effort 的顺序是：**binding 显式值 → role 值 → 模型 `reasoning.default`**。

详细 schema 与字段规则见 [design/configuration-agents-modes.md](configuration-agents-modes.md) 和 [agents.md](../agents.md)。

## 8. 安全模型

安全不是一层，而是三个必须同时成立的环节：

```text
暴露面（allowlist）        授权（DSH preset）              执行（sandbox）
agentProfiles / modes  →  read-only                      →  文件围栏 / Seatbelt
  tools / skills           workspace-write                →  bwrap / Landlock
                           danger-full-access             →  无本地文件沙盒
        │                          │                                │
        └──────────── 取交集 ──────┴──────── 取交集 ─────────────────┘
```

| 层 | 决定 | 失败姿态 |
| --- | --- | --- |
| allowlist | 模型能看见哪些工具和 skill | 未知工具名是配置错误；隐藏工具无法被伪造调用 |
| DSH preset | 会话的准入与审批策略 | 缺失、legacy、非法事件都拒绝执行 |
| sandbox | 写入哪些路径、shell 进程能做什么 | 无可用受限后端时拒绝执行，不回退为无沙盒 |

关键规则：

- `read-only`、`workspace-write`、`danger-full-access` 是仅有的三个预设。
- 普通 `workspace-write` 文件写入不逐次弹窗；只有模型显式请求更宽的沙盒时才一次性审批。
- 一次性升级只对当前调用生效，不写入会话预设，不能重复使用。
- `danger-full-access` 关闭本地文件沙盒，并且审批策略是 `never`；它不表示「所有显式升级请求都会自动批准」。
- plan 模式只是提示词与 `exit_plan_mode` 的可见性，不是权限或沙盒机制。
- 子代理继承创建者的权限预设，但使用自己的 agent 角色解析模型。
- MCP 工具在服务器进程执行，不受本地文件沙盒约束，因此被视为 trusted；配置者必须自行信任该服务器。
- Web 认证默认关闭；启用后所有业务 API（包括 SSE / follow）要求登录 cookie。它只保护 HTTP 访问，不隔离同 OS 用户的其他进程，也不提供传输加密。
- 附件存放在工作区外的私有批次目录，模型只收到「不可信元数据 + 路径」；`read_file` 可在只读预设下读取附件，但内容仍是被审查的用户输入。
- Linux 启动时会尝试准备 bubblewrap；不可用时报告原因或要求管理员安装 Landlock 启动器，不会自动降级为无沙盒。

详见 [design/tools-permissions-sandbox.md](tools-permissions-sandbox.md)。

## 9. 状态归属

| 状态 | 事实来源 | 内存副本 |
| --- | --- | --- |
| 会话消息、选择、todo、plan、goal、标题、pin、fork | `~/.omniagent/sessions/**/session.jsonl` | `Session` / `SessionLog` |
| providers、models、roles、profiles、默认权限、MCP 配置 | `~/.omniagent/config.json` | `ConfigStore` snapshot |
| Web 模式预设 | `~/.omniagent/modes.json` | `ModeStore` |
| 智能体定义 | `~/.omniagent/agents/*.md` | `AgentCatalog` |
| 工作区注册 | `~/.omniagent/workspaces.json` | `WorkspaceRegistry` |
| Web 附件 | `~/.omniagent-attachments/` 或 `/var/tmp/omniagent-attachments-<uid>/` | 按批次路径读取，不在内存中常驻 |
| Web 账号密码 | `~/.omniagent/config.json` 的 `web.auth` | 启动时读取，重启生效 |
| 计划任务与投递记录 | `~/.omniagent/schedules.json` | `ScheduleStore` / `ScheduleService` |
| Web 审计 | `~/.omniagent/web-audit/*.jsonl` | 每次请求尾部读取 |
| TUI 审计 | `<workspace>/.omniagent/audit.jsonl` | `AuditLog` |
| 会话指标 | 事件日志的纯投影 | 每次请求重算 / UI 增量维护 |

会话日志是 append-only 的；标题、pin、模式等「最新值」都是对事件流做 fold 得到的投影。配置类文件是读穿式加载，变更通过内容哈希 revision 生效。

## 10. 主要设计取舍

**JSONL 事件日志 vs 数据库**

选择 append-only JSONL：可直接阅读、可 diff、崩溃后容易判断完整性、无需迁移数据库。代价是每次 append 需要重读并原子替换整个文件，会话很长时写入成本线性增长。

**显式选择 vs 自动迁移**

旧版会话的 `mode` / `permissions` 不推断为 DSH 授权，v1 `model/selected` 直接视为 invalid。代价是旧会话需要重新选择；收益是不会把未知历史悄悄放大成权限或错误模型。

**每回合快照 vs 实时热更新**

配置、agent、模式、权限在回合开始时固化。代价是运行中的回合看不到新配置；收益是行为可解释、可复现，不会在一个回合中途改变工具表或授权。

**压缩不调用模型**

自动压缩只保留尾部消息并插入一条占位摘要，不额外调用模型。代价是会丢失被移除内容；收益是压缩本身不产生额外 token、延迟和失败路径。

**审批在 Web 层事件化**

core 只暴露 `approve` / `reviewPlan` 回调。Web 的 `ApprovalBroker` 把回调转换成 `permission.requested` / `plan.review.requested` 事件，再通过 HTTP 回填。这样 core 不需要知道 HTTP，TUI 也可以继续用阻塞式 readline 问答。

**前端共享 core 协议**

TUI 与 Web 都消费 `AgentEvent`，但两者的持久化视图不同：Web 通过 `/events`、`/trajectory`、`/audit` 读取日志投影，TUI 通过 `SessionStore` 直接重放。共享协议让行为一致，但前端仍各自负责呈现策略。

## 11. 继续阅读

- 主循环与事件顺序：[runtime-loop.md](runtime-loop.md)
- 会话状态与 goal / plan / todo：[session-state.md](session-state.md)
- 工具与安全：[tools-permissions-sandbox.md](tools-permissions-sandbox.md)
- 配置与模型解析：[configuration-agents-modes.md](configuration-agents-modes.md)
- 子代理与计划任务：[subagents-and-schedules.md](subagents-and-schedules.md)
- 持久化与观测：[persistence-and-observation.md](persistence-and-observation.md)
- core 模块地图：[../implementation/core.md](../implementation/core.md)
