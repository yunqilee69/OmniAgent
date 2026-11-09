# 持久化与观测

本文说明 OmniAgent 把什么写到哪里、如何保证追加安全、以及 TUI / Web 如何从同一份日志生成列表、轨迹、审计和导出。实现位置：

- 会话存储：`packages/core/src/session/store.ts`、`file-lock.ts`
- 历史投影：`packages/core/src/session/projection.ts`
- 标题 / pin / fork：`packages/core/src/session/title.ts`、`pin.ts`、`fork.ts`
- 审计：`packages/core/src/store/audit.ts`、`packages/web/src/audit.ts`
- 轨迹与导出：`packages/web/src/trajectory.ts`、`trace-projection.ts`、`session-export.ts`
- 工作区：`packages/web/src/workspaces.ts`
- 实时会话：`packages/web/src/live-sessions.ts`

## 1. 会话文件布局

```text
~/.omniagent/sessions/
├── --<workspace-slug>--<sha256>/          # 现代 workspace key
│   └── <encoded-session-id>/
│       └── session.jsonl
└── --<legacy-slug>--/                     # 旧版路径，只读兼容
    └── <session-id>/
        └── session.jsonl
```

现代 workspace key：

```text
--<slug 前 160 字符>--<sha256(workspace 路径, utf16le)>
```

legacy key 只有 slug，可能冲突；读取时现代文件优先，legacy 只作为回退，不自动迁移。

`encodeSegment()`：

- `[A-Za-z0-9._-]` 原样保留；
- 其他 UTF-16 code unit 编码为 `~XXXX`；
- `.` 和 `..` 特判为 `~002E` / `~002E~002E`，防止路径穿越。

## 2. 文件格式

第一行是 header JSON，之后每行一个 event JSON，文件以换行结尾。

### 2.1 Header

```ts
{
  type: 'session',
  version: 1,
  id: string,
  workspace: string,
  cwd: string,
  createdAt: string,        // ISO
  agentId?: string,
  parentSessionId?: string,
  depth?: number,
  description?: string      // ≤200
}
```

`StoredHeaderSchema` 先宽松解析，再校验 `SESSION_FORMAT_VERSION === 1`。版本不符直接失败。

### 2.2 Event

```ts
{
  seq: number,     // 从 0 开始连续
  ts: number,      // 毫秒时间戳
  type: string,
  data: unknown
}
```

`SessionLog` 在内存中深冻结每个事件；`append()` 自动分配 `seq = nextSeq` 和 `ts = Date.now()`。显式传入不连续的 `seq` 会抛错。

## 3. 读取与校验

`parseLog()`：

- header 的 `id` / `workspace` 必须与请求一致；
- 逐行拒绝空行；
- 拒绝 JSON / schema 错误；
- 每个 event 的 `seq` 必须等于行 index，即从 0 连续；
- 任何损坏 → `invalid session event; original log was preserved`；
- 不截断、不猜测、不跳过损坏行。

唯一的自动修复：**完整记录但缺少末尾换行**。`open()` 会补 `\n`，解析成功后用 `persistUnlocked()` 规范化整个文件。

`tornTail` 字段目前恒为 `false`；没有「最后一条记录不完整就丢弃」的恢复逻辑。

## 4. 追加的原子性

`SessionHandle.append()` → `SessionStore.appendToSession()`（`session/store.ts:425-478`）：

```text
1. 进程内 per-path 串行队列
2. 跨进程 lock：<session.jsonl>.lock
3. realpath(target)，读完整原文件
4. 校验 header 身份、普通文件属性
5. 重新 parseLog
6. 基于磁盘日志构造 staged log
7. 写临时文件 <target>.<pid>.<uuid>.tmp（wx, 0600）
   ├─ 先写原始字节
   ├─ 再 O_APPEND 追加新 event 行
   ├─ chmod 回原文件 mode
   └─ fsync
8. stat(bigint) 比较 realpath/dev/ino/size/mtimeNs/ctimeNs
   └─ 任一变化 → "session changed during append"
9. rename 覆盖目标
10. fsync 目录（Windows 跳过）
11. 更新内存 log
```

任一步失败：

- 删除临时文件；
- 内存日志不前进；
- 不重建已被删除的会话文件。

### 4.1 跨进程锁

`file-lock.ts`：

- 锁文件：同级 `<session.jsonl>.lock`；
- 创建：`open('wx', 0o600)`；
- 内容：`"<pid>\n"`；
- 拿不到锁时最多等待 10 秒，重试 20 ms 起，指数退避到 200 ms；
- 只有能证明 holder 已死（`process.kill(pid, 0)` 返回 `ESRCH`）或锁内容损坏且 mtime 超过 60 秒时，才抢占；
- 抢占通过 `rename` 移动旧 inode，多个抢占者只有一个成功，避免误删新锁。

读者不加锁，依赖原子 rename 读取一致快照。锁只约束协作写入者；非协作外部进程仍可能竞争，但会在元数据比较时被检测。

### 4.2 权限

- 新建目录：`0700`；
- 新会话文件：`0600`；
- 临时文件：`0600`；
- 锁文件：`0600`；
- 追加时保留既有文件 mode，不主动收紧旧文件。

## 5. 列表摘要

`SessionSummary`（`session/store.ts:132-153`）：

```ts
{
  id, agent?, mode?, agentId?,
  parentSessionId?, depth?, description?,
  title?, titleSource?, pinned?,
  blank, workspace, cwd,
  createdAt, updatedAt, eventCount
}
```

- `title`：最新合法 `session/title`；
- `titleSource`：`fallback | provider | user`；
- `pinned`：最新 `session/pinned`；
- `blank`：第一条人类消息之前为 true；
- `updatedAt`：最后一个非 title / 非 pin 事件的时间。

改名和 pin 不会把会话顶到列表顶部。

`list()` 扫描两层目录，跳过损坏文件；现代 / legacy 去重时现代优先。

## 6. 标题、pin、fork

### 6.1 标题

事件：

```json
{ "title": "...", "messageSeqs": [], "source": { "kind": "fallback" | "provider" | "user" } }
```

- fallback：第一条人类文本的前 5 词，最多 40 字节；
- provider：异步生成，最多 80 字节，失败静默；
- user：Web PATCH 或显式命名，之后停止自动生成。

清洗会去除 OSC / CSI / ESC、C0/C1 控制字符、方向性 / 不可见控制字符，并统一空白。

### 6.2 Pin

事件：

```json
{ "pinned": true }
```

最新事件胜出；格式错误视为未 pin。pin 只影响列表分组，不改变 `updatedAt`。

### 6.3 Fork

`POST .../fork`：

1. 读取源会话事件；
2. 删除 `session/title`、`session/pinned`、`session/fork`；
3. 保留其余事件和原始 `ts`；
4. 如果源有标题，追加 `(fork)` 标题；
5. 追加 `session/fork { sourceSessionId }`，`ts = now`；
6. 用 `store.create()` 创建新 root 会话，重新分配 `seq`。

不复制：

- 子会话；
- pin；
- 父会话关系；
- 附件。

## 7. 审计

### 7.1 核心格式

```ts
{
  ts: string,             // ISO
  sessionId: string,
  step: number,
  tool: string,
  callId: string,
  argsDigest: string,     // sha256(JSON.stringify(arguments))
  decision: 'allow' | 'ask' | 'deny',
  source: string,         // 命中的规则文本 / 模式原因
  ok?: boolean,
  durationMs?: number
}
```

一行一个 JSON，只增不改。

### 7.2 TUI 审计

- 路径：`<workspace>/.omniagent/audit.jsonl`；
- 新目录 `0700`，新文件 `0600`；
- 拒绝 symlink / 非普通文件；
- 既有目录和文件的 mode 不改。

### 7.3 Web 审计

- 路径：`~/.omniagent/web-audit/<sha256(workspace, utf16le)>.jsonl`；
- 读取最多尾部 2 MiB、最多 1,000 条；
- 丢弃从中间截断的首行；
- 跳过超过 64 KiB 的行、非法 JSON、sessionId 不匹配的行；
- API 投影只返回：

  `ts / sessionId / step / tool / callId / decision / ok / durationMs`

- **不返回 `argsDigest` 和 `source`**，避免泄露参数摘要和权限规则文本。

TUI 和 Web 的审计文件互不读取、不迁移。

## 8. Trace、轨迹与导出

### 8.1 Trace 投影

`projectTraceEvents()`（`web/src/trace-projection.ts`）只保留 `trace/*` 类型，并只输出有限的元数据：

- step；
- reason；
- name；
- decision；
- ok；
- truncated；
- durationMs；
- beforeTokens / afterTokens。

不保留：

- callId；
- 工具参数；
- 工具结果；
- 权限规则；
- 错误文本。

### 8.2 轨迹

`projectTrajectory()`（`web/src/trajectory.ts`）把事件日志投影成：

```ts
{
  version: 1,
  turns: [...],
  records: [...],
  timeline: { sequence, time }
}
```

规则：

- `message/user` 或 `user/message` 开新 turn；
- 重复 `trace/turn.start` 视为新 step；
- 非递增 step 开新 turn 片段；
- 工具关联不跨 step / user turn；
- 工具名限定内置白名单；
- 只在唯一匹配时合并 call / result / decision；
- 时间轴使用事件记录时间，不代表模型延迟。

不包含消息正文、参数、结果内容、权限规则或错误字符串。

### 8.3 导出

`GET .../export?format=markdown|json`：

- JSON schema：`omniagent-session-transcript` v1；
- Markdown 使用可变长 fenced block 包裹不受信任文本；
- 排除：
  - system / injected context；
  - metadata；
  - tool arguments；
  - internal output reference；
  - trace / audit；
- 图片替换为 `{ type: 'image', omitted: true }`；
- 被权限拒绝的工具输出替换为 `contentOmitted: 'permission'`；
- 不包含子会话和附件。

导出仍包含对话文本和工具输出，可能含敏感信息，分享前必须检查。

## 9. 工作区注册表

`~/.omniagent/workspaces.json`：

```json
[
  { "id": "uuid", "path": "/canonical/path", "name": "basename", "lastUsedAt": 1234567890 }
]
```

- `add()`：`realpath` 规范化路径，必须是已存在目录；同一 canonical path 复用已有记录；
- `remove()`：只删除注册项，不删除目录或会话；
- `touch()`：更新 `lastUsedAt`；
- 读取校验：数组、字段类型、id / path 唯一；
- 写入：临时文件 + rename，**没有 fsync**，只保证单进程串行。

Web 会话路由以注册表为权威：workspace id 必须存在，mutation 时还会校验注册路径。

## 10. 实时会话与缓存

### 10.1 LiveSessionRegistry

`packages/web/src/live-sessions.ts`：

- key：`<workspacePath>\0<sessionId>`；
- LRU，默认上限 128；
- 作用：让 Web 标签页、计划任务、子代理共享同一个 `Session` 实例，避免两个实例写同一份日志。

### 10.2 Web Session 缓存

`server.ts` 的 `getSession()`：

- 缓存维度：
  - 权限预设；
  - 模型 binding（`JSON.stringify`）；
  - resolver revision；
- 命中 `liveSessions` 或本地 `sessions` Map 时复用；
- 超过 `MAX_CACHED_WEB_SESSIONS = 64` 时按插入序淘汰，跳过当前 key 和 running 中的 key；
- 权限 / agent / model / plan 变更、删除会话时主动失效。

## 11. 手工检查数据

```bash
# 列出所有会话文件
find ~/.omniagent/sessions -name session.jsonl

# 查看某个会话的事件类型序列
jq -r '.type' ~/.omniagent/sessions/**/session.jsonl 2>/dev/null | sort | uniq -c

# 查看最近一次工具调用
tail -n 50 ~/.omniagent/sessions/**/session.jsonl | jq -c 'select(.type|startswith("trace/tool"))'

# 查看计划任务
jq . ~/.omniagent/schedules.json

# 查看工作区
jq . ~/.omniagent/workspaces.json
```

注意：

- 会话文件是追加日志，不要手工编辑；
- 如果必须删除，只能删除整个会话目录，并确保没有进程正在运行该会话；
- 审计和会话都可能包含敏感内容。

## 12. 隐私边界

| 数据 | 可能包含 | 暴露面 |
| --- | --- | --- |
| `session.jsonl` | 对话、工具参数 / 结果、图片、权限决策、goal / todo | 本机文件；Web API 只返回脱敏消息和 trace |
| `web-audit/*.jsonl` | 工具名、参数摘要、权限 source、决策 | Web API 不返回摘要和 source |
| `schedules.json` | prompt、目标会话、投递记录 | 本机文件 |
| `workspaces.json` | 本地路径 | Web API 返回注册信息 |
| 实时 SSE | 完整 assistant / tool 事件 | 只在本机 loopback；不是脱敏导出 |
| 会话导出 | 对话文本、工具输出 | 可能含秘密，需人工检查 |
| 轨迹 / trace | 元数据，无正文 / 参数 / 结果 | 相对安全，但仍暴露工具调用模式 |

没有本地用户认证。Host / Origin 检查只防止浏览器跨站请求，不阻止同 OS 用户的其他进程。
