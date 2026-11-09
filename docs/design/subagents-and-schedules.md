# 子代理与计划任务

本文说明两类「不止一个回合」的能力：

- **子代理**：由主会话派生、独立持久化的子会话，形成协作树。
- **计划任务**：由 Host 级定时器触发的无人值守投递。

实现位置：

- 子代理：`packages/core/src/subagents/manager.ts`、`packages/core/src/tools/builtin/subagent.ts`、`packages/core/src/domain/subagent.ts`
- 计划任务：`packages/core/src/schedule/`
- Web 投递宿主：`packages/web/src/schedule-host.ts`

## 1. 子代理模型

### 1.1 不是线程，是独立会话

每个子代理都是一个完整的 `Session`，有自己的：

- `session.jsonl`；
- `agent/selected`、`model/selected`、`permission/dsh-preset` 事件；
- 工作区、cwd、深度、父会话 id 和描述；
- 工具表、skill allowlist、system prompt；
- 消息历史、todo、plan、goal、标题。

它出现在普通会话列表中，可以通过正常会话接口读取。父会话只保存 `subagent/start`、`subagent/end`、`subagent/notice` 等关联事件。

### 1.2 限制

| 限制 | 默认 | 说明 |
| --- | --- | --- |
| `subagents.maxDepth` | 1 | 根会话深度 0；子代理深度 = 父 + 1 |
| `subagents.maxActive` | 8 | 同一运行时内同时运行的活动子代理数 |
| 结果长度 | 8,000 字符 | 超出追加 `…[truncated]` |
| description | 200 字符 | |
| prompt / message | 100,000 字符 | |

`canStart()` 还要求：

- manager 未关闭；
- 父会话有持久化 handle；
- 父会话有 DSH 权限快照；
- 当前 `activeRuns + reservedRuns < maxActive`。

### 1.3 启动流程

`SubagentManager.start()`（`manager.ts:134-205`）：

1. 校验 description、prompt。
2. `cwd` 若提供，必须在父会话 cwd 的物理路径内。
3. 选择 agent：`request.agent ?? parent.agent.id ?? 'default'`。
4. 解析模型绑定和 `RuntimeResolver.resolve({ isRoot: false })`。
5. `store.create()` 创建持久化子会话。
6. 追加三个初始事件：
   - `permission/dsh-preset`（复制父会话当前 preset）；
   - `agent/selected`；
   - v2 `model/selected`。
7. 构造子 `Session`，加入 `children` 和 `live`。
8. 向父会话追加 `subagent/start`。
9. 异步 `launch()` 启动第一个回合；工具立即返回 `started subagent <id>`。

### 1.4 模型选择

`selectBinding()`（`manager.ts:337-358`）：

- `role` 不能与 `provider` / `model` 同时出现；
- `provider` 和 `model` 必须成对；
- `reasoning_effort` 只能配合显式 provider/model；
- 否则使用 `{ version: 2, kind: 'agent' }`，由目标 agent 的 role 决定模型。

注意：子代理默认**不复制父会话当前的模型绑定**，而是使用目标 agent 的角色。这样父会话切换模型不会意外改变子代理的模型。

### 1.5 权限与工作区继承

- 权限预设：复制父会话创建时的快照，写入子会话；之后父会话切换预设不会影响已存在子代理。
- 工作区：同一个 workspace。
- cwd：继承父会话 cwd；显式 `cwd` 必须被限制在父 cwd 的物理路径内。
- 审批：TUI 把终端审批回调传给子 Session；Web 的子代理是后台会话，没有绑定父回合的 SSE 审批流。
  - 普通工作区操作仍按继承的预设执行；
  - 一次性沙盒升级因为没有 live approval handler 而被拒绝；
  - plan review 不可用。

### 1.6 生命周期与状态

```text
running → completed
        → failed
        → interrupted
        → idle（回合结束但仍可继续）
```

- 每个子代理维护一个串行 `queue`，同一子代理的回合不会并发。
- 第一个回合事件到达时 resolve `started`；`turn.end` 时 resolve `settled`。
- 后台回合（父代理向 idle 子代理发消息）会把状态重置为 running，并新建 `settled`。
- 完成时：
  - 追加 `subagent/end` 到父会话；
  - 如果父会话仍在本进程 live，调用 `receiveSubagentNotice()`；
  - 否则追加 `subagent/notice`，等父会话下次恢复时消费。

### 1.7 协作工具

| 工具 | 语义 |
| --- | --- |
| `subagent` | 创建子代理并异步启动；参数 `description`、`prompt`、可选 `cwd`、`agent`、`role`、`provider`、`model`、`reasoning_effort` |
| `send_message` | 向同一协作树中的目标发送消息；running 时插入下一步，idle 时启动新回合 |
| `list_agents` | 返回根、自身、可继续的后代；`running` 只表示有回合在执行，`inactive` 不表示成功或失败 |
| `wait_agent` | 等待**调用者自己的下一步输入**（消息、完成通知、用户 steering），不是等待某个子代理的最终状态 |
| `interrupt_agent` | 中断某个后代；只对当前进程中 running 的子代理生效 |

`list_agents` 和 `send_message` 都要求目标在同一棵协作树内。`interrupt_agent` 要求目标是调用者的后代；子代理自己启动的子代理不会因为父被中断而自动停止。

### 1.8 消息投递

`send()` 的路径：

```text
caller 发消息给 target
  ├─ target 不是本进程 managed child，但是 caller 的祖先
  │    ├─ 祖先 live → deliverExternalMessage
  │    └─ 否则 → 报 "not live in this process"
  ├─ 其他 → ensureChild(targetId) 懒恢复
  ├─ target running
  │    ├─ 已有 activeTurn → deliverExternalMessage
  │    ├─ 尚未建立 activeTurn → 报 "not ready to receive a message"
  │    └─ 等待启动
  └─ target idle → launch 新回合
```

每条消息带 `[message from agent <caller>; message <id>]` 归属标记。

### 1.9 懒恢复

当父进程重新打开一个已存在的子代理时，`ensureChild()` 会：

1. 从 store 找到 summary 并 `open()`；
2. 校验 `parentSessionId` 存在；
3. 重放并校验：
   - `permission/dsh-preset` 必须 ready；
   - `agent/selected` 必须 selected；
   - v2 `model/selected` 必须 selected；
4. 用持久化的 cwd / agent / binding 重新 resolve；
5. 恢复 depth、最后 `trace/turn.end` 状态和最后 assistant 文本；
6. 加入 `children` / `live`。

任一选择缺失或非法 → 拒绝恢复，不回退到父模型或默认模型。

### 1.10 已知边界

- `maxActive` 是进程内计数，不是跨进程配额。
- `wait_agent` 不等待子代理完成，等待的是调用者下一步可消费的输入；需要最终状态时应使用 `list_agents` 或读取子会话详情。
- Web 子代理的后台通知不会进入父回合的原始 SSE 响应；父会话重新加载后才能看到。
- 子代理的 plan review 在 Web 中不可用。
- 子代理的权限预设不会跟随父会话后续切换。

## 2. 计划任务

### 2.1 存储与作用域

- 路径：`~/.omniagent/schedules.json`；
- 作用域：Host，不属于任何会话日志；
- 单文件 JSON：`{ version: 1, tasks: [...] }`；
- 写入：临时文件 + fsync + rename；
- 假设单个 Host 进程拥有该文件，没有跨进程锁。

### 2.2 任务模型

```ts
type ScheduleTask = {
  id: string;
  record: ScheduleRecord;
  target: ScheduleTarget;
  involvedSessionIds: string[];
  status: 'active' | 'paused' | 'ended';
  createdAt?: string;
  updatedAt?: string;
  lastDelivery?: ScheduleDeliveryReceipt;
  deliveryHistory: {
    records: DeliveryRecord[];
    earlierRecordsUnavailable: boolean;
    earlierRecordsPruned: boolean;
  };
};
```

`record` 包含标题、prompt、timing、下一次 `scheduledAt` 等。

### 2.3 时间规则

| kind | 形态 | 说明 |
| --- | --- | --- |
| `after` | `{ afterSeconds }` | 延迟一次 |
| `at` | ISO 字符串或 `{ date, time, time_zone }` | 绝对一次 |
| `every` | `{ everySeconds }` | 固定间隔，最小 60 秒 |
| `daily` | `{ time, time_zone }` | 每天 |
| `weekly` | `{ time, time_zone, weekdays }` | 每周，ISO 周一到周日 1–7 |
| `cron` | `{ expression, time_zone }` | 五字段 cron |
| `rrule` | `DTSTART` + `RRULE` 两行 | RFC 5545 |

约束：

- 时间必须是 canonical RFC3339 UTC，带毫秒；
- 本地时间规范化为 `HH:mm:ss.SSS`；
- DST 不存在的本地 wall-clock 时间直接拒绝；
- `every` 第一次触发必须是严格未来；
- RRULE 限制 `COUNT <= 1000`、单周期候选 <= 10080、`BYSETPOS <= 31`；
- cron 搜索地平线 400 年。

### 2.4 投递目标

| target | 行为 |
| --- | --- |
| `{ kind: 'session', sessionId }` | 投递到已有 root 会话 |
| `{ kind: 'new_once', create? }` | 创建时预分配 session id，第一次投递创建会话，后续继续使用 |
| `{ kind: 'new', create? }` | 每次投递创建新会话 |

`create` 可以指定 `cwd` 和 `agentPreset`。子代理会话不能作为 target，会返回 `subagent_session`。

### 2.5 服务层

`ScheduleService`：

- 默认保留投递历史 30 天 / 200 条；
- 默认列表 100，最大 500；
- 排序：active 优先，active 内按 `scheduledAt` 升序；非 active 按最近更新 / 投递倒序；
- `create`：生成 `schedule-<uuid>`；默认 target `new_once`；
- `list` / `view` / `history` 不激活目标会话；
- `run`：立即执行一次，不消费 / 移动 `scheduledAt`；
- `edit`：
  - 空 patch 拒绝；
  - `expectedUpdatedAt` 用于 compare-and-set，冲突返回 `schedule_conflict`；
  - 修改 timing 会重新计算下一次 occurrence；
  - 恢复一个没有未来 occurrence 的任务返回 `not_future`；
  - `active: false` → paused；`active: true` → active。

### 2.6 运行时

`ScheduleRuntime`：

- 同一时刻最多一个 timer；
- timer 最大延迟 `2^31 - 1` ms，超过则分段唤醒；
- `drive()` 选择 `active && !executing && scheduledAt <= now` 的任务；
- 同一目标会话的多个到期任务合并成一条批量消息；
- 下次唤醒时间取 `max(scheduledAt, nextAdmissionAt)`；
- 非 `new` 目标两次投递最小间隔 60 秒；`new` 目标默认也是 60 秒；
- 投递失败不会立即重试；本轮把失败任务排除，等下一次 `requestDrive()`（启动、创建 / 编辑、其他任务投递结束等）；
- **错过的触发只补最近一次**，不补跑积压；
- 一次性 `after` / `at` 即使迟到也只投递一次，然后 `ended`；
- recurring 任务投递成功后把 `scheduledAt` 推进到下一次；没有下一次 → `ended`。

### 2.7 投递消息

单条：

```text
[SCHEDULE REMINDER]
schedule_id: ...
occurrence_at: ...
prompt: <JSON 字符串>
```

批量：

```text
[SCHEDULE REMINDER BATCH]
reminders: <JSON 数组>
```

消息通过 `deliverExternalMessage(text, 'schedule')` 进入会话；如果会话正在运行，进入 inbox，在下一步被模型看到；否则启动后台 turn。

### 2.8 目标会话创建

`SessionScheduleHost.createTargetSession()`（`web/src/schedule-host.ts:135-175`）：

- `cwd = spec.cwd ?? process.cwd()`；
- 在已注册 workspace 中找最长匹配前缀；找不到就直接用 cwd；
- `store.create()`；
- 追加：
  - 全局默认 DSH preset（或 `workspace-write`）；
  - `agent/selected`：`spec.agentPreset ?? mode?.agent ?? 'default'`；
  - `model/selected`：默认 agent + mode 时用 mode 的模型，否则 `{ kind: 'agent' }`；
  - 默认 agent + mode 时追加 `mode/selected` 快照；
  - 可选用户来源标题。
- 投递时优先复用 `LiveSessionRegistry` 中的 Session；否则重新 resolve、构造、注册 live，再投递。这避免同一日志被两个 Session 实例写入。

### 2.9 无人值守语义

- 计划任务的 turn 是 unattended：
  - 审批请求一律 deny；
  - plan review 不可用；
- 子代理不能创建或修改任务；
- 服务停止期间错过的多次触发只补最近一次；
- 进程崩溃可能导致重复投递；
- 任务使用全局默认权限预设；已有会话保持自己的预设。

### 2.10 模型工具

| 工具 | 说明 |
| --- | --- |
| `schedule_create` | 只暴露 `rrule` timing；可指定 `this_session` / `new_once` / `new` |
| `schedule_list` | 列出任务 |
| `schedule_view` | 查看单个任务，隐藏内部字段，增加本地时间 |
| `schedule_edit` | 只接受 `rrule` 更新 |

限制：

- 只能在深度 0 的主会话使用；子代理调用会被拒绝；
- 工具声明 `mutating: false`，但 create / edit 实际会修改 Host 状态；这个字段不是权限依据；
- HTTP 路由支持全部 timing 类型，模型工具只支持 rrule 是刻意的收窄。

### 2.11 HTTP 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/schedules` | 列表，支持 active / limit / offset |
| `POST` | `/api/schedules` | 创建 |
| `GET` | `/api/schedules/limits` | 历史保留边界 |
| `GET` | `/api/schedules/:id` | 单个任务 |
| `PATCH` / `PUT` | `/api/schedules/:id` | 更新，支持 `expectedUpdatedAt` |
| `DELETE` | `/api/schedules/:id` | 删除任务及投递历史 |
| `POST` | `/api/schedules/:id/run` | 立即执行 |
| `GET` | `/api/schedules/:id/history` | 投递历史分页 |
| `POST` | `/api/schedules/clear-ended` | 清理已结束任务 |

详细请求体见 [web-api.md](../web-api.md#schedules)。

## 3. 两者如何配合

典型场景：

```text
主会话
  └─ subagent(explorer)        探索代码，只读
  └─ subagent(worker)          并行实现
  └─ schedule_create           每天 9 点汇总进展到当前会话
```

关系：

- 子代理是**会话树**，由父子关系约束；
- 计划任务是**Host 定时器**，只认目标会话 id；
- 计划任务可以投递到主会话，也可以每次新建会话；
- 子代理不能创建计划任务，避免后台任务在无人观察的深层会话中扩散；
- 子代理完成通知和计划任务投递都通过 `deliverExternalMessage` / `receiveSubagentNotice` 进入 inbox，遵循相同的「运行中进队列、空闲时启动后台 turn」规则。

## 4. 已知限制

- 子代理最大深度默认 1，不能形成很深的递归树。
- `maxActive` 和 `maxDepth` 是进程内限制；多进程运行时不共享配额。
- `wait_agent` 的语义是等待调用者下一步输入，不是等待子代理完成；不要用它轮询最终结果。
- 子代理懒恢复要求三份选择事件都有效；旧会话可能无法恢复。
- Web 子代理没有父 SSE 审批流；需要审批的升级操作会被拒绝。
- 计划任务的 timer 不持久化；进程重启后重新计算下一次触发。
- 错过的触发只补最近一次；崩溃可能重复投递。
- 计划任务的目标会话创建使用全局默认权限，不会继承创建者的工作区权限。
