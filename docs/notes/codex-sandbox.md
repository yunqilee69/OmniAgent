# Codex 的沙盒与审批模型

来源：官方文档 `learn.chatgpt.com/codex/sandboxing`、`/codex/agent-approvals-security`；源码 `github.com/openai/codex`（`codex-rs/core/src/sandboxing/`、`codex-rs/linux-sandbox/`、`codex-rs/execpolicy/`）。记录时间 2026-10。

## 一句话

Codex 是 **sandbox-first**：默认把命令关进操作系统沙盒里跑，沙盒内自由，越界才问人。权限规则（execpolicy）是沙盒的补充，不是主力。

## 沙盒

### 三档模式

| `sandbox_mode` | 语义 |
| --- | --- |
| `read-only` | 能读，不能写，不能执行未审批的命令 |
| `workspace-write` | 能读、能在工作区内写、能跑常规本地命令（默认档） |
| `danger-full-access` | 无任何限制 |

### 各平台用什么

- **macOS**：Seatbelt（`sandbox-exec`）+ 动态生成的 profile，开箱即用。
- **Linux / WSL2**：**bubblewrap 为主**。先 `--ro-bind / /` 把整机挂成只读，再把可写根用 `--bind` 挂回读写。**Landlock 已降级为 legacy 路径**，因为无法隔离 app-server 的 Unix socket；文件系统受限的策略现在要求 bwrap，见到 Landlock 会拒绝。
- **seccomp**：bwrap 建好文件系统视图之后，再装 no-new-privileges 和 seccomp 过滤。网络受限时封网络 syscall；只有文件系统受限但网络放开时也封 `AF_VSOCK`；**所有模式都封 `io_uring`**。托管代理模式下允许 IP socket，但会封新的独立 `AF_UNIX` socket（socketpair 仍允许）。
- **Windows**：原生 Windows 沙盒（PowerShell 下），或 WSL2 下走 Linux 那套。

### workspace-write 的边界细节（最值得抄的部分）

1. 整机只读起步，可写根 = 工作区 + `/tmp`（可写根可通过 `sandbox_workspace_write.writable_roots` 扩展）。
2. **可写根内部的受保护路径重新挂回只读**：`.git`、解析出来的 `gitdir`、`.codex`。这是个有意的取舍：agent 改不了仓库元数据，也就不能自己 commit，想 commit 得升级权限。
3. 可读/可写策略按路径**具体度**解析：更窄的可写路径可以重新打开更宽的只读/禁止父目录；但**更窄的 deny 子路径仍然赢**。
4. 无法读取的 glob 匹配会被展开并遮蔽；可写根内若某个受保护路径的组件是 symlink 或不存在，用挂载 `/dev/null` 的方式封掉。

第 4 条是防 symlink 绕过的标准做法，我们 M3 一定要做：只在字符串层面判路径（我们现在的 `resolveInside`）是挡不住 symlink 的。

### 网络

`workspace-write` 下网络默认封死，需要显式打开：

```toml
[sandbox_workspace_write]
network_access = true
```

## 审批（approval）

审批策略和沙盒是解耦的两件事。

| `approval_policy` | 语义 |
| --- | --- |
| `on-request` | 沙盒内允许的直接跑；需要越界、写工作区外、访问网络时才问 |
| `never` | 不弹任何提示，但仍然在沙盒限制内运行 |
| `untrusted` | **已退役**，官方说设成它可能让客户端起不来 |

> 老资料里常见的 `on-failure`（失败后再升级权限重试）在现行文档里已经不出现了。抄旧文章时要留意。

替代 `untrusted` 的做法是项目级信任：

```toml
[projects."/path/to/project"]
trust_level = "untrusted"
```

另外还有 `approvals_reviewer = "user" | "auto_review"`——`auto_review` 就是「用另一个模型审这个模型」，它会拒绝关键风险动作，失败时 **fail closed**。还有细粒度的审批类别：

```toml
approval_policy = { granular = {
  sandbox_approval = true,
  rules = true,
  mcp_elicitations = true,
  request_permissions = false,
  skill_approval = false
} }
```

## execpolicy：规则即代码

`codex-rs/execpolicy` 用 **Starlark** 写规则（`.rules` 文件），不是 JSON。核心是 `prefix_rule`：

- 定义有序的 token 前缀模式、可选的 alternatives、一个 `decision`（`allow` / `prompt` / `forbidden`）、一句 justification。
- 可以在规则文件里写 `match` / `not_match` 例子，**加载时就校验**规则是否符合你的意图。这一点非常值得学：策略自带回归测试。
- `host_executable(name=..., paths=[...])` 限制哪些绝对路径允许退化成 basename 匹配。
- 多个 `--rules` 文件按顺序合并求值。
- 多条命中时取**最严格**的：`forbidden > prompt > allow`。
- 第一 token 精确匹配优先；开了 `--resolve-host-executables` 后，绝对路径可以退化成 basename 规则。

## 可以抄进 OmniAgent 的

1. **deny 优先 + 取最严格**的求值语义（已在 `permissions/evaluate.ts` 实现，按类别 deny → ask → allow）。
2. **受保护路径在可写根内重新只读**：`.git`、`.omniagent`（已在 `permissions/modes.ts` 里用「问一次」的软方式实现，硬方式留给沙盒）。
3. **规则文件自带 match / not_match 测试**：我们的等价做法是给 `rules.ts` 写表驱动测试；等你受够了手写测试，可以升级成规则文件里携带样例。
4. **symlink 用 `/dev/null` 遮蔽**：M3 绕不过去的东西。
5. **项目级信任**比逐条规则省事，适合个人 agent 起步。

## 不抄的

- Starlark DSL。个人项目的规则量还没到需要 DSL 的程度，JSON 足够；等规则超过 ~50 条再考虑。
- Windows 沙盒。M3 只做 macOS 和 Linux。
- `auto_review` 分类器。没有 eval harness 之前，无法判断它审得准不准。
