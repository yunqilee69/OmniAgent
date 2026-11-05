# OmniAgent

一个本机运行的个人智能体，用来把 agent 的内部机制亲手实现一遍：主循环、上下文与记忆、沙盒、skills、会话级模型选择和多前端观测。

目标不是「再做一个编码助手」，而是让每一层都短到能一眼看完，并且都能单独测试。

---

## 快速开始

```bash
pnpm install    # install dependencies
pnpm dev        # interactive TUI
pnpm web        # local Web UI at http://127.0.0.1:4317
pnpm test       # unit and integration tests
pnpm eval       # run eval tasks
pnpm typecheck
```

TUI 支持 `/help`、`/sessions`、`/resume <id>`、`/new`、`/plan [on|off]`、`/todos`、`/permission [preset]`、`/model [序号]`、`/think [full|compact|off]`、`/verbose` 和 `/clear`。正文按流式 Markdown 渲染（标题、强调、列表、表格、带高亮的代码块）；思考内容显示在 `✻ 思考` 区块中，默认完整展开，可切到一行摘要或隐藏；工具调用显示为状态行（运行中 / 成功 / 失败 / 拒绝）并附上按工具类型提取的参数摘要和结果预览，`/verbose` 可展开完整工具输出。plan 模式会将调研约束注入系统提示，并要求模型通过 `exit_plan_mode` 提交计划供你批准；`todo_write` 会持久化整份任务清单，TUI 在每次更新后展示。Web 工作台支持登记和切换本地工作区、浏览及恢复会话、实时对话、plan 模式开关与计划审批、任务清单、权限与模型设置、一次性工具审批、子会话显示和轨迹图。子代理会作为独立会话出现在会话列表中；它们继承父会话的工作区、权限预设和默认模型，并可通过 `subagent`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent` 协作。会话菜单可以复制 Markdown 或下载 JSON 会话摘录；导出可能包含敏感对话和工具输出，分享前应检查。JSON 不是 DSH 的 ZIP/JSONL 归档，也不包含子会话和附件。取消登记工作区不会删除目录或会话；会话按工作区保存在 `~/.omniagent/sessions/` 下。

Web 仅监听本机，不提供本地用户身份认证；Host/Origin 检查不能限制其他本地进程。会话使用 `read-only`、`workspace-write` 或 `danger-full-access` 权限预设，并将选择持久化在该会话中；旧会话不会从旧 `mode` 或规则猜测权限，须显式选择。普通 `workspace-write` 不逐次询问；只有请求扩大当前调用的沙盒范围时才进行一次性审批。`~/.omniagent/config.json` 中的全局默认值只作用于新会话。Web 与 TUI 都支持会话级模型切换，选择以不含凭据的 `model/selected` 事件持久化。`.agents/skills` 中的 skill 会在会话系统提示里列出，模型通过 `skill` 工具按需加载完整说明。文件和 shell 限制不隔离网络，且不是完整 OS 安全边界。会话消息、实时 SSE、原始审计文件以及加载的 skill 文本都可能包含敏感内容。设置 `OMNIAGENT_PORT` 可更换监听端口。接口和数据边界见 [Web API](docs/web-api.md)。

The runtime is implemented without Cordis or the DSH plugin/profile system. See [docs/architecture.md](docs/architecture.md) and [NOTICE](NOTICE) for current boundaries and DSH attribution.

---

## 模型与权限配置

新配置可以使用 DSH 的 DeepSeek Messages 协议，也可以通过 `@earendil-works/pi-ai` 选择其支持的 provider/API 组合。旧的 OpenAI-compatible `provider` object 仍走原有 Chat Completions endpoint 和 credential 配置；迁移不会替换 endpoint、复用其他 route 的 key，或将它自动改成 DeepSeek Messages。

例如，DeepSeek 官方 Messages route：

```json
{
  "model": "deepseek-flash",
  "provider": "deepseek-official",
  "providers": {
    "deepseek-official": { "apiKeyEnv": "DEEPSEEK_API_KEY" }
  },
  "reasoningEffort": "high",
  "maxTokens": 8192,
  "dsh": { "permission": { "defaultPreset": "workspace-write" } },
  "subagents": { "maxDepth": 1, "maxActive": 8 }
}
```

```bash
export DEEPSEEK_API_KEY=sk-...
pnpm dev
```

- 不设置 `provider` 时，应用可使用 FakeModel 演示流程。
- DeepSeek route 通过各自 profile 的 `apiKey` 或 `apiKeyEnv` 取凭据；pi-ai route 也只读取其自身显式配置或 provider ambient auth，不会借用旧 OpenAI object 的密钥。
- 对于既有配置对象，例如 `{ "type": "openai", "baseURL": "https://example/v1", "apiKeyEnv": "LEGACY_KEY" }`，OmniAgent 保持原 Chat Completions 语义。
- Web 的全局默认权限存于 `dsh.permission.defaultPreset`，只用于真正的新会话。值为 `read-only`、`workspace-write` 或 `danger-full-access`。如果配置仅有旧 `mode`/`permissions` 且没有新默认值，用户必须显式选定，不会推断或扩大权限。
- `subagents.maxDepth` 从根会话的深度 0 开始计数，默认 1，即根会话可以启动子代理但子代理不能再启动孙代理。`subagents.maxActive` 限制同一运行时的活动子代理数量，默认 8。子代理继承创建者的权限预设、工作区/受限 cwd 和默认模型；显式指定的模型必须存在于当前模型目录。
- plan 模式只改变模型指导与 `exit_plan_mode` 的可见性，不是权限或沙盒机制；它不会自动禁止写文件，实际写入仍由当前权限预设和沙盒决定。
- 旧版 `mode` 和 `permissions` 字段目前为兼容性保留，不会成为 Session 的 DSH 授权来源。

模型流式响应由 provider 适配层转换为统一 `ModelClient` 消息和文本增量；工具调用在循环中执行。DeepSeek Messages 与 pi-ai 会话回放元数据保留在内部历史中，不通过公共会话响应或导出接口返回。

---

## eval harness

一句话：**把「agent 遇到某个任务应该做什么」写成可重复运行、可断言的用例集。**

改 prompt、换模型、调权限规则之后，靠肉眼看几条对话判断「有没有变差」是不可靠的。eval harness 提供三样东西：

1. **隔离环境**：每个 case 一个临时工作区，fixture 现场铺，跑完清理。
2. **可控模型**：可以塞 `FakeModel` 剧本（稳定、零 token，测循环和权限），也可以接真实 provider（测模型能力）。
3. **结构化断言**：工具调用顺序、每次权限决策、最终回答、落盘文件、停止原因。

```bash
pnpm eval              # 跑内置套件
pnpm eval -- --keep    # 失败时保留临时工作区，方便看现场
```

一个 case 长这样（完整套件在 [basic.ts](packages/core/src/eval/suites/basic.ts)）：

```ts
{
  name: '只读预设阻止写文件',
  permissionPreset: 'read-only',
  steps: [
    toolCallResponse([{ name: 'write_file', args: { path: 'secret.txt', content: 'x' } }]),
    textResponse('写文件被拒绝了。'),
  ],
  expect: {
    stopReason: 'end_turn',
    decisions: ['allow'],
    absentFiles: ['secret.txt'],
    finalText: /拒绝/,
  },
}
```

`permissionPreset` 是 eval 的唯一授权来源。旧 `mode`/`permissions` 字段可以作为兼容输入保留，但不会给 Session 授权。`decisions: ['allow']` 只表示调用通过了 DSH 工具准入；只读写入仍会在真实文件围栏处返回失败结果。

### 两种 eval，别混在一起

- **能力 eval**：任务能不能完成。断言工具调用、文件内容、最终回答。真实模型有随机性，要跑多次看通过率。
- **权限 eval**：某次工具调用该 allow / ask / deny。它本质是分类问题，最重要的是 **false allow**（该拒却放行），不是总体准确率。`auto` 权限模式必须先有这类标注用例，否则无从判断分类器准不准。

现在这套 harness 先覆盖能力和权限决策；专门评估分类器的混淆矩阵（precision / recall / false-allow）是下一步。设计细节见 [docs/spec/eval-harness.md](docs/spec/eval-harness.md)。

---

## 目录地图

```
OmniAgent/
├── docs/                      调研笔记、决策记录、协议规格
├── packages/
│   ├── core/                  智能体内核，不依赖任何 UI / 终端 / 网络框架
│   ├── tui/                   终端前端，只消费 core 的事件流
│   └── web/                   本地工作区、会话和观测工作台
├── config.example.json        配置样例（复制到 ~/.omniagent/config.json）
└── vitest.config.ts           测试配置（含 @omniagent/core 的源码别名）
```

### packages/core/src

| 目录 | 作用 | 现状 |
| --- | --- | --- |
| `domain/` | 纯数据模型：`Message`、`ToolCall`、`ToolResult`、`Usage` | 含受校验的 provider replay 数据；公共投影会剥离内部字段 |
| `protocol/` | core 与 UI 的契约：事件流、命令、权限决策 | DSH execution policy 由 Session 组合 |
| `providers/` | DeepSeek Messages、pi-ai、legacy OpenAI 路由和剧本化假模型 | DSH adapters 已接入；旧 OpenAI object 保留原 endpoint/credential 语义 |
| `loop/` | 主循环、停止条件、步数上限和上下文压缩 hook | DSH-shaped loop 已接入 |
| `permissions/` | DSH preset、持久事件和一次性 escalation | 三种 preset；旧 mode/rules 不授权 |
| `exec/` | 执行器：把异常统一转成 observation | 已接入真实工具执行 |
| `tools/` | 工具契约、注册表、内置读/写/列目录、skill、`bash`、todo/plan/subagent 工具 | 文件围栏与 shell sandbox 已接入 Session |
| `subagents/` | 子会话启动、消息、list/wait/interrupt、通知与模型/权限继承 | depth/active 上限；持久化子会话可懒恢复 |
| `session/` | plan/todo 投影、模型选择、会话投影与持久化辅助 | plan 与 todo 均为可恢复的会话事件 |
| `store/` | transcript 持久化、JSONL 审计日志 | append 使用跨进程锁、暂存文件、fsync 和原子 rename |
| `config/` | 加载模型 routes、推理参数、DSH 默认权限和 subagent 上限 | 保留未知配置字段及旧 provider object |
| `context/` | token 计数、截断策略、compaction | 由模型目录或显式配置提供上下文窗口 |
| `sandbox/` | DSH 文件围栏、Seatbelt/bwrap/Landlock 执行策略 | 无可用受限后端时 fail closed |
| `skills/` | SKILL.md 发现、1 MiB 上限和渐进加载 | 目录注入系统提示，完整内容经 `skill` 工具加载 |

### packages/tui/src

| 文件 | 作用 |
| --- | --- |
| `main.ts` | REPL 主循环 + 权限确认提示（`readline/promises`） |
| `render.ts` | 事件 → 终端文本。唯一「认识 UI」的地方 |

---

## TypeScript 类型放哪

一句话：**不建全局 `types.ts`，类型跟着「谁是这份契约的提供方」走。**

分三类，各有各的位置：

### 1. 领域数据模型 → `domain/`

`Message`、`ToolCall`、`ToolResult`、`Usage`。特征是**只描述数据形状、不含行为**，并且是持久化的单位（transcript 落盘、发给模型）。

这些用 zod schema 定义，再用 `z.infer` 导出类型：

```ts
export const ToolCallSchema = z.object({ id: z.string(), name: z.string(), arguments: z.unknown() });
export type ToolCall = z.infer<typeof ToolCallSchema>;
```

理由：模型返回、工具参数、用户配置文件都是**不可信输入**，需要在运行时校验。手写一遍 interface 再手写一遍 schema，早晚漂移。

### 2. 对外契约 → `protocol/`

事件流（`AgentEvent`）、发回 core 的指令（`AgentCommand`）、权限决策形状（`Rule`、`PermissionRequest`）。

判断标准很简单：**换一个 UI 还要用它的，就是协议。** 现在 TUI 消费它，以后 web 和 Electron 也消费同一套。

事件设计成 `type` 字段的 discriminated union，UI 用 `switch` 精确享受类型收窄：

```ts
export type AgentEvent =
  | { type: 'turn.start'; step: number }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; message: AssistantMessage }
  | { type: 'tool.call'; call: ToolCall }
  | { type: 'tool.result'; result: ToolResult }
  | { type: 'turn.end'; reason: StopReason }
  | { type: 'error'; error: AgentError };
```

### 3. 模块内部接口 → 就放在那个模块里

`ModelClient` 在 `providers/types.ts`，`Tool` 在 `domain/tool.ts`，`PermissionGate` 在 `protocol/permission.ts`。

不要为了「整齐」把它们集中到某个 `interfaces.ts`：那会让本来没有关系的两个模块产生假耦合——你改 `Tool` 的签名，却要去动一个装着 20 个无关接口的文件。

### 两条附带的规矩

- **DSH 权限选择使用显式 preset。** `PERMISSION_MODES` 仅为旧源兼容保留，不能用来推断当前 Session 的授权。
- **barrel 文件只放在包边界。** 只有 `src/index.ts` 用 `export ...` 汇总；模块之间直接相对引用，不要 `export *` 满天飞，否则循环依赖和打包体积都会失控。

---

## DSH 权限与沙盒

权限预设和执行沙盒是相互配合但不同的层：

| | DSH 权限预设 | 执行沙盒 |
| --- | --- | --- |
| 决定 | 会话使用哪种准入与审批策略 | 文件和 shell 进程能写入哪些位置 |
| 预设 | `read-only`、`workspace-write`、`danger-full-access` | macOS Seatbelt、Linux bubblewrap 或受信任的 Landlock runner |
| 普通 workspace-write 调用 | 不逐次弹窗 | 真实工作区/临时目录文件围栏 |
| 显式扩大范围 | 仅本次调用审批 | 通过审批后重新构造一次执行策略 |
| 失败姿态 | 未选择、非法或 legacy 状态 fail closed | 无可用受限后端时拒绝执行，不回退为无沙盒 |

文件围栏会解析符号链接并拒绝硬链接目标，但仍有检查与系统调用之间的 TOCTOU 限制。Seatbelt、bubblewrap 和 Landlock 主要限制文件写入；它们不提供网络隔离、完整读取隔离或虚拟机边界。`danger-full-access` 绕过 DSH 文件沙盒，但不表示模型请求的额外审批会被自动批准。

---

## 验收进度

这份仓库现在以 DSH 行为为基准，不依赖 Cordis 或 DSH 插件/profile runtime；会话、工作区、权限预设、模型 route、文件/shell 执行以及 Web/TUI 前端已接通。后续工作应根据实际剩余缺口拆分，不再沿用原先 M1-M6 的线性计划表。



---

## 已知边界

- 文件写入的物理路径围栏会阻止当前已验证的符号链接逃逸和硬链接目标，读取工具也解析物理路径并拒绝越界符号链接；检查与实际系统调用之间仍有 TOCTOU 窗口。shell 的硬链接预检覆盖 workspace 和额外可写根，但不扫描 `/tmp` 或 `$TMPDIR` 中预先存在的硬链接。
- `read-only`/`workspace-write` 的 Seatbelt、bubblewrap 和 Landlock 执行器限制文件写入；它们不隔离网络、不限制所有读取，也不是虚拟机。没有可用受限后端时，shell 执行 fail closed。Windows 等未支持平台不会伪装成已隔离。
- 同一会话的 append 通过 `<session>.lock` 协调多个 OmniAgent 进程，并在 rename 前 fsync 文件和目录；锁只约束协作写入者，非协作的外部进程修改仍会在元数据校验时被拒绝。工作区 registry 仍只保证单进程写入。
- Web 审计日志保存在 `~/.omniagent/web-audit/`；Observe API 每个会话最多返回最近 1,000 条记录，并只读取文件尾部 2 MiB。旧版或 TUI 写在工作区内的 `.omniagent/audit.jsonl` 不会被自动读取或迁移。TUI 新建审计目录/文件使用 `0700/0600`，但不会修改既有路径的权限；指向符号链接或非普通文件的审计路径会被拒绝。
- Web loopback 不做本地用户认证；活动 turn 或 session 创建期间，权限/default/模型修改和新建 session 返回 `409`，这只是防止运行中权限竞态，不是身份认证。实时 SSE 和原始会话/审计记录可能包含工具参数、结果或其他敏感内容，不能当作脱敏导出格式。
- 上下文窗口优先取 `contextWindowTokens` 配置，否则取会话所选模型目录中的上下文长度；两者都不可用时不做自动压缩。`read_file` 单次最多读取 16 MiB，`list_dir` 最多收集 10,000 个条目；工具输出仍会截断，不存在可回读的完整输出引用。
- Web 的一次性审批不是权限预设本身：`workspace-write` 普通文件写入不弹窗，只有显式更宽的 `sandbox_permissions` 请求才进入审批；断线、中断、超时或异常时待处理请求默认拒绝。
- 流式只向外暴露文本增量；tool_call 分片在 provider 内部拼完才交给循环，UI 看不到参数逐字生成的过程。

---

## 文档

- [docs/notes/](docs/notes/) — 读别人家实现的笔记（Codex、Claude Code），带出处
- [docs/adr/](docs/adr/) — 自己做的决定：背景、候选、结论、后果
- [docs/spec/](docs/spec/) — 自家的协议与 schema 设计
