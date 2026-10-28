# Agent harness

模型只做一件事：看消息，吐文本，或者要一次工具调用。Harness 是包在模型外面的运行时。它决定这一轮怎么转、能用什么工具、喂进去什么上下文、记住什么、什么允许执行、失败了怎么停和怎么恢复、事后怎么查。

本文是这七层的解决说明。每一层先给目标形态和一个具体例子，再对照 `packages/core` 里现在的代码：做了什么、跑起来是什么效果、缺什么。

评测那套东西叫 eval harness，见 [eval-harness.md](eval-harness.md)。它用来断言这套运行时的行为，不是运行时本身。

---

## 一回合怎么走

```
用户输入
  → 拼上下文（系统提示 + 记忆 + 历史消息 + 工具描述）
  → 问模型
  → 没有工具调用：这一轮结束
  → 有工具调用：逐个
       权限门（规则 / 模式 / 问人）
       不允许：写成失败 observation，不执行
       允许：执行前做快照，带超时和中断信号去跑
              （路径限制，将来再加上沙盒）
       结果截断后塞回消息
  → 再问模型，直到它不再要工具、步数用尽、或被中断
  → 全程往事件日志里追加，供以后回放
```

循环现在已经遵守的不变量：

1. 被拒绝的调用也要有一条 `ok: false` 的工具结果。拒绝是 observation，不是静默丢弃。
2. 工具抛出的异常不许逃出执行器，一律变成错误文本回灌。
3. 一次 `send()` 以且仅以一个 `turn.end` 或 `error` 结束。事件顺序见 [event-protocol.md](event-protocol.md)。

还没守住的不变量：上下文有预算、变更可撤销、一次运行可以原样回放。这三件下面分开写。

---

## 1. Agent loop

**解决什么。** 把「问模型 → 执行工具 → 把结果塞回去 → 再问」收成一个短循环。步数上限、用户中断、模型报错，都在这里停下来，并把原因告诉外面。高级范式（goal、workflow、多 agent）是在这个循环周围加东西，不是换掉它。

**例子。** 用户说「看看工作区里有什么，再读 README」。剧本化模型先要 `list_dir`，再要 `read_file`，然后用文本收尾。循环产生的事件是：

```
turn.start step=0
assistant.message          list_dir
  tool.call                list_dir
  permission.decided       allow
  tool.result              ok
turn.start step=1
assistant.message          read_file
  tool.call / decided / result
turn.start step=2
assistant.message          「README 里写的是……」
turn.end                   end_turn
```

步数默认 25。到了还在要工具，就 `turn.end reason=max_steps`，不再问模型。用户中断是 `interrupted`，模型抛错是先 `error` 再 `turn.end reason=error`。

**现在。** 实现就是 [`packages/core/src/loop/agent-loop.ts`](../../packages/core/src/loop/agent-loop.ts)。`Session`（[`session.ts`](../../packages/core/src/session.ts)）是唯一的组合根：模型、工具表、权限门、循环、审计在这里拼起来，循环本身不认识 UI。

流式是可选的。provider 实现了 `stream()` 就把文本增量转成 `assistant.delta`；没实现就走 `complete()`，循环后面的逻辑不变。`FakeModel` 和 `OpenAIModel` 都走流式路径。

**效果。** `pnpm dev` 不配 provider 时，FakeModel 按固定剧本走完「列目录 → 读 README → 说话」。每次工具调用都会在终端里打出 `→ 工具名`、权限决定、`✓/✗` 结果。配了 `~/.omniagent/config.json` 的 provider 之后，同一条循环换成真模型，权限和工具一行都不用改。`pnpm eval` 的三个内置 case 断言的就是这条链路：工具顺序、权限决定、落盘文件、结束原因。

**缺口。**

- 同一轮里的多个工具调用是串行的。现在工具少，这不是问题；以后有互相独立的只读调用时再考虑并行。
- `Session` 上只有一个 `AbortController`，而且活过整段会话。`interrupt()` 一旦调用，这个 session 之后的 `send()` 也会直接 `interrupted`。TUI 目前也没有把 Ctrl+C 接成「打断这一轮、会话还在」。
- 模型调用失败就结束这一轮，循环自己不重试。重试只发生在 SDK 里面，见第 6 节。

---

## 2. 工具注册与使用

**解决什么。** 工具是模型能对世界做的动作。注册表负责三件事：名字唯一、把参数 schema 变成给模型看的 JSON Schema、按名字取出实现。执行器负责第四件：任何失败都变成 `ToolResult`，不把异常扔进循环。

一条工具的契约：

```ts
interface Tool {
  name: string;
  description: string;
  parameters: z.ZodType;   // 运行时校验，同时生成 JSON Schema
  mutating: boolean;       // 会不会改工作区。权限和撤销都靠它
  execute(args, ctx): Promise<ToolOutput>;
}
```

`ctx` 里只有 `cwd` 和 `AbortSignal`。工具不自己问权限，也不自己写审计。

**例子。** 内置的三个工具：

| 工具 | mutating | 行为 |
| --- | --- | --- |
| `list_dir` | 否 | 列目录，跳过 `node_modules`、`.git`、`dist`、`.omniagent` |
| `read_file` | 否 | 带行号读文本，默认最多 2000 行 |
| `write_file` | 是 | 覆盖写入，父目录不存在就创建 |

模型如果给了坏参数，zod 失败，回灌的是「参数校验失败：path: …」，文件不会被碰。模型如果要读 `../../etc/passwd`，`resolveInside()` 在字符串层拒绝，回灌「路径越出工作区」。单次输出超过 3 万字符就保留头 70% 和尾 20%，中间写明省略了多少，避免一次工具结果把上下文撑爆。

**现在。** 注册表在 [`tools/registry.ts`](../../packages/core/src/tools/registry.ts)，执行器在 [`exec/executor.ts`](../../packages/core/src/exec/executor.ts)，三个工具在 [`tools/builtin/`](../../packages/core/src/tools/builtin)。`Session` 默认用 `createDefaultRegistry()`。测试可以换一套自己的表，循环不用改。

**效果。** 在工作区里，读、列、覆盖写是通的，并且都先过权限门。写出去的内容就是模型给的整文件，没有补丁、没有 diff。读大文件会被截断，但截断后的全文没有另存，`fullOutputRef` 这个字段在类型里，三个工具都没填。

**缺口。**

- 没有 `edit_file`，也没有 `shell`。改一个函数只能整文件覆盖。shell 按 [ADR-0001](../adr/0001-permission-first-sandbox-later.md) 跟沙盒一起上，不单独裸奔。
- `Tool.mutating` 写了，权限层没用它。`plan` / `acceptEdits` 认的是写死的工具名集合 `write_file`、`edit_file`（[`permissions/modes.ts`](../../packages/core/src/permissions/modes.ts)）。以后加工具，忘了改这个集合就会放错。
- `resolveInside()` 不解析符号链接。指向工作区外的 symlink 现在穿得过去。这是已知缺口，等沙盒用挂载遮蔽补，不是靠把检查写得更复杂。
- 工具只在开头看一眼 `signal.throwIfAborted()`，真正的 `readFile` / `writeFile` 没有把 signal 传进去。读到一半被中断，这次 IO 还是会跑完。

---

## 3. 上下文

**解决什么。** 上下文是这一轮真正喂给模型的东西，不是「聊天记录」的同义词。它至少有四块，预算要分开算：

| 块 | 谁写 | 生命周期 |
| --- | --- | --- |
| 系统提示 | harness 拼出来 | 每次请求都带，不进会话记录 |
| 记忆 | 见下一节 | 短、稳定、跨会话 |
| 历史消息 | 循环追加 | 这一段会话，会被压缩 |
| 工具描述 | 注册表的 `specs()` | 每次请求都带 |

系统提示只写行为约束，不写项目事实。项目事实进工作区记忆，用户偏好进全局记忆。混进系统提示，就没法单独改、单独测、单独关掉。

**例子。** 一次发给模型的请求长这样：

```
system:
  你是运行在用户本机的个人智能体。
  需要了解文件时先读，不要猜。
  被拒绝的调用不要原样重试。

  # 全局记忆
  回答用中文，先给结论。

  # 工作区记忆
  本仓库的测试用 pnpm test，不要用 npm。

messages:
  user: 把 README 的安装说明改成 pnpm
  assistant: tool_call read_file README.md
  tool: （带行号的内容，可能已截断）
  assistant: tool_call write_file …

tools:
  list_dir, read_file, write_file
```

上下文要有预算。历史快满时，把较早的工具结果压成一段摘要，留下最近几轮原文，并发出 `context.compacted`。压完的摘要写进会话记录，不写进记忆——摘要是有损的，记忆是人认过的事实。

**现在。** 系统提示是一整段字符串。[`DEFAULT_SYSTEM_PROMPT`](../../packages/core/src/session.ts) 写了「先读再改、被拒绝别重试、回答简洁」。`config.json` 里的 `system` 可以整段换掉。它不在 `messages` 里，由 provider 单独放到请求最前面（[`providers/openai.ts`](../../packages/core/src/providers/openai.ts) 的 `toOpenAIMessages`）。

工具描述每次都从注册表生成。历史就是 `Session` 内存里的 `messages`，只增不减。

**效果。** 换提示词会改变模型行为，而且可以用 eval 保住循环不被带歪：FakeModel 的 case 不看提示词好不好，真实模型的 case 才看。长会话没有上限。消息会一直涨，直到服务端以 `max_tokens` 或直接报错停掉。事件类型里有 `context.compacted`，TUI 也能画它，但没有任何代码发出这个事件。README 里写了 `context/` 目录，仓库里还没有这个目录。

**缺口。** 没有 token 计数，没有压缩，没有「系统提示 / 记忆 / 历史」的分层拼接。现在的系统提示是一个不可拆的字符串，全局记忆和工作区记忆没有地方可挂。

---

## 4. 记忆

**解决什么。** 记忆是跨过这一轮、还想让模型知道的事实。它不是会话记录，也不是配置。

两层，作用域不同，不要合成一个文件：

| | 全局记忆 | 工作区记忆 |
| --- | --- | --- |
| 放哪 | `~/.omniagent/memory.md` | `<cwd>/.omniagent/memory.md` |
| 记什么 | 这个用户的偏好：语言、回答风格、常用约定 | 这个仓库的事实：怎么测试、哪条目录别动、术语 |
| 谁能改 | 用户，或 agent 在用户确认后追加 | 同上，但只对当前工作区生效 |
| 怎么进上下文 | 拼进系统提示的固定槽，有字符上限 | 同左，排在全局记忆后面 |
| 冲突 | 工作区覆盖全局里同一条主题 | — |

会话记录（transcript）是另一样东西：这一次对话的原始消息，用来续跑和回放，默认不进下一次新会话的上下文。配置（模型、权限模式、规则）也不是记忆：它决定 harness 怎么运转，不拿去「提醒模型」。

**例子。**

```markdown
<!-- ~/.omniagent/memory.md -->
- 回答用中文，先给结论。
- 不要主动 git commit，除非我明确说提交。

<!-- <repo>/.omniagent/memory.md -->
- 测试命令是 pnpm test。
- packages/core 不依赖 UI，不要在这里 import tui。
```

模型不该靠「上次聊过」来记住这两条。下次新开会话，harness 把这两个文件读进上下文的记忆槽。文件不存在就当空，不报错。

记忆要短。超过上限就拒绝继续追加，让人删，而不是静默截断后假装还记得。agent 自己写记忆必须过权限门——它是一次对 `.omniagent/` 的写入，工作区读写模式下这条路径也要问人。

**现在。** 没有记忆文件，也没有加载逻辑。

有一个容易看错的 [`TranscriptStore`](../../packages/core/src/store/transcript.ts)：把整份 `messages` 存成一个 JSON。它没有被 `Session` 或 TUI 调用。注释写明持久化以后再加。所以进程一退，这一轮说了什么、读了什么、写了什么，都不在了。下次 `pnpm dev` 是一个新的 `Session`，历史是空的。

配置只有用户级的 `~/.omniagent/config.json`。`Rule.source` 已经预留了 `project`、`local`、`user`、`managed`，加载器只用了 `user`。这是配置的作用域，不是记忆。

**效果。** 今天没有任何东西会跨会话影响模型的输入，除了你手写进 `config.json` 的 `system` 字符串和权限规则。把「这个仓库用 pnpm」写在聊天里，只活在当前进程的内存里。

**缺口。** 全局记忆和工作区记忆都还没做。不要把 transcript 自动摘要进记忆：那会把一次错误结论变成永久事实。记忆的写入应该是显式的。

---

## 5. 工作区

**解决什么。** 工作区是一个项目，不是一次会话，也不是用户家目录。一次会话只绑一个工作区，根目录就是这个项目的根。权限范围、工作区记忆、会话日志、审计、检查点都挂在这个根上。换一个项目，就是换一个工作区，模式可以不同。

工作区里的东西不放进项目，放在用户目录：

| 放在 `~/.omniagent/sessions/<key>/` | 作用 |
| --- | --- |
| `workspace.json` | 这个项目的根路径，以后放这个项目的权限模式 |
| `<sessionId>.jsonl` | 这一次会话的事件日志（还没写） |
| `<sessionId>.audit.jsonl` | 这一次会话的工具审计 |
| `memory.md` | 工作区记忆（还没做，不跟会话混在一个文件里） |

变更快照不进这个目录。做撤销时放到 `~/.omniagent/blobs/`，会话文件里只留指针。

全局配置和项目配置用同一套四种模式：`read`、`workspace`、`global`、`plan`。不写配置时的默认是 `read`（工作区只读）。要改这个默认，在 `~/.omniagent/config.json` 里设 `mode`。某个项目要例外，再在它自己的 `~/.omniagent/sessions/<key>/workspace.json` 里覆盖。

生效顺序：

```
<项目>/.omniagent/workspace.json 的 mode
  → 没有，就用 ~/.omniagent/config.json 的 mode
    → 还没有，就是 read
```

`global` 可以写成全局默认，但不建议。不写配置就只读，是为了新开一个目录时不会直接改文件。

**例子。** 全局默认只读，OmniAgent 这个项目单独放开写入：

```json
// ~/.omniagent/config.json
{ "mode": "read" }

// ~/.omniagent/sessions/OmniAgent-<哈希>/workspace.json
{ "path": "/home/yunqi/src/OmniAgent", "mode": "workspace" }
```

不写这两份时，效果和全局 `"mode": "read"` 一样。在 OmniAgent 里，`write_file src/a.ts` 可以落盘；`write_file ~/src/notes/a.md` 直接拒绝，因为出了这个工作区。notes 没有自己的 `workspace.json`，跟着全局默认走，连自己目录里的写入也不允许。要改 notes，得把会话绑到 notes 并把它改成 `workspace`，或者把当前工作区显式切成 `global`。

工作区外的路径不是「再问一次人」就能过。范围是硬边界，规则和确认都在范围之内才有意义。

**现在。** 工作区身份在 [`packages/core/src/workspace/`](../../packages/core/src/workspace)。TUI 启动时用 `process.cwd()` 打开它：`realpath` 解开符号链接，目录名是「基名 + 路径哈希」，登记写在用户目录，不写进项目。

```
~/.omniagent/sessions/<目录名>-<12位哈希>/
  workspace.json              { "path": "<realpath 后的根>" }
  <sessionId>.jsonl           路径已经留好，会话正文还没写
  <sessionId>.audit.jsonl     这一次会话的工具审计（有工具调用之后才出现）
```

`Session` 的 `cwd` 用的是这份登记里的根。`resolveInside()` 仍然拒绝跑出这个根。同一个仓库从符号链接走进去，会落到同一个目录。

模式还不在工作区配置里。`mode` 仍来自 `~/.omniagent/config.json`，所有项目共用一个。所以「这个仓库只读、那个仓库可写」今天做不到。从子目录启动时，根就是那个子目录，不会往上找 git 根。

**效果。** `pnpm dev` 启动时会打印工作区根和数据目录。读、写都被关在这个根里，包括 `bypass` 模式——路径检查不看权限模式，工作区外一律抛「路径越出工作区」。放行过的工具调用记到 `~/.omniagent/sessions/<key>/<sessionId>.audit.jsonl`，一次会话一份，不再写到项目里的 `.omniagent/`。

**缺口。** 工作区对象只有根目录和存储位置。四种模式还没挂上去，会话 jsonl 和变更 blob 也还没写。有了这个目录，下面的模式才有地方放。

---

## 6. 权限控制

**解决什么。** 两层，正交，不要合成一个模块：

| | 权限 | 沙盒 |
| --- | --- | --- |
| 问题 | 要不要执行这次调用 | 执行时进程能碰什么 |
| 时机 | 工具执行前 | 进程已经拉起来之后 |
| 实现 | 纯函数 + 问人 | OS：seatbelt / bubblewrap |
| 挡得住 | 「该不该问人」 | `curl` 的各种写法、symlink、意外的子进程 |

规则不是安全边界。`shell(curl *)` 拦不住 `/usr/bin/curl`。规则把「什么时候该问」写清楚；真正的执法在沙盒。这个决定已经写在 ADR-0001 里。

权限先看工作区模式，再看规则。模式回答「这次会话能碰哪」；规则回答「在这个范围里，这一次要不要问人」。出了范围的调用直接 deny，不再进入问人。

**四种模式，全局和项目是同一套。** 词汇只有 `read`、`workspace`、`global`、`plan`。全局 `config.json` 的 `mode` 是默认值，项目 `workspace.json` 的 `mode` 覆盖它。两边都不写时是 `read`。

| 模式 | 工作区内读 | 工作区内写 | 工作区外 | 用来做什么 |
| --- | --- | --- | --- | --- |
| `read` 只读 | 允许 | 拒绝 | 拒绝 | 不写配置时的默认。查问题、看代码，不改这个项目 |
| `workspace` 工作区读写 | 允许 | 允许 | 拒绝 | 要改这个项目时打开 |
| `global` 全局读写 | 允许 | 允许 | 允许 | 要改家目录或别的仓库时打开 |
| `plan` 计划 | 允许 | 拒绝 | 拒绝 | 只产出计划，不执行修改 |

`plan` 和 `read` 的权限上限一样：都能读这个工作区，都不能写，都不能出去。差别不在门上，在这一轮的合同上。`read` 是把只读任务做完（回答、审查）。`plan` 是不许动手，结束时必须给出计划：要改哪些文件、按什么顺序、有什么风险。计划写在回复里，不写进项目源码。要执行，人把模式改成 `workspace` 再开一轮。

`global` 是唯一可以放开 `resolveInside()` 的模式。放开之后，deny 规则仍然有效（例如 `~/.ssh/**`、`.env`）。它不是沙盒，也不是「问都不问」。

范围内的确认仍然用规则，求值顺序不变：**deny → ask → allow → 这一模式的默认**。

```json
{
  "mode": "read",
  "permissions": {
    "allow": ["read_file(./docs/**)", "list_dir"],
    "ask": ["write_file(./.git/**)"],
    "deny": ["read_file(./.env)"]
  }
}
```

这份可以放在 `~/.omniagent/config.json`，作为所有项目的默认。某个项目的 `workspace.json` 只写 `{ "mode": "workspace" }` 就覆盖模式，规则仍然叠加上面。`permissions` 也可以项目一份、用户一份，跟模式不是同一个字段。

| 调用 | 工作区模式 | 结果 |
| --- | --- | --- |
| `read_file .env` | 任意 | deny，规则先于模式 |
| `read_file docs/a.md` | `read` | allow |
| `write_file src/a.ts` | `read` 或 `plan` | deny，模式不允许写 |
| `write_file src/a.ts` | `workspace` | 允许执行；`.git` / `.omniagent` 仍要问 |
| `write_file ~/other/a.ts` | `workspace` | deny，出了工作区 |
| `write_file ~/other/a.ts` | `global` | 进入规则；没有规则就问人 |

人的回答目前只有 allow / deny。还没有「这次允许，并写成一条规则」。

**现在代码里的五种模式是另一根轴。** 它们写在 [`permissions/modes.ts`](../../packages/core/src/permissions/modes.ts)，回答的是「没写规则时问不问」，不是「能碰哪个目录」。而且这个 `mode` 在用户级 `config.json` 里，所有项目共用。

| 现有模式 | 没写规则时 | 对应到上面的哪种 |
| --- | --- | --- |
| `default` | 每次工具调用都问 | 接近 `workspace`，但读也要问 |
| `acceptEdits` | 编辑类放行，其它问；`.git`、`.omniagent` 仍问 | `workspace`，再加「工作区内编辑不问」 |
| `plan` | 读放行，编辑和 shell 直接拒绝 | 就是 `plan` |
| `dontAsk` | 本来要问的一律拒绝 | 不是范围。给 CI 用的确认策略，不作为工作区的日常模式 |
| `bypass` | 全部放行，不问 | 看起来像 `global`，但今天出不了工作区 |

最后一行是现有实现的实际效果：`bypass` 只跳过确认，跳不过 `resolveInside()`。五种模式没有一个能读工作区外面的文件。

沙盒加上之后，模式说允许的 `shell` 也在沙盒里跑。`workspace` 下工作区可写，家目录和网络默认不可碰。`global` 只是放宽权限门，不自动等于关掉沙盒。越界仍然是系统调用失败。

**现在。** 纯函数 `decide()` 在 [`permissions/evaluate.ts`](../../packages/core/src/permissions/evaluate.ts)，规则语法在 [`permissions/rules.ts`](../../packages/core/src/permissions/rules.ts)（`Tool` 或 `Tool(specifier)`，路径 glob，`//` `~/` `/` `./` 四种锚点）。复合命令拆解在 [`permissions/bash.ts`](../../packages/core/src/permissions/bash.ts)，给还没出生的 shell 用：allow 要每个子命令都命中，deny / ask 命中一个就够。

`RuleBasedGate` 把纯函数接到 UI 的 `approve` 回调上。core 不弹窗。TUI 在回调里问 `y/N`，回车默认拒绝。

沙盒目录不存在。没有 shell 工具。

**效果。** 不配规则、模式用默认时，`pnpm dev` 里每一次 `list_dir` 和 `read_file` 都会停下来等 `y`。拒绝之后模型会看到「调用被权限策略拒绝（用户拒绝）。不要重试同一调用……」，演示剧本的下一步是直接说话，不会再调工具。

`pnpm eval` 里能看到两条硬效果：

- `deny: ["write_file(./secret.txt)"]` 时，决策是 deny，`secret.txt` 不会出现。
- `mode: "acceptEdits"` 时，`write_file out.txt` 不问人，文件内容就是 `hello`。

这是现有五模式的效果，不是上面四种工作区模式的效果。四种里今天一个都还没有：没有 `workspace.json`，`decide()` 也不认识 `read` / `workspace` / `global`。

**缺口。**

- 工作区模式还没落地。现有五模式把「问不问」和「能不能改」塞在同一个枚举里，而且全局默认是 `default`（每次都问），不是 `read`。
- 没有沙盒，所以没有安全边界。就算模式是 `workspace`，破坏力上限仍是「改掉这个项目里的文件」。不写配置时不能默认成 `global`。
- 权限确认是阻塞回调，不是事件通道。UI 在等人回答时不能做别的。`AgentCommand` 里已经留了 `permission.respond`，daemon 化时再换。
- 规则只有用户级那一份。项目级、会话级的 source 字段在，加载时没有合并。
- 没有 auto 分类器模式。缺的不是代码，是一套标好 allow / ask / deny 的用例。没有它就不知道误放行有多少，不该做。

---

## 7. 可靠性

**解决什么。** 模型会超时、会 429、会返回坏 JSON。工具会挂住、会被人打断。写入会把文件改坏。这三件要分开处理，而且都要可恢复，而不是「失败了就让用户重来」。

**模型重试。** 只重试瞬时失败：网络错误、超时、429、5xx。401、400、内容审核不重试。次数和退避有上限，用尽了再发 `error`，并带上 `retryable`。重试发生在这一轮内部，不占用 `maxSteps`，也不额外写一条 assistant 消息。

**工具超时和中断。** 每个工具有自己的时限，和用户的「停」是两个 signal，合成一个交给工具：

```
read_file / write_file   10s
shell（将来）            默认 120s，调用方可缩短
```

用户中断只取消这一轮，会话还在，已经写进历史的消息保留。超时变成一条 `ok: false` 的工具结果（「read_file 超时」），模型可以换个做法；用户中断则是 `turn.end reason=interrupted`，不再问模型。

**失败可恢复。** 每一次会改文件的工具，执行前把旧内容存下来。一轮结束时给出一个检查点 id。恢复就是把这些文件写回去，不是「让模型再改一遍」。

```
.omniagent/checkpoints/<id>/
  manifest.json          # 哪些路径被改过，旧文件在不在
  files/...              # 改之前的内容
```

`write_file` 覆盖 `README.md` 之前，旧的 README 进检查点。人说「撤销」，harness 把旧内容写回，并在会话里追加一条说明，而不是指望模型记得原文。新文件（原来不存在）撤销时删除。检查点只覆盖 mutating 工具碰过的路径，不复制整个工作区。

这个机制不依赖 git。仓库是不是 git 不影响能不能撤销。

**现在。**

- 模型：`provider.timeoutMs` 和 `provider.maxRetries` 原样交给 OpenAI SDK。不配的话，用的是 SDK 自己的默认。循环里没有另一层重试。`AgentError.retryable` 这个字段没有人填。坏的工具参数 JSON 不会让回合崩掉：解析失败会变成非法参数，再被 zod 打成 `ok: false`。这是已经做对的一半。
- 中断：`Session.interrupt()` 能让循环在下一轮模型调用前停，模型的 HTTP 请求也会带上 signal。但 controller 是会话级的，中断一次就废掉整个 session；TUI 没有接这个方法；工具的文件 IO 不响应 signal。没有按工具计时的超时。
- 恢复：没有。`write_file` 直接覆盖。写错了，旧内容不在 harness 的任何地方，只能靠编辑器或 git 自己找回。

**效果。** 真模型网络抖一下，有可能被 SDK 默默重试成功，用户看不到。重试用尽或 401，这一轮以 `错误：…` 结束，已经执行过的工具不会回滚。`write_file` 一旦被允许，磁盘上就是新内容，进程里没有「撤销」这个动作。

**缺口。** 上面三块里，检查点是和「能改文件」直接相关的那块，优先级高于把重试策略重写一遍。SDK 的重试已经能盖住常见的 429；覆盖写没有任何退路。

---

## 8. 观测与回放

**解决什么。** 事后要能回答两个不同的问题：

1. **它干了什么？** 安全审计。工具名、参数摘要、权限决定、成败、耗时。不要把整份文件内容写进审计。
2. **当时屏幕上发生了什么？** 回放。用户输入、模型文本、每一次工具调用和完整结果、权限决定、结束原因。按时间追加，只增不改。

回放是把事件日志再喂给现在的 `renderEvent`，不是把工具再执行一遍。再执行会有副作用，而且文件已经变了，看到的也不会是当时的结果。

从某一步继续（fork）是第三件事：把那一刻的 `messages` 装进一个新 `Session`，后面的工具调用走正常的权限和执行。回放不等于 fork。

**例子。** 一行审计，和一行事件，不要混在一个文件里。

```json
{"ts":"2026-10-28T12:00:01.000Z","sessionId":"s_1","step":0,"tool":"write_file","callId":"call_1","argsDigest":"{\"path\":\"README.md\",\"content\":\"# …","decision":"allow","source":"用户放行","ok":true,"durationMs":4}
```

```json
{"type":"tool.result","result":{"callId":"call_1","name":"write_file","ok":true,"content":"已写入 README.md（12 字符，1 行）"}}
```

审计回答「有没有写过 README、谁放行的」。事件日志回答「写之前模型说了什么、结果原文是什么」。回放命令读第二个文件，不碰模型，不碰工具。

**现在。** 审计有了。[`AuditLog`](../../packages/core/src/store/audit.ts) 是追加写的 JSONL。TUI 把它放在 `~/.omniagent/sessions/<工作区 key>/<sessionId>.audit.jsonl`，跟这次会话的事件文件并列，不跟别的会话混在一起。循环在每次工具调用之后记一条：时间、session、步数、工具名、截断到 200 字符的参数、权限决定和来源、成败、耗时。

事件协议本身就是回放该用的格式，但没有落盘。`Session.send()` 的事件只在当次生成器里存在。eval 把事件收进内存做断言，跑完就丢。`TranscriptStore` 能存消息，没有人调用，而且它是整文件覆盖的 JSON，不是可追加的事件流，也没有用户输入之外的权限和计时。

**效果。** 跑过一次 `pnpm dev` 并放行过工具之后，这一次会话的 `.audit.jsonl` 能看出调了哪个工具、是问了人还是命中规则。看不出模型说了什么，看不出工具返回的正文，也不能从这条日志回放终端上的画面。进程退出后再也看不到那次对话。下一次启动是一个新的会话 id，审计也是一个新文件。

**缺口。** 缺的是「事件日志」这一个文件，以及一个只读的回放入口。不要把审计加字段加到能回放：审计故意丢掉了正文，这是对的。

---

## 对照

| 层 | 现在有的 | 跑起来的效果 | 还没有 |
| --- | --- | --- | --- |
| Agent loop | 循环、步数上限、流式、组合根 `Session` | 假模型零 token 走完读文件；真模型换 provider 即可 | 一轮一停的中断；模型失败的循环内重试 |
| 工具 | 注册表、zod、三个文件工具、异常变 observation、输出截断、字符串层路径限制 | 读 / 列 / 覆盖写，坏参数和越界路径会回灌给模型 | shell、按行编辑、符号链接、`fullOutputRef`、IO 级中断 |
| 上下文 | 一段系统提示 + 全量历史 + 工具 schema | 提示词能换；历史只增不减 | token 预算、压缩、记忆槽 |
| 记忆 | 无。transcript 类写了但没接入 | 退出即忘。只有 `config.json` 里的 system 和规则会留下来 | 全局记忆、工作区记忆 |
| 工作区 | 根目录 + `~/.omniagent/sessions/<key>/workspace.json` | 工具出不了启动目录；符号链接不会拆成两个工作区；审计写在用户目录 | 按项目保存的模式；从子目录找到项目根 |
| 权限 | 五模式（问不问）、deny/ask/allow 规则、问人回调、受保护路径 | 默认每次都问；deny 能挡住写入；acceptEdits 能自动写。bypass 也出不了目录 | 只读 / 工作区读写 / 全局读写 / plan；沙盒；项目级规则 |
| 可靠性 | SDK 级 timeout / maxRetries；坏 JSON 不崩回合 | 网络抖动可能被 SDK 吃掉；写错文件没有退路 | 工具超时、会话级中断语义、变更检查点 |
| 观测 | 工具审计 JSONL；事件类型足够描述 UI | 能查工具和权限决定；不能回放对话 | 事件日志、回放、从某一拍 fork |

---

## 改进顺序

按依赖排，不按「听起来完不完整」排。前面的步骤不改循环的形状，`AgentLoop` 仍然应该短到能一眼看完。

1. **事件日志落盘。** `Session` 把已经定义好的 `AgentEvent` 追加到 `~/.omniagent/sessions/<工作区 key>/<id>.jsonl`。这个路径已经由工作区布局给出，文件还没写。审计保持现在的摘要，不要合并进会话文件。
2. **一轮一个 AbortSignal，加上工具超时。** `interrupt()` 只取消当前 `send()`。文件工具把 signal 传进 IO，到时限写成失败 observation。TUI 用 Ctrl+C 打断这一轮而不是杀掉进程。这是改动最小、能立刻碰到的可靠性。
3. **mutating 工具的检查点。** `write_file` 执行前保存旧内容，提供一个恢复入口，把文件写回去。在有 shell、能改更多东西之前先把这一条路径补上。
4. **上下文预算和压缩。** 对应原来的 M2。发出已经预留的 `context.compacted`。压缩历史，不要压缩记忆槽。
5. **工作区，以及同一套四种模式。** 把 `cwd` 收成工作区。`mode` 只剩只读、工作区读写、全局读写、plan，全局配置和项目配置用同一个枚举。都不写时是 `read`；`~/.omniagent/config.json` 改所有项目的默认；`<root>/.omniagent/workspace.json` 只覆盖这一个项目。现有的 `default` / `acceptEdits` / `dontAsk` / `bypass` 退出这个字段，问不问留给规则。
6. **全局记忆和工作区记忆。** 两个 markdown，显式写入，拼进系统提示的固定槽，并算进预算。不要从 transcript 自动抽取。工作区记忆跟着工作区走。
7. **shell 和沙盒一起上。** 对应原来的 M3，ADR-0001 不变。工作区模式回答「能碰哪」，沙盒回答「进程实际能碰哪」。

另外几件小事，做上面任何一件时顺手改掉即可，不单独立项：

- 权限判断改看 `Tool.mutating`，删掉写死的工具名集合。
- 截断输出时把全文写到旁边，填上 `fullOutputRef`。
- 模型错误填 `retryable`，循环对瞬时错误做有上限的重试，和 SDK 的重试合成一层，不要两层各重试一轮。
- 规则加载把 `project`（仓库里的配置）叠到 `user` 上面，source 字段已经够用。
