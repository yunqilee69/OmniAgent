# Web 上下文读数改为流内事件（实施计划）

本文件是交给编码智能体执行的执行计划。编写阶段只做了代码阅读，**没有运行测试**；本文中的命令与期望都是待执行项。

- 范围：`packages/web/src`（Web Host）、`packages/web/ui`（React 工作台）、相关测试与文档。
- 不改：core（`packages/core`）、TUI（`packages/tui`）、`ModelClient`、压缩算法、任何权限/沙盒行为。
- 不新增依赖。

---

## 1. 问题

Context Meter 的读数是**前端按需拉取**的：

| 位置 | 现状 |
| --- | --- |
| `packages/web/ui/src/components/ContextMeter.tsx:152-189` | effect 里 `authFetch(.../sessions/:id/context)`；依赖 `[pollable, workspaceId, sessionId, scope, busy, modelSaving, turnTick]` |
| 同上 `:39`, `:183` | 空闲时 `IDLE_POLL_MS = 15_000` 定时器持续轮询 |
| `packages/web/ui/src/lib/store.ts:396-400` | `contextTickFor()` 把 `turn.start` / `assistant.message` / `tool.result` / `turn.end` 变成"再发一次请求"的计数 |
| `packages/web/ui/src/lib/store.ts:2674-2683, 2705, 2766` | `contextTick` 在 follow 流与快照重放时累加，仅用于触发上面的请求 |
| `packages/web/ui/src/components/Composer.tsx:1337` | 把 `contextTick` 当 `turnTick` 传给 `ContextMeter` |
| `packages/web/src/server.ts:1986-2017`, `:2427-2460` | `follow` 流只推 agent 事件，不推任何上下文读数 |

数据在服务端本来就是现成的：`WebSession.contextProjection()` / `contextMessageEstimate()`
（`packages/web/src/server.ts:149-153`）在**每个 step 边界**就已是"下一次请求真正会发送的内容"，
`publishTurnEvent()` 恰好站在同一个点上。让前端反过来逐 step 请求，等于把服务端已算好的值
丢弃后要求客户端再触发一次计算，还多了一条与回合状态可能错拍的 HTTP 路径。

## 2. 目标

1. **回合中**：上下文读数随 `follow` 流推给前端（新帧 `run.context`），前端不再发请求。
2. **打开会话时**：读数随已有的会话详情响应一起返回（`context` 字段），不再有一次专门的请求。
3. **切换模型后**：读数随 `POST .../model` 响应一起返回（该路由本来就已经解析了 runtime）。
4. **空闲时**：没有周期性请求，`IDLE_POLL_MS` 与 `contextTick` 全部删除。

`GET .../sessions/:id/context` **保留**：它是同一份读数的 pull 通道（脚本与既有测试使用），
字段集合不变；只是工作台不再调用它。这样"push 为主、pull 可查"两通道共用同一个 helper，
不会出现两套算法。

## 3. 协议（新增）

`follow` 流（以及 `run.snapshot.events` 的重放）新增一种宿主帧：

```jsonc
{ "type": "run.context", "context": { "estimatedMessageTokens": 42000, "projection": { "...": "同 /context" }, "modelWindow": 200000, "window": { "tokens": 200000, "source": "model" } } }
```

- 载荷与 `GET .../context` 的响应体**完全同构**（`{ estimatedMessageTokens?, projection?, modelWindow?, window? }`），
  前端只有一个校验函数 `validateContextEstimate()`。
- 只在读数**变化**时推送（服务端按序列化结果去重）。
- 触发点：`turn.start` / `assistant.message` / `tool.result` / `turn.end` / `context.compacted` 之后。
  这些正是 AgentLoop 发布"下一步请求快照"的边界，也是旧 `contextTick` 认可的边界。
- 不写入会话日志（与 `run.user.message` 一样是宿主帧，不是 core 事件）。
- 会话的 live runtime 不提供 `contextProjection` 时不推任何 `run.context` 帧。

## 4. 服务端改动

`packages/web/src/server.ts`：

1. **抽出读数 helper**（现 `:1550-1604` 的内联逻辑）：
   ```ts
   function contextReading(
     options: WebHostOptions,
     workspace: Workspace,
     handle: SessionHandle,
     key: string,
     resolveRuntime: () => Promise<ResolvedSessionRuntime | undefined>, // 或直接传 runtime
     live: WebSession | undefined,
   ): Record<string, unknown>   // 与 /context 响应体同构
   ```
   `GET .../context` 路由改为调用它，行为与字段集合不变（`server.test.ts` 现有四条断言必须继续通过）。

2. **`RunningTurn` 增加读数字段**：
   - `contextScope?: { modelWindow?: number; window?: { tokens: number; source: 'config' | 'model' } }`
     —— 在准入时（`runtime` 已解析处，`:2145` 附近）捕获，回合内不变。
   - `lastContext?: string` —— 上去重用的序列化结果。

3. **新增 `publishTurnContext(turn)`**：`turn.session?.contextProjection` 不存在则直接返回；
   否则组装 `{ ...scope, estimatedMessageTokens?, projection? }`，与 `turn.lastContext` 相同则跳过，
   不同则 `publishTurnEvent(turn, { type: 'run.context', context })`。

4. **调用点**：`:2182-2215` 的推流循环里，在 `turn.start` / `assistant.message` / `tool.result` /
   `turn.end` / `context.compacted` 发布之后调用 `publishTurnContext(turn)`。`run.user.message` 之后不调用
   （此时投影仍是回合前的快照，随后 `turn.start` 会给出正确值）；异常路径与中断路径合成的 `turn.end`
   之后也不调用——那时 Live Session 的状态没有前进，推出去的只会是旧读数，回合结束的对账（详情响应里的
   `context`）本来就会给出最终值。

5. **会话详情**（`:1447-1475`）：响应新增 `context`。为避免二次解析 runtime，
   `describeSelection()` 额外返回内部字段 `runtime?: ResolvedSessionRuntime`，
   路由解构时把它剔除后再 `json()`（不得出现在响应体里）。

6. **模型切换**（`:1694-1716`）：响应新增 `context`（该分支已解析 `resolved`）。

## 5. 前端改动

1. `SessionEntry` 新增 `contextEstimate?: ContextEstimate`（`packages/web/ui/src/lib/store.ts:169` 附近）；
   **删除** `contextTick` 字段、`contextTickFor()`（`:396-400`）及其三处累加（`:2674-2683, 2705, 2766`）。
2. `wire.ts` 新增 `parseContextEstimate(value: unknown): ContextEstimate | undefined`
   （基于现有 `validateContextEstimate()`，非法时返回 `undefined` 而不是抛错——流被一帧坏数据打断是不可接受的）。
3. `consumeStream()`（`store.ts:2644` 起）：识别 `run.context`（快照重放与实时帧同样处理），
   `carryProjection(previous, next)` 后写入 `contextEstimate`，与现有事件共用同一次 `emit()`。
4. `loadDetail()`（`store.ts:1835`）：`body.context` 存在时写入 `contextEstimate`（同样 `carryProjection`）。
5. `saveSessionModel()`（`store.ts:3409-3423`）：采用响应里的 `context`。
6. `ContextMeter`（`ContextMeter.tsx`）：改为纯展示组件 —— props 变为
   `{ workspaceId, value, locale }`；删除 `useEffect`/`authFetch`/`IDLE_POLL_MS`/`turnTick`/`busy`/`modelSaving`/`modelKey`；
   语义不变：无工作区返回 `null`，无读数显示 `0%` + `No reading yet.`，有投影无窗口显示明细 + `This model has no known context window.`。
7. `Composer.tsx:1334-1337` 改为传 `value={entry?.contextEstimate ?? null}`。
8. `lib/context-reading.ts` 顶部注释改写成"读数由宿主随流推送，缺投影时沿用上次"。

## 6. 文档

- `docs/web-api.md`：`.../context` 段落补一句"工作台不再轮询该路由"；新增 `run.context` 帧说明
  （`.../follow` 段落）；会话详情与 `POST .../model` 的响应新增 `context` 字段。
- `docs/implementation/web.md`：§6.1 增补 push 通道；`:135` 路由表；`:516`、`:527-533`、`:593` 中
  `contextTick` / 15 秒轮询 / `turnTick` 的描述全部改写为事件驱动。
- `docs/design/overview.md:136`："Context Meter 通过 `.../context` 单独刷新" → 随 `run.context` 更新。
- `docs/design/session-state.md:137`：补一句宿主在 step 边界把读数作为 `run.context` 推给客户端。
- `docs/implementation/testing.md:91`：`context-meter.test.ts` 的描述改为"仪表纯展示 + 流内读数折入"。
- `README.md`：无需改（只说"上下文用量表"）。

## 7. 测试

| 文件 | 覆盖 |
| --- | --- |
| `packages/web/src/server.test.ts` | 新增：带 `contextProjection` 的 live session 在 `turn.start` 后收到 `run.context`，值随 step 变化、重复值不重发；`run.snapshot` 重放包含该帧；无 `contextProjection` 的 session 不产生该帧（现有精确帧序列断言即为回归保护）。新增：会话详情返回 `context`；`POST .../model` 返回 `context` |
| `packages/web/src/context-meter.test.ts` | props 改为 `value`；"没有工作区不渲染"、"无读数 0%"、"有投影显示明细"断言保留；新增"渲染不产生任何请求"（无 network 依赖即可，删除原 fetch 相关假设） |
| `packages/web/src/ui-store.test.ts` | 删除 `contextTick` 断言；新增 `run.context` 帧折入 `contextEstimate`、快照重放折入、详情 `context` 折入、无 `projection` 的帧沿用上次投影 |
| `packages/web/src/context-budget.test.ts`、`model-route.test.ts` | 不改（pull 通道语义不变），必须继续通过 |

## 8. 验收判据

1. `rg -n "contextTick|IDLE_POLL_MS|turnTick" packages/web` 无结果。
2. `rg -n "/context" packages/web/ui` 无结果（工作台不再请求该路由）。
3. 回合中每个 step 边界，follow 流出现 `run.context`，且连续相同读数不重复出现。
4. 打开已结束会话：详情响应带 `context`，仪表首屏即显示读数（不再有独立 `/context` 请求）。
5. `pnpm typecheck` 通过；`pnpm test` 通过。

## 9. 风险

| 风险 | 处理 |
| --- | --- |
| 每步调用 `contextProjection()` 有成本（估算整段历史） | 与改造前同一节奏（旧前端每 step 也触发同一函数），且服务端省掉了 HTTP 往返；只在 5 类事件后调用 |
| `run.context` 帧进入重放缓冲，挤占 8 MiB 预算 | 帧体积为几十字节量级，且与 agent 事件共享同一预算；`truncated` 语义不变 |
| 详情新增 `context` 字段会多算一次 replay 投影 | 复用 `describeSelection()` 已解析的 runtime；只在没有 live session 且会话空闲时走 replay 分支（与旧 `/context` 一致） |
| 前端丢掉"上次读数" | `carryProjection` 语义保留：无投影的帧/响应沿用上次投影 |
| 其它 host 持有回合 | 本 host 无 live session 时不推也不报投影，前端沿用上次读数（与旧行为一致） |
