# Claude Code 的权限与沙盒

来源：`code.claude.com/docs/en/permissions`、`/docs/en/sandboxing`；沙盒实现 `github.com/anthropic-experimental/sandbox-runtime`。记录时间 2026-10。（Claude Code 本身闭源，以下来自文档与开源运行时。）

## 一句话

Claude Code 是 **permission-first**：默认每个工具首次使用都问，allow / ask / deny 规则决定问不问；沙盒是**可选叠加层，且默认关闭**。

## 权限模式

| 模式 | 语义 |
| --- | --- |
| `default`（别名 `manual`） | 每个工具首次使用都问 |
| `acceptEdits` | 自动接受文件编辑和 `mkdir` / `touch` / `mv` / `cp` 这类常见文件系统命令 |
| `plan` | 只读；不编辑源文件 |
| `auto` | 由后台分类器判断常规请求，代替逐条询问 |
| `dontAsk` | 本来要问的一律拒；预授权工具照常跑 |
| `bypassPermissions` | 跳过所有提示（**建议只在隔离容器里用**） |

`disableBypassPermissionsMode` / `disableAutoMode` 可以在设置里禁掉这些模式。`defaultMode` 决定会话启动时的模式。

## 规则语法

形状是 `Tool` 或 `Tool(specifier)`，放进 `permissions.allow` / `ask` / `deny`：

```json
{
  "permissions": {
    "allow": ["Bash(npm run *)", "WebFetch(domain:example.com)", "mcp__puppeteer__*"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(./.env)", "Edit(./secrets/**)"]
  }
}
```

### 求值顺序

**deny → ask → allow**，第一个命中的**类别**决定结果，具体程度不影响顺序。

- 宽的 deny 不能被更窄的 allow 覆盖（`Bash(aws *)` 挡住 `Bash(aws s3 ls)`）。
- ask 命中就一定会问，即使同时有更窄的 allow。
- 裸工具名的 deny（`Bash`）会把工具**从上下文里摘掉**；带 specifier 的 deny（`Bash(rm *)`）只是拦调用。
- 任意层级的 deny 都无法被其他层级放行；managed 设置优先级最高。
- 阻塞型 `PreToolUse` hook（exit 2）在规则求值**之前**生效；但 deny / ask 规则仍然优先于 hook 返回的 `"allow"`。

### Bash 规则的三个关键细节

1. **复合命令拆开**：按 `&&`、`||`、`;`、`|`、`&`、换行拆分，每个子命令独立匹配。deny / ask 任一子命令命中即命中；allow 必须全部命中（否则 `Bash(npm *)` 会放行 `npm i && rm -rf ~`）。
2. **wrapper 先剥掉**：`timeout`、`nice`、`nohup`、裸 `xargs` 等在匹配前去掉。
3. **它不是安全边界**（文档原话大意）：`Bash(curl *)` 拦得住 `curl ...`，拦不住 `/usr/bin/curl ...` 或 `sh -c 'curl ...'`。

第 1、2 条已在 `permissions/bash.ts` 实现；第 3 条写在 README 的「权限 vs 沙盒」里。

### 路径规则

前缀语义解决「规则文件在哪、路径相对谁」：

| 写法 | 锚点 |
| --- | --- |
| `//path` | 文件系统根 |
| `~/path` | home |
| `/path` | 相对 settings 文件所在目录 |
| `path` 或 `./path` | 相对当前工作目录 |

另外：

- `Read` 的 deny 规则会连带挡住同路径的 Edit / Write。
- `Write` / `NotebookEdit` / `Glob` / `MultiEdit` 上的路径规则**能写但不生效**，官方让用 `Edit(...)` / `Read(...)`。
- 支持参数匹配（`Agent(model:opus)`、`Bash(run_in_background:true)`），但**明确不支持** `command` / `file_path` / `path` / `url` 这类主内容字段——避免给人假的安全感。这个「知道什么不该支持」的判断很值得学。

已实现于 `permissions/rules.ts` 的 `resolveRulePath` / `matchesPath`。

### 设置作用域

- 项目：`.claude/settings.json`（需先接受 workspace trust）
- 本地个人：`.claude/settings.local.json`（「don't ask again」写在这里）
- 用户：`~/.claude/settings.json`
- managed：最高优先级，可用 `allowManagedPermissionRulesOnly` 独占规则来源
- `--settings <file>`：`/path` 规则锚定到该文件所在目录

我们的 `config/load.ts` 目前只读 `~/.omniagent/config.json`，但 `Rule.source` 字段已经预留，扩展多作用域不用改数据结构。

## 沙盒

### 默认关闭

这点容易被忽略：要 `/sandbox` 或 `sandbox.enabled = true` 才开。`/sandbox` 本身**不是**权限模式。

### 实现

基于 `@anthropic-ai/sandbox-runtime`（**TypeScript 写的**，这点对 TS 项目特别友好，可以直接读甚至复用）。

- **macOS**：`sandbox-exec` + 动态 Seatbelt profile，限制文件系统，只允许连到受控的 localhost 代理端口。
- **Linux / WSL2**：`bwrap` 做命名空间和挂载，`socat` 转发；沙盒进程拿到独立网络命名空间，原本的网络被移除；seccomp 封 Unix socket（除非显式允许）。
- 约束作用于**整棵进程树**。

### 网络

- 默认 deny，只放行 `network.allowedDomains`；`deniedDomains` 先判。
- 流量走宿主侧代理：HTTP/HTTPS 走 HTTP 代理，其他 TCP 走 SOCKS5。
- 域名支持通配（`*.example.com`）、端口（`api.example.com:443`）、IPv6 字面量。
- **代理会做解析后地址检查**：拒绝 loopback、link-local、multicast、云 metadata 地址等危险段（防 SSRF）。私有网段默认**不**拒，因为内网主机可能是合法的。

### 文件系统默认值

- 读：默认很宽（整机），除非配 `denyRead`。
- 写：默认只在工作目录、每用户临时目录、额外添加的目录；`denyWrite` 优先于 `allowWrite`；读侧 `allowRead` 优先于 `denyRead`。
- 凭据文件和环境变量可以 `deny`（阻止读取 / unset）或 `mask`（替换成哨兵值，需要 TLS 终止配合）。
- 沙盒路径和权限规则的路径/域名会**合并**成最终配置。

### 局限（官方明说）

- **只管 shell**。内置 Read/Write/WebFetch、hooks、MCP server、LSP、plugin monitor 都在沙盒外跑。
- 只有遵守 proxy 环境变量的工具能联网；SSH、很多数据库驱动、UDP、QUIC、ICMP 出不去。
- Docker 不兼容；`watchman` 会让 Jest 挂。
- 依赖缺失时默认**回退成不沙盒执行**（除非 `failIfUnavailable: true`）。这是个危险默认值。
- 代理默认**不终止 TLS**，只按域名放行。

### 逃逸口

模型可以请求 `dangerouslyDisableSandbox` 做一次「非沙盒重试」；`allowUnsandboxedCommands: false` 关掉它。`excludedCommands`（如 `docker compose *`）在沙盒外跑。

## 可以抄进 OmniAgent 的

1. **规则求值按类别而非按精度**（已实现）。
2. **复合命令拆解 + wrapper 剥离**（已实现于 `permissions/bash.ts`）。
3. **路径前缀语义**（已实现于 `resolveRulePath`）。
4. **拒绝参数匹配主内容字段**这条克制：我们也只匹配 `path` / `command`，不做通用参数匹配。
5. **沙盒直接复用 `@anthropic-ai/sandbox-runtime`**：M3 的首选路径，比自己啃 Seatbelt profile 语法省一个月。
6. **代理做解析后地址检查**：等 M3 做网络策略时再抄，现在别提前。

## 不抄的

- `auto` 分类器模式（需要 eval harness 才能评估）。
- `mask` 凭据（要 TLS 终止，复杂度远超收益）。
- 默认「依赖缺失就退回不沙盒」的危险行为——我们改成 fail closed。
