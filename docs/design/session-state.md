# 会话状态与上下文

本文说明 `Session` 如何把循环、历史、持久化和会话级状态（todo / plan / goal / title）组织在一起。实现位置：

- 会话组合根：`packages/core/src/session.ts`
- 历史投影：`packages/core/src/session/projection.ts`
- 输入投影：`packages/core/src/session/init-command.ts`、`workspace-instructions.ts`、`packages/core/src/context/image-input.ts`
- 上下文压缩与投影：`packages/core/src/context/compaction.ts`、`projection.ts`
- todo / plan / goal：`packages/core/src/session/todo.ts`、`plan.ts`、`goal.ts`、`goal-controller.ts`
- 标题：`packages/core/src/session/title.ts`

## 1. Session 的职责

`Session` 是整个项目唯一的「组合根」，它同时承担：

- 持有模型客户端、工具注册表、AgentLoop、审计 sink；
- 维护会话消息历史与 inbox；
- 执行 DSH 权限 / 沙盒准入；
- 持久化用户消息、assistant 消息、工具结果和 trace；
- 投影 plan / todo / goal 状态；
- 生成会话标题；
- 接入子代理、计划任务、智能体定义等扩展工具；
- 在后台运行 turn 并把事件转发给宿主。

它**不负责**：

- 发现配置或解析智能体（由 `RuntimeResolver` 完成）；
- 决定模型绑定（由 `session/model-binding.ts` 完成）；
- 渲染 UI 或处理 HTTP；
- 在多个会话之间调度（由前端 / `SubagentManager` / `ScheduleService` 完成）。

## 2. 构造参数

`SessionOptions`（`session.ts:89-136`）按用途分组：

| 组 | 字段 |
| --- | --- |
| 运行环境 | `cwd`、`workspace`、`session`、`sessionId`、`depth` |
| 模型 | `model`、`modelId`、`modelCapabilities` |
| agent / profile | `agent`（含 tools / skills 白名单）、`todoAllowParallelInProgress` |
| 权限与沙盒 | `dshPermissions`、`approve`、`dshSandbox`（受信任 host 配置） |
| plan | `reviewPlan`、`planActive` |
| 循环 | `maxSteps`、`contextWindowTokens`、`retainContextTokens`、`audit` |
| 扩展 | `tools`、`mcpTools`、`subagents`、`schedule`、`agentAuthoring`、`title` |
| 事件 | `onBackgroundEvent` |

构造时的重要行为：

- **权限快照在这里固化**（`session.ts:188`）。`Session` 生命周期内不会自动重新读取权限；前端在 resolver revision / preset 变化时重建 Session。
- 有持久化 `SessionHandle` 时，plan 状态和历史都从事件日志投影；否则使用传入的 `planActive` 和空历史。
- 没有 `SessionHandle` 时不会注册 `todo_write`，因为无法持久化整份清单。

## 3. 历史：事件日志的投影

### 3.1 projectMessages

`projectMessages(events)`（`session/projection.ts:7-28`）把事件折叠成 provider 需要的 `Message[]`：

| 事件 | 投影 |
| --- | --- |
| `message/user` / `user/message` | `role: 'user'` |
| `message/notice` / `subagent/notice` | 合成为 `role: 'user'` 的系统通知文本 |
| `message/assistant` / `assistant/message` | `role: 'assistant'` |
| `message/tool-result` / `tool/result` | 合并进上一条 `role: 'tool'`，没有则新建 |

同时兼容两代事件名，是为了读取旧会话。新写入统一使用 `message/*`。

`projectMessages` 不修改日志，只生成内存视图。日志永远是事实来源。

### 3.2 向 provider 发送前的修复

`prepareModelHistory()`（`session.ts:1154-1208`）只修复**喂给 provider 的输入**，不重写 transcript：

1. 丢弃无法配对的 `role: 'tool'` 消息（没有对应 assistant 调用）。
2. assistant 的 `toolCalls` 按 `call.id` 去重。
3. 只接受紧跟在 assistant 之后、`callId` 匹配的 tool result；重复或孤立的 result 丢弃。
4. 对每个没有结果的调用合成一条 `ok:false` 的 observation：

   ```text
   Tool result is unavailable because the previous turn was interrupted or failed...
   may or may not have run.
   ```

5. 返回 `{ messages, repaired }`。

如果发生了修复，turn 结束后**不会**把 loop 返回的 messages 写回 `this.history`（`session.ts:713`）。这样：

- provider 看到的是一段自洽的对话；
- 会话日志仍然精确记录「有调用、没有结果」的真实状态；
- 下一次读取会话时，修复会重新发生，而不是把合成结果永久写进日志。

`projectPublicHistory()` 在 `projectMessages()` 之上为每条消息生成稳定的 `messageId`（身份 + 事件哈希）和 `timestamp`（事件时间），供 Web 复制消息、显示时间和对账；它还会合并连续的 tool 消息。这些元数据只出现在 API / UI，不进入 provider 请求。

### 3.4 `/init`、工作区指令与图片投影

**`/init`**：`isInitCommand()` 只匹配单段纯文本且没有附件展示元数据的 `/init [notes]`。`Session` 把用户消息标记为 `initCommand: true`，日志仍保存用户原始输入；`projectCommandInput()` 在每次请求前把它展开成「检查仓库并创建 / 更新根 `AGENTS.md`」的完整指令，可选 notes 附在末尾。这样摘要和导出看到的是用户实际输入，模型看到的是展开后的任务。

**工作区指令**：`systemText()` 每次请求都会读取工作区根目录的 `AGENTS.md`：

- 只接受普通文件，`O_NOFOLLOW`，不跟随 symlink；
- 最大 32 KiB，必须是合法 UTF-8；
- 内容被 JSON 转义后放进 `<workspace_agents_md_json>`，并明确声明优先级低于 system / developer 指令、只能当作数据；
- 缺失、超限、非法编码或读取失败的 `AGENTS.md` 会被跳过，不影响会话。

`/init` 只是让模型去创建或更新这个文件；实际读写仍受权限预设、文件围栏和审批约束。

**图片**：模型能力由 `modelCapabilities.imageInput` 决定：

- `imageInput !== false`（包括能力未知）时，图片原样发给 provider；
- `imageInput === false` 时，`projectImageInput()` 在**每次请求**把 image part 替换成带文件名和路径的文本占位；会话历史、日志和磁盘附件中的图片字节保持不变；
- 这是请求期投影，不修改历史，因此切换模型后仍能重新使用图片；
- 支持图片的模型看到的是原始图片；不支持图片的模型可以通过 `read_file` 读取附件路径的文本内容（图片本身仍不可预览）。

### 3.5 上下文投影与用量观测

`projectContext(messages, system, tools, provider, model)`（`context/projection.ts`）给 Web / TUI 提供 Context Meter 数据：

```ts
{
  breakdown: { systemTokens, toolsTokens, messageTokens },
  projectedTokens: number,
  source: 'usage' | 'estimate',
  inputTokens?: number
}
```

算法：

1. 计算当前 system / tools / messages 的估算；
2. 从后向前找最近一条同时有 `usage.inputTokens > 0` 和 `contextSample` 的 assistant；
3. 要求 `contextSample.provider / model` 与当前路由一致，且 `historyHash` 等于该消息之前请求历史的哈希；
4. 命中时 `projectedTokens = 上次真实 inputTokens + (当前估算 - 上次采样估算)`，`source: 'usage'`；
5. 否则直接使用三段估算之和，`source: 'estimate'`。

`contextSample` 在每次成功请求后写入 assistant 消息，包含 provider / model、历史哈希和三段估算。它和 `usage` 一样不发给 provider；估算使用 UTF-8 JSON 字节 / 4，图片按每张 1,024 token 的固定近似，不读取图片真实尺寸。

`Session.contextProjection()` / `contextMessageEstimate()` 只在没有活动回合时可用。Web 的 `GET .../context` 会优先使用匹配当前 preset / 模型 / revision 的 live Session，其次用 replay 构造临时 Session；运行中的回合不返回估算，避免把旧数据当成实时值。

会话指标（runs / steps / requests / usage / cache / throughput）不是新的持久化事件，而是 `projectSessionMetrics()` 对持久化 trace 和 assistant usage 的投影；Web UI 在流式过程中增量维护同一形状，并在 reconnect 时用服务器 baseline 重建。

### 3.6 为什么不在日志里补结果

补写会伪造历史：模型可能以为工具执行过，或者审计与轨迹出现不存在的记录。当前设计选择「输入修复、日志保真」。代价是每次读取都要重新计算，同时压缩后的 provider 输入不会替换原始历史，后续 turn 可能重复压缩。

## 4. 上下文压缩

### 4.1 估算

```ts
estimateMessageTokens(message) =
  max(1, ceil(UTF8(JSON.stringify(messageWithoutUsageAndContextSample)).length / 4))
  + imageCount * 1024
```

这是一个 provider 无关的保守估算，包含 JSON 字段名、tool 参数 / 结果全文，但不包含 `usage` / `contextSample`（它们是本地计量元数据，不会发给 provider）。图片不按 base64 长度计算，而是每张固定 1,024 token 的视觉近似。

### 4.2 算法

`compactMessages(input, { maxTokens, retainTokens?, summarize?, project?, protectedIndices? })`：

1. 深拷贝消息。
2. 用 `project(messages)`（如果提供）估算 `beforeTokens`；不超过 `maxTokens` 就原样返回。
3. `retainTokens` 默认是 `maxTokens * 0.25`。
4. 把消息分组：
   - assistant 带 tool calls + 紧随其后的 tool 消息 → 一组；
   - 其他消息单条一组。
5. `protectedIndices` 指向的消息所在组标记为受保护，压缩时永不丢弃。AgentLoop 至少保护当前 turn 的最新用户消息，以及队列中新增的 steering 用户消息。
6. 从尾部向前累计到 `retainTokens`，得到保留后缀起点。
7. 继续从前面丢弃未受保护的组，直到「保留后缀 + 受保护组」不超过 `maxTokens`。
8. 被移除的前缀作为 `removed`；保留后缀和受保护组不动。
9. 如果没有任何可移除的消息，返回未压缩副本。
10. 摘要默认是 `Earlier conversation compacted (N messages).`。
11. 结果 = 一条 `user` 消息 `[conversation summary]\n<summary>` + 保留消息。
12. 如果压缩后 token 数没有减少，返回未压缩副本，避免「摘要反而变大」。
13. 返回更新后的 `protectedIndices`（摘要插入后索引整体后移一位）。

### 4.3 触发方式

- **自动**：配置了 `contextWindowTokens` 时，AgentLoop 每个 step 都会尝试压缩。
- **手动**：`Session.requestCompaction()` 设置一次性标志；下一个 step 消费它。
  - 手动压缩的 `maxTokens = max(1, floor(beforeTokens / 2))`；
  - 不传 `retainTokens`，因此使用默认的 1/4。

两种路径都通过 `project: history => projectImageInput(projectCommandInput(history), imageInput)` 估算「真正发给 provider 的消息」：图片按 1,024 token 计，不支持图片的模型按占位文本计，`/init` 按展开后的长指令计。

### 4.4 重要限制

- 压缩预算只计算 `messages`，**不包含 system prompt、tool JSON schema 和输出预留**；`contextWindowTokens` 在 AgentLoop 里是「历史消息预算」。
- Context Meter 的投影包含 system + tools + messages，因此即使投影接近模型窗口，压缩预算仍可能只按消息部分计算；需要更保守时手动把 `contextWindowTokens` 调小。
- 没有真实摘要：AgentLoop 不传 `summarize`，被移除的内容只留下条数占位符。
- 图片按固定 1,024 token 近似，可能高估或低估实际视觉成本。
- 压缩结果只存在于内存 / 本次循环，**不写回会话日志**。重新打开会话会从完整历史重建，内存视图与日志视图可能不同。
- 如果历史修复发生（`repaired=true`），本次循环的压缩结果会被整体丢弃。
- 受保护的用户消息可能让保留部分超过 `maxTokens`；这是有意的，优先保证当前输入和 steering 不丢失。

### 4.5 配置建议

- `contextWindowTokens` 取配置值或模型目录的 `contextWindow`，是压缩触发窗口；需要为 system prompt、工具 schema 和输出预留空间时，显式配置得更小。
- 需要保留更多近期上下文时调大 `retainContextTokens`；但保留越多，压缩越频繁。
- 需要真正摘要时，应在 `compactMessages` 的调用处注入 `summarize`，并接受额外的模型调用成本。

## 5. 消息投递与后台回合

Session 内部有一个 `inbox` 和等待者表：

| 方法 | 用途 | 行为 |
| --- | --- | --- |
| `deliverUserMessage()` | 运行中用户插话（steer） | 追加 `message/user`，push 到 history 和 inbox |
| `deliverExternalMessage()` | 其他 agent / 计划任务消息 | 追加 `message/notice`；运行中进 inbox，空闲时启动后台 turn |
| `receiveSubagentNotice()` | 子代理完成通知 | 追加 `subagent/notice`；运行中进 inbox，空闲时启动后台 turn |
| `waitForInput()` | `wait_agent` 工具 | 等待 inbox 有消息、超时或 abort |

`AgentLoop` 在每个 step 顶部调用 `takeQueuedMessages()`，所以运行中的消息在**下一个模型请求前**被模型看到。

后台 turn 通过 `onBackgroundEvent` 转发事件；它不进入原始 `send()` 的 SSE 响应。宿主关闭后，后台 turn 仍可能继续运行，直到进程退出。

## 6. Plan 模式

### 6.1 状态

`plan/mode` 事件：

```json
{ "active": true }
```

`projectPlanMode()` 取最后一个格式正确的 boolean；非法或缺失视为 inactive。

### 6.2 行为

- `systemText` 在 plan 模式下追加 `PLAN_MODE_GUIDANCE`，要求先调研、不写文件、计划完成后调用 `exit_plan_mode`。
- `exit_plan_mode` 只在提供了 `reviewPlan` handler 时注册。
- 工具调用时，Session 检查：
  - 非 plan 模式下调用 `exit_plan_mode` → deny；
  - plan 模式下 agent profile 不允许 `exit_plan_mode` → `send()` 直接抛错。
- `exit_plan_mode` 要求计划非空且以 `# ` 一级标题开头。
- 批准 → `onApproved()` 清除 plan 模式；拒绝 → 工具返回错误，把用户反馈交给模型继续修订。

### 6.3 不是安全机制

Plan 模式**只改变提示词和工具可见性**，不改变 DSH 权限预设或沙盒。模型在 plan 模式下仍然可以写文件，只要当前 preset 允许。README 和 `docs/architecture.md` 都明确这一点。

### 6.4 边界

`exit_plan_mode` 只在有 `reviewPlan` 时注册，但 `setPlanMode(true)` 不要求 handler。因此嵌入方如果打开了 plan 模式却没有提供 review 回调，系统提示会指向一个不存在的工具。TUI / Web 都提供了 review 回调，所以当前两个前端不会进入这个状态。

## 7. Todo 列表

### 7.1 工具契约

`todo_write` 是「整份列表替换」，不是增量修改：

```json
{
  "todos": [
    { "content": "读取代码", "status": "completed" },
    { "content": "写文档", "status": "in_progress" }
  ]
}
```

`parseTodoList()`（`session/todo.ts:21-34`）校验：

- 内容非空；
- 不允许重复内容；
- 默认最多一个 `in_progress`；
- `config.todo.allowParallelInProgress: true` 时允许多个。

校验失败是工具错误，不会写入事件。

### 7.2 持久化与投影

- 每次成功调用追加完整 `todo/write` 事件。
- `projectTodos()` 取最后一次合法写入。
- TUI 在 `tool.result` 后重印列表；Web 在会话详情和底部 todo dock 显示。
- `turn/end` 不清空，方便用户在回合结束后看到清单。
- `projectTodos` 遇到 `message/user` / `user/message` 会清空；当前 Session 写的是 `trace/turn.start`，因此实际重置发生在下一条用户消息，而不是 trace 事件。

### 7.3 实现备注

`projectTodos` 还识别 `turn/start` 事件，但当前会话日志不会写这个类型（写的是 `trace/turn.start`）。这是历史兼容分支，不影响正常行为。后台通知（`message/notice` / `subagent/notice`）不会清空 todo，旧清单会跨后台回合保留。

## 8. Goal

### 8.1 状态模型

```ts
type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';
type GoalActivation = 'armed' | 'disarmed';
```

- `phase` 持久化。
- `activation` 是进程内状态，会话重载后一律 `disarmed`。
- 默认最大轮数 256；默认阻塞阈值 3 轮。

### 8.2 事件

`goal/change` v1，两种形状：

```ts
// 创建 / 编辑 / 暂停 / 恢复 / 完成 / 阻塞
{ version: 1, operation, goal: { id, revision, objective, phase, maxGoalRounds, blockedReason? }, roundsStarted, createdAt, updatedAt }

// 清空（重放兼容层支持，当前没有控制器入口）
{ version: 1, operation: 'clear', cleared: { id, revision }, clearedAt }
```

校验规则（`session/goal.ts`）：

- 正向 revision；
- 非空、规范化的 objective；
- `updatedAt >= createdAt`；
- block reason 是 lower-kebab-case；
- `create` 必须是 revision 1、active、rounds 0；
- 其他操作 revision 必须恰好 +1；
- `createdAt` 不变，`roundsStarted` 不变；
- pause / resume / complete / block 的相位转换受限。

### 8.3 谁可以修改

`GoalController` 和 `goal` 工具区分两种权威：

| 操作 | direct human | 当前 goal round |
| --- | --- | --- |
| `create_goal` | 必须 | 否 |
| `update_goal edit/pause/resume` | 必须 | 否 |
| `update_goal complete` | 允许 | 允许（精确匹配 id/revision/round） |
| `update_goal blocked` | 允许 | 允许，但要求 `roundsStarted >= 3` |

`direct human` 指顶层智能体上的真实用户 turn；goal 自动续轮不算。

### 8.4 自动续轮

`runGoalChain()`（`session.ts:589-629`）：

1. 执行普通 turn。
2. 如果 stop reason 是 `error` / `max_tokens` / `max_steps` → disarm。
3. 如果是 goal 来源且 `interrupted` → 暂停 goal。
4. 只有 `end_turn` / `tool_use` 才允许继续。
5. 取 active + armed 的 goal：
   - 达到 `maxGoalRounds` → 自动 `block('round-limit')`；
   - 否则生成下一轮 prompt，追加带 `source: { kind: 'goal', goalId, revision, round }` 的 `message/user` 事件。
6. 继续下一轮。

轮次计数不单独写计数器事件，而是从带 goal source 的用户消息重放得到。

终止条件：完成、阻塞、暂停、disarm、turn 中断、错误、轮数上限、没有 active + armed 的 goal。

### 8.5 收尾提示

goal 轮中完成或阻塞后，Session 通过 `deferGoalContext()` 注入 `<goal_complete>` / `<goal_blocked>` 通知，要求模型写一条收尾消息而不是静默停止。

## 9. 标题

### 9.1 来源

`session/title` 事件：

```json
{ "title": "...", "messageSeqs": [], "source": { "kind": "fallback" | "provider" | "user" } }
```

最新合法事件胜出。

### 9.2 生成流程

`Session.ensureTitle()`（`session.ts:961-1055`）：

1. 取第一条合格的人类文本消息。
2. 如果当前标题来源是 `user`，不再自动生成。
3. 没有标题时先写确定性 fallback：
   - 取前 5 个词；
   - 最多 40 字节。
4. 只有 root 会话、配置了模型、用户尚未改名时，异步请求一次 provider 标题：
   - 输入截断；
   - 超时 / abort；
   - 要求 `end_turn` 且无 tool calls；
   - 清洗控制序列，限制 80 字节；
   - 成功写 `session/title`，source 为 `provider`。
5. provider 标题失败不影响用户回合。

### 9.3 UI 行为

- `Session.send()` 只在新写 fallback 标题时 yield `session.title`。
- provider 标题没有 live 事件；UI 在下一次加载会话详情时看到持久化值。
- TUI 忽略 `session.title`，标题只在 `/sessions` 列表中从磁盘摘要读取。

## 10. 状态所有权

| 状态 | 写入方 | 读取方 |
| --- | --- | --- |
| `message/user` | `Session.send` / `deliverUserMessage` / goal 续轮 | `projectMessages`、UI |
| `message/assistant` | `runTurn` | `projectMessages`、UI；含 `usage`、`requestDurationMs`、`firstTokenDurationMs`、`contextSample` |
| `message/tool-result` | `runTurn` | `projectMessages`、UI |
| `todo/write` | `todo_write` 工具 | `projectTodos`、TUI/Web |
| `plan/mode` | `/plan` 或 Web plan 路由 | `projectPlanMode`、Session |
| `goal/change` | GoalController | `projectGoal`、goal 工具 |
| `session/title` | `ensureTitle` / Web PATCH | `foldSessionTitle`、列表 |
| `session/pinned` | Web pin 路由 | `projectPin`、列表 |
| `trace/*` | Session | trace 投影、轨迹、审计 |
| `permission/dsh-preset` | 新会话创建 / 显式切换 | `projectDshPermissions` |
| `agent/selected` | TUI / Web 创建或切换 | `projectAgentSelection` |
| `model/selected` | 同上 | `projectModelSelection` |
| `mode/selected` | Web 创建 / 计划任务创建 | `projectModeSelection` |

## 11. 已知限制与实现备注

- **权限快照在构造时捕获**：不是每个 turn 重新捕获。修改预设后必须重建 Session；前端在 revision / preset 变化时会重建。
- **压缩无真实摘要**：见 4.4。
- **压缩不持久化**：重新打开会话后内存历史会回到完整版本。
- **Context 投影只在空闲时可信**：运行中的回合由 AgentLoop 持有可变历史，`contextProjection()` / `contextMessageEstimate()` 返回 `undefined`；Web 不返回活动回合的估算。
- **Context sample 会失效**：provider / model 变化、历史哈希不匹配或前一条 assistant 没有有效 usage 时，投影退回纯估算；切换路由后会先显示估算值，直到产生新的真实 usage。
- **工作区 `AGENTS.md` 不进入事件日志**：每次请求重新读取，修改后立即影响下一次请求；超过 32 KiB、非法 UTF-8 或 symlink 会被跳过。它不能覆盖 system / developer 指令。
- **`/init` 日志与请求不同**：日志保存用户输入的 `/init ...`，模型看到的是展开后的指令；导出也保留用户原文。
- **不支持图片的模型不再失败**：图片在请求期被替换为文本占位，原始图片仍留在历史和磁盘附件中；`read_file` 只能读取附件的文本内容。
- **`max_tokens` 留下悬空 tool calls**：由下一次历史修复补齐，但日志保持原样。
- **后台 turn 的错误可能被吞掉**：`runBackgroundTurn` 捕获异常后只记录 `runTurn` 已写的 trace；如果异常发生在 `runTurn` 之前，可能没有可见错误。
- **标题请求不随 `interrupt()` 取消**：`interrupt()` 只 abort 主 turn 的 controller；标题请求有独立超时。
- **`AgentCommand` 未使用**：没有命令总线；中断用 AbortSignal，审批用回调。
