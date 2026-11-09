# 主循环与事件协议

本文说明一次 turn 在 core 中如何执行，以及 UI 能观察到什么。实现位置：

- 主循环：`packages/core/src/loop/agent-loop.ts`
- 事件协议：`packages/core/src/protocol/events.ts`
- 会话包装：`packages/core/src/session.ts`
- 执行器：`packages/core/src/exec/executor.ts`

## 1. 核心模型

Agent 的本质是一个很小的循环：

```text
请求模型
  ↓
模型返回 assistant 消息（可能带 tool calls）
  ↓
有工具调用 → 逐个准备 / 授权 / 执行
  ↓
把工具结果追加为 role:'tool' 消息
  ↓
再次请求模型
  ↓
没有工具调用 → 结束
```

`AgentLoop.run(history, signal)` 是 `AsyncGenerator<AgentEvent, Message[]>`：

- **yield** 的是 UI 事件；
- **return** 的是本次 turn 结束时的完整消息数组，由调用方负责持久化；
- 循环本身不写文件、不认识 UI、不持有会话状态。

`maxSteps` 默认 25（`agent-loop.ts:58`）。一个 step 对应一次模型请求。

## 2. 单个 step 的执行顺序

每个 step 的精确顺序如下（`agent-loop.ts:71-202`）：

```text
1. 检查 signal.aborted
   └─ 已中断 → yield turn.end(interrupted)，不进入本 step

2. 排空队列消息 takeQueuedMessages()
   └─ 把运行期间到达的 steering / 通知 / 外部 agent 消息追加到 messages

3. yield turn.start { step }

4. 按需压缩历史
   ├─ 条件：配置了 contextWindowTokens，或本轮有手动 compact 请求
   ├─ compactMessages()
   └─ 成功则 yield context.compacted { beforeTokens, afterTokens }

5. 构造 ModelRequest
   ├─ model
   ├─ system（可以是函数，动态求值）
   ├─ messages
   ├─ tools（优先 toolSpecs()，否则注册表的 specs）
   └─ signal

6. 调用模型
   ├─ 有 stream() → forwardStream()，逐条转发增量
   └─ 否则 complete()

7. 模型异常
   ├─ signal 已中断 → turn.end(interrupted)
   └─ 其他 → yield error，再 yield turn.end(error)

8. messages.push(assistant)
   yield assistant.message

9. 终止判断
   ├─ 没有 tool calls → turn.end(stopReason)
   └─ stopReason === 'max_tokens' → turn.end(max_tokens)，不执行工具

10. 工具批处理
    对每个 tool call：
      a. 检查中断
      b. yield tool.call
      c. prepareToolCall()（Session 提供）
         否则回退到 permissions.check()
      d. 检查中断
      e. yield permission.decided
      f. allow → 执行 prepared.execute() 或 executor.execute()
         deny  → 生成 ok:false 的 observation
      g. yield tool.result
      h. 写审计

11. 把本 step 的结果合并成一条 { role:'tool', results }

12. 进入下一个 step；达到上限 → turn.end(max_steps)
```

两个容易忽略的细节：

- `turn.start` 在压缩之前发出，所以 UI 先看到 step 开始，再看到 `context.compacted`。
- 工具结果只在**整个批处理结束后**合并成一条 `role: 'tool'` 消息，而不是每个工具一条。这是 provider 无关的统一表示。

## 3. 停止原因

`StopReason`（`protocol/events.ts:11`）：

| 值 | 含义 | 是否执行工具 |
| --- | --- | --- |
| `end_turn` | 模型正常结束，没有工具调用 | — |
| `tool_use` | provider 返回 tool use，但循环没有可执行的调用 | — |
| `max_tokens` | 模型输出达到上限 | 否；即使 assistant 带了 tool calls 也不执行 |
| `max_steps` | 达到 `maxSteps` 上限 | 最后一步的工具已执行 |
| `interrupted` | AbortSignal 中断 | 未执行的调用不会执行 |
| `error` | 模型请求抛错 | 否 |

`max_tokens` 的行为值得单独说明：assistant 消息（包括可能被截断的 tool calls）仍会进入历史，但工具不会执行。下一个 turn 的 `prepareModelHistory()` 会为缺失结果的调用合成 `ok:false` 的「结果不可用」observation，避免 provider 看到悬空的 tool call。

## 4. 工具准备与执行

### 4.1 两层接口

```ts
// 旧式、纯决策
interface PermissionGate {
  check(call): Promise<{ decision: 'allow' | 'deny'; source: string }>;
}

// Session 实际使用的可信 host hook
type PreparedToolCall =
  | { decision: 'deny'; source: string }
  | { decision: 'allow'; source: string; execute(): Promise<ToolResult> };
```

`AgentLoop` 优先使用 `prepareToolCall`。Session 总是提供它，因此：

- 权限判断、一次性升级审批、沙盒策略构造都在 `prepareToolCall` 内完成；
- 被允许的调用带一个**绑定当次策略和 signal 的 execute 闭包**，而不是让 loop 再去注册表里找工具；
- 传给 loop 的 `permissions` 只是一个恒拒绝的桩（`session.ts:323`），防止绕过 Session 直接执行。

### 4.2 拒绝也是 observation

被拒绝的调用会生成一条正常的 `ToolResult`：

```text
调用被权限策略拒绝（<source>）。不要重试同一调用，换一种方式或向用户说明。
```

它和工具执行失败一样会回灌模型。这是有意的：模型需要知道「为什么不行」，才有机会换方案，而不是在 UI 层静默消失。

### 4.3 执行器兜底

`ToolExecutor.execute()`（`exec/executor.ts:18-61`）保证工具异常不会穿透主循环：

- 未知工具；
- `parameters.safeParse` 失败；
- `execute` 抛异常。

三者都变成 `ok:false` 的 `ToolResult`，并填充 `durationMs`。因此 **工具代码不需要自己 try/catch 后再包装**；它只需要返回正确的 `ToolOutput`。

### 4.4 审计

每个调用结束后写入一条审计：

```ts
{
  ts, sessionId, step, tool, callId,
  argsDigest,        // sha256(JSON.stringify(arguments))
  decision, source,
  ok, durationMs?
}
```

审计发生在 `tool.result` yield 之后（`agent-loop.ts:187-198`）。参数只保存摘要，不保存原文；`source` 可能包含权限规则文本，Web API 不会把它返回给浏览器。

## 5. 流式事件

provider 的流接口只产生两类增量：

```ts
type ModelStreamDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string };
```

`forwardStream()`（`agent-loop.ts:214-227`）把它们翻译成：

| provider delta | AgentEvent |
| --- | --- |
| `text` | `assistant.delta` |
| `reasoning` | `assistant.reasoning.delta` |

tool call 的分片在 provider 内部累积，循环只有在流结束拿到完整 `ModelResponse` 后才看到 tool calls。因此 UI 看不到「参数逐字生成」的过程。

`assistant.reasoning.delta` 只用于实时展示，**不会写入会话日志**。持久化的 assistant 消息只包含可见文本、tool calls 和 provider replay 元数据。

## 6. 中断

中断通过 `AbortSignal` 传播，不通过事件协议发送命令。

循环在四个位置检查 `signal.aborted`：

1. step 开始；
2. `tool.call` 之后；
3. `prepareToolCall` / 权限决策之后；
4. `permission.decided` 之后。

任何一处命中都立即 `turn.end(interrupted)` 并返回当前 messages。已经在执行的工具不会因为检查点而停止；它的 `execute` 会收到同一个 signal，由工具自己决定如何响应。

模型请求被 abort 时抛出的 `AbortError` 不会被当作 `error` 事件；循环检测到 signal 已中断后直接以 `interrupted` 结束。

## 7. 错误语义

主循环只捕获模型调用本身的异常：

| 出错位置 | 表现 |
| --- | --- |
| provider / stream | `error` 事件 + `turn.end(error)` |
| 工具执行 | `ToolExecutor` 转成 `ok:false` 的 `ToolResult`，循环继续 |
| `prepareToolCall` / 权限 hook / 审计 sink | **异常穿透 generator**，由 Session 捕获并写脱敏 trace，最终 `send()` reject |
| UI 在消费事件时抛错 | 不属于 core 责任；generator 的 `return()` 会触发清理 |

因此，前端不能假设所有失败都会以 `error` 事件结束。Web 在 SSE 流里对「headers 已发送后的异常」补发 `error` + `turn.end(error)`；TUI 在 `send()` reject 时打印错误。

## 8. AgentEvent 完整清单

`protocol/events.ts:25-44`：

| 事件 | 载荷 | 持久化 | 说明 |
| --- | --- | --- | --- |
| `turn.start` | `step` | `trace/turn.start` | 每个 step 一次 |
| `session.title` | `title` | `session/title` | 仅新写入 fallback 标题时实时发出；provider 标题没有 live 事件 |
| `assistant.reasoning.delta` | `text` | 否 | 思考增量，只用于实时展示 |
| `assistant.delta` | `text` | 否 | 文本增量，拼接后与 `assistant.message` 文本一致 |
| `assistant.message` | `AssistantMessage` | `message/assistant` | 完整消息 |
| `tool.call` | `ToolCall` | `trace/tool.call` | 在权限决策之前 |
| `permission.requested` | `requestId`, `call`, `reason` | 否 | **live-only**；core 不发射，由 Web `ApprovalBroker` 生成 |
| `permission.decided` | `callId`, `decision`, `source` | `trace/permission.decided` | 循环发射 |
| `plan.review.requested` | `requestId`, `plan` | 否 | **live-only**；Web broker 生成 |
| `plan.review.decided` | `requestId`, `approved`, `feedback?` | 否 | **live-only**；Web broker 生成 |
| `tool.result` | `ToolResult` | `message/tool-result` | |
| `context.compacted` | `beforeTokens`, `afterTokens` | `trace/context.compacted` | |
| `turn.end` | `reason` | `trace/turn.end` | |
| `error` | `AgentError` | `trace/error` | trace 中只记录固定文案 |

`isTerminalEvent()` 把 `turn.end` 和 `error` 都视为 terminal，但实际循环会先发 `error` 再发 `turn.end(error)`。UI 如果只监听 terminal 事件，应保留 `turn.end` 作为最终状态。

### 8.1 live-only 事件

`permission.requested`、`plan.review.requested`、`plan.review.decided` 不出现在持久化 trace 中。它们由 Web 的 `ApprovalBroker` 在会话之外生成，再与 `Session.send()` 的事件流交错：

```text
tool.call
  → permission.requested（broker 在 prepareToolCall 挂起时插入）
  → permission.decided
  → tool.result
```

TUI 不生成这些事件；它直接在 `approve` 回调里用 readline 阻塞询问。

### 8.2 AgentCommand

`AgentCommand`（`protocol/events.ts:52`）是给未来常驻 daemon 预留的命令契约：

```ts
{ type: 'user.message'; text }
{ type: 'permission.respond'; requestId; decision }
{ type: 'interrupt' }
```

当前代码**没有任何消费者**。中断通过 `AbortSignal`，权限通过注入回调，用户消息通过 `Session.send()`。阅读或扩展时不要误以为存在一条命令总线。

## 9. Session 如何包住循环

`Session.send()` 不是简单地 `for await (loop.run(...))`，它还负责：

- 追加用户消息事件；
- 生成 / 更新标题；
- 维护 `executing` 与 `AbortController`，防止同一会话并发 turn；
- 投影并修复 provider 历史；
- 把 loop 的事件映射为持久化 trace；
- 处理 goal 自动续轮；
- 在后台 turn 中把事件转发给 `onBackgroundEvent`。

### 9.1 一个 send 可能包含多个 turn.end

`runGoalChain()`（`session.ts:589-629`）会在 active + armed 的 goal 下循环：

```text
send()
  → runTurn(初始用户消息)
    → AgentLoop.run() → turn.end
  → 如果 goal 仍需继续：
      追加 <goal_round> 用户消息
      → runTurn() → AgentLoop.run() → turn.end
  → ...
```

因此前端必须把「一个 HTTP SSE 响应 / 一次 `send()`」理解为**可能包含多个 turn 的流**，而不是严格一一对应。

### 9.2 后台 turn

以下情况会在没有用户 `send()` 的情况下启动后台 turn：

- 外部 agent 消息到达空闲会话；
- 子代理完成通知到达；
- 队列中还有未消费的消息；
- 计划任务向空闲会话投递。

后台 turn 的事件通过 `onBackgroundEvent` 转发，不进入原始 SSE 响应。Web 会在下次加载会话详情时从日志中看到这些事件。

## 10. 最小示例

假设用户问「读取 README 并总结」，模型先调用 `read_file`：

```text
turn.start { step: 0 }
assistant.delta { text: "我先读取文件。" }
assistant.message { message: { text: "我先读取文件。", toolCalls: [read_file] } }
tool.call { call: read_file }
permission.decided { callId, decision: "allow", source: "dsh:workspace-write" }
tool.result { result: { ok: true, content: "..." } }
turn.start { step: 1 }
assistant.delta { text: "总结如下..." }
assistant.message { message: { text: "总结如下..." } }
turn.end { reason: "end_turn" }
```

Web 会在 `tool.call` 与 `permission.decided` 之间看到 `permission.requested`，但这只在需要审批时发生。

## 11. 扩展点

| 需求 | 改哪里 |
| --- | --- |
| 支持新的模型协议 | `packages/core/src/providers/`，实现 `ModelClient` |
| 增加新工具 | `packages/core/src/tools/builtin/` + `tools/index.ts` + `names.ts` |
| 改变 step 上限 | `SessionOptions.maxSteps` / `config.maxSteps` |
| 改变压缩策略 | `context/compaction.ts` + `AgentLoopDeps.contextWindowTokens` |
| 接入新的审批 UI | 实现 `approve` / `reviewPlan` 回调；需要事件化时参考 `web/src/approval.ts` |
| 修改事件协议 | `protocol/events.ts`，同时更新 TUI renderer、Web SSE、Web UI reducer 和文档 |

## 12. 实现备注

- `AgentLoop` 不负责审批 UI、持久化或会话选择；这些都在 Session / 前端。
- `turn.start` 的 `step` 在每个 `run()` 内从 0 重新计数；goal 续轮会重新从 0 开始。
- `max_tokens` 不执行工具，但 assistant 消息仍会被持久化，下一轮通过历史修复补齐结果。
- 核心的 `error` 事件只包含异常 message；Web 在对外流中会把错误替换为固定文案，避免泄露内部信息。
- 协议中的 `permission.requested` / `plan.review.*` 是「可选的事件化审批」接口，不是所有 embedder 都必须实现。
