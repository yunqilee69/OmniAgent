# OmniAgent

一个本机运行的个人智能体，用来把 agent 的内部机制亲手实现一遍：主循环、上下文与记忆、沙盒、skills、模型/角色/智能体分层配置和多前端观测。

目标不是「再做一个编码助手」，而是让每一层都短到能一眼看完，并且都能单独测试。

---

## 快速开始

```bash
pnpm install    # install dependencies
pnpm dev        # interactive TUI
pnpm web        # build the React client, then serve it at http://127.0.0.1:4317
pnpm web:dev    # Vite HMR client at http://127.0.0.1:4318 (run pnpm web:serve in another terminal)
pnpm test       # unit and integration tests
pnpm eval       # run eval tasks
pnpm typecheck
```

TUI 支持 `/help`、`/sessions`、`/resume <id>`、`/new`、`/plan [on|off]`、`/todos`、`/permission [preset]`、`/agent [id]`、`/model [序号|agent|role <id>|<provider> <model>]`、`/think [full|compact|off]`、`/verbose`、`/color [on|off]` 和 `/clear`。模型默认跟随当前智能体的角色，因此修改角色指向的模型后，所有引用该角色的智能体都会在下一回合切换。

TUI 的排版只有一条规则：**四类内容各有自己的左缘**，所以长对话不用逐字读也能分出层次。

```
  2 空格 + Markdown      正文（含 `Assistant` 标签，一回合一次）
  ┊ 虚线导轨 + 内收斜体   思考（`✻ 思考`）
  │ 实线导轨 + 内收       工具结果体（头部是 `● 工具 / 读取文件 · README.md · 2 行`）
  引导符                 通知（`◇`/`⚠`/`✗`）与回合尾行（`✓ 完成 · 8s`）
```

工具卡整行由结果状态上色（运行中黄、成功绿、失败红、拒绝亮黄），待定行会原地刷新耗时；`/verbose` 展开完整输出。正文按流式 Markdown 渲染（标题、强调、列表、表格、带高亮的代码块）。思考默认完整展开，`/think compact|off` 切到一行摘要或隐藏。等待首个 token 时才显示转圈，一旦有内容可看就让位——不设常驻底栏。

配色只用 ANSI 16 色前景与属性（无 24 位 RGB、无背景色），内收文字用 `dim`（SGR 2）而不是固定灰，因此浅色与深色终端都能自动重映射，不另设主题；`/color off` 或 `NO_COLOR=1` 关掉颜色，`FORCE_COLOR` 可在管道里强制开启。角色表见 [ADR-0003](docs/adr/0003-tui-visual-hierarchy.md)。

plan 模式会将调研约束注入系统提示，并要求模型通过 `exit_plan_mode` 提交计划供你批准；`todo_write` 会持久化整份任务清单，TUI 在每次更新后展示。`create_goal` 可以把长期目标登记到会话中，之后由自动续轮推进，`get_goal` / `update_goal` 负责读取、编辑、暂停、恢复和结束目标；每次自动续轮都写入带 goal source 的用户消息，达到轮次上限会自动进入 blocked。Web 工作台支持登记和切换本地工作区、浏览及恢复会话、实时对话、plan 模式开关与计划审批、任务清单、权限、模型、MCP、模式与智能体设置、一次性工具审批、子会话显示、自动化任务页和轨迹图。输入框支持四类快捷引用：`@` 搜索并插入工作区文件或目录，`#` 打开近期会话（当前工作区优先，可切到其他工作区），`/` 运行内置指令（新建会话、计划模式、设置目标、压缩上下文、权限、智能体、模型、设置、导出、清空和帮助），`$` 只列出当前智能体可调用的 skill；菜单输入按 LIKE 规则过滤，方向键选择、Enter 确认、Esc 关闭。`/goal` 会插入一段让智能体调用 `create_goal` 的请求，`/compact` 会安排在下一次回复前压缩较早上下文。设置弹窗按「通用配置 / 模型配置 / MCP 服务器 / 模式预设 / 智能体」分栏；模型配置维护角色与模型来源，可编辑协议、接口地址、只写 API Key、模型目录（上下文窗口、输出上限、输入类型、思考等级与默认等级），从 OpenAI 兼容或 Anthropic 接口拉取模型并调整顺序，再为模型分配可选角色；MCP 服务器页支持 stdio 与 Streamable HTTP 两种标准传输（旧版 HTTP+SSE 服务器会自动回退，已有配置仍兼容），可配置命令/参数/环境变量或 URL/请求头、启用状态与超时，并在保存前测试连接和查看工具列表，模式和智能体 profile 可以用 `"*"` 或 `mcp__<server>__<tool>` 授权这些工具；模式预设内置标准模式与创造模式，可配置智能体、模型来源、工具和 Skill；智能体页列出默认智能体、创造智能体及自定义定义，可直接填写表单新建、编辑或删除自定义智能体，也可以进入创造模式通过对话生成。新会话先选择模式，智能体、工具和 Skill 由模式固定，模型默认取模式配置但可在创建前覆盖，创建后仍可继续切换；需要不同智能体或工具组合时只能新建会话；创造模式可通过对话创建自动化任务、写入智能体定义并调整 OmniAgent 配置。自动化任务按 Host 维度持久化在 `~/.omniagent/schedules.json`，支持一次、固定间隔、每天、每周、cron 和 RFC 5545 RRULE 规则；投递目标可以是当前会话、首次运行时创建一个新会话，或每次运行都新建会话。Web 的「自动化任务」页可以新建、编辑、暂停/恢复、立即运行、查看投递记录和清理已结束任务。模型侧提供 `schedule_create`、`schedule_list`、`schedule_view`、`schedule_edit` 四个工具；它们只能在主会话中使用，子代理不能创建或修改任务。计划任务唤醒已有会话时会复用进程内的实时 Session 实例；新建会话时使用全局默认权限预设和当前默认模式。服务停止期间错过的多次触发只补投最近一次，进程崩溃时可能重复投递。智能体配置存放在 `~/.omniagent/agents/*.md`；TUI 可以在新建会话或切换智能体时选择，Web 新会话由模式决定使用的智能体；子代理会作为独立会话出现在会话列表中，它们继承父会话的工作区、权限预设和 cwd 限制，但按目标智能体的角色选择模型，并可通过 `subagent`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent` 协作。`list_agents` 返回整棵协作树的根节点、自身和可继续的子代理；`wait_agent` 等待下一步输入（消息、完成通知或用户 steering），而不是轮询某个子代理的最终状态。会话菜单可以复制 Markdown 或下载 JSON 会话摘录；导出可能包含敏感对话和工具输出，分享前应检查。JSON 不是 DSH 的 ZIP/JSONL 归档，也不包含子会话和附件。取消登记工作区不会删除目录或会话；会话按工作区保存在 `~/.omniagent/sessions/` 下。

Web 仅监听本机，不提供本地用户身份认证；Host/Origin 检查不能限制其他本地进程。会话使用 `read-only`、`workspace-write` 或 `danger-full-access` 权限预设，并将选择持久化在该会话中；旧会话不会从旧 `mode` 或规则猜测权限，须显式选择。普通 `workspace-write` 不逐次询问；只有请求扩大当前调用的沙盒范围时才进行一次性审批。`~/.omniagent/config.json` 中的全局默认值只作用于新会话。TUI 支持会话级智能体和模型切换；Web 的新会话在创建时选择模式，模式快照以 `mode/selected` 持久化，agent、tools 和 skills 由模式固定并拒绝切换，模型默认取模式配置且可在创建前选择或在创建后继续切换。智能体选择仍以 `agent/selected`、模型绑定仍以 v2 `model/selected` 事件持久化，这些事件都不含凭据。`.agents/skills` 中的 skill 会在会话系统提示里列出，模型通过 `skill` 工具按需加载完整说明；智能体 profile 可以进一步收窄可见工具和 skill。文件和 shell 限制不隔离网络，且不是完整 OS 安全边界。会话消息、实时 SSE、原始审计文件以及加载的 skill 文本都可能包含敏感内容。设置 `OMNIAGENT_PORT` 可更换监听端口。接口和数据边界见 [Web API](docs/web-api.md)，配置分层与智能体文件格式见 [智能体、角色与模型绑定](docs/agents.md)。

The runtime is implemented without Cordis or the DSH plugin/profile system. See [docs/architecture.md](docs/architecture.md) and [NOTICE](NOTICE) for current boundaries and DSH attribution.

---

## 模型、角色与智能体配置

配置按五层解析，每一层只回答一个问题：

```text
providers / models  →  连到哪里、模型元数据、能力、思考字段映射
roles               →  一组 provider + model + reasoningEffort
agentProfiles       →  一个智能体可见的工具和 skill（config.json）
agents/*.md         →  身份、说明、角色、usage、profile、system prompt
modes.json          →  Web 新会话的 agent + 模型 + tools + skills 组合
```

顶层 `model`、`provider`、`reasoningEffort` 自动合成 `default` 角色；显式 `roles.default` 覆盖顶层字段。智能体文件引用角色，所以切换角色指向的模型后，引用该角色的智能体在下一回合自动使用新模型。

```json
{
  "model": "deepseek-flash",
  "provider": "deepseek-official",
  "reasoningEffort": "high",
  "providers": {
    "deepseek-official": {
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": [
        {
          "id": "deepseek-flash",
          "name": "DeepSeek V4.1 Flash",
          "contextWindow": 1048576,
          "maxTokens": 8192,
          "input": ["text", "image"],
          "capabilities": { "imageInput": true },
          "reasoning": {
            "efforts": { "off": null, "low": "low", "high": "high", "max": "max" },
            "default": "high",
            "wire": { "effortField": "output_config.effort", "budgetField": "thinking.budget_tokens" }
          }
        }
      ]
    }
  },
  "roles": {
    "quick": { "name": "快速", "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "low" }
  },
  "agentProfiles": {
    "default": { "tools": "*", "skills": "*" },
    "search-only": { "tools": ["read_file", "list_dir", "glob", "grep", "web_fetch", "skill"], "skills": ["web-research"] }
  },
  "todo": {
    "allowParallelInProgress": true
  }
}
```

模型条目规则：

- `capabilities` 当前支持 `imageInput`。未配置时从 `input` 是否包含 `image` 推断。
- `reasoning.efforts` 把规范等级 `off/minimal/low/medium/high/xhigh/max` 映射为线缆值，`null` 表示关闭；`reasoning.budgets` 可选；`reasoning.default` 必须出现在 `efforts` 中。
- `reasoning.wire` 用点分路径写入请求体。拒绝 `__proto__`、`constructor`、`prototype`、空路径段，以及 `model`、`messages`、`stream`、`tools` 等保留顶层字段。
- 模型目录只包含元数据，不包含 endpoint、headers 或 API key。

角色与 profile 规则：

- `role.provider`、`role.model` 必须存在于模型目录；`reasoningEffort` 必须是该模型支持的值。
- `agentProfiles` 未配置时内置 `default = { "tools": "*", "skills": "*" }`。一旦配置了 `agentProfiles`，引用不存在的 profile 的智能体就会失效。
- `tools` 可以是 `"*"` 或精确列表；`subagent` 组展开为 `subagent`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`；`todo_write`、`exit_plan_mode`、`get_goal`、`create_goal`、`update_goal` 需要逐项授权。未知工具名是配置错误。
- `skills` 可以是 `"*"` 或数组，省略等价于 `[]`。缺失的 skill 只产生 warning，不会授予额外能力。
- profile 只是 allowlist，不能扩大 DSH 权限预设、沙盒、endpoint 或凭据范围。
- `todo.allowParallelInProgress` 默认 `false`，此时 `todo_write` 最多一个任务处于 `in_progress`。当工作会交给多个子智能体并行推进时设为 `true`，允许同时保留多个进行中任务。

智能体内容不写在 `config.json`，而是放在 `~/.omniagent/agents/*.md`，文件名就是 id：

```markdown
---
name: Explorer
description: 只读搜索、代码探索和资料定位
role: quick
usage: subagent
profile: search-only
---

你是一个探索型智能体。只做只读调查，把结构化结论返回给父智能体。
```

`usage` 为 `primary`、`subagent` 或 `both`（默认 `both`）。`subagent` 智能体不会出现在主智能体选择器，也不能被选为根会话，但可以被 `subagent` 工具调用。没有 `default.md` 时使用内置 default agent；存在但无效时不会回退。frontmatter 只允许 `name`、`description`、`role`、`usage`、`profile`，未知字段报错，`x-` 前缀字段忽略。完整规则见 [docs/agents.md](docs/agents.md)。

会话持久化两个选择：

```json
{ "version": 1, "agent": "explorer" }
{ "version": 2, "kind": "agent" }
{ "version": 2, "kind": "role", "role": "quick" }
{ "version": 2, "kind": "model", "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "high" }
```

模型绑定 `kind: "agent"` 跟随当前智能体的角色；`kind: "role"` 使用指定角色；`kind: "model"` 直接指定模型。最终 effort 顺序是 binding 显式值 → role 值 → 模型默认值。v1 的 `model/selected` 事件视为 invalid，不迁移、不猜测；缺少 agent 或模型选择的旧会话需要显式重新选择后才能运行。

配置和智能体文件在新回合开始前重新读取，内容变化通过内容哈希 revision 生效；运行中的回合保留旧快照。无效 JSON、schema 错误、未知 role/profile、未知模型、不支持的 effort、图片能力不足都会明确失败，不回退到旧配置或默认模型，也不会删除既有会话。

Provider 连接：

- DeepSeek Messages 使用 `provider` 字符串 route 和 `providers.<id>` 条目；`apiKey` 或 `apiKeyEnv` 只留在 provider 配置和进程环境中。
- pi-ai route 支持其对应的 provider/API 组合和 ambient auth。
- 旧的 OpenAI-compatible `provider` object 仍走原有 Chat Completions endpoint 和 credential 配置，不会把 endpoint 或 key 自动迁移到其他 route。
- 不设置可用 provider 时，应用使用 FakeModel 演示流程。

Web 的全局默认权限存于 `dsh.permission.defaultPreset`，只用于真正的新会话。值为 `read-only`、`workspace-write` 或 `danger-full-access`。如果配置仅有旧 `mode`/`permissions` 且没有新默认值，用户必须显式选定，不会推断或扩大权限。

`subagents.maxDepth` 从根会话的深度 0 开始计数，默认 1；`subagents.maxActive` 限制同一运行时的活动子代理数量，默认 8。子代理继承创建者的权限预设、工作区/受限 cwd，并使用目标智能体的角色解析模型；显式指定的模型也必须存在于当前模型目录。

plan 模式只改变模型指导与 `exit_plan_mode` 的可见性，不是权限或沙盒机制；它不会自动禁止写文件，实际写入仍由当前权限预设和沙盒决定。旧版 `mode` 和 `permissions` schema 字段保留用于读取既有配置，但不会成为 Session 的 DSH 授权来源。

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
    toolCallResponse([{ name: 'write_file', args: { file_path: 'secret.txt', content: 'x' } }]),
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

运行时数据目录：

```text
~/.omniagent/
├── config.json                providers、models、roles、agentProfiles、todo、权限默认值
├── modes.json                 Web 模式预设、内置模式覆盖与默认模式
├── agents/                    每个 *.md 是一个智能体
├── sessions/                  按工作区和会话 id 保存的 JSONL 事件日志
├── schedules.json             Host 级自动化任务与投递记录
├── workspaces.json            Web 登记的工作区
└── web-audit/                 Web 审计日志
```

### packages/core/src

| 目录 | 作用 | 现状 |
| --- | --- | --- |
| `domain/` | 纯数据模型：`Message`、`ToolCall`、`ToolResult`、`Usage` | 含受校验的 provider replay 数据；公共投影会剥离内部字段 |
| `protocol/` | core 与 UI 的契约：事件流、命令、权限决策 | DSH execution policy 由 Session 组合 |
| `providers/` | DeepSeek Messages、pi-ai、legacy OpenAI 路由和剧本化假模型 | 模型目录提供 capabilities 与思考字段映射；凭据不进入目录 |
| `loop/` | 主循环、停止条件、步数上限和上下文压缩 hook | DSH-shaped loop 已接入 |
| `permissions/` | DSH preset、持久事件和一次性 escalation | 三种 preset；旧 mode/rules 不授权 |
| `exec/` | 执行器：把异常统一转成 observation | 已接入真实工具执行 |
| `tools/` | 工具契约、注册表、DSH 移植的 read/write/edit/glob/grep/web_fetch、`list_dir`、skill、`bash`、todo/plan/goal/subagent 工具 | 工具 allowlist 与 DSH 权限取交集 |
| `subagents/` | 子会话启动、消息、整树 list、下一步输入 wait、interrupt、通知与模型/权限继承 | 目标 agent + role；depth/active 上限；懒恢复需有效选择 |
| `schedule/` | Host 级计划任务：时间规则、持久化、定时器、投递记录和模型工具 | 一次/间隔/每日/每周/cron/RRule；错过的触发只补最近一次 |
| `modes/` | 模式预设存储：内置标准/创造模式、自定义模式、默认模式和工具/skill 校验 | `modes.json` 原子写入；模式快照在创建会话时固化 |
| `session/` | plan/todo/goal 投影、agent/model 绑定、mode 快照、RuntimeResolver、会话投影与持久化辅助 | goal/change + CAS 与自动续轮；agent/selected v1、model/selected v2、mode/selected v1 |
| `agents/` | `*.md` 智能体发现、frontmatter、usage/profile 校验和目录渲染 | 内置 default/creator；拒绝符号链接和超限文件 |
| `store/` | transcript 持久化、JSONL 审计日志 | append 使用跨进程锁、暂存文件、fsync 和原子 rename |
| `config/` | 加载 providers/models/roles/agentProfiles、模型目录、热加载 ConfigStore | schema 严格校验；内容哈希 revision；失败 fail closed |
| `context/` | token 计数、截断策略、compaction | 由模型目录或显式配置提供上下文窗口 |
| `sandbox/` | DSH 文件围栏、Seatbelt/bwrap/Landlock 执行策略 | 无可用受限后端时 fail closed |
| `skills/` | SKILL.md 发现、1 MiB 上限和渐进加载 | 目录注入系统提示，按智能体 profile 过滤，完整内容经 `skill` 工具加载 |

### packages/tui/src

| 文件 | 作用 |
| --- | --- |
| `main.ts` | REPL 主循环 + 权限确认提示（`readline/promises`） |
| `render.ts` | 事件 → 终端文本。唯一「认识 UI」的地方 |
| `blocks.ts` | 各类块的纯文本构建（思考头、工具卡、状态行、帮助），可单独断言 |
| `palette.ts` | 角色 → SGR 的单一事实来源，外加 `roleViolations` 测试闸门 |
| `ansi.ts` / `markdown.ts` / `highlight.ts` | SGR 拼装、流式 Markdown、代码高亮 |

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

这份仓库现在以 DSH 行为为基准，不依赖 Cordis 或 DSH 插件/profile runtime；会话、工作区、权限预设、模型路由、配置分层（providers/models → roles → agentProfiles → agents/*.md）、RuntimeResolver、文件/shell 执行以及 Web/TUI 前端已接通。Web/TUI 都支持按智能体角色解析模型，并可以显式切换智能体或模型绑定。后续工作应根据实际剩余缺口拆分，不再沿用原先 M1-M6 的线性计划表。



---

## 已知边界

- 文件写入的物理路径围栏会阻止当前已验证的符号链接逃逸和硬链接目标，读取工具也解析物理路径并拒绝越界符号链接；检查与实际系统调用之间仍有 TOCTOU 窗口。shell 的硬链接预检覆盖 workspace 和额外可写根，但不扫描 `/tmp` 或 `$TMPDIR` 中预先存在的硬链接。
- `read-only`/`workspace-write` 的 Seatbelt、bubblewrap 和 Landlock 执行器限制文件写入；它们不隔离网络、不限制所有读取，也不是虚拟机。没有可用受限后端时，shell 执行 fail closed。Windows 等未支持平台不会伪装成已隔离。
- 同一会话的 append 通过 `<session>.lock` 协调多个 OmniAgent 进程，并在 rename 前 fsync 文件和目录；锁只约束协作写入者，非协作的外部进程修改仍会在元数据校验时被拒绝。工作区 registry 仍只保证单进程写入。
- Web 审计日志保存在 `~/.omniagent/web-audit/`；Observe API 每个会话最多返回最近 1,000 条记录，并只读取文件尾部 2 MiB。旧版或 TUI 写在工作区内的 `.omniagent/audit.jsonl` 不会被自动读取或迁移。TUI 新建审计目录/文件使用 `0700/0600`，但不会修改既有路径的权限；指向符号链接或非普通文件的审计路径会被拒绝。
- Web loopback 不做本地用户认证；活动 turn 或 session 创建期间，权限/default/模型修改和新建 session 返回 `409`，这只是防止运行中权限竞态，不是身份认证。实时 SSE 和原始会话/审计记录可能包含工具参数、结果或其他敏感内容，不能当作脱敏导出格式。
- 上下文窗口优先取 `contextWindowTokens` 配置，否则取会话所选模型目录中的上下文长度；两者都不可用时不做自动压缩。`read_file` 默认和单次最多返回 2,000 行，单行最多 2,000 字符、选中内容最多 50 KiB，达到 10 MiB 的文件走流式读取；`glob` 最多展示 100 个路径，`grep` 最多 250 条匹配、单行预览 2,000 字节，`web_fetch` 响应体最多 5 MB、正文 100,000 字符、完整输出 200,000 字符。工具输出仍会截断，不存在可回读的完整输出引用。
- 智能体 profile 和 skill allowlist 只是减少暴露面，不是安全隔离。被允许的工具仍受 DSH 权限预设和沙盒约束，被加载的 skill 文本也属于模型上下文，不能视为可信指令。
- `capabilities.imageInput` 是当前唯一的模型能力标记。模型不支持图片时，包含图片历史的回合会在请求前失败，不会静默丢弃图片。
- 配置和智能体文件按内容哈希热加载；运行中的回合使用旧快照，变化从下一回合生效。无效配置或 agent 文件会 fail closed，不回退到旧配置、其他模型或其他智能体，也不会删除既有会话。
- v1 `model/selected` 和缺少 agent 选择的旧会话需要显式重新选择。这是有意的不兼容：不会猜测旧模型的 reasoning effort，也不会把旧会话自动绑定到当前默认 agent。
- 子代理懒恢复要求会话中存在有效的 `agent/selected` 和 v2 模型绑定；缺失或 invalid 时拒绝恢复，不回退到父模型或默认模型。活动中的子代理保留创建时快照。
- Web 的一次性审批不是权限预设本身：`workspace-write` 普通文件写入不弹窗，只有显式更宽的 `sandbox_permissions` 请求才进入审批；断线、中断、超时或异常时待处理请求默认拒绝。
- 流式只向外暴露文本增量；tool_call 分片在 provider 内部拼完才交给循环，UI 看不到参数逐字生成的过程。

---

## 文档

- [docs/agents.md](docs/agents.md) — providers/models、roles、agentProfiles、agents/*.md 与会话选择事件
- [docs/notes/](docs/notes/) — 读别人家实现的笔记（Codex、Claude Code），带出处
- [docs/adr/](docs/adr/) — 自己做的决定：背景、候选、结论、后果
- [docs/spec/](docs/spec/) — 自家的协议与 schema 设计
