# OmniAgent

一个本机运行的个人智能体，用来把 agent 的内部机制亲手实现一遍：主循环、上下文与记忆、沙盒、skills、goal / workflow。

目标不是「再做一个编码助手」，而是让每一层都短到能一眼看完，并且都能单独测试。

---

## 快速开始

```bash
pnpm install
pnpm dev        # TUI；没配 provider 时走 FakeModel 演示剧本，零 token
pnpm test       # 单测，零 token
pnpm eval       # 跑 eval 任务集
pnpm typecheck
```

`pnpm dev` 会走完整链路：模型产出工具调用 → 权限门拦截 → 问你 y/N → 执行 → 结果回灌 → 再问模型。换成真模型只需要在 `~/.omniagent/config.json` 里配置 `provider`（见下一节），循环和权限一行都不用改。

---

## 接真实模型（OpenAI 兼容）

模型调用直接使用官方 `openai` SDK，不自己拼 HTTP。任何兼容 Chat Completions 的端点都能用：OpenAI、DeepSeek、OpenRouter、Ollama（`/v1`）、vLLM 等。

复制 `config.example.json` 到 `~/.omniagent/config.json`，加上 `provider` 和真实模型 id：

```json
{
  "model": "deepseek-chat",
  "provider": {
    "type": "openai",
    "baseURL": "https://api.deepseek.com/v1",
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  },
  "mode": "default",
  "maxSteps": 25,
  "permissions": {
    "allow": ["read_file(./docs/**)", "list_dir"],
    "ask": ["write_file(./.git/**)"],
    "deny": ["read_file(./.env)"]
  }
}
```

```bash
export DEEPSEEK_API_KEY=sk-...
pnpm dev
```

- **不配 `provider`**：退回 FakeModel 演示剧本，零 token。
- **密钥**：默认读 `provider.apiKeyEnv` 指向的环境变量（不填该字段时是 `OPENAI_API_KEY`）。也可以直接写 `provider.apiKey`，但不建议把明文密钥放进配置文件。
- **`baseURL`**：不填则用 SDK 默认的 OpenAI 地址。
- **`model`**：必须填端点支持的模型 id；配了 `provider` 却仍写 `"fake"` 会直接报错。
- **`headers` / `timeoutMs` / `maxRetries`**：可选，透传给 SDK。

### 流式输出

`ModelClient.stream()` 是可选接口，`OpenAIModel` 已实现：

1. SDK 的每个文本 chunk 被转成 `assistant.delta` 事件，主循环原样 `yield` 给 UI。
2. `tool_call` 的分片在 provider 内部按 `index` 累积（id / name / arguments 都可能被拆开），流结束后拼成完整 `ToolCall`，随 `ModelResponse` 一起返回。
3. 没实现 `stream()` 的模型自动退回 `complete()`，事件流里不会出现 `assistant.delta`，其他代码不用改。

TUI 收到 delta 时用 `process.stdout.write` 直接写、不换行；收到 `assistant.message` 时只补一个换行，避免把整段文本再打印一遍。

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
  name: 'deny 规则阻止写文件',
  steps: [
    toolCallResponse([{ name: 'write_file', args: { path: 'secret.txt', content: 'x' } }]),
    textResponse('写文件被拒绝了。'),
  ],
  permissions: { deny: ['write_file(./secret.txt)'] },
  expect: {
    stopReason: 'end_turn',
    decisions: ['deny'],
    absentFiles: ['secret.txt'],
    finalText: /拒绝/,
  },
}
```

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
│   └── tui/                   终端前端，只消费 core 的事件流
├── config.example.json        配置样例（复制到 ~/.omniagent/config.json）
└── vitest.config.ts           测试配置（含 @omniagent/core 的源码别名）
```

### packages/core/src

| 目录 | 作用 | 现状 |
| --- | --- | --- |
| `domain/` | 纯数据模型：`Message`、`ToolCall`、`ToolResult`、`Usage` | M1 完成 |
| `protocol/` | core 与 UI 的契约：事件流、命令、权限决策 | M1 完成 |
| `providers/` | 模型客户端接口、剧本化假模型、OpenAI 兼容 provider | FakeModel + OpenAI 兼容已接（官方 SDK） |
| `loop/` | 主循环、停止条件、步数上限 | M1 完成 |
| `permissions/` | 规则解析、复合命令拆解、纯函数求值、权限门 | M1 完成 |
| `exec/` | 执行器：把异常统一转成 observation | M1 完成 |
| `tools/` | 工具契约、注册表、内置工具（读/写/列目录） | M1 完成（shell 在 M3） |
| `store/` | transcript 持久化、JSONL 审计日志 | M1 完成（compaction 后改造） |
| `workspace/` | 工作区身份，登记到 `~/.omniagent/sessions/<key>/` | 已落地（会话正文未写） |
| `config/` | 加载 `~/.omniagent/config.json`（含 provider） | M1 完成 |
| `context/` | token 计数、截断策略、compaction | M2（目录已留，未实现） |
| `sandbox/` | seatbelt / bubblewrap 封装 | M3（未创建） |
| `skills/` | SKILL.md 发现与渐进加载 | M4（未创建） |

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

- **不用 `enum`**，用 `as const` 数组 + `typeof arr[number]`。`PERMISSION_MODES` 就是这么写的，好处是还能遍历它做校验。
- **barrel 文件只放在包边界。** 只有 `src/index.ts` 用 `export ...` 汇总；模块之间直接相对引用，不要 `export *` 满天飞，否则循环依赖和打包体积都会失控。

---

## 权限 vs 沙盒

这是两个**正交**的层，别混在一起实现：

| | 权限（`permissions/`） | 沙盒（M3） |
| --- | --- | --- |
| 决定 | 要不要执行这次调用 | 执行时进程能碰什么 |
| 层次 | 工具级、执行前 | OS 级、进程树 |
| 实现 | 纯函数，可全量单测 | 调 `sandbox-exec` / `bwrap` |
| 失败姿态 | fail closed | 拒绝系统调用 |

**规则不是安全边界。** `shell(curl *)` 拦不住 `/usr/bin/curl`，也拦不住 `sh -c 'curl ...'`。规则只是把「什么时候该问人」表达清楚；真正的执法在沙盒层。

参考实现见 [docs/notes/codex-sandbox.md](docs/notes/codex-sandbox.md) 和 [docs/notes/claude-permissions.md](docs/notes/claude-permissions.md)。

---

## 里程碑

| | 内容 | 填哪 |
| --- | --- | --- |
| M1 | 循环 + 假模型 + 权限门 + 3 个内置工具 + TUI | ✅ 已完成 |
| M2 | 真 provider（✅ OpenAI 兼容已接）、token 计数、compaction、transcript 续跑 | `providers/`、`context/` |
| M3 | shell 工具 + 沙盒（先 macOS seatbelt，再 Linux bwrap） | `tools/builtin/shell.ts`、`sandbox/` |
| M4 | skills 渐进加载 | `skills/` |
| M5 | 自维护 todo 工具、goal 循环、eval harness（✅ 最小版本已落地） | `goals/`、`eval/` |
| M6 | 前端升级（本地 web → 可选 Electron） | `packages/web/` |

每个里程碑的验收标准写在 `docs/milestones/`（M2 起开始建）。

---

## 已知缺口（写在这里，免得误以为它已经安全）

- `resolveInside()` 只做字符串层越权检查，**不解析符号链接**。指向工作区外的 symlink 目前能穿过去。
- 没有 shell 工具，所以也还没有沙盒。shell 会和沙盒一起上线，不单独裸奔。
- 没有 token 计数与 compaction，长会话会一直涨。
- 权限应答走注入的回调，不是异步命令通道；做成常驻 daemon 时要改。
- 流式只向外暴露文本增量；tool_call 分片在 provider 内部拼完才交给循环，UI 看不到参数逐字生成的过程。

---

## 文档

- [docs/notes/](docs/notes/) — 读别人家实现的笔记（Codex、Claude Code），带出处
- [docs/adr/](docs/adr/) — 自己做的决定：背景、候选、结论、后果
- [docs/spec/](docs/spec/) — 自家的协议与 schema 设计
- [docs/spec/agent-harness.md](docs/spec/agent-harness.md) — agent harness：循环、工具、上下文、记忆、权限、可靠性、观测，以及当前落地情况
