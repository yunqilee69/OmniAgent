# TUI 实现

TUI 是 OmniAgent 的终端前端。它只消费 core 的 `AgentEvent`，不直接解析配置文件，也不自己实现 agent 循环。

实现位置：`packages/tui/src`

| 文件 | 作用 |
| --- | --- |
| `main.ts` | 进程装配、REPL、命令处理、审批问答、会话恢复 |
| `render.ts` | 事件 → 终端文本；唯一「认识 UI」的地方 |
| `blocks.ts` | 各类块的纯文本构建（思考头、工具卡、状态行、帮助） |
| `palette.ts` | 角色 → SGR 的唯一事实来源，以及 `roleViolations()` 测试闸门 |
| `ansi.ts` | SGR 拼装、颜色开关、显示宽度 / 截断 |
| `markdown.ts` | 流式 Markdown、表格、围栏、行内样式、折行 |
| `highlight.ts` | 单行代码高亮、diff 高亮 |
| `tools.ts` | 工具名 → 中文标题 / 摘要 / 输出裁剪 |

## 1. 进程装配

`main()`（`main.ts:218-249`）：

1. `ConfigStore.open(~/.omniagent/config.json)`；
2. `AgentCatalog`；
3. `RuntimeResolver`；
4. `SessionStore(~/.omniagent/sessions)`；
5. `AuditLog(<cwd>/.omniagent/audit.jsonl)`；
6. `McpService`（启动时 sync 一次）；
7. `SubagentManager`；
8. `Approval` 回调、`reviewPlan` 回调、`onBackgroundEvent`；
9. 进入 REPL。

TUI 的全局对象：

```ts
const cwd = process.cwd();
const rl = readline.createInterface(...);
const theme = createTheme();
const roles = createRoles(theme);
const renderer = new TuiRenderer({ theme });
```

`renderer` 在模块级创建，因此启动错误也能用它打印。

## 2. 主循环

```text
for (;;) {
  refreshStatus();
  line = await rl.question(promptLine());
  if (!line.trim()) continue;
  if (statusError && !allowed(line)) continue;

  if (line 是命令) { handleCommand(); continue; }

  store.open(cwd, handle.id)
  projection() 必须 ready，否则提示 /permission
  resolveSessionRuntime()
  settingsKey = `${preset}\0${runtime.revision}`
  懒创建 Session
  for await (event of session.send(line)) renderer.handle(event)
}
```

关键点：

- Session 是懒创建的：只有真正发送消息时才 `makeSession()`，所以 `/resume` 只重放事件，不重跑模型。
- `settingsKey` 由权限预设和 resolver revision 组成；配置 / agent / 模型变化会触发重建。
- `projection()` 不是 `ready` 时，除 `/help`、`/clear`、`exit`、`q` 外一律拒绝输入，并提示先 `/permission`。

## 3. 命令

命令在 `main.ts` 内联实现，没有单独的命令注册表。

| 命令 | 行为 |
| --- | --- |
| `exit` / `q` | 关闭子代理后退出 |
| `/help` | 打印帮助 |
| `/color [on\|off]` | 开关颜色；`NO_COLOR` / `TERM=dumb` 决定默认 |
| `/clear` | TTY 下清屏并重印 banner；非 TTY 换行 |
| `/think [full\|compact\|off]` | 思考展示模式 |
| `/verbose` | 展开 / 收起工具输出 |
| `/sessions` | 列出会话，标出当前、parent/depth、eventCount、agent |
| `/todos` | 打印当前 todo 列表 |
| `/plan [on\|off]` | 切换 plan 模式；运行中禁止 |
| `/new` | 新建会话，继承当前 agent |
| `/permission <preset>` | 切换 DSH 预设 |
| `/agent [id]` | 列出 / 切换主智能体 |
| `/model [n\|agent\|provider model]` | 列出 / 切换模型 |
| `/resume <id>` | 打开已有会话 |
| 未知 `/x` | 警告并指向 `/help` |

### 3.1 实现备注

帮助文案（`blocks.ts:294`）写了 `/model role <id>`，但 `main.ts:680-698` 只实现了：

- `/model`：列表；
- `/model agent`：跟随智能体角色；
- `/model <序号>`：按目录序号；
- `/model <provider> <model>`：显式模型。

`/model role <id>` 尚未实现，会落到「该模型不在当前配置的模型目录中」。如果要用角色绑定，请暂时通过 Web 或直接写会话事件。

## 4. 渲染管线

`TuiRenderer.handle(event)`（`render.ts:130-213`）是唯一的事件分发点。

| 事件 | 行为 |
| --- | --- |
| `turn.start` | 停 spinner、结束上一个块、清流式状态、启动 spinner |
| `assistant.reasoning.delta` | 累积 reasoning；`full` 模式下流式写入 `┊` 思考块 |
| `assistant.delta` | 停 spinner、结束 reasoning、确保正文块，交给 `MarkdownStream` |
| `assistant.message` | 对不支持流式的 provider 补写缺失后缀，避免重复 |
| `tool.call` | 结束正文 / 思考，启动工具卡 |
| `permission.decided` | allow 只在 verbose 时打印；deny 记录并打印通知 |
| `tool.result` | 原地覆盖 pending 行，按状态着色 |
| `context.compacted` | 单行通知 |
| `error` | 单行通知 |
| `turn.end` | 打印尾行并重置 |
| `permission.requested` | 渲染器不处理；由 `approve` 回调打印审批卡 |

`session.title` 没有分支，TUI 忽略它。

### 4.1 四类左缘

TUI 的排版只有一条规则：四类内容各有自己的左缘。

```text
  2 空格 + Markdown      正文（含 Assistant 标签，一回合一次）
  ┊ 虚线导轨 + 内收斜体   思考（✻ 思考）
  │ 实线导轨 + 内收       工具结果体
  引导符                 通知（◇ / ⚠ / ✗）与回合尾行（✓ 完成）
```

`GLYPH`（`blocks.ts:18-34`）定义：

| 名称 | 符号 |
| --- | --- |
| 正文缩进 | 两个空格 |
| 思考导轨 | `┊` |
| 工具导轨 | `│` |
| 项目符号 | `·` |
| 思考头 | `✻` |
| pending ring | `○` |
| done ring | `●` |
| denied ring | `⊘` |
| 成功 | `✓` |
| 失败 | `✗` |
| 通知 | `◇` |
| 中断 | `■` |
| 警告 | `⚠` |
| 提示符 | `❯` |

块间距：

- 连续 `tool` / `notice` 只换行；
- 跨类留一个空行；
- `write()` 把连续空行压到最多一个。

## 5. 流式 Markdown

`MarkdownStream`（`markdown.ts:35`）按完整行处理：

- `push()` 只把 chunk 追加到 buffer；
- 遇到 `\n` 才 `processLine()`；
- 因此粗体、代码、表格不会被切碎。

支持：

- 围栏代码块：`╭─ lang ─...` / `╰───`，正文走 `highlightCode()`；
- 表格：分隔行、对齐、列宽；超宽时退化为 `·` 拼接；
- 标题、水平线、引用、列表、4 空格缩进代码；
- 行内代码、图片、链接、autolink、删除线、粗体、斜体、裸 URL；
- 按显示宽度折行，CJK / emoji 记 2 格，组合符 / ZWJ 记 0。

思考流使用 `baseStyle`，不上色，只 dim。

## 6. 调色板

两条硬约束（`palette.ts:1-12`）：

1. 只用 ANSI 0–15 前景色与属性；
2. 不用 24-bit RGB，不用背景色。

其他规则：

- 内收文字用 `dim`（SGR 2），不用固定 `gray`（SGR 90），这样浅色 / 深色终端都能重映射；
- `ROLE_SPEC` 是唯一的角色 → SGR 表；
- `roleViolations(text)` 只允许 SGR 0/1/2/3/4/9/39/30–37/90–97；
- 测试用 `roleViolations()` 守住这个边界。

颜色开关：

- `NO_COLOR` 优先；
- `FORCE_COLOR=0`；
- `TERM=dumb`；
- 非 TTY 默认无色。

## 7. 工具卡

`tools.ts`：

- `PRESENTATION`：工具名 → 中文标题 + 图标；
- `describeToolCall()`：生成 `{ icon, title, summary, detail }`；
- `summarizeArguments()`：按工具生成一行摘要；
- `escalationDetail()`：解析 `sandbox_permissions` + `justification`；
- `describeToolResult()`：按工具裁剪输出。

默认输出裁剪：

| 工具 | 成功 | 失败 | verbose |
| --- | --- | --- | --- |
| `bash` | 6 行 | 14 行 | 200 行 |
| `read_file` | 5 行 | — | 60 行 |
| `list_dir` / `glob` / `grep` / `web_fetch` / `skill` / `todo_write` | 只给 meta | 同左 | 展开 |
| 未知工具 | 非 verbose 时安静 | 显示 | 展开 |

工具卡整行按结果状态着色：

- 运行中：黄；
- 成功：绿；
- 失败：红；
- 拒绝：亮黄。

pending 行会原地刷新耗时，状态切换时用 `\r\x1b[2K` 覆盖。

## 8. 审批与计划审阅

### 8.1 工具审批

`approve(request)`（`main.ts:84-97`）：

1. `renderer.showPermissionRequest(request)` 打印审批卡；
2. 用 readline 读取 `y/N`；
3. `y` / `yes` → allow；
4. 异常 → deny；
5. `recordPermissionAnswer()` 记录答案，供 `permission.decided` 去重。

审批卡内容：

```text
⚠ 需要授权 · <工具标题>
  操作 <摘要>
  提升 <目标预设> · <理由>     # 仅一次性升级时
  原因 <reason>
  ❯ 允许执行？(y/N)
```

### 8.2 计划审阅

`reviewPlan(plan, signal)`：

1. 检查 signal；
2. 用正文缩进渲染计划；
3. 询问「批准并退出 plan 模式？(y/N)」；
4. 拒绝时再问补充意见；
5. 返回 `{ approved: false, feedback? }`。

## 9. 后台事件

子代理 / 后台 turn 的事件通过 `onBackgroundEvent` 转发到 `backgroundNotice()`：

- 只渲染 `tool.call`、`tool.result`、`error`、非正常 `turn.end`、`context.compacted`；
- 加 `[sessionId 前 8 位]` 或 `[background]` 标签；
- 过滤 `assistant.delta`、`reasoning.delta`、`assistant.message`，避免后台输出淹没当前对话。

## 10. 会话恢复

`/resume <id>`：

1. `store.open(cwd, id)`；
2. `resetSession()`，让下次发送重建 Session；
3. 打印消息数与 agent 选择；
4. 没有 agent 选择时警告。

`/sessions`：

- `store.list()` 列出所有工作区；
- 当前会话用 `*` 高亮；
- 显示 parent / depth / eventCount / agent。

TUI 不渲染历史消息，只显示摘要；恢复后发送新消息时，Session 会从事件日志重建历史。

## 11. 如何扩展

### 加一个命令

1. 在 `main.ts` 的 REPL 分支里加 `if (line === '/x' ...)`。
2. 更新 `blocks.ts` 的 `renderHelp()`。
3. 如果命令改变会话状态，调用 `resetSession()` 或 `refreshStatus()`。
4. 加 `main.test.ts` 覆盖输入解析。

### 加一种块

1. 在 `render.ts` 的 `BlockKind` 里加类型；
2. 在 `enterBlock()` 里决定间距；
3. 在 `blocks.ts` 里加纯文本构建函数；
4. 在 `handle()` 里分发事件；
5. 加 `render.test.ts` 断言输出。

### 加工具展示

1. 在 `tools.ts` 的 `PRESENTATION` 加标题 / 图标；
2. 在 `summarizeArguments()` 加一行摘要；
3. 在 `describeToolResult()` 加输出裁剪；
4. 加 `blocks.test.ts` / `render.test.ts`。

### 加颜色角色

1. 在 `palette.ts` 的 `ROLE_SPEC` 加角色；
2. 只用 ANSI 0–15 前景或属性；
3. 确保 `roleViolations()` 通过。

## 12. 已知偏差

- `/model role <id>` 帮助文案存在，但解析未实现。
- `session.title` 事件被忽略；标题只在 `/sessions` 从磁盘摘要读取。
- TUI 只在启动时 `mcp.sync()`；运行中修改 MCP 配置需要重启。
- TUI 不渲染历史消息，只显示会话摘要。
- `permission.requested` 由 `approve` 回调打印，而不是 renderer 的 switch 分支。
