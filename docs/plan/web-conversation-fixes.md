# Web 会话体验修复实施计划（七项问题版本）

本文件是交给编码智能体执行的执行计划，不是完成报告。编写阶段只做了代码阅读与配置链路核对（下称「调查证据」），**没有运行任何测试、没有做运行时探针**；文档中所有命令与期望都是待执行项。

> **版本 v4 变更点**
> 1. **预算不足改为硬错误**：`window <= system + tools + outputReserve` 时不再 clamp 到 1 继续请求，而是 AgentLoop 在模型调用前 `yield error(code='CONTEXT_BUDGET_TOO_SMALL')`（含 window/system/tools/outputReserve/rawBudget 与调整建议）+ `turn.end(error)`，不调用 provider；`max(1, …)` 只作校验通过后的防御性钳制（§6.2-F2、§7.4、B5、T13/T14、§10.2-15、风险表）。
> 2. **对账去重改为统一 `reconcileOnce` 守卫**：stamp 取该回合最新 `trace/turn.end` 的持久 `seq`（缺失则跳过，不做时间猜测），`pending`/`done` 按 key+stamp 双向判重，stamp 在检测时取一次、请求后不重算；`observeSessionStatus` 与 `finishObservedRun` 共用（§6.4、F8、T4、风险表）。
> 3. **口径文案统一**：手工验收第 2 条改为 `0 turns 0 steps · 整会话累计 0 tok · 缓存命中 —`；风险表中 `tool.result` tick 的回滚项改为「同一工具批次合并多个 `tool.result` 为一次 context 刷新（仍满足每 step）」。
>
> **版本 v3 变更点**
> 1. **修正问题 7 的根因归因**：删除「CJK 时 provider token 远高于 bytes/4，所以界面 500k 而门禁认为不到 300k」这一与调查证据冲突的因果；明确估算在剥离 replay 后基本准确（0.92–1.09×），当前因 replay 重复计入反而高估（1.16× / 1.58× / 3.48×）。根因重排为：预算=100% 窗口、`repaired` 丢弃压缩、失败静默、窗口缺失不压缩、**显示口径混淆（整会话累计 vs 上下文占用）**为主因，估算口径降为次要。
> 2. 新增 §4.7.1「归因（待判别）」：列出三种可能（累计口径 / 另一个模型 / `repaired` 回跳）与各自判别方法，并在 §10.2 增加四数对照验收。
> 3. **新增显示口径任务**：`UsagePill` 标注「整会话累计」、ContextMeter 弹窗明确分母是本会话模型窗口（F4/F5/T9/§7.5/M1）。
>
> **版本 v2 变更点（保留）**
> 1. 新增第 7 项问题专项：模型 `contextWindow=300000` 却在读数 500000 时仍不自动压缩 —— 新增 §4.7、§5.2、§6.2、§7.4、B4–B7、T12–T16（T17 同步既有测试）、D2，并把这些任务并入 M1。
> 2. 修正 v1 的审查问题：A1 改为 AgentLoop 单一 `onTurnHistory` 回调；ContextMeter tick 增加 `tool.result` 并同步文案；结束对账与 `finishObservedRun` 按 key+turn 去重（不靠时间猜测）；手工验收明确详情 URL 精确匹配与 `/context` 15 秒预期；附件恢复期禁止新增附件；逐条修订引用行号、`role="presentation"`、重命名冲突保留顺序、结构断言、IndexedDB 测试工作量、ContextMeter 全部空状态。
> 3. v1 的六项方案结构保留：A 上下文、B 多标签、C 刷新、D 附件、E 文案；新增 F 自动压缩预算，后续编号顺延。

- 范围：Web 前端（`packages/web/ui`）、Web Host（`packages/web/src`）、core 的上下文投影与压缩（`packages/core/src`）、相关配置解析、文档与测试。
- 明确不做：不改 HTTP 路由与响应字段集合、不加依赖、不引入 Dockkit/Cordis、不移植 zcode 的 token 算法、不改 TUI（含 `packages/tui/src/main.ts` 的 Session 组装）。
- 事实基线：`git log -1` = `a564a64`，工作树干净。

---

## 1. 背景与目标

| # | 现象 | 目标 |
| --- | --- | --- |
| 1 | 上下文占用要等回合结束才统计 | 每个 step（`turn.start` / `assistant.message` / `tool.result` / `turn.end`）就更新读数 |
| 2 | 输入框下的缓存/上下文信息启动后延迟出现 | 首屏立即显示读数：无历史显示 0，无缓存数据显示 `—`，不伪造命中率 |
| 3 | 右侧预览等标签没有关闭 X | 右侧多标签，每个内容标签有 X，开始页单例无 X |
| 4 | 页面约每 2 秒有请求与可见刷新，左侧列表跟着刷新 | 去掉空闲期周期性全量详情请求与固定 2 秒重连；只保留真实状态变化与回合结束一次对账 |
| 5 | 侧边栏文案「自动化任务」 | 导航改「自动化」；页面标题与错误文案保持「自动化任务」 |
| 6 | 草稿文本能恢复，图片/文件附件不能 | 附件在新建、切换会话与刷新页面后恢复；发送 accepted 后与文本一起清理 |
| 7 | 模型 `contextWindow=300000`，读数到 500000 仍不自动压缩 | 用「窗口 − system − tools − 输出预留」作为有效消息预算，压缩在真实超限前触发；压缩失败可观测；压缩结果不再被丢弃；**「整会话累计 token」与「上下文占用」两种口径在 UI 上不再混淆**（见 §4.7.1） |

已确认的用户决策（执行时不得更改）：

1. 上下文**每个 step 更新**。
2. 附件（图片与普通文件）在**新建、切换会话和刷新页面后都恢复**。
3. 右侧实现**多个可关闭标签**。

---

## 2. 非目标

- 不改 `GET /api/workspaces/:ws/sessions/:sid/context` 的路由、查询参数与字段集合；**不新增** `/context` 字段（有效消息预算是内部派生值，见 §7.4）。
- 不新增 SSE 帧类型、不新增会话事件类型；压缩摘要与新事件持久化不在本次范围（保留 §11 的限制说明）。
- 不实现真实摘要生成（继续用 `compactMessages` 的占位摘要）、不接 provider 专用 tokenizer（仍是 bytes/4 + 图片固定近似）。
- 不做草稿的服务端持久化、跨浏览器同步；不迁移 `localStorage` 里的文本草稿格式（只追加附件记录）。
- 不改 `packages/tui/src/main.ts` 的 Session 组装（TUI 不传输出预留，回落 20% 窗口，见 §7.4）；不改 `SubagentManager` 的预算接线（同一回落，明确留作后续）。
- 不实现侧栏 `terminal` 标签的终端内容（`RightPanel` 当前没有该渲染分支，是既有缺口）。
- 不改 `followRun()` 的运行中断线重连节奏，不改自动化页 15 秒轮询，不改 ContextMeter 的空闲校准请求本身。
- 不做「压缩结果写回会话日志」的迁移，不重写 `repaired` 修复语义之外的 provider 输入处理。

---

## 3. 现状与约束

### 3.1 已核实的关键文件与位置（调查证据）

| 关注点 | 文件与位置 | 现状 |
| --- | --- | --- |
| 回合中不给投影 | `packages/core/src/session.ts:512-521` | `contextProjection()` / `contextMessageEstimate()` 在 `activeTurn` 时返回 `undefined` |
| 每步已持久化 | `packages/core/src/session.ts:1096-1105` | `runTurn` 在 `assistant.message` / `tool.result` 时先 `appendMessage` 再 `this.history.push`/合并，step 边界历史可用 |
| 压缩改写 loop 私有数组 | `packages/core/src/loop/agent-loop.ts:106,130-148` | `const messages = [...history]`；压缩用 `messages.splice(...)`；`context.compacted` 事件（`packages/core/src/protocol/events.ts:58`）只带 token 数 |
| 丢弃压缩结果 | `packages/core/src/session.ts:1081` | `if (!modelHistory.repaired) this.history = next.value;` |
| 压缩预算=纯消息 | `packages/core/src/loop/agent-loop.ts:131-138` | `maxTokens = contextWindowTokens`，`retainTokens = retainContextTokens`；不含 system/tools/输出 |
| 估算器计入 replay | `packages/core/src/context/compaction.ts:22-38` | 只剥 `usage`/`contextSample`；assistant 的 `dshReplay`/`providerReplay` 仍进 JSON |
| 压缩失败静默 | `packages/core/src/context/compaction.ts:57,100,116`；`agent-loop.ts:145-147` | 返回 `compacted:false` 时 loop 不产生事件、不打日志 |
| 窗口解析 | `packages/core/src/session/runtime.ts:166,203-207` | `contextWindowTokens = config.contextWindowTokens ?? model.contextWindow`，`source='config'\|'model'` |
| 输出上限来源 | `packages/core/src/providers/pi-catalog.ts:118` | `maxTokens` 缺省 128000；`ResolvedSessionRuntime.modelDescriptor.maxTokens` |
| Web 组装 | `packages/web/src/main.ts:170-205` | `composeSession` 传 `contextWindowTokens`、`retainContextTokens`；未传输出预留 |
| 服务端丢投影 | `packages/web/src/server.ts:1523-1534` | `runningNow` 时 `estimatedMessageTokens`/`projection` 置空 |
| ContextMeter 回合内不刷新 | `packages/web/ui/src/components/ContextMeter.tsx:28,59-102` | `POLL_MS=5000`；`:68` `if (busy && loaded) return;`；`:101` 无数据不渲染 |
| 读数工具 | `packages/web/ui/src/lib/context-reading.ts` | `carryProjection` / `contextOccupancy` 语义需保留 |
| 统计条无数据即消失 | `packages/web/ui/src/components/SessionStats.tsx:89,119,157` | steps=0 隐藏、无 usage 隐藏、无 metrics 整体返回 `null` |
| 统计条是整会话累计 | `packages/web/ui/src/components/SessionStats.tsx:117-130`、`packages/web/ui/src/lib/session-metrics.ts:80-88` | `UsagePill` 显示 `usage.inputTokens + outputTokens`，按每个 assistant 请求累加**整个会话**；与 ContextMeter 的当前占用是两个口径 |
| 空 metrics | `packages/web/ui/src/lib/session-metrics.ts:16` | `emptyMetrics()` 已存在 |
| 右栏单视图 | `packages/web/ui/src/components/RightPanel.tsx:36,59-70,184-190,210-274` | `RightView` 标量 + 单个 tab 按钮；无关闭；`terminal` 无内容分支 |
| 面板状态散落 | `packages/web/ui/src/app.tsx:77-98,129-172,239,254,358-370` | `rightView`/`preview`/`planDoc` 三份状态；切会话归零；Header 强制 guide |
| 3 秒全量详情 | `packages/web/ui/src/lib/store.ts:1226-1239` | `scheduleDiscovery()` |
| 2 秒固定重连 | `packages/web/ui/src/lib/store.ts:1455-1476` | 状态流异常关闭后固定 2000ms |
| 结束对账现状 | `packages/web/ui/src/lib/store.ts:1372-1407,1409-1426,2465-2500` | `observeSessionStatus` 只刷列表；`finishObservedRun` 各自 `loadDetail` |
| 全量替换 | `packages/web/ui/src/lib/store.ts:1706-1790` | 一次 patch 全部字段；不比较相等 |
| 不稳定 key | `packages/web/ui/src/lib/events.ts:5-10,804-880` | 全局自增 id；两次 hydrate 同内容不同 id；`ConversationView.tsx:425` 用 `key={item.id}` |
| SSE 无心跳 | `packages/web/src/server.ts:364-425,1123-1150` | 只写一次 `: connected`（`:1132`） |
| 草稿只有文本 | `packages/web/ui/src/lib/composer-drafts.ts:1-126` | 文本 `localStorage`，`MAX_DRAFTS=32` |
| 附件只在内存 | `packages/web/ui/src/components/Composer.tsx:255-310,744-782,962-990` | key 变化 `setAttachments([])` |
| 附件约束 | `packages/web/ui/src/lib/wire.ts:613-660` | 8 个 / 单元 8MiB / 总 20MiB、`attachmentLimitError`、`restoreSendAttachment` |
| 文案键 | `packages/web/ui/src/lib/i18n.ts:140,713,789-793`；`Sidebar.tsx:423-429`；`app.tsx:268` | `'Automations'` 与 `'Automation tasks'` 两套措辞 |
| 自动化页轮询 | `packages/web/ui/src/components/AutomationPage.tsx:148` | 15 秒 |

### 3.2 命令

```bash
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest run（node 环境，include packages/*/src/**/*.test.ts）
pnpm vitest run <file>    # 单文件
pnpm web:build            # vite build（packages/web）
git diff --check
```

测试环境为 **Vitest node + `renderToStaticMarkup` SSR**（`vitest.config.ts`）：没有 jsdom，也没有 `indexedDB`。交互行为只能靠纯函数与服务端契约测试覆盖，其余见 §10.2 手工验收。

### 3.3 参考来源与限制

- **DSH**（`../deepseek-harness`，只读参考）可借鉴并采用的模式：
  - 每会话布局状态：`packages/client/ui-sidebar-right/src/client/stores.ts:95`（`bySession`）；
  - page 单例 / 资源去重：`stores.ts:225-237`（用 `{closeTab},{focusTab,existing}` 合并）；
  - 关闭选邻：`packages/client/ui-dockkit/src/engine/tree.ts:255-259`（`remaining[max(0, removedIndex - 1)]`），`engine/operations.ts:199`；
  - 最后内容页关闭后回到默认页：`stores.ts:441-455`（`canCloseTab` + reseed）。
  不引入 Dockkit、Cordis、浮动/拖拽/分屏/布局历史。
- **zcode**：仓库无源码（仅 `.zcode/plans/*.md` 历史计划与 `.zcodeignore`），只能作为「模型推 usage → 前端增量更新 → 重连/刷新用快照恢复」的行为参照，不复制其 token 算法，不引用其代码路径。
- 不可新增依赖（`package.json` 不动）：因此没有 `fake-indexeddb`、没有 testing-library、没有 jsdom —— 附件 IDB 测试需要自己写假 `IDBFactory`（工作量见 T10）。

### 3.4 与给定方案的冲突/偏差（执行时按此处理，不扩大范围）

1. **`/context` 运行中语义与既有文档、测试冲突**：`docs/web-api.md:190`、`docs/design/session-state.md:137`、`docs/implementation/web.md:502-505` 写「回合中不返回估算」；`packages/web/src/server.test.ts:403-415` 断言运行中返回 `{}`。按用户决策改为运行中返回投影，必须同改这三处文档与该断言。
2. **`SessionStats` 既有测试与「首屏显示 0」冲突**：`packages/web/src/session-stats.test.ts` 的「renders nothing until the session reports a reading」与 `steps.started === 0` 断言需改写。
3. **`RightPanel` props 变更破坏两处 SSR 测试**：`header-trajectory.test.ts:57`、`preview-viewers-ui.test.ts:56,72` 直接传 `view`/`preview`，需同步改写。
4. **`Automations` 键被两处复用**：`Sidebar.tsx:425`（导航可见文本）与 `app.tsx:268`（自动化面板 `aria-label`）。改键后 aria-label 同步变「自动化」，属「依赖它的 aria」范围；页面标题/错误文案用 `'Automation tasks'`，不动。
5. **`terminal` 标签无内容渲染分支**：本次只保证标签壳正确。
6. **压缩结果不落盘**：回合中投影用压缩后快照；刷新后到下一轮请求前只能用完整日志重算，读数可能先偏大再回落。保留为已知限制。
7. **其它 host 持有的运行中回合**：本 host 没有 live Session 时 `/context` 仍无投影，前端保留上次读数。
8. **node 测试环境无 IndexedDB**：适配器必须接受注入的 `IDBFactory | undefined`，可测逻辑（校验/上限/键派生/清理决策）放在纯函数里。
9. **`followRun` 的 1.5 秒重连**不在问题 4 的定位清单内（只在运行中 follow 断线时触发），本次不改。
10. **问题 7 牵连既有「小窗口测试」**：`packages/core/src/loop/agent-loop.test.ts:76,416,430,449` 用 `contextWindowTokens: 8/10/100` 等构造，隐含「window == 消息预算」。改为有效预算后这些用例可能翻转，必须在同一改动里复核并显式改写（不是「测试挂了再凑」）。
11. **问题 7 牵连 `session.test.ts:729`**（`repairs incomplete batches before compacting history for the next request`）：它断言第二回合**仍**发生压缩，正是「丢弃压缩结果」的编码。采纳压缩历史后该断言需要改写。
12. **问题 7 与 `/context` 字段**：`window.tokens` 仍是「模型窗口（配置覆盖优先）」，有效消息预算是内部派生值。要在 UI 暴露有效预算就必然新增字段，与「HTTP 不变」冲突，故不暴露；一致性验收口径见 §10.1-T15 与 §7.4。
13. **估算器剥离 replay 会让既有 `contextSample` 的 `historyHash` 失效一次**：`contextHistoryHash` 与估算共用同一剥离函数后，升级后的第一次请求会回落 `source:'estimate'`，之后自动恢复 `usage`（一次性、可接受）。
14. **「500000」不是上下文占用的同义词**：`UsagePill` 是整会话累计（`SessionStats.tsx:117-130`），ContextMeter 是当前占用。实现与验收都不得用累计值判断压缩是否失效，判别方法见 §4.7.1 与 §10.2-17。

---

## 4. 逐项根因

### 4.1 问题 1：上下文环回合后才统计

- 证据：`ContextMeter.tsx:68` 回合内只取一次（`busy && loaded` 早退）；`server.ts:1523-1528` 运行中丢弃；`session.ts:512-515` `activeTurn` 直接 `undefined`。
- 根因：三层「回合中不给读数」的保守设计叠加。

### 4.2 问题 2：输入框下读数延迟出现

- 证据：`SessionStats.tsx:89,119,157` 三处「无数据返回 null」；`ContextMeter.tsx:101` 无数据返回 null，草稿不在 `pollable` 内。
- 根因：首屏没有「零值/未知占位」概念，数据到达前整条消失，表现为延迟出现与布局跳动。

### 4.3 问题 3：右侧标签无关闭 X

- 证据：`RightPanel.tsx:36,184-190` 单标量 + 单按钮；`app.tsx:77-82` 视图与资源分离。
- 根因：没有标签集合，缺少身份、去重、关闭语义。

### 4.4 问题 4：约 2 秒的请求与可见刷新

- 证据：
  1. `store.ts:1226-1239` 每 3 秒全量详情；
  2. `store.ts:1455-1476` 固定 2 秒重连，服务端无心跳（`server.ts:1132` 后无写入）；
  3. `loadDetail` 全量替换（`store.ts:1706-1790`）+ 不稳定 id（`events.ts:5-10`）+ `key={item.id}`（`ConversationView.tsx:425`）→ 重挂载；
  4. 每次 patch `emit()`（`store.ts:697-705`），整棵订阅树重渲染。
- 根因：轮询替代事件、无心跳导致重连抖动、不稳定 identity、全量替换四者叠加；左侧列表被 store 级 `emit` 带出「刷新」。

### 4.5 问题 5：侧边栏「自动化任务」

- 证据：`i18n.ts:140` 的 `'Automations': '自动化任务'` 被 `Sidebar.tsx:425` 使用；页面标题用 `'Automation tasks'`（`i18n.ts:713`）。
- 根因：导航与页面共用措辞，导航需要更短的产品名词。

### 4.6 问题 6：草稿文本有缓存、图片/文件没有

- 证据：`composer-drafts.ts` 只处理文本；`Composer.tsx:267,299` 附件是内存状态并在 key 变化时清空；发送成功后只清文本（`:683-689`）。
- 根因：附件从未进入任何持久层，生命周期与文本不一致。

### 4.7 问题 7：300000 窗口下到 500000 仍不自动压缩

先分清两个口径，否则会归错因：

- **ContextMeter 的百分比 = 下一次请求的上下文占用**：`projection.projectedTokens / window.tokens`（system + tools + messages，见 `server.ts:1493-1545`、`ContextMeter.tsx:144-146`）。
- **`SessionStats` 的 `UsagePill` = 整会话累计 token**：`SessionStats.tsx:117-130` 取 `stats.usage.inputTokens + stats.usage.outputTokens`，而 `session-metrics.ts:80-88` 对每个 assistant 请求累加。一次长会话累计 500k 完全正常。

也就是说，用户报的「500000」在未区分口径前**不能直接当作 provider 的上下文占用**。下面按优先级列出原因，主因决定「压缩是否/何时发生」，显示与配置口径决定「用户看到了什么、是否误判」。

**主因（按优先级）**

1. **预算语义错误（主因）**：`contextWindowTokens` 被当成纯消息预算（`agent-loop.ts:130-138`），而窗口还必须容纳 system prompt、tool JSON schema 和模型输出。300k 窗口下，只有消息估算超过 300k 才压缩——此时真实请求必然已经超过窗口。
2. **`repaired` 时压缩结果被整体丢弃（主因）**：`session.ts:1081` 只在 `!repaired` 时采纳 loop 返回的历史；文档也已明文记录（`docs/design/session-state.md:191`、`docs/architecture.md:39`）。表现是回合内压缩、回合结束读数又回到压缩前，观感即「一直不压缩」。
3. **压缩失败不可观测（主因）**：`compactMessages` 在「没有可移除的组」或「摘要没有变小」时返回 `compacted:false`（`compaction.ts:57,100,116`），loop 只在成功时 yield `context.compacted`（`agent-loop.ts:145-147`），失败既无事件也无日志 —— 用户无法判断是「没触发」还是「触发但失败」。
4. **窗口缺失时完全不压缩（主因）**：`contextWindowTokens` 为 `undefined` 时 loop 跳过自动压缩（`agent-loop.ts:130`），且没有任何提示。
5. **显示口径混淆（主因之一）**：`UsagePill` 的 `{count} tok` 是整会话累计（`SessionStats.tsx:117-130`），ContextMeter 的百分比与 `~X / Y` 是当前占用（`ContextMeter.tsx:144-146`），两者相邻显示、文案都只说 `tok`。长会话里「累计 500k + 占用 40%」极易被读成「到了 500k 还没压缩」。**这是「500000 仍不压缩」最可能的直接来源，而不是压缩器失效。** 本轮必须把两个口径在 UI 上标清楚（§6.1-A4/A5、F4/F5/T9）。

**次要**

6. **估算口径：方向是高估，不是低估**：`estimateMessageTokens` 只剥 `usage`/`contextSample`，`dshReplay`/`providerReplay` 仍参与 JSON（`compaction.ts:22-38`）；实际 wire 是用 replay 块渲染的（`packages/core/src/providers/dsh-messages-serialize.ts:47-96`、`pi-model.ts:56-90`），且 replay 的 text/tool_use 必须与可见 content 一致（序列化前校验），因此当前是「同一份正文与工具参数计两次 + 签名/块包装开销」→ 局部高估。
   调查证据：三份真实会话在剥离 replay 后，估算/真实用量为 **0.92–1.09×（基本准确）**；当前重复计入造成的偏差是 **1.16× / 1.58× / 3.48×（高估）**。
   结论：**估算不是「门禁滞后于显示」的原因**；它会让压缩略微提前。修掉它仍是真缺陷（避免过早压缩），但「压缩之后仍可能超限」只能靠主因 1 的输出预留解决，不能靠调估算系数。

### 4.7.1 归因（待判别，不是已确认事实）

同一个「500000」有三种可能来源，互不排斥；实现前先按 §10.2 的四数对照判别，不要默认是压缩器 bug：

| 可能 | 说明 | 判别方法 |
| --- | --- | --- |
| (a) 看到的是整会话累计 | `UsagePill` 把整会话所有请求的 input+output 相加（`SessionStats.tsx:117-130`、`session-metrics.ts:80-88`），与当前上下文占用无关 | 同一时刻记录四个数：`/context` 的 `window.tokens`、`projection.projectedTokens`、ContextMeter 弹窗 `~X / Y`、`UsagePill` 的 `{count} tok`。若 `{count}` 远大于 `projectedTokens`、且环形百分比正常（如 40%），即为口径问题 |
| (b) 当前会话绑定的是另一个模型 | 300k 那条设置属于另一个模型，会话实际用默认 role 模型（例如 1M 窗口），所以 `window.tokens` 是 1048576，压缩自然按 1M 判断 | 看 `/context` 的 `window.tokens` 与 `window.source` 是否等于 300000；用两个不同窗口的模型对照切换。配置链路本身可达：SettingsModels → `models[].contextWindow`（`model-settings.ts:206,223-226`）→ `runtime.ts:166` → `main.ts:190` |
| (c) `repaired` 采纳导致回合后回跳 | 回合内确实压缩过，但回合结束时压缩结果被丢弃，读数回到压缩前 | 回合中记录环形与 `projectedTokens`，回合结束再看；若先降后回升、且日志里出现过 `trace/context.compacted`，命中 (c)（T15 覆盖修复） |

判别顺序建议：先用四数对照排除 (a)，再用 `/context` 的 `window.tokens` + 模型选择器排除 (b)，最后用「回合内 vs 回合后」对比确认 (c)。无论命中哪一种，主因 1–4 的修复都要做（它们决定压缩本身是否正确）。

---

## 5. 候选方案与取舍

### 5.1 上下文更新（问题 1）

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A0（现状） | 回合中不投影 | 零风险 | 用户明确拒绝 | 否 |
| A1（推荐） | AgentLoop 新增单一 `onTurnHistory(messages)` 回调，在初始历史、queued 追加、压缩替换、assistant 推入、tool 结果推入（含 `afterToolBatch`）后同步推送快照；Session 只在回合开始时初始化快照、之后靠回调更新、`finally` 清空；`contextProjection()` 回合中用快照、空闲用 `history`；server 不再因 `runningNow` 隐藏字段 | 不读 loop 私有数组；压缩后读数正确；与 `history` 不会在下一步互相覆盖；天然对齐 step 边界 | 需要新增一个内部可选 dep；每次回调浅拷贝数组 | **采用** |
| A2 | 回合中直接投影 `this.history`，不处理压缩 | 改动最小 | 压缩后明显偏大，违反「压缩后以最新 history 生成」；且 `repaired` 采纳会让快照落后 | 否 |
| A3 | loop 把完整消息数组塞进事件流 | 客户端也能拿到 | 事件体积爆炸、协议大改、日志污染 | 否 |

补充决策：
- 快照与 `history` 同样是浅拷贝（消息对象不可变，唯一例外是 tool 消息 `results.push`，共享对象带来的「快照略新」无副作用）。
- **不**把压缩结果直接写回 `this.history`（只在回合结束时按 §6.2 的采纳规则处理），保持「transcript 是精确事件记录」。
- 前端触发点：`turn.start`、`assistant.message`、`tool.result`、`turn.end`。工具结果推入后读数就应可见（工具输出也是上下文成本），不再等下一次 assistant。
- 回调契约：**同步**、不接受 Promise、AgentLoop 不 `await`；Session 实现只做赋值（不会抛）。若未来实现抛错，按回合失败暴露，**不吞异常**（写入 §6.1 契约）。

### 5.2 自动压缩预算（问题 7）

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| P0（现状） | `contextWindowTokens` 即消息预算 | 简单 | 就是问题 7；system/tools/输出不计入 | 否 |
| P1（推荐） | 保持 `contextWindowTokens` = 窗口；在 **AgentLoop 每步**用 `system + toolSpecs` 的现成估算和新增的 `outputTokenReserveTokens` 派生有效消息预算；窗口/接口语义不变，估算最近真实 | 位置最小（loop 每步已有 system 与 specs）；不新增 HTTP 字段；`/context` 的 `window` 语义不变；可单测 | 需要新增一个可选 Session/loop 选项；每步多一次 system/tools 估算（可忽略） | **采用** |
| P2 | 在 RuntimeResolver 里直接算出「消息预算」并替换 `contextWindowTokens` | 配置层一次算清 | 解析期拿不到最终 tool specs（含 MCP 工具）与动态 system；`/context` 的 `window` 会变成消息预算，与 Meter 分母（含 system/tools 的投影）冲突；`revision` 需重算 | 否 |
| P3 | 只在 UI 上提示用户手动调小 `contextWindowTokens` | 零代码 | 用户已明确这是 bug | 否 |

> 取舍说明：P1 只修「预算语义」这一条主因，不解决显示口径（§4.7-5）与「失败静默」（§4.7-3）；三者必须同批交付，否则用户仍会拿累计值判断压缩是否生效。

### 5.3 刷新策略（问题 4）

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| C0（现状） | 3 秒详情 + 2 秒固定重连 | 简单 | 就是抱怨来源 | 否 |
| C1（推荐） | 删除 `scheduleDiscovery`；详情由事实驱动：`session.status` 的 `running:true→false` 且本 tab 无 follow 观察者时**按 key+turn 去重地**对账一次；运行中用 follow；显式入口（Retry、首次选择会话）保留；服务端 workspace SSE 加 15 秒注释心跳；客户端指数退避（1s→…→30s，收到数据归零，只在「曾经连通过」时重连） | 空闲零详情请求；无新接口 | 别的标签页改了非运行类元数据不会即时同步（现有 UI 也没这个能力） | **采用** |
| C2 | 把轮询拉长到 15/30 秒 | 改动最小 | 仍是周期性全量替换，核心抱怨未解，且与自动化页 15 秒叠加更难解释 | 否 |
| C3 | WebSocket / 新事件推完整详情 | 最实时 | 新协议、广播全字段、背压与安全成本高 | 否 |

同时必须做的稳定性改造（否则「无请求」仍会闪）：确定性 transcript id + 等价响应不 patch（§6.4）。「无请求」目标只针对会话详情 GET；自动化页 15 秒、ContextMeter 空闲校准、运行中的 follow 流不在目标内（口径见 §10.2）。

### 5.4 附件存储（问题 6）

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| D0 | 塞进 localStorage | 复用现有代码 | 20MiB 上限 + base64 膨胀 ≈ 27MB 字符串，超常见配额；同步阻塞主线程 | 否 |
| D1（推荐） | 原生 IndexedDB 封装（无依赖），一个 draft key 一条记录；写入前用现有上限校验，读回再校验并丢弃坏记录；不可用/超额降级为内存 + 明确提示 | 容量够、异步、可原子替换 | 需要 IDB 样板；node 环境无 IDB，测试成本真实存在（T10） | **采用** |
| D2 | 只持久化图片 | 体积小 | 用户要求图片与普通文件都恢复 | 否 |
| D3 | 服务端持久草稿 | 跨设备 | 新接口（违反 HTTP 不变）、隐私面变大 | 否 |

补充决策：文本仍在 `localStorage`；附件记录用**同一个 draft key**（`composerDraftKey()` 结果，形如 `new:<ws>` 或 `JSON.stringify([ws,sid])`），两者一起写、一起清、一起迁移；内存里保持 base64 字符串（与 `SendAttachment.data` 一致）；整条记录替换（移除即一次 `put`）。

### 5.5 标签状态放哪里（问题 3）

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| T1（推荐） | 纯 reducer `ui/src/lib/right-panel-tabs.ts` + `App` 持有 `Map<layoutKey, layout>` | **采用**：可单测、无 React 依赖、布局与视图同源 |
| T2 | 放进 `AppStore` | 否：纯 UI 状态会污染所有订阅者 |
| T3 | 引入 Dockkit | 否：用户明确不引入 |

---

## 6. 技术方案与关键决策

### 6.1 A：上下文与首屏读数

**A-1 Session 侧（core）**

```ts
// packages/core/src/session.ts
#projectionHistory: readonly Message[] | undefined;   // 仅回合内

contextProjection() {
  const history = this.activeTurn ? this.#projectionHistory ?? this.history : this.history;
  return projectContext(projectImageInput(projectCommandInput(prepareModelHistory(history).messages), this.modelCapabilities?.imageInput),
    this.systemText(), this.visibleToolSpecs(), this.contextProvider, this.contextModel);
}
contextMessageEstimate() {
  const history = this.activeTurn ? this.#projectionHistory ?? this.history : this.history;
  return estimateModelHistory(history, this.modelCapabilities?.imageInput);
}
```

- 构造 loop 时传 `onTurnHistory: (messages) => { this.#projectionHistory = messages; }`。
- `runTurn`：进入时 `this.#projectionHistory = this.history`（初始化），`finally` 中置 `undefined`；**不再**在 `assistant.message` / tool 分支里自己刷快照（避免与 loop 的压缩结果互相覆盖）。
- 空闲投影继续用 `this.history`（回合结束后它可能已被压缩历史采纳，见 §6.2），因此读数在回合结束后不会跳回压缩前。

**A-2 AgentLoop 回调契约**

```ts
// packages/core/src/loop/agent-loop.ts
/** 同步推送「下一次请求会发送的消息」快照；不得 await、不得抛错。 */
onTurnHistory?: (messages: readonly Message[]) => void;
```

调用时机（全部同步，传 `messages.slice()`）：
1. `run()` 入口，`const messages = [...history]` 之后；
2. 每步 `messages.push(...queued)` 之后；
3. 压缩 `messages.splice(...)` 之后（`context.compacted` yield 之前）；
4. `messages.push(assistant)` 之后；
5. tool 结果 `messages.push({role:'tool',...})` 之后；
6. `afterToolBatch` 结果 push 之后。

异常/异步：AgentLoop 不 `try/catch`、不 `await`。Session 的实现只有一次赋值，不会抛；若将来实现抛错，回合按失败处理（不静默吞掉）。

**A-3 Web Host（server）**

```ts
const runningNow = running.has(key) || sharedSession?.activeTurn === true || live?.activeTurn === true;
const estimatedMessageTokens = live ? live.contextMessageEstimate?.()
  : runningNow ? undefined : estimateModelHistory(projectMessages(handle.events));
let projection = live?.contextProjection?.();
if (!live && !runningNow && runtime && options.replayContext) { /* 保持现状 */ }
```

- 字段与语义不变；唯一变化是本 host 持有 live Session 时运行中也带 `projection`/`estimatedMessageTokens`。
- 无 live Session（别的 host 持有回合）仍返回空投影。

**A-4 ContextMeter（前端）**

- 新增 prop `turnTick: number`（来自新字段 `SessionEntry.contextTick`），在 `turn.start` / `assistant.message` / `tool.result` / `turn.end` 时由 store 递增。
- effect 依赖 `[pollable, workspaceId, sessionId, scope, modelSaving, turnTick]`，进入即发一次请求（删除 `busy && loaded` 早退）；`busy` 时不设定时器；空闲保留 `IDLE_POLL_MS = 15_000` 校准。
- 陈旧响应：`AbortController` + `current` + `snapshot.scope` 三重校验；失败保留上次（`carryProjection`）。
- **全部空状态（逐条实现，不许留空白）**：

| 状态 | 渲染 | 请求 | 说明文案 |
| --- | --- | --- | --- |
| 无工作区（`workspaceId === null`） | 不渲染 | 不发 | — |
| 草稿（`draft === true`，有 workspace） | 环形 0% | 不发 | 弹窗「还没有读数。」 |
| 会话已选、首次响应未到 | 环形 0% | 发 1 次 | 同上 |
| 响应无 `projection`（别的 host 持有回合） | 保留上次已结算投影；无则 0% | 按 tick/校准 | 有上次则不提示；无则「还没有读数。」 |
| 有投影、无 `capacity` | 环形 0%，明细照列 | — | 「This model has no known context window.」 |
| 请求失败 | 保留上次 | 下次 tick/校准再试 | 不提示 |
| scope 变化（会话/模型） | 清空后按上表 | 重新发 | — |

- **口径标注（本轮新增，防误判）**：弹窗里的 `~X / Y`（`ContextMeter.tsx:144-146`）必须让人看出 `Y` 是**本会话模型窗口**，而不是整会话累计：
  - figures 元素加 `title` + `aria-label`（新键 `'The denominator is this session’s model window.'`，见 §7.5）；
  - 弹窗底部加一行可见说明（同一键，`role="note"` 或普通 `<p>`），仅在 `projection !== undefined && capacity !== undefined` 时显示；
  - 不新增数字、不改分母来源（仍是 `contextCapacity()` 的结果）。

**A-5 SessionStats（前端）**

- `const stats = entry?.run?.metrics ?? entry?.metrics ?? emptyMetrics();`（`entry === null` 也用空 metrics）。
- `ActivityPill`：删除 `steps.started === 0` 早退，显示 `0 turns 0 steps`。
- `UsagePill`：主读数改成**整会话累计**口径，使用新键 `'Session total {count} tok'`（中文「整会话累计 {count} tok」）替换现有的 `'{count} tok'`；无 usage 时显示「整会话累计 0 tok」；缓存命中显示 `—`（新键）；不得把未知命中率显示为 0%/100%。
- 明细弹窗（`会话统计 / Token usage`）里的行项目保持不变，不改累加算法、不改 `SessionMetrics` 类型。
- 有数据时其余行为、`memo`、明细弹窗交互全部不变。

### 6.2 F：自动压缩预算与结果采纳（问题 7）

**F-1 估算器只算 wire 内容（core）**

```ts
// packages/core/src/context/compaction.ts
/** 剥掉全部本地计量/回放元数据；不改持久化，不重建消息。 */
export function wireVisibleMessage(message: Message): Message
export function estimateMessageTokens(message: Message): number   // 基于 wireVisibleMessage
```

- 剥离字段：`usage`、`contextSample`、`dshReplay`、`providerReplay`（含未来新增的本地元数据时，此函数是唯一入口）。
- 同一函数供 `estimateMessages`、`estimateModelHistory`、`context/projection.ts` 的 `requestMessages`（影响 `contextBreakdown` 与 `contextHistoryHash`）使用。
- 已知后果：升级后首次请求 `source` 回落 `estimate`（§3.4-13）；丢失 replay 里 `thinking`/`signature` 的少量增量（它们确实上 wire），属于可接受的轻微低估，远好于当前重复计入造成的 1.16× / 1.58× / 3.48× 高估（调查证据，见 §4.7-6）。
- 同时修掉 `requestMessages` 只剥 usage/contextSample 的不一致（`projection.ts:10-16`）。

**F-2 有效预算（core，最小实现）**

契约（写入 §7.4）：

```
window            = contextWindowTokens = config.contextWindowTokens ?? descriptor.contextWindow   // 不变，/context window.tokens 报它
outputReserve     = min(outputTokenReserveTokens ?? floor(window * 0.2), floor(window / 2))
overhead          = systemTokens + toolsTokens          // 用 contextBreakdown(system, specs, []) 的同一估算
rawBudget         = window - overhead - outputReserve
rawBudget < 1      → 逐回合致命配置错误（见下），不调用 provider
messageBudget     = max(1, rawBudget)                  // 仅在校验通过后作防御性钳制，不得用来掩盖预算不足
retainTokens      = min(config.retainContextTokens ?? floor(messageBudget * 0.25), max(0, floor(messageBudget / 2)))
```

- 新增 `SessionOptions.outputTokenReserve?: number` → `AgentLoopDeps.outputTokenReserveTokens?: number`；Web 侧由 B7 的 `modelBudgetOptions(resolved)` 在 `composeSession` 传入 `resolved.modelDescriptor?.maxTokens`（缺省不传）。
- AgentLoop 每步**解析一次** `system` 字符串与 `toolSpecs()` 并复用（不要为了估算二次调用，二者可能有动态行为）；用 `contextBreakdown` 取 `systemTokens/toolsTokens`。
- 手动压缩路径保持 `maxTokens = max(1, floor(beforeTokens / 2))`，`retainTokens` 同样按上式钳制。
- **预算不足必须终止回合，不得 clamp 后继续请求**：当 `rawBudget < 1`（即 `window <= overhead + outputReserve`）时，AgentLoop 在该步**模型调用之前** `yield { type: 'error', error }` 再 `yield { type: 'turn.end', reason: 'error' }` 并 `return`，**不调用 provider**、不再压缩、不再进入下一步。
  - `error.code = 'CONTEXT_BUDGET_TOO_SMALL'`（有 code 才会被 `appendTrace` 记入持久日志而不被折叠成通用文案），`error.message` 必须是可读、无敏感信息的一段话，包含：`window`、`systemTokens`、`toolsTokens`、`outputReserve`、`rawBudget`，以及调整建议（调大 `contextWindowTokens`/模型 `contextWindow`、调小 `maxTokens`、或减少工具）。
  - 示例：`Context budget too small: window=300000, system=12000, tools=8000, outputReserve=128000, remaining=-1000. Raise contextWindowTokens/model contextWindow, lower maxTokens, or reduce tools.`
  - 该错误同样经 `console.warn` 打一行（便于现场排查），但**告警不是唯一动作**：回合必须以 `error` + `turn.end(error)` 结束。
- 校验通过后 `messageBudget >= 1` 才继续；`max(1, rawBudget)` 只是防御性写法，不得作为「钳到 1 继续跑」的实现。
- `retainTokens <= messageBudget/2`；压缩每步最多尝试一次，步数受 `maxSteps` 约束；无进展时 `compactMessages` 返回 `compacted:false`、历史不变（见 F-3），与预算不足是两回事。
- `contextWindowTokens === undefined` 时保持「不自动压缩」（不是错误），但每回合 `console.warn` 一次提示「未配置窗口，自动压缩已关闭」。

**F-3 压缩失败可观测（core）**

- 当 `beforeTokens > messageBudget` 且 `compactMessages` 返回 `compacted:false` 时，`console.warn` 一行（每回合最多一次）：
  `[agent-loop] context over budget but compaction made no progress: before=320000 budget=172000 removed=0`
- 不新增事件类型、不改 `/context`、不新增 API；`trace/context.compacted` 语义不变（只在成功时记录）。
- 明确的「失败于何因」在日志里区分两种：`removed=0`（无可移除组，通常是 protected 当前消息过大）与 `no-reduction`（摘要未变小）。

**F-4 采纳已修复且压缩后的历史（core）**

```ts
// session.ts runTurn
let compactedThisTurn = false;   // 收到 context.compacted 事件时置 true
...
if (!modelHistory.repaired || compactedThisTurn) this.history = next.value;
```

- 语义：`repaired=false` 时行为不变（采纳 loop 返回）；`repaired=true` 且本轮压缩过时**也采纳**，避免压缩结果被整体丢弃 → 下一回合不必重复压缩、空闲读数不会回到压缩前。
- 不伪造日志：`this.history` 被替换，但**不追加任何事件**，磁盘日志仍是精确记录（压缩摘要、修复出来的占位 tool 结果都不落盘）。`session.messages` 在「repaired+compacted」后可能与 `projectMessages(events)` 不同，这与现有「非 repaired 时采纳压缩数组」的行为一致（`session-state.md:190` 已有同源说明）。
- 文档同步：`docs/design/session-state.md:184-196`、`docs/architecture.md:39` 的「repaired 时压缩结果被整体丢弃」改为新规则，并保留「压缩不落盘、重开会话可能再次压缩」的限制。
- 既有测试改写：`packages/core/src/session.test.ts:729` 现在断言「第二回合仍压缩」，改为断言「第二回合不再重复压缩（历史已采纳）、日志未出现摘要事件、tool 结果仍成对」。

**F-5 集成验收（问题 7）**

- 新增共享小模块 `packages/web/src/session-options.ts`：`export function modelBudgetOptions(resolved): { contextWindowTokens?: number; outputTokenReserve?: number; retainContextTokens?: number } | {}`，`composeSession` 与测试共用，避免测试复制组装逻辑（`main.ts` 不能直接 import，它会在导入时启动 host）。
- 集成链路：配置文件 300000 窗口 + `maxTokens` → `RuntimeResolver.resolve` → `modelBudgetOptions` → `new Session(...)` → 下一次请求前压缩。
- 验收同时覆盖「UI 当前选中模型预算生效」：配置两个窗口不同的模型（如 1M 与 300k），选中 300k 后 `/context` 的 `window.tokens === 300000`，且新建 Session 收到同一个窗口；绝不是另一个模型（默认 role 的 1M）的值。

### 6.3 B：右侧多标签

**B-1 reducer（新文件 `packages/web/ui/src/lib/right-panel-tabs.ts`）**

纯函数、无 React、无 store 依赖；类型见 §7.2。规则：

- `tabs[0]` 恒为 `guide`，`guide` 不可关闭（无 X）。
- 单例 kind：`guide` / `files` / `terminal` / `observe` / `plan`；资源 kind：`preview`，id = `preview:<workspaceId>:<encodeURIComponent(path)>`，身份 = workspaceId + path（`line` 不参与身份）。
- `open`：单例已存在 → 激活，`plan` 同时覆盖 payload；`preview` id 已存在 → 激活并合并 `line`（新值有则更新，无则保留），不新增、不挪位；否则追加末尾并激活。
- `close`：`guide` 或找不到 → 原样返回；否则删除；若关的是激活标签，取**删除后**数组的 `remaining[max(0, index - 1)]`（左邻；`index === 1` 时左邻就是 `guide`）；关非激活标签不改 `activeId`。
- 重命名：`workspaceId` 匹配且 `path === from || path.startsWith(from + '/')` 的预览标签改成 `to + 后缀`；新旧 id 冲突时保留 **`tabs` 数组中靠前者**（顺序不变），被丢弃的若正是激活标签，按 `close` 的选邻规则重选。
- 删除：`remove-preview` 关闭匹配（含目录前缀）的全部预览标签，激活标签被关时同理选邻。
- 布局按 `layoutKey`（`new:<ws>` 或 `sessionKey(ws,sid)`）存内存 Map，不落 `localStorage`；刷新回到种子布局。

**B-2 RightPanel 组件**

- props：`layout`、`onAction`、`fullscreen`、`onClose`、`onToggleFullscreen`、`onOpenFile`、`refreshToken`、`onFilesChanged`；删除 `view`/`preview`/`plan`/`onViewChange`。
- 标签条：`role="tablist"` + `aria-label`（新键 `'Panel tabs'`）。每个标签结构固定为：

```html
<div role="presentation" data-tab-id="…">
  <button role="tab" aria-selected="true|false">…标题…</button>
  <button aria-label="Close tab 文件预览｜guide.md">×</button>
</div>
```

  - 两个按钮是**兄弟**，外层是 `role="presentation"` 的 `div`（不是 `button`）—— 从结构上杜绝 `button` 嵌套；
  - 关闭按钮 `stopPropagation`，只派发 `close`，不激活标签；
  - 标签条水平可滚动（`overflow-x: auto`，隐藏滚动条），标签仍 `min-width:80px; max-width:210px`、省略号。
- 内容区：所有标签都挂载，非激活用 `hidden` + `data-active="false"`；关闭即卸载。`files` 页面在 `kind === 'files'` 时拉取（不以「激活」为条件），避免切回重复请求。
- 标题继续用 `viewTitle`（`File preview｜<文件名>` 等）；主按钮的可访问名称即标题。
- chrome 不变：guide 快捷按钮（聚焦 guide）、fullscreen（面板级）、collapse。

**B-3 App 集成**

- `App` 持有 `layoutsRef = useRef(new Map<string, RightPanelLayout>())` 与当前 `layout`；`layoutKey`：无会话或草稿时 `new:<workspaceId>`，否则 `sessionKey`。
- 会话/工作区切换 effect：取该 key 的布局，没有则 `seedLayout()`；不再把 preview/plan 归零（布局已按会话隔离）。
- Header `onToggleRight` 只 `setRightOpen(true)`（保持最后激活标签）。
- `openFile(path,{line})` → `open({kind:'preview', resource})`；`openPlanPreview()` → `open({kind:'plan', plan: planDocument})`；`planDocument` 变化派发 `set-plan`（只更新已存在的 plan 标签，不自动开标签）。
- `followFileChange`：先 `refreshToken++`，再派发 `rename-preview`/`remove-preview`；`WorkspaceFileTree.selected` = 激活标签是 preview 时的 path，否则 null。
- 关面板只关可见性，不清布局。

### 6.4 C：刷新与稳定渲染

- **删除** `scheduleDiscovery()` 与 `discoveryTimer`（含 `bootstrap` 调用、`dispose` 清理）。
- **按 key+turn 去重对账**（不靠时间猜测，也不以事件数组末尾或长度作标识）：
  - **turn 完成标识（stamp）**：在 `entry.events` 中从后向前找最近一条 `type === 'trace/turn.end'` 的事件，取其持久 `seq`（会话事件自带连续 `seq`，见 `packages/core/src/session/store.ts:101,184,207`）。`turn.end` 一经写入，同一 turn 的 stamp 不再变化；`loadDetail` 之后即使 events 变多（补进 assistant/tool 事件）也仍是同一个 stamp。
  - **fallback**：找不到 `trace/turn.end`（会话尚未完整结束过任何回合）时**跳过对账**，不做时间猜测；只有当下一次 `turn.end` 出现时才对账（T4 覆盖）。
  - **单一守卫 `reconcileOnce(key, stamp, run)`**（store 私有方法，`observeSessionStatus` 与 `finishObservedRun` 共用）：
    1. `stamp` 由调用方在**检测到本轮结束时**从 `entry.events` 取一次，之后整条链路（含 await 之后）都使用这个值，**请求返回后不得重算**；
    2. 内部维护 `Map<key, { stamp: number; status: 'pending' | 'done' }>`：`status === 'pending' || 'done'` 且 stamp 相同 → 直接返回 `false`，不发请求；
    3. 发请求前置 `pending`，`loadDetail` 成功（或判定无需更新）后置 `done`，失败则**清掉该条记录**以便下次状态变化重试（失败重试由下一次事件驱动，不自造定时器）；
    4. 只在该会话是当前会话、`run === undefined`、且本 tab 没有 follow 观察者时由 `observeSessionStatus` 调用；`finishObservedRun` 在 follow 结束后调用同一守卫。
  - 两种先后顺序都只对账一次：状态帧先到、follow 结束先到、或两者交错，都由同一 `{stamp,status}` 判重。
  - 有 follow 观察者时状态路径不额外对账（follow 结束路径已覆盖）；`running:false→true` 继续走现有 `scheduleRunningPoll` → `loadDetail` → `followRun`（一次性）。
- **SSE 退避**：`ui/src/lib/session-status.ts` 新增 `statusReconnectDelay(attempt) = min(30_000, 1000 * 2^attempt)`；store 维护 `statusAttempts`，成功读到数据块后归零，dispose/切工作区清 timer；保留「曾经连通过才重连」。
- **服务端心跳**：`SessionStatusHub.subscribe` 内部持有连接级 `setInterval`（默认 15 秒，可用 `WebHostOptions.statusHeartbeatMs` 覆盖，仅测试用），每 tick 写 `: ping\n\n`；写前检查 `destroyed/writableEnded`；`close`、hub 驱逐、`closeAll` 都 `clearInterval`；不新增帧类型。仅 workspace 状态流（follow 流不在范围）。
- **稳定 React identity**（`ui/src/lib/events.ts`）：
  - `hydrateTranscript(messages, events, previous?)`：id 改为确定性 —— user `u:<messageIndex>`、assistant `a:<messageIndex>`、tool `t:<callId>`（callId 空则 `t:<messageIndex>:<resultIndex>`）；`compaction`/`notice` 只由 live 事件产生（hydrate 不产出），live 侧继续用现有 `itemId`，不参与 reconcile 匹配；
  - 传入 `previous` 时，按「同 kind + 同 turn（user/assistant）/ 同 callId（tool）」+ 内容匹配（user：text+timestamp；assistant：text+usage；tool：callId）复用旧 `id`，迁移组件状态；
  - `loadDetail` 增加**等价跳过**：patch 前比较指纹（`transcript`/`turns` 的 JSON、`events.length`、`metrics`、header/title/permission/plan/todos/running），完全一致时只更新 `loaded/loading/request`，不替换数组、不额外 `emit`；
  - `loadDetail` 与 follow baseline 重建都传 `previous`。
- **左侧列表不被动刷新**：删除 3 秒详情后，`patchEntry` 只在真实事件与去重后的对账时 `emit`；`refreshSessions` 仍只在会话结束与显式刷新时发生一次。

### 6.5 D：草稿附件

**D-1 存储模块（新文件 `packages/web/ui/src/lib/draft-attachments.ts`）**

- 纯逻辑（可测）：`draftAttachmentBytes(data)`（base64 校验 + 字节数）、`sanitizeDraftAttachments(value,key)`（逐条 `restoreSendAttachment` shape 校验、重算字节并与 `size` 比对、套用 `attachmentLimitError` 的 8 个/8MiB/20MiB，坏记录逐条丢弃）、`draftAttachmentRecord(key,items)`（落库前同一套校验）。
- 适配器（薄）：`createIndexedDbDraftStore(factory, dbName='omniagent.drafts')` 返回 `read/write/remove/prune`，`factory` 缺失或 `open` 失败返回 `null`；`resolveDraftAttachmentStore()` 从 `globalThis.indexedDB` 取，测试注入假实现。
- 全部 IDB 调用 try/catch；配额错误归入「不可用」；不得抛到 UI。

**D-2 Composer 集成**

- 新状态：`attachmentsLoading`、`attachmentsWarning`、`attachmentGeneration`。
- key 变化 effect：递增 generation → `setAttachments([])`/清错误 → 文本沿用现有逻辑（含 `draftFollowsSession` 迁移）→ 异步 `read(key)` → 仅当 generation 与 key 仍匹配时 `sanitizeDraftAttachments` → `setAttachments`（图片补 `preview`）→ `setAttachmentsLoading(false)`；迁移时附件记录也 `read(old)→write(new)→remove(old)`；失败不阻断输入。
- **恢复期禁止新增附件**（简单且可观察，不做队列合并）：`attachmentsLoading === true` 时 `addFiles`（含文件选择、拖拽、粘贴）全部早退，`+` 按钮 `aria-disabled`，并显示「正在恢复附件…」；`onPaste` 在拦截文件前先判该状态。恢复完成或失败后恢复可交互。
- 写入：`addFiles` 成功后写一次记录；手动移除后**立即**重写记录（等于删除）；`attachmentsLoading` 期间不写（避免用空数组覆盖）。
- 发送：`canSend`/`submit` 增加 `attachmentsLoading` 守卫与提示「请等待附件恢复完成再发送。」；accepted（含 queue/steer/`/goal` 分支）后同时 `clearComposerDraft(key)` 与 `remove(key)`。
- 提示：附件栏上方 `role="status"` 小字（「本次会话内保留，刷新可能丢失。」/「正在恢复附件…」），不弹 alert、不阻塞输入。

### 6.6 E：文案

- `i18n.ts:140` 的 `'Automations'` 中文改 `自动化`（英文键不变）。
- 依赖该键的 `app.tsx:268` `aria-label` 随之变「自动化」；`'Automation tasks'`（`i18n.ts:713`）与错误文案（`i18n.ts:789-793`）保持「自动化任务」。
- `Sidebar` 其他标签不动。

---

## 7. 数据模型与接口契约

### 7.1 HTTP（不变）

- `GET .../context`：路由、字段集合不变（`estimatedMessageTokens?`、`projection?`、`modelWindow?`、`window?`）。语义变化：本 host 持有 live Session 时运行中也会返回 `projection`/`estimatedMessageTokens`；无 live Session 仍为空。**不新增字段**（有效消息预算是内部派生值）。
- `GET /api/workspaces/:ws/events`：帧类型不变，新增周期 `: ping` 注释（客户端 parser 忽略）。
- `GET .../follow`、`POST .../messages`：不变。
- `WebHostOptions.statusHeartbeatMs?: number` 是 host 组合选项（测试用），不是 HTTP 契约。

### 7.2 右栏标签类型

```ts
export type TabKind = 'guide' | 'files' | 'terminal' | 'observe' | 'plan' | 'preview';

export interface PreviewResource { workspaceId: string; workspaceName: string; path: string; line?: number }

export type RightTab =
  | { id: 'guide'; kind: 'guide' }
  | { id: 'files'; kind: 'files' }
  | { id: 'terminal'; kind: 'terminal' }
  | { id: 'observe'; kind: 'observe' }
  | { id: 'plan'; kind: 'plan'; plan: PlanDocument }
  | { id: `preview:${string}`; kind: 'preview'; resource: PreviewResource };

export interface RightPanelLayout {
  /** 不变量：tabs[0] 恒为 guide，且不可关闭。 */
  tabs: RightTab[];
  activeId: string;
}

export type RightPanelAction =
  | { type: 'open'; tab: RightTab }
  | { type: 'activate'; id: string }
  | { type: 'close'; id: string }
  | { type: 'rename-preview'; workspaceId: string; from: string; to: string }
  | { type: 'remove-preview'; workspaceId: string; path: string }
  | { type: 'set-plan'; plan: PlanDocument }
  | { type: 'set-workspace-name'; workspaceId: string; workspaceName: string };

export function previewTabId(workspaceId: string, path: string): `preview:${string}`;
export function seedLayout(): RightPanelLayout;                 // { tabs:[guide], activeId:'guide' }
export function rightPanelReducer(layout: RightPanelLayout, action: RightPanelAction): RightPanelLayout;
export function activeTab(layout: RightPanelLayout): RightTab;  // 空数组兜底返回 guide
```

### 7.3 IndexedDB 契约（`draft-attachments.ts`）

- DB `omniagent.drafts` v1；store `draft-attachments`，`keyPath: 'draftKey'`（一 draft 一记录）。
- 记录：`{ draftKey: string; attachments: Array<{ id: string; kind: 'image'|'file'; name: string; mimeType: string; data: string /* base64 */; size: number }>; updatedAt: number }`。
- `draftKey` 复用 `composerDraftKey()`，不新增编码。
- 清理：写入时按 `updatedAt` 保留最新 8 条 draft 记录；单记录内仍受 8 个/8MiB/20MiB 约束。
- 不可用/超额：视为无持久化，不阻塞、不重试风暴。

### 7.4 上下文预算契约（问题 7）

```
输入（config / descriptor）
  config.contextWindowTokens?: number        // 显式覆盖，优先级最高（语义不变）
  descriptor.contextWindow?: number          // 模型窗口
  descriptor.maxTokens?: number              // 输出上限（pi-catalog 缺省 128000）
  config.retainContextTokens?: number        // 保留偏好

派生（AgentLoop 每步）
  window        = config.contextWindowTokens ?? descriptor.contextWindow
  outputReserve = min(outputTokenReserveTokens ?? floor(window * 0.2), floor(window / 2))
  overhead      = systemTokens + toolsTokens            // 与 contextBreakdown 同一估算
  rawBudget     = window - overhead - outputReserve
  rawBudget < 1 → 回合以 error(code=CONTEXT_BUDGET_TOO_SMALL) + turn.end(error) 结束，不调用 provider
  messageBudget = max(1, rawBudget)          // 仅防御性；不得用钳制掩盖预算不足
  retainTokens  = min(config.retainContextTokens ?? floor(messageBudget * 0.25), max(0, floor(messageBudget / 2)))

报告（HTTP 不变）
  /context.window.tokens       = window                // 仍是窗口；source 仍是 'config' | 'model'
  /context.modelWindow         = descriptor.contextWindow
  有效 messageBudget 不通过 HTTP 暴露；可观测入口 = 压缩触发时机 + trace/context.compacted 的 before/after
```

- 不变量：`messageBudget <= window`；校验通过后 `messageBudget >= 1`；`retainTokens < messageBudget`（当 `messageBudget >= 2`）。
- 硬错误（不发 provider 请求）：`window` 已定义且 `rawBudget < 1` → `error`（`code='CONTEXT_BUDGET_TOO_SMALL'`，消息含 `window/system/tools/outputReserve/rawBudget` 与调整建议）+ `turn.end(error)`。
- 告警（每回合最多一次 `console.warn`，非终止）：`contextWindowTokens` 缺失（自动压缩关闭）、超预算但压缩无进展。
- `SessionOptions.outputTokenReserve` 由 Web 组装传入（`resolved.modelDescriptor?.maxTokens`）；TUI/SubagentManager 暂不接线 → 回落 `window * 0.2`（写入 §2 非目标与 §11 风险）。

### 7.5 store 与 i18n 增量

- `SessionEntry` 新增 `contextTick: number`（`emptyEntry()` 初值 0；在 `turn.start`/`assistant.message`/`tool.result`/`turn.end` 事件落入 `consumeStream` 时递增，follow 快照重放同样递增）。
- 新增 i18n 键（英文键 = 中文源串，中文映射同步补齐）：

| 英文键 | 中文 |
| --- | --- |
| `'Cache hit —'` | `缓存命中 —` |
| `'Session total {count} tok'` | `整会话累计 {count} tok` |
| `'The denominator is this session’s model window.'` | `分母为本会话模型窗口。` |
| `'Close tab {title}'` | `关闭标签页：{title}` |
| `'Panel tabs'` | `面板标签页` |
| `'No reading yet.'` | `还没有读数。` |
| `'Restoring attachments…'` | `正在恢复附件…` |
| `'Kept for this session only; a refresh may lose these attachments.'` | `本次会话内保留，刷新可能丢失。` |
| `'Wait for the draft attachments to finish restoring.'` | `请等待附件恢复完成再发送。` |

- 改键：`'Automations'` 中文 → `自动化`（英文键不变）。

---

## 8. 任务拆分

约定：每条「完成判据」都包含 `pnpm typecheck` 保持通过；测试任务单列在 §8.4，实现任务不强制自带测试，但不得让既有测试静默失效。

### 8.1 前端任务

- **F1 右栏标签 reducer**
  - 输入：§6.3-B1、§7.2。
  - 产出：`packages/web/ui/src/lib/right-panel-tabs.ts`。
  - 完成判据：导出 §7.2 全部符号；`guide` 不可关；单例合并；preview 去重并合并 `line`；关激活选左邻（`index===1` 回 guide）；重命名跟随子路径、冲突保留 `tabs` 靠前者；删除目录关闭子预览；无 React/store 依赖。
- **F2 RightPanel 多标签渲染**
  - 输入：F1；现有 guide/files/preview/plan/observe 分支与 `preview/*` 组件。
  - 产出：`packages/web/ui/src/components/RightPanel.tsx`、`packages/web/ui/src/styles/dsh/right-panel.module.css`。
  - 完成判据：`role="tablist"` + `aria-label`；标签外层 `div role="presentation" data-tab-id`，内含两个兄弟按钮（`role="tab"` + 关闭按钮 `aria-label="Close tab …"`）；关闭 `stopPropagation` 且不激活；无 button 嵌套；非激活 `hidden`；标签条可横向滚动；guide 无 X；fullscreen/collapse/guide 快捷行为不变；`files` 拉取不再依赖激活状态。
- **F3 App 集成与每会话布局**
  - 输入：F1/F2；`app.tsx` 现有 `rightView/preview/planDoc/followFileChange/openFile/openPlanPreview`。
  - 产出：`packages/web/ui/src/app.tsx`。
  - 完成判据：`layoutKey` 布局存取与恢复；Header 不强置 guide；`openFile` 去重带 `line`；`set-plan` 只更新已存在标签；重命名/删除派发对应 action；`WorkspaceFileTree.selected` 取激活预览。
- **F4 ContextMeter 事件驱动与全部空状态**
  - 输入：§6.1-A4、`context-reading.ts` 现有语义。
  - 产出：`packages/web/ui/src/components/ContextMeter.tsx`、`packages/web/ui/src/components/Composer.tsx`（传 `turnTick`）。
  - 完成判据：`turnTick` 变化（含 `tool.result`）立即请求；`busy` 无 interval、空闲 15 秒校准；失败保留上次；scope 切换丢陈旧；§6.1-A4 表格中 7 个空状态逐条实现且都有可观察文案/数值；弹窗 `~X / Y` 带 `title`/`aria-label` 与底部说明，明确 `Y` 是本会话模型窗口。
- **F5 SessionStats 零值占位**
  - 输入：§6.1-A5。
  - 产出：`packages/web/ui/src/components/SessionStats.tsx`、`packages/web/ui/src/lib/i18n.ts`。
  - 完成判据：`entry===null`/无 metrics/`steps===0`/无 usage 均渲染 `0 turns 0 steps`、`整会话累计 0 tok`、`缓存命中 —`；主读数文案使用新键 `'Session total {count} tok'`（`整会话累计 {count} tok`），与 ContextMeter 的占用百分比在视觉上可区分（ContextMeter 侧的分母说明由 F4 落地，T9 一并断言）；真实数据行为不变；累加算法与 `SessionMetrics` 类型不变。
- **F6 附件持久层适配器**
  - 输入：§6.5-D1、§7.3、`wire.ts:613-660`。
  - 完成判据：`createIndexedDbDraftStore(undefined) === null`；`read/write/remove/prune` 全部不抛；`sanitizeDraftAttachments` 丢弃坏记录并套三档上限；`draftAttachmentRecord` 落库前同一套校验；`draftKey` 复用 `composerDraftKey`。
- **F7 Composer 附件恢复/写入/清理/禁写**
  - 输入：F6；`Composer.tsx` 的 key effect、`addFiles`、`onPaste`、`submit`、附件栏。
  - 产出：`packages/web/ui/src/components/Composer.tsx`、`packages/web/ui/src/styles/dsh/composer-attachments.module.css`。
  - 完成判据：按 key 恢复（图片有预览）；generation 防串会话；**恢复期 `addFiles`/拖拽/粘贴/`+` 按钮全部不可用并显示「正在恢复附件…」**；恢复期禁止发送并提示；新增/移除立即写库；accepted 后文本与附件一起清理；不可用/超额显示「本次会话内保留，刷新可能丢失。」且不阻塞输入。
- **F8 store：去掉 3 秒轮询 + 按 key+turn 去重对账**
  - 输入：§6.4 前两条。
  - 产出：`packages/web/ui/src/lib/store.ts`。
  - 完成判据：`scheduleDiscovery`/`discoveryTimer` 删除（含 `bootstrap`/`dispose`）；stamp = 最近一条 `trace/turn.end` 的 `seq`（缺失则跳过对账）；`reconcileOnce` 守卫同时拦 `pending` 与 `done`，stamp 在检测时取一次、请求后不重算；`observeSessionStatus` 与 `finishObservedRun` 共用该守卫，任一先后顺序只对账一次；有 follow 观察者时状态路径不额外对账；`refreshSessions` 仍只在结束时一次。
- **F9 store：SSE 退避与 `contextTick`**
  - 输入：§6.4、§7.5。
  - 产出：`packages/web/ui/src/lib/store.ts`、`packages/web/ui/src/lib/session-status.ts`。
  - 完成判据：`statusReconnectDelay(0)=1000`、`(5)=30000` 上限；成功读数据后计数归零；dispose/切工作区清 timer；`contextTick` 在四个事件上递增、初值 0；无固定 2000ms 字面量残留。
- **F10 确定性 transcript id + 等价跳过**
  - 输入：§6.4 第三条。
  - 产出：`packages/web/ui/src/lib/events.ts`、`packages/web/ui/src/lib/store.ts`。
  - 完成判据：同一输入两次 hydrate 的 id 序列一致；不带 previous 时 tool id `t:<callId>`；带 previous 时内容未变的条目沿用旧 id；`loadDetail` 指纹一致不替换数组；`followRun` baseline 重建传 `previous`。
- **F11 文案**
  - 输入：§6.6。
  - 产出：`packages/web/ui/src/lib/i18n.ts`。
  - 完成判据：`'Automations'` → `自动化`；`'Automation tasks'` 与自动化页错误文案不变；新增键见 §7.5。

### 8.2 后端任务

- **B1 Session 回合内投影快照（单一回调）**
  - 输入：§6.1-A1/A2。
  - 产出：`packages/core/src/session.ts`、`packages/core/src/loop/agent-loop.ts`。
  - 完成判据：新增 `onTurnHistory` 并在 §6.1-A2 的 6 个时机同步调用（`slice()`）；Session 只在 `runTurn` 入口初始化、`finally` 清空；回合中 `contextProjection()`/`contextMessageEstimate()` 返回快照值；**不**在 step 分支里用 `this.history` 刷快照（压缩后不会被覆盖）；未新增事件类型；回调契约（同步/不抛）写在实现注释里。
- **B2 `/context` 回合内返回投影**
  - 输入：§6.1-A3。
  - 产出：`packages/web/src/server.ts`。
  - 完成判据：有 live Session 时运行中也返回 `projection`/`estimatedMessageTokens`；无 live 且运行中仍为空；replay 条件不变；字段集合不变。
- **B3 workspace SSE 心跳**
  - 输入：§6.4。
  - 产出：`packages/web/src/server.ts`。
  - 完成判据：每 `statusHeartbeatMs`（默认 15000）写 `: ping\n\n`；close/驱逐/`closeAll` 清 timer；`destroyed`/`writableEnded` 不写；`session.status` 帧不变。
- **B4 估算器剥离本地元数据**
  - 输入：§6.2-F1。
  - 产出：`packages/core/src/context/compaction.ts`、`packages/core/src/context/projection.ts`。
  - 完成判据：导出 `wireVisibleMessage`；`estimateMessageTokens` 与 `context/projection.ts:requestMessages` 共用；剥离 `usage`/`contextSample`/`dshReplay`/`providerReplay`；不改持久化、不改 `Message` 类型、不改日志。
- **B5 有效消息预算、输出预留、预算不足错误与压缩失败告警**
  - 输入：§6.2-F2/F3、§7.4。
  - 产出：`packages/core/src/loop/agent-loop.ts`、`packages/core/src/session.ts`（**不**改 `packages/web/src/main.ts`，Web 侧接线由 B7 统一完成）。
  - 完成判据：`SessionOptions.outputTokenReserve` → `AgentLoopDeps.outputTokenReserveTokens`；每步只解析一次 `system`/`toolSpecs` 并复用；`rawBudget`/`messageBudget`/`retainTokens` 按 §7.4；**`rawBudget < 1` 时在模型调用前 `yield error(code='CONTEXT_BUDGET_TOO_SMALL')` + `turn.end(error)` 并返回，不调用 provider**（这是错误路径，不是仅 `console.warn`、更不是钳到 1 继续）；`contextWindowTokens` 缺失时保持不压缩 + 每回合一次告警；手动压缩路径保留。
- **B6 采纳已修复且压缩后的历史**
  - 输入：§6.2-F4。
  - 产出：`packages/core/src/session.ts`。
  - 完成判据：`repaired && compactedThisTurn` 时 `this.history = next.value`；其余情况行为不变；不追加任何事件；`session.messages` 与日志可能不同（与既有「非 repaired 采纳压缩」一致），在注释与文档中写明。
- **B7 预算集成缝与 Web 接线**
  - 输入：§6.2-F5；依赖 B5 的 `SessionOptions.outputTokenReserve`。
  - 产出：`packages/web/src/session-options.ts`（新）、`packages/web/src/main.ts`。
  - 完成判据：`modelBudgetOptions(resolved)` 只在有值时返回 `contextWindowTokens`/`outputTokenReserve`/`retainContextTokens`（`outputTokenReserve` 取 `resolved.modelDescriptor?.maxTokens`）；`composeSession` 改用该函数（替换现在的 `main.ts:190-191` 内联展开）；不改变 `replayContext` 行为；模块可被测试直接 import（不触发 host 启动）。

### 8.3 文档任务

- **D1 API 文档**
  - 输入：B2/B5。
  - 产出：`docs/web-api.md:190`（`/context` 段落）。
  - 完成判据：去掉「回合中不返回估算」；说明回合中基于已持久化 step 边界投影、压缩后以压缩结果为准、本 host 无 live Session 时仍无投影；说明 `window.tokens` 仍是窗口预算、有效消息预算不通过 HTTP 暴露；字段列表不变。
- **D2 压缩设计文档**
  - 输入：B4/B5/B6。
  - 产出：`docs/design/session-state.md:114-196`（3.5/§4.3-4.5）、`docs/architecture.md:39`。
  - 完成判据：写明有效预算公式与 `retainContextTokens` 的新语义、输出预留来源、`rawBudget < 1` 的硬错误（事件序列、code、消息字段、不发 provider）与两类非终止告警；把「repaired 时压缩结果整体丢弃」改为新采纳规则；保留「压缩不落盘、重开可能再压缩」的限制；估算器剥离 replay 的理由与轻微低估说明。
- **D3 Web 实现文档**
  - 输入：A/B/C/D/E/F 全部实现。
  - 产出：`docs/implementation/web.md`（`491`、`502-505`、`510`、`522`、`540-560`、`692-713` 等相关段落）。
  - 完成判据：更新 ContextMeter（事件驱动 + `tool.result` + 15 秒空闲校准 + 草稿/空状态表）、右栏多标签（类型、去重、关闭选邻、每会话内存布局、全挂载隐藏、`role="presentation"` 结构）、store（删轮询、按 key+turn 去重对账、退避、心跳）、稳定 id 与等价跳过、草稿附件 IDB 契约与降级；不再出现「5 秒轮询」「2 秒后重连」「草稿态不渲染环形」。
- **D4 本计划状态回写**
  - 产出：本文件 §12「执行记录」。
  - 完成判据：编码完成后由执行者追加实际执行到的测试命令与结果（不是本阶段的工作）。

### 8.4 测试任务（每条都必须真实跑通）

- **T1 core 回合内投影**
  - 产出：`packages/core/src/session.test.ts`、`packages/core/src/loop/agent-loop.test.ts`。
  - 覆盖：回合中 `contextProjection()` 有值并随 assistant/tool 增长；`onTurnHistory` 在 6 个时机各被调用（含 queued 与 `afterToolBatch`）；压缩后快照等于压缩结果、且不会被下一步 `this.history` 覆盖；中断/异常后快照清空且空闲投影一致。
- **T2 `/context` 运行中语义**
  - 产出：`packages/web/src/server.test.ts`（改写 `:403-415`）。
  - 覆盖：busy-context 的 WebSession stub **同时 mock `contextProjection()` 与 `contextMessageEstimate()`**，断言响应包含两者；无 live Session 的运行中仍返回空；空闲 replay 不变。
- **T3 SSE 心跳**
  - 产出：`packages/web/src/session-status-stream.test.ts`（或新增 `server-status-heartbeat.test.ts`）。
  - 覆盖：真实短周期 `statusHeartbeatMs: 20` + 真实 `fetch` 流，未发任何状态帧也能读到 `:` 注释行；关闭响应/`host.close()` 后流结束且不再有新写入（等待若干周期读到的字节数为 0）。不用 fake timers（与 node http 冲突）。
- **T4 不再周期拉详情 + 对账去重**
  - 产出：`packages/web/src/ui-store.test.ts`。
  - 覆盖：`vi.useFakeTimers()` + `advanceTimersByTimeAsync(10_000)` 后无新的会话详情 GET（fetch stub 记录 URL）；`running:true→false` 只触发一次详情 GET；同一状态帧重复推送同一 turn 不重复请求；**两种先后顺序各一条用例**：(i) 状态帧先到、follow 后结束，(ii) follow 先结束、状态帧后到 —— 合计都只请求一次；**对账响应里补进更多 events（`turn.end` 之后还有事件）也不会产生第二次请求**（证明 stamp 取 `turn.end`、且请求后不重算）；`trace/turn.end` 缺失时不对账；`running:false→true` 仍 follow。
- **T5 SSE 退避**
  - 产出：`packages/web/src/session-status.test.ts`（纯函数）+ `packages/web/src/session-status-store.test.ts`。
  - 覆盖：延迟序列与 30s 上限；从未连通过不重连；成功读帧后计数归零。
- **T6 稳定 id 与等价跳过**
  - 产出：`packages/web/src/ui-protocol.test.ts` + `packages/web/src/ui-store.test.ts`。
  - 覆盖：同一输入两次 hydrate id 一致；不带 previous 时 tool id = `t:<callId>`；带 previous 时内容未变条目沿用旧 id；相同详情两次响应不产生新 transcript 数组引用（可用 `toBe` 比较引用）。
- **T7 右栏 reducer**
  - 产出：`packages/web/src/right-panel-tabs.test.ts`。
  - 覆盖：guide 不可关且永远首位；单例合并；preview 去重 + `line` 合并；关激活选左邻、`index===1` 回 guide；关非激活不改选中；关最后一个内容标签回 guide；重命名跟随子路径、冲突保留 `tabs` 靠前者；删除目录关闭子预览。
- **T8 右栏渲染**
  - 产出：`packages/web/src/header-trajectory.test.ts`、`packages/web/src/preview-viewers-ui.test.ts`（改写 props）+ 新增 `packages/web/src/right-panel-tabs-ui.test.ts`。
  - 覆盖：`role="tablist"`、`role="tab"`、`aria-selected`；内容标签关闭按钮 `aria-label="Close tab File preview｜guide.md"`（en）；guide 无关闭按钮；非激活 `hidden`；标签外层 `role="presentation"`；**用标签栈扫描断言无嵌套 button**（测试内约 10 行小工具：扫描 SSR 字符串，遇 `<button` 入栈、`</button>` 出栈，栈深 >1 即失败），不依赖宽松正则。
- **T9 读数零值**
  - 产出：`packages/web/src/session-stats.test.ts`（改写「renders nothing」）、`packages/web/src/context-meter.test.ts`。
  - 覆盖：`entry===null`/无 metrics 渲染 `0 轮 0 步`、`整会话累计 0 tok`、`缓存命中 —`；有 metrics 时断言主读数含「整会话累计」且不再只是裸 `tok`；ContextMeter 弹窗在无投影时提示「还没有读数。」、在有投影时含 `分母为本会话模型窗口。`（en 断言语料对应英文）；草稿渲染 `0%` 且无网络；无工作区仍返回 `''`；有投影无 capacity 时 0% + 明细；真实数据用例保持原断言（只更新文案）。
- **T10 草稿附件**
  - 产出：`packages/web/src/draft-attachments.test.ts`。
  - 覆盖：key 复用 `composerDraftKey`；坏 base64/超 8MiB/超 8 个/超 20MiB 被拒；`size` 与 `data` 不一致视为坏记录；`read` 抛错返回 `[]`；`prune` 保留最新 8 条；`createIndexedDbDraftStore(undefined) === null`。
  - **工作量提示（不隐藏）**：node 无 IDB，需在测试里实现假 `IDBFactory`（`open`→`onsuccess`、`transaction`、`objectStore`、`put/get/delete/getAll`），约 100–150 行；若不写，则适配器里 IDB 的写入/读取/清理分支将无测试覆盖，**不允许**用「已手工验证」替代（可另加一个基于注入 `DraftAttachmentStore` 假实现的 Composer 逻辑测试，但仍需假工厂覆盖适配器本身）。
  - **测试边界**：Composer 的「恢复期禁止 addFiles/粘贴/拖拽/发送」属于组件交互，node + SSR 无法覆盖，仅由 §10.2-13b 手工验收；T10 只覆盖存储层与纯校验逻辑，不要把交互写成「已测」。
- **T11 文案**
  - 产出：`packages/web/src/i18n.test.ts`、`packages/web/src/sidebar.test.ts`。
  - 覆盖：`translate('zh','Automations') === '自动化'`；`translate('zh','Automation tasks') === '自动化任务'`；zh 侧栏渲染「自动化」且不含「自动化任务」。
- **T12 估算器剥离元数据**
  - 产出：`packages/core/src/context/compaction.test.ts`、`packages/core/src/context/projection.test.ts`。
  - 覆盖：带 `dshReplay`/`providerReplay` 的 assistant 与不带时 `estimateMessageTokens` 相等；`usage`/`contextSample` 仍不影响；`contextHistoryHash` 对仅 replay 不同的历史给出相同哈希；图片仍按 1024 计、文本模型占位仍生效。
- **T13 有效预算与钳制/告警**
  - 产出：`packages/core/src/loop/agent-loop.test.ts`。
  - 覆盖：`window=300000`、system/tools 已知、`outputTokenReserveTokens=8000` 时，历史估算在 `messageBudget` 以上才压缩、在 `window` 以下就触发；`retainContextTokens` 超过预算时被钳到一半；**`window <= overhead + outputReserve` 时事件序列为 `turn.start` → `error`（`code='CONTEXT_BUDGET_TOO_SMALL'`，message 含 window/system/tools/outputReserve/rawBudget 与建议）→ `turn.end(error)`，且 `FakeModel.requests` 为空**（不调用 provider）、不再压缩；`contextWindowTokens` 缺失时无 error、不压缩、告警一次；复核并改写既有小窗口用例（`agent-loop.test.ts:76,416,430,449`）使它们表达「有效预算」而非「窗口即预算」。
- **T14 压缩失败可见**
  - 产出：`packages/core/src/loop/agent-loop.test.ts`。
  - 覆盖：预算合法（`rawBudget >= 1`）但超预算且无可移除组（只有 protected 当前消息）时 `compacted:false` 且 `console.warn` 含 `before`/`budget`/`removed=0`，回合仍正常结束（与 T13 的致命预算错误区分）；摘要未变小分支同样告警；同一回合不重复刷屏。
- **T15 修复+压缩采纳**
  - 产出：`packages/core/src/session.test.ts`（改写 `:729`）。
  - 覆盖：坏 tool 批 + 小窗口 → 第一回合压缩且采纳（`session.messages` 首条为摘要、长度变小）；第二回合**不再**重复压缩（与改写后的断言一致）；`handle.events` 中没有摘要事件、没有合成 tool 结果事件；`repaired && !compacted` 时仍不采纳（保持既有测试 `:634` 的语义）。
- **T16 窗口→runtime→Session→压缩 集成 + `/context` 一致性**
  - 产出：`packages/web/src/context-budget.test.ts`（新）。
  - 覆盖：配置两个模型（1M 与 300k，后者 `maxTokens` 已知）；选中 300k；用 `RuntimeResolver` + `modelBudgetOptions` + 真实 `Session`（`FakeModel` 记录请求）构造；预置日志使历史估算超过 `messageBudget` → **第一次模型请求前**发生压缩（首条消息为摘要），且首请求估算仍小于 300k；`GET /context` 的 `window.tokens === 300000`；切换到 1M 模型并重建 Session 后 `window.tokens === 1048576` 且不再压缩——证明用的是**当前选中模型**的窗口，不是默认 role 的模型。
- **T17 既有测试同步**
  - 产出：`packages/web/src/session-stats.test.ts`、`packages/web/src/header-trajectory.test.ts`、`packages/web/src/preview-viewers-ui.test.ts`、`packages/web/src/server.test.ts`。
  - 覆盖：所有因新契约而必须改写的断言在 §3.4 清单内有对应更新，不允许「注释掉/跳过」。

---

## 9. 执行顺序依赖与里程碑

```text
B1 → B2 → T1,T2,D1
B3 → T3
B4 → B5 → B6 → T12,T13,T14,T15
B5,B7 → T16 → D2
F1 → F2 → F3 → T7,T8
F4(turnTick) ← F9(contextTick)
F5 → T9
F6 → F7 → T10
F8 → T4（依赖 F10 的对账指纹无关，可并行）
F9 → T5
F10 → T6
F11 → T11
全部实现 → D3 → 全量验收
```

里程碑：

- **M1 上下文与预算（问题 1、2、7）**
  任务：B1、B2、B4、B5、B6、B7、F4、F5、F9（`contextTick` 部分）、D1、D2、T1、T2、T9、T12、T13、T14、T15、T16。
  验收：回合中每个 step（含 `tool.result`）读数变化；新会话/草稿立即 `0%`/`整会话累计 0 tok`/`缓存命中 —`；300k 窗口构造场景在首请求前压缩；`/context window` 与当前选中模型一致；压缩失败在日志可见；**「整会话累计」与「上下文占用」两个口径在 UI 上可区分**（F4/F5/T9）。
- **M2 右栏多标签（问题 3）**
  任务：F1、F2、F3、T7、T8。
  验收：多标签、X、关闭选邻、每会话布局恢复、Header 不强制 guide。
- **M3 刷新与稳定渲染（问题 4）**
  任务：F8、F9（退避）、F10、B3、T3、T4、T5、T6。
  验收：空闲 30 秒无详情 GET、无 2 秒重连、展开态不丢、左侧列表不闪、同一 turn 只对账一次。
- **M4 草稿附件（问题 6）+ 文案（问题 5）**
  任务：F6、F7、F11、T10、T11。
  验收：图片与文件在切换/刷新后恢复、恢复期不可新增/发送、发送后一起清理；导航「自动化」。
- **M5 文档与全量验收**
  任务：D3、T17、§10.1 全绿、§10.2 手工清单。

每个里程碑可独立回滚（§11）。

---

## 10. 测试与验收

> 本节只是待执行命令与期望，编写阶段**未执行**。

### 10.1 自动化验收

```bash
# M1（上下文/预算，问题 1、2、7）
pnpm vitest run packages/core/src/session.test.ts \
  packages/core/src/loop/agent-loop.test.ts \
  packages/core/src/context/compaction.test.ts \
  packages/core/src/context/projection.test.ts \
  packages/core/src/session/runtime.test.ts \
  packages/web/src/server.test.ts \
  packages/web/src/context-budget.test.ts \
  packages/web/src/context-meter.test.ts \
  packages/web/src/session-stats.test.ts

# M2（右栏，问题 3）
pnpm vitest run packages/web/src/right-panel-tabs.test.ts \
  packages/web/src/right-panel-tabs-ui.test.ts \
  packages/web/src/header-trajectory.test.ts \
  packages/web/src/preview-viewers-ui.test.ts \
  packages/web/src/preview-registry.test.ts

# M3（刷新，问题 4）
pnpm vitest run packages/web/src/ui-store.test.ts \
  packages/web/src/session-status.test.ts \
  packages/web/src/session-status-store.test.ts \
  packages/web/src/session-status-stream.test.ts \
  packages/web/src/ui-protocol.test.ts

# M4（附件与文案，问题 5、6）
pnpm vitest run packages/web/src/draft-attachments.test.ts \
  packages/web/src/composer-drafts.test.ts \
  packages/web/src/i18n.test.ts \
  packages/web/src/sidebar.test.ts
```

最终门禁：

```bash
pnpm typecheck
pnpm test
pnpm web:build
git diff --check
```

关键期望：

- `pnpm test` 用量只增不减；`server.test.ts` 的 busy-context 用例改为断言包含 `projection` 与 `estimatedMessageTokens`（两者都 mock）。
- `session-stats.test.ts`「无读数不渲染」改为「渲染零值」。
- `session.test.ts:729` 改为断言「第二回合不重复压缩 + 日志无摘要事件」。
- `agent-loop.test.ts` 的小窗口用例改写后仍覆盖：重复压缩保留 prompt/steer（`:416`）、文本模型不按图片 base64 计（`:430`）、强制压缩（`:449`）。
- `context-budget.test.ts` 必须出现「300k 选中模型 → 首请求前压缩 → `/context` window=300000」；切换模型后 window 变化。
- `ui-store.test.ts` 的时间推进用例证明「10 秒推进窗口内无新详情请求」，并证明同一 turn 只对账一次。

### 10.2 手工验收（可观察，逐条打勾）

前置：`pnpm web:build && pnpm web:serve`，DevTools Network 打开，过滤器写成**精确 URL**（不要只用 `sessions` 关键字，避免把 `/context`、`/follow`、`/events` 混进来）：

- 详情：`/api/workspaces/<ws>/sessions/<sid>`（路径到此为止，**不带** `/context`、`/follow`、`/messages`、`/events`）
- 上下文：`/api/workspaces/<ws>/sessions/<sid>/context`
- 状态流：`/api/workspaces/<ws>/events`

1. **每个 step 更新上下文**：发一条会多次调用工具的消息。期望：每次工具结果后环形与明细变化，不用等回合结束；回合结束读数与结束前一致（含压缩后的下降）。
2. **新会话立即读数**：`New session` 后立刻看输入框下方。期望：`0%` + `0 turns 0 steps · 整会话累计 0 tok · 缓存命中 —`（与 F5/T9 文案一致），无空白补位跳动。
3. **压缩后读数**：对长会话配置一个较小窗口（或触发压缩）。期望：压缩后读数明显下降，且同一回合内不先冲高再回落；日志出现 `context.compacted`。
4. **多标签与 X**：打开 files / observe / plan / 文件 A / 文件 B。期望：5 个标签并存；内容标签悬停有 X，`aria-label`「关闭标签页：…」；点 X 不激活该标签；点标签本体才切换。
5. **关闭选邻**：关中间标签 → 激活左邻；关最左内容标签（紧邻 Start）→ 回 Start；关最后一个内容标签 → 停在 Start；Start 无 X。
6. **每会话布局**：会话 A 开 3 个标签，切到 B 再回 A。期望：A 完整恢复、B 只有 Start；刷新页面回到种子布局。
7. **Header 重开面板**：collapse 后再展开。期望：恢复最后标签，不是强制 Start。
8. **空闲无详情请求、无 2 秒重连**：停留在已加载会话，Network 清空后等 30 秒。期望：精确 URL 过滤下**没有任何**详情请求；状态流连接数不增长（无 2 秒级重连）；左侧列表不重渲染、不闪。**注意**：`/context` 每约 15 秒一次是预期的空闲校准，不算失败；自动化页 15 秒轮询同理。
9. **状态推送对账一次**：另一标签页对同一会话发消息，回到本页等回合结束。期望：结束后的数秒内出现**一次**详情 GET，内容更新一次；同一 turn 再次触发状态帧不产生第二次请求。
10. **展开状态保持**：展开工具块/思考块，切走再切回。期望：展开与滚动位置不丢，工具块不闪。
11. **列表不因读数刷新**：回合进行中观察左侧列表。期望：只有状态点/标签按真实状态变化，无整列刷新。
12. **导航文案**：导航显示「自动化」；页面标题与错误提示仍「自动化任务」；面板 `aria-label` 为「自动化」。
13. **草稿附件恢复**：
    - a) 新建会话拖入 1 张图片 + 1 个文本文件，切走再切回：都在，图片有缩略图。
    - b) 刷新页面：恢复期间显示「正在恢复附件…」，此时 `+`/拖拽/粘贴不可用，发送被阻止；恢复完成后可交互。
    - c) 手动移除一个附件：立即消失，刷新后不再出现。
    - d) 发送成功：输入框与附件栏清空，刷新后不出现（记录已删）。
    - e) 队列/steer accepted 后同样清空。
14. **存储不可用降级**：让 `indexedDB` 打开失败（隐私模式或配额打满）。期望：附件仍可用，提示「本次会话内保留，刷新可能丢失。」，输入与发送不受阻，无未捕获异常。
15. **模型预算生效（问题 7 主验收）**：
    - **前置诊断（先做，不做会误判）**：确认当前会话的模型选择器显示的是 300k 模型，且 `GET .../context` 的 `window.tokens === 300000`（不是 1048576、也不是空）。两者任一不成立，先按 §4.7.1 (b) 排查绑定关系，**不要**把它当压缩器 bug。
    - 若 `UsagePill` 显示约 `500k tok` 而 ContextMeter 环形只有约 40%，这是**显示口径问题**（累计 vs 占用），不是压缩失效；按第 17 条四数对照确认。
    - 期望：上下文**占用**（`projection.projectedTokens` / 环形）增长到约 150k–200k 时（取决于 `maxTokens` 预留）出现 `context.compacted`，而不是等占用到 300k 或累计到 500k。
    - 若把该模型 `maxTokens` 调得过大导致预算不足（`window <= system + tools + outputReserve`）：该回合**立即失败**并显示可读错误（含 `window/system/tools/outputReserve` 与调整建议，`code=CONTEXT_BUDGET_TOO_SMALL`），**不发出 provider 请求**；调小 `maxTokens` 或调大窗口后重试可继续。
16. **切换模型后预算跟随**：在同一会话切到另一个窗口的模型并发一条消息。期望：`/context` 的 `window.tokens` 立即是新模型窗口，压缩在按新预算的时机触发（不需要重开浏览器）。
17. **四数对照（口径判别，问题 7 的归因验收）**：在同一时刻记录并并排比较四个数：
    1. `/context` 的 `window.tokens`（分母，应等于当前选中模型的窗口）；
    2. `/context` 的 `projection.projectedTokens`（下一次请求的占用估算）；
    3. ContextMeter 弹窗的 `~X / Y`（`X` 应约等于第 2 项，`Y` 应等于第 1 项，且旁边有「分母为本会话模型窗口。」说明）；
    4. `UsagePill` 的 `{count} tok`（**整会话累计**，通常远大于第 2 项）。
    期望：第 1/2/3 项自洽；第 4 项大于第 2 项属正常，不应据此判断压缩失效。若第 1 项不是 300000，回到第 15 条前置诊断；若第 1/2 项在第 15 条场景下始终不触发压缩，再按 §4.7 主因 1–4 排查。

---

## 11. 风险与回滚

| 风险 | 影响 | 缓解 | 回滚 |
| --- | --- | --- | --- |
| 有效预算使用 `descriptor.maxTokens`（pi-catalog 缺省 128k） | 小窗口模型压缩更早；极端配置下回合直接失败 | 契约写明公式；预算不足给出可读错误与调整建议（不静默、不钳 1）；T13/T16 固化期望 | 回退 B5（Web 不传 `outputTokenReserve` → 回落 20% 窗口），此时不会因预留触发失败 |
| 「整会话累计」被读成「上下文占用」，导致误判压缩失效 | 修了压缩也被认为没修 | UI 明确标注两个口径（F4/F5/T9）；§4.7.1 归因 + §10.2-15/17 四数对照 | 文案改动可单独回滚，不影响压缩修复 |
| 估算器剥离 replay 后估算变小，压缩更晚 | 若不同时改预算，可能恶化 | B4 与 B5 必须同一里程碑（M1）合并验收；T12/T13 联测 | 回退 B4 的剥离（保留 F2 预算） |
| 小窗口既有测试语义翻转 | 测试大面积失败 | §3.4-10 明确要求复核改写，不允许跳过 | 保留「window == budget」测试分支仅在测试内构造，不改实现 |
| 采纳「repaired+compacted」后 `session.messages` 与日志不同 | 排查困惑 | 文档写明（D2）；不追加事件 | 回退 `compactedThisTurn` 条件（恢复旧行为） |
| 回合中投影仍有偏差（tool 消息请求期重建/压缩不落盘） | 读数小幅偏差或刷新后回落 | 与请求同源估算；文档写明 | 回滚 B1 快照 + 回调 |
| 每 step 请求增多（含 `tool.result`） | 服务端负载上升 | 只在四个事件触发；空闲 15 秒；失败保留旧值 | 保留 tick 但**把同一工具批次里的多个 `tool.result` 合并成一次 context 刷新**（仍满足「每个 step 更新」：同一批次本就属于同一步）；不得回滚为「忽略 `tool.result`」 |
| 右栏 props 重构波及测试/CSS | 编译期大面积报错 | F1 先落地，F2/F3 一次改完 | 单文件回滚 `RightPanel.tsx`/`app.tsx` |
| 关闭选邻实现错误 | 丢失当前上下文 | T7 全覆盖；guide 不可关，最坏回开始页 | 回滚 reducer `close` 分支 |
| 全挂载标签增内存 | 大文件预览常驻 | 只挂载已打开标签；关闭即卸载 | 改回仅挂载激活标签（牺牲状态保持） |
| 删除 3 秒轮询后别的来源变更不同步 | 罕见（标题/元数据） | 结束对账 + 状态推送 + 显式 Retry | 恢复低频（≥30s）兜底轮询（仅在验收发现真实缺口时） |
| 去重 stamp 依赖 `trace/turn.end` 的 `seq` | 若详情响应裁掉 seq 或事件类型被改名，守卫会失效并重复对账 | 详情返回原始 `events`（含 `seq`）已有保证；找不到 `turn.end` 时**跳过对账**而不是退化为时间/长度比较；T4 覆盖两种先后顺序与「响应补事件」场景 | 若事件格式变更，改为在服务端详情响应里直接给出 `lastTurnEndSeq`（需评估是否属于 HTTP 变更，默认不改） |
| SSE 心跳被中间层立即断开 | 状态流抖动 | 写前判 destroyed；已有驱逐逻辑 | 删除心跳定时器（退避仍生效） |
| IndexedDB 写入 20MiB 卡顿/配额失败 | 附件丢失 | 单记录整体写；失败降级 + 提示；prune 8 份 | 关闭写入即回「内存-only」，文本草稿不受影响 |
| 确定性 id 与 live id 不一致 | 回合结束轻微重挂载 | previous 复用 + 等价跳过 | 只保留等价跳过 |
| TUI/Subagent 未接输出预留 | 预算比 Web 保守度低 | §2 已列非目标；后续单独接线 | 不需回滚（无改动） |

---

## 12. 执行记录

> 本节由文档任务（D3/D4）的执行者在实现完成后填写。**只记录可以核对的事实**：源码与测试文件的存在性、`git status` 的真实输出、本人亲手运行并看到输出的命令。测试结果中凡不是本阶段复跑的，都标注来源为任务报告。

### 12.1 状态摘要

- **M1–M4 的源码与测试文件均已落地**（文件清单见 12.3），D1（`docs/web-api.md`）、D2（`docs/design/session-state.md`、`docs/architecture.md`）与 D3（`docs/implementation/web.md`）文档已更新。
- **本阶段本人实际执行的验证只有三条**：`pnpm typecheck`、`pnpm web:build`、`git diff --check`，输出与退出码见 12.4。按交付要求**没有执行全量 `pnpm test`**（另一任务正在核实一个环境性抖动），因此本记录不把「全量测试全绿」写成已验证结论。
- §10.1 的分组测试由各实现任务在其交付时执行并报告通过；那部分结论的**来源是任务报告，不是本阶段的复跑**（见 12.5）。
- §10.2 手工验收**未执行**，需要真实浏览器与 provider；清单原样保留在 §10.2，本节不声称任何一条已通过。

### 12.2 里程碑与任务

| 里程碑 | 任务 | 落地证据 | 验证来源 |
| --- | --- | --- | --- |
| M1 上下文与预算（问题 1、2、7） | B1、B2、B4、B5、B6、B7、F4、F5、F9（`contextTick`）、D1、D2、T1、T2、T9、T12、T13、T14、T15、T16 | `core/src/session.ts`、`core/src/loop/agent-loop.ts`、`core/src/context/{compaction,projection}.ts`、`web/src/server.ts`、`web/src/session-options.ts`、`web/ui/src/components/{ContextMeter,SessionStats,Composer}.tsx`、对应测试文件 | 源码经本次阅读核对；测试结果来源见 12.5 |
| M2 右栏多标签（问题 3） | F1、F2、F3、T7、T8 | `web/ui/src/lib/right-panel-tabs.ts`、`web/ui/src/components/RightPanel.tsx`、`web/ui/src/app.tsx`、`web/ui/src/styles/dsh/right-panel.module.css` | 同上 |
| M3 刷新与稳定渲染（问题 4） | F8、F9（退避）、F10、B3、T3、T4、T5、T6 | `web/ui/src/lib/store.ts`、`web/ui/src/lib/{session-status,events}.ts`、`web/src/server.ts`（状态流心跳） | 同上 |
| M4 草稿附件与文案（问题 5、6） | F6、F7、F11、T10、T11 | `web/ui/src/lib/draft-attachments.ts`、`web/ui/src/components/Composer.tsx`、`web/ui/src/styles/dsh/composer-attachments.module.css`、`web/ui/src/lib/i18n.ts` | 同上 |
| M5 文档与全量验收 | D3、T17、§10.1、§10.2 | 本文件 + `docs/implementation/web.md`；T17 改写的断言在 `session-stats` / `header-trajectory` / `preview-viewers-ui` / `server` 四个测试文件里 | D3/D4 由本阶段完成；T17 来源为任务报告；§10.1 未由本阶段复跑（见 12.5）；§10.2 未执行 |

### 12.3 改动文件清单

`git status --short` 的真实输出（本次 D3/D4 交付前，工作树状态）：

```text
 M docs/architecture.md
 M docs/design/session-state.md
 M docs/implementation/web.md
 M docs/web-api.md
 M packages/core/src/context/compaction.test.ts
 M packages/core/src/context/compaction.ts
 M packages/core/src/context/projection.test.ts
 M packages/core/src/context/projection.ts
 M packages/core/src/loop/agent-loop.test.ts
 M packages/core/src/loop/agent-loop.ts
 M packages/core/src/session.test.ts
 M packages/core/src/session.ts
 M packages/web/src/context-meter.test.ts
 M packages/web/src/header-trajectory.test.ts
 M packages/web/src/i18n.test.ts
 M packages/web/src/main.ts
 M packages/web/src/preview-viewers-ui.test.ts
 M packages/web/src/server.test.ts
 M packages/web/src/server.ts
 M packages/web/src/session-stats.test.ts
 M packages/web/src/session-status-store.test.ts
 M packages/web/src/session-status-stream.test.ts
 M packages/web/src/session-status.test.ts
 M packages/web/src/sidebar.test.ts
 M packages/web/src/ui-protocol.test.ts
 M packages/web/src/ui-store.test.ts
 M packages/web/ui/src/app.tsx
 M packages/web/ui/src/components/Composer.tsx
 M packages/web/ui/src/components/ContextMeter.tsx
 M packages/web/ui/src/components/RightPanel.tsx
 M packages/web/ui/src/components/SessionStats.tsx
 M packages/web/ui/src/lib/events.ts
 M packages/web/ui/src/lib/i18n.ts
 M packages/web/ui/src/lib/session-status.ts
 M packages/web/ui/src/lib/store.ts
 M packages/web/ui/src/styles/dsh/composer-attachments.module.css
 M packages/web/ui/src/styles/dsh/right-panel.module.css
?? docs/plan/
?? packages/web/src/context-budget.test.ts
?? packages/web/src/draft-attachments.test.ts
?? packages/web/src/right-panel-tabs-ui.test.ts
?? packages/web/src/right-panel-tabs.test.ts
?? packages/web/src/session-options.ts
?? packages/web/ui/src/lib/draft-attachments.ts
?? packages/web/ui/src/lib/right-panel-tabs.ts
```

按分组的说明（同一份清单换一个视图）：

| 分组 | 文件 | 对应任务 |
| --- | --- | --- |
| core（`packages/core/src`） | `session.ts`、`loop/agent-loop.ts`、`context/compaction.ts`、`context/projection.ts` | B1、B4、B5、B6 |
| web-host（`packages/web/src`） | `server.ts`、`main.ts`、`session-options.ts`（新） | B2、B3、B7 |
| web-ui（`packages/web/ui/src`） | `app.tsx`、`components/Composer.tsx`、`components/ContextMeter.tsx`、`components/RightPanel.tsx`、`components/SessionStats.tsx`、`lib/store.ts`、`lib/events.ts`、`lib/session-status.ts`、`lib/i18n.ts`、`lib/right-panel-tabs.ts`（新）、`lib/draft-attachments.ts`（新）、`styles/dsh/right-panel.module.css`、`styles/dsh/composer-attachments.module.css` | F1–F11 |
| docs | `docs/web-api.md`、`docs/design/session-state.md`、`docs/architecture.md`、`docs/implementation/web.md`、`docs/plan/web-conversation-fixes.md`（本文件，含本节） | D1、D2、D3、D4 |
| tests | `core/src/session.test.ts`、`core/src/loop/agent-loop.test.ts`、`core/src/context/compaction.test.ts`、`core/src/context/projection.test.ts`、`web/src/server.test.ts`、`web/src/context-meter.test.ts`、`web/src/session-stats.test.ts`、`web/src/header-trajectory.test.ts`、`web/src/preview-viewers-ui.test.ts`、`web/src/ui-store.test.ts`、`web/src/ui-protocol.test.ts`、`web/src/session-status.test.ts`、`web/src/session-status-store.test.ts`、`web/src/session-status-stream.test.ts`、`web/src/i18n.test.ts`、`web/src/sidebar.test.ts`、`web/src/context-budget.test.ts`（新）、`web/src/draft-attachments.test.ts`（新）、`web/src/right-panel-tabs.test.ts`（新）、`web/src/right-panel-tabs-ui.test.ts`（新） | T1–T17 |

（`docs/plan/` 整目录仍为 untracked，本计划与本节都在其中；`pnpm web:build` 的产物写进被忽略的 `packages/web/dist`，没有出现在上面的新增项里。）

### 12.4 本阶段实际执行的验证（本人运行并看到输出）

三条命令在实现完成后的工作树上执行过两轮（D3 文档改动前、改动后各一轮），之后在最后一轮文档表述微调完成时又重跑了 `pnpm typecheck` 与 `git diff --check`；每次都通过（两个命令退出码 0，`pnpm web:build` 成功）。下面贴最后一轮的真实输出：

```bash
$ pnpm typecheck
> omniagent@ typecheck /Volumes/DevDisk/yunqi-home/project/OmniAgent
> tsc --noEmit
# 退出码 0，无编译错误
```

```bash
$ pnpm web:build
...
../dist/assets/index-BdQpz_Eu.js   1,748.99 kB │ gzip: 496.20 kB │ map: 10,613.33 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 2.00s
# 退出码 0（首次运行为 2.08s）；只有既有的 chunk 体积告警，没有构建错误
```

```bash
$ git diff --check
# 无任何输出，退出码 0（空白错误检查通过）
```

口径说明：`git diff --check` 只检查**已跟踪文件的改动**，因此 untracked 的新文件（`packages/web/ui/src/lib/right-panel-tabs.ts`、`lib/draft-attachments.ts`、`packages/web/src/session-options.ts`、四个新测试、`docs/plan/`）不在它的覆盖范围内——这些文件没有经过空白检查，只能以 `pnpm typecheck` / `pnpm web:build` 的通过作为间接证据。

### 12.5 来源为任务报告、本阶段未复跑的验证

- §10.1 的四组命令（M1 / M2 / M3 / M4）由各实现任务在交付时执行，其报告声称对应测试通过。**本阶段没有复跑这些命令**，因此本文件不是它们通过与否的独立证据，也不逐条转录其原始输出。
- 最终门禁里的 `pnpm test`（全量）**本阶段未执行**：按要求留给正在核实环境性抖动的任务。`pnpm typecheck`、`pnpm web:build`、`git diff --check` 已由本阶段执行（见 12.4）。
- §10.1 里点名的断言改写（`server.test.ts` 的 busy-context 断言、`session-stats.test.ts`「无读数不渲染」→「渲染零值」、`session.test.ts:729` → 「第二回合不重复压缩 + 日志无摘要事件」、`agent-loop.test.ts` 的小窗口用例）在源码中可见对应改动；其运行结果同属任务报告来源。

### 12.6 已知未覆盖项

1. **§10.2 手工验收全部未执行**，其中这些只能在真实浏览器 + provider 下观察，node 测试环境（Vitest node + `renderToStaticMarkup`，无 jsdom / 无 IndexedDB）覆盖不到：第 1 条（每个 step 环形变化）、第 3 条（压缩后读数下降且不先冲高）、第 4–7 条（标签并存 / X 不激活 / 关闭选邻 / 每会话布局恢复 / Header 重开）、第 8 条（30 秒空闲无详情 GET、无 2 秒级重连；自动化测试里只有 T4 的 fake timer 覆盖 10 秒推进窗口）、第 9 条（跨标签页状态推送只对账一次）、第 10 条（展开态与滚动位置保持）、第 11 条（列表不闪）、第 13a–e 条（附件恢复、恢复期 `+`/拖拽/粘贴不可用与发送被阻止、移除后不再出现、发送/队列/steer accepted 后清理）、第 14 条（IDB 不可用降级提示）、第 15–17 条（真实 provider 下的预算、切换模型与四数对照）。第 12 条（导航文案）不在缺口里，它由 T11 的 `i18n.test.ts` / `sidebar.test.ts` 覆盖。
2. **T10 的边界**（计划已声明）：`draft-attachments.test.ts` 只覆盖存储层与纯校验，Composer 的「恢复期禁止新增 / 发送」是组件交互，只由 §10.2-13b 覆盖。
3. **假 IDB 工厂未覆盖的分支**：`settleOpen()` 的 `onblocked`、`db.onversionchange = () => db.close()`，以及 `runRequest()` 中 `db.transaction()` **同步抛错**的分支——假工厂没有对应开关，这三处只在真实浏览器（另一个标签页阻塞升级、隐私模式）里走到。
4. **`RightPanel` 的 `hasPlan` 是可选 prop**（缺省 `false`），计划 §6.3-B2 的 props 清单里没有它；`App` 目前都显式传入，但类型上允许省略，将来新增调用方忘记传只会少掉 guide 里的「计划审阅」卡片，不会编译失败。
5. **右栏标签样式属性锚点没有注释**：`min-width: 80px` / `max-width: 210px` / `overflow-x: auto` 这些与 T8 的结构断言相关的值，CSS 里没有写明它们为何是这些数，也没有测试直接断言具体数值。
6. **`web/ui/src/lib/context-reading.ts` 顶部注释仍写着「回合中 `.../context` 不返回投影」**，与 B2 之后的行为不一致。它属源码注释陈旧，不在本次允许改动的范围（本任务只改两个文档），保留为遗留项。
7. **`followRun()` 的 1.5 秒断线重连**未改（§3.4-9 已声明不属于问题 4 的范围），因此「无 2 秒级重连」只针对工作区状态流。
8. **`docs/plan/` 整目录尚未提交**，`git diff --check` 不覆盖它（见 12.4 的口径说明）。

### 12.7 与原计划的偏差

| # | 计划处 | 实际实现 | 状态 |
| --- | --- | --- | --- |
| 1 | §3.4-1/2/3、T17：改写 `server.test.ts` busy-context、`session-stats.test.ts`「无读数不渲染」、`header-trajectory.test.ts` / `preview-viewers-ui.test.ts` 的 props | 这些断言与 props 调用已按新契约改写，未被注释或跳过 | 已由规划确认（§3.4 明文要求） |
| 2 | §7.5：新增 9 个 i18n 键并改 `'Automations'` 中文 | 键与中文映射按表落地，`'Automation tasks'` 与错误文案保持「自动化任务」 | 已由规划确认（§6.6、§7.5） |
| 3 | §6.3-B2 的 props 清单：`layout`、`onAction`、`fullscreen`、`onClose`、`onToggleFullscreen`、`onOpenFile`、`refreshToken`、`onFilesChanged` | 多一个可选 `hasPlan?: boolean`（缺省 `false`），只控制 guide 里「计划审阅」卡片是否出现 | 待确认 |
| 4 | §7.2 的动作联合类型（7 个 action） | 组件层多一层 `RightPanelIntent = RightPanelAction \| { type: 'open-plan' }`，并新增纯函数 `planPreviewAction(plan)`：面板只上报「想打开计划」，文档由 `App` 提供，避免 reducer 里出现第二个计划来源 | 待确认（类型只在 UI 内部使用，未改 §7.2 的 reducer 契约） |
| 5 | §6.4：stamp「在检测时取一次、请求后不重算」 | 请求身份确实只用检测时取的 `stamp`；但 `finishObservedRun()` 路径在 `loadDetail()` 成功后会重算一次 stamp 再记为 `done`（`turnEndStamp(key) ?? stamp`），目的是让随后到达的状态帧认得同一回合，否则同一回合会被对账两次 | 待确认（行为符合 T4「两种顺序都只请求一次」，措辞与计划的「请求后不重算」不同） |
| 6 | §6.1-A4：effect 依赖 `[pollable, workspaceId, sessionId, scope, modelSaving, turnTick]` | 实际依赖多一个 `busy`（`[pollable, workspaceId, sessionId, scope, busy, modelSaving, turnTick]`）：回合开始时必须能清掉空闲校准的 interval，只靠 `pollable` 无法表达「同一定域内进入/退出运行」 | 待确认（实现必需） |
| 7 | §6.5-D2：恢复期禁止发送并提示「请等待附件恢复完成再发送。」 | 草稿为空时不弹提示（避免空输入按 Enter 也弹一条），非空才提示；发送在这两种情况下都被阻止 | 待确认（细节取舍） |
| 8 | §8.3-D3 的产出描述为「更新 `docs/implementation/web.md` 的 491、502-505、510、522、540-560、692-713 等相关段落」 | 除改写这些段落后，另外新增三个小节：§6.1 `/context` 与上下文预算、§9.9 右栏标签（dock）、§9.10 草稿附件（IndexedDB），因为「预算公式与 `modelBudgetOptions` 接线」「标签类型/去重/关闭选邻/内存布局」「IDB 库/store/keyPath 契约与降级」在原文没有落点 | 待确认（D3 完成判据要求覆盖这些内容） |
| 9 | §6.5-D1 的纯函数清单：`draftAttachmentBytes`、`sanitizeDraftAttachments`、`draftAttachmentRecord`，适配器 `createIndexedDbDraftStore` / `resolveDraftAttachmentStore` | 额外导出了契约常量（`DRAFT_ATTACHMENT_DB_NAME`、`DRAFT_ATTACHMENT_STORE_NAME`、`MAX_DRAFT_ATTACHMENT_RECORDS`）与 `draftAttachmentKey()`（内部就是 `composerDraftKey()`），`sanitizeDraftAttachments` 同时接受整条记录与裸数组 | 待确认（只为让测试与文档引用同一份契约值） |
| 10 | — | `web/ui/src/lib/context-reading.ts` 的注释仍描述「回合中不返回投影」的旧语义，本次未改（只允许改两个文档） | 待确认（建议后续单独改注释） |
