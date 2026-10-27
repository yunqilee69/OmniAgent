# 事件协议 v0（M1）

`packages/core/src/protocol/events.ts` 的实现说明。这是 core 与 UI 之间唯一的契约；改它等于改公共 API。

## 事件的形状

```ts
type AgentEvent =
  | { type: 'turn.start'; step: number }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; message: AssistantMessage }
  | { type: 'tool.call'; call: ToolCall }
  | { type: 'permission.decided'; callId: string; decision: 'allow' | 'deny'; source: string }
  | { type: 'tool.result'; result: ToolResult }
  | { type: 'context.compacted'; beforeTokens: number; afterTokens: number }
  | { type: 'turn.end'; reason: StopReason }
  | { type: 'error'; error: AgentError };
```

用 `type` 做 discriminated union，UI 侧 `switch` 一次就能收窄到具体形状，不需要查文档猜字段。

## 顺序保证

一次 `session.send()` 内，事件的顺序是确定的：

```
turn.start
assistant.delta*             ← 流式文本增量，可能没有
assistant.message            ← 完整消息，可能带 toolCalls
  tool.call                  ← 每个调用依次
  permission.decided         ← 紧跟在对应的 tool.call 之后
  tool.result                ← 执行完，或者被拒
  (...)                      ← 同一轮多个调用会重复这四行
turn.start                   ← 下一轮
...
turn.end
```

硬保证：

1. `permission.decided` 一定出现在对应 `tool.call` 之后、`tool.result` 之前。
2. 每个 `tool.call` 一定恰好有一个 `tool.result`（被拒绝也要有一个 `ok: false` 的结果）。
3. 一次 `send()` 以且仅以一个 `turn.end` 或 `error` 结束。
4. `assistant.message` 里的 `toolCalls` 与后续 `tool.call` 一一对应，顺序一致。
5. `assistant.delta` 只出现在同一轮的 `assistant.message` 之前；把所有 delta 的 `text` 依次拼接，等于该条 assistant 消息的文本内容（provider 实现 `stream()` 时成立）。

## 流式是可选的

`ModelClient.stream()` 是可选方法。实现了它的 provider 在生成过程中 yield 文本增量，最后 return 完整的 `ModelResponse`；没实现的 provider 走 `complete()`，这一轮就不会有 `assistant.delta`。

`tool_call` 的分片不放进事件流：provider 内部按 `index` 累积 id / name / arguments，拼完整后随 `assistant.message` 一起出现。UI 需要的是「模型正在输出文本」，不是「工具参数拼到第几个字符」。

## 为什么被拒也要产生 `tool.result`

因为**拒绝是一种 observation**。模型需要看到「这次调用被拦了，原因是 X」，才能换个做法；如果只是静默丢弃，模型会以为工具没响应，然后重复同一个调用——这正是所谓「agent 卡住」最常见的成因。

## `turn.end` 的 reason

| reason | 含义 |
| --- | --- |
| `end_turn` | 模型不再调工具，正常结束 |
| `tool_use` | 保留值；M1 不会用它作为终止原因 |
| `max_tokens` | 模型输出被截断 |
| `max_steps` | 达到步数上限（默认 25） |
| `interrupted` | 被 `AbortSignal` 中断 |
| `error` | 模型调用抛错，前面已经发过 `error` 事件 |

## 权限确认不在事件流里

M1 的权限确认走**注入回调**：`Session` 构造时传入 `approve(request) => Promise<'allow' | 'deny'>`。
core 调用它并 await，UI 在回调里直接渲染提示。

这是 ADR-0002 的取舍：先不引入 request/response 配对机制。代价是「确认」是同步阻塞的，UI 不能在这期间做别的事。

**升级路径**（做 daemon 时）：改成

```
core  --permission.request--> UI
core  <--permission.respond-- UI
```

`PermissionRequest.id` 已经预留，`AgentCommand` 里也已经定义了 `permission.respond`。届时把 `RuleBasedGate` 换成一个持有 pending map 的实现即可，事件类型不用动。

## 版本策略

现在是 v0，没有兼容性承诺。等 M2（真 provider + compaction）稳定后，再给 `AgentEvent` 加 `v` 字段并冻结形状——在那之前每次改动同步更新本文件。
