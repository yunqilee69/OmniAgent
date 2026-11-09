# 事件协议 v0（M1）

`packages/core/src/protocol/events.ts` 的实现说明。这是 core 与 UI 之间唯一的契约；改它等于改公共 API。

## 事件的形状

```ts
type AgentEvent =
  | { type: 'turn.start'; step: number }
  | { type: 'assistant.reasoning.delta'; text: string }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; message: AssistantMessage }
  | { type: 'tool.call'; call: ToolCall }
  | { type: 'permission.decided'; callId: string; decision: 'allow' | 'deny'; source: string }
  | { type: 'plan.review.requested'; requestId: string; plan: string }
  | { type: 'plan.review.decided'; requestId: string; approved: boolean; feedback?: string }
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
assistant.reasoning.delta*   ← 流式思考增量，可能没有
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
3. 每个模型回合段以且仅以一个 `turn.end` 或 `error` 结束；`send()` 在最后一个回合段后关闭流。
4. `assistant.message` 里的 `toolCalls` 与后续 `tool.call` 一一对应，顺序一致。
5. `assistant.delta` 只出现在同一轮的 `assistant.message` 之前；把所有 delta 的 `text` 依次拼接，等于该条 assistant 消息的文本内容（provider 实现 `stream()` 时成立）。
6. `assistant.reasoning.delta` 同样只出现在 `assistant.message` 之前，但它**不是**正文的一部分，也不保证被持久化或回放。UI 可以只把它当实时展示；没有思考内容时该事件完全缺席。

## 自动目标续轮

当会话里存在 `active` 且进程内 `armed` 的 goal 时，一次 `send()` 可能包含多个模型回合段：

```
turn.start ... turn.end     ← 直接人类回合
turn.start ... turn.end     ← goal round 1
turn.start ... turn.end     ← goal round 2
...
```

每个后续回合开始前，Session 先追加一条带 `source: { kind: 'goal', goalId, revision, round }` 的 `message/user` 事件，再运行模型。客户端必须能在同一个流里处理多次 `turn.start` / `turn.end`，不能在第一个 `turn.end` 就关闭连接或允许新的并发发送；服务端的运行锁在整个目标链结束后才释放。goal 完成、blocked、paused、disarmed、中断、错误或达到轮次上限时链停止。中断正在执行的 goal round 会把 goal 持久化为 `paused`；错误会 disarm 但保留 phase。

## 流式是可选的

`ModelClient.stream()` 是可选方法。实现了它的 provider 在生成过程中 yield 文本或思考增量，最后 return 完整的 `ModelResponse`；没实现的 provider 走 `complete()`，这一轮就不会有 `assistant.delta` 或 `assistant.reasoning.delta`。

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

## 权限和计划审批

`Session` 通过注入的 `approve` 回调等待一次性权限审批。普通 `workspace-write` 调用不逐次询问；请求扩大当前调用的沙盒范围时才可能触发审批，批准只作用于本次调用。权限预设通过 `permission/dsh-preset` 会话事件持久化，审批不会修改预设。

Web 的实时通道提供 live-only 的 `permission.requested`、`plan.review.requested` 和 `plan.review.decided` 事件。它们不会写入持久轨迹；`exit_plan_mode` 的计划和最终结果仍通过普通工具调用与工具结果进入会话记录。计划审核发生在 `tool.call` 之后、`tool.result` 之前。

## 版本策略

现在是 v0，没有兼容性承诺。等 M2（真 provider + compaction）稳定后，再给 `AgentEvent` 加 `v` 字段并冻结形状——在那之前每次改动同步更新本文件。
