# 工具、权限与沙盒

本文说明模型能调用什么、调用如何被授权、授权如何被真正执行。实现位置：

- 工具契约与注册表：`packages/core/src/domain/tool.ts`、`packages/core/src/tools/tool.ts`、`registry.ts`
- 内置工具：`packages/core/src/tools/builtin/`
- 权限预设：`packages/core/src/permissions/dsh-permissions.ts`
- 升级审批：`packages/core/src/permissions/dsh-escalation.ts`、`session.ts`
- 文件围栏与 shell 沙盒：`packages/core/src/sandbox/`

## 1. 工具契约

```ts
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema，发给模型
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodType;
  readonly mutating: boolean;
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface ToolOutput {
  content: string;
  ok?: boolean;
  truncated?: boolean;
}
```

`parameters` 同时用于两件事：

- `z.toJSONSchema()` 生成发给模型的 JSON Schema；
- 执行前 `safeParse` 做运行时校验。

`mutating` 是描述性字段，当前权限执行路径**不读取它**；真正决定写权限的是工具名和 DSH 预设。

## 2. 注册表与执行器

`ToolRegistry`（`tools/registry.ts`）是一个简单的 `Map<string, Tool>`：

- `register()` 对重名抛错；
- `get()` / `has()` / `list()` / `specs()`。

`ToolExecutor`（`exec/executor.ts`）保证工具异常不会穿透主循环：

| 情况 | 结果 |
| --- | --- |
| 工具不存在 | `ok:false`，内容说明未知工具 |
| 参数 schema 校验失败 | `ok:false`，内容包含校验错误 |
| `execute()` 抛异常 | `ok:false`，内容包含异常信息 |
| 正常返回 | `ok` 默认为 `true`，填充耗时 |

所有工具输出都会经过 `truncateOutput()`：

- 默认上限 `MAX_OUTPUT_CHARS = 30_000`；
- 保留头 70%、尾 20%；
- 中间插入「已截断 N 个字符」；
- 返回 `truncated: true`。

## 3. 内置工具

### 3.1 默认注册表

`createDefaultRegistry()`（`tools/index.ts:10-16`）只注册无状态工具：

`read_file`、`write_file`、`edit_file`、`list_dir`、`grep`、`glob`、`skill`、`web_fetch`。

会话相关工具由 `Session` 根据权限和 profile 追加：

`bash`、`todo_write`、`exit_plan_mode`、`get_goal`、`create_goal`、`update_goal`、`subagent`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、`schedule_*`、`list_agent_definitions`、`write_agent_definition`。

### 3.2 文件与搜索

| 工具 | 行为 | 关键限制 |
| --- | --- | --- |
| `read_file` | 读取工作区文件，支持 offset / limit | 默认 / 单次最多 2,000 行；单行最多 2,000 字符；选中内容最多 50 KiB；≥10 MiB 走流式；拒绝 binary 和非 UTF-8 |
| `write_file` | 原子写入文件 | 目标必须在可写根内；保留原文件 mode；拒绝硬链接目标；同路径进程内串行 |
| `edit_file` | 字面量替换 | `old_string` 必须唯一，除非 `replace_all`；拒绝 binary；保留 CRLF/LF 风格 |
| `list_dir` | 列目录 | 忽略 `node_modules`、`.git`、`dist`、`.omniagent`；最多 10,000 条 |
| `glob` | 按 pattern 找文件 | 使用打包的 ripgrep；最多 100 条；排除 VCS 元数据；按修改时间排序 |
| `grep` | 按正则搜索 | 最多 250 条匹配；单行预览最多 2,000 字节；`include` 不允许负向 glob 或逗号列表 |

所有路径工具都会：

- 先用词法 `resolveInside` 计算展示路径；
- 再用 `resolveInsidePhysical` 解析真实路径，拒绝 symlink 逃逸；
- 在 `read_file` / `list_dir` / `glob` / `grep` 中始终执行工作区围栏，即使是 `danger-full-access`。

### 3.3 网络

`web_fetch`：

- 只允许 `http:` / `https:`，拒绝 URL 内凭据；
- 每个重定向 hop 都做 SSRF 检查，拒绝回环、私有、链路本地、CGNAT、组播和保留地址；
- 默认不允许私有主机（`allowPrivateHosts` 关闭）；
- 跨源重定向不自动跟随，只允许同源；
- 响应体最多 5 MB，正文最多 100,000 字符，完整输出最多 200,000 字符；
- 超时 30 秒，最多 5 次重定向；
- 只接受文本类 content type；
- HTML 经 turndown 转 Markdown，转换失败时省略正文；
- 输出带 `EXTERNAL_WEB_CONTENT_NOTICE`，提醒模型这是不可信数据。

### 3.4 Shell

`bash`：

- 参数：`command`、`timeout_ms?`、`sandbox_permissions?`、`justification?`；
- 默认超时 120 秒，最大 600 秒；
- stdout / stderr 每流默认保留 16,000 字节，最大 4 MiB；
- 通过 `confineDshArgv()` 包装成 Seatbelt / bwrap / Landlock 命令；
- 环境变量清洗：剔除 `KEY|PASSWORD|SECRET|TOKEN`、`DSH_*`、`LD_*`、`DYLD_*`、`BASH_ENV`、`ENV`、`NODE_OPTIONS`；
- 设置 `NO_COLOR=1`、`TERM=dumb`、`PAGER=cat`；
- `workspace-write` 下 spawn 前扫描可写根中的硬链接；
- 进程组 SIGTERM → 500 ms → SIGKILL；
- 非零退出、信号终止、超时或取消 → `ok:false`。

`bash` 的 `sandbox_permissions` / `justification` **不会**直接生效。它们必须由 Session 的 `prepareToolCall` 审批并剥离；如果执行层仍看到这两个字段，会抛 `SANDBOX_ESCALATION_UNPROCESSED`。

### 3.5 会话工具

| 工具 | 说明 |
| --- | --- |
| `skill` | 按名称加载 `SKILL.md` 完整正文；只允许 agent profile 中列出的 skill |
| `todo_write` | 整份替换任务清单，持久化 `todo/write` |
| `exit_plan_mode` | 提交计划并请求审批；只在 plan 模式可用 |
| `get_goal` / `create_goal` / `update_goal` | 目标读取、创建、编辑、暂停、恢复、完成、阻塞 |
| `subagent` / `send_message` / `list_agents` / `wait_agent` / `interrupt_agent` | 子代理协作 |
| `schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit` | 计划任务；主会话可用，子代理不可用 |
| `list_agent_definitions` / `write_agent_definition` | 只在创造模式会话注册 |

## 4. 工具暴露：四层过滤

一个工具能被模型调用，需要同时通过四层：

```text
1. agent / mode allowlist
   ├─ mode 有 tools 时，完全替换 profile.tools（不是取交集）
   └─ subagent 组会展开成 5 个协作工具

2. Session 注册过滤
   ├─ allowsTool(name) 检查 agent.tools
   └─ 只有存在 SessionHandle 时才注册 todo_write

3. 每次调用复查
   └─ prepareToolCall 再查一次 allowlist，防止伪造调用

4. trusted 集合
   ├─ danger-full-access：任意注册工具都 trusted
   ├─ 受限预设：只有会话内置工具和策略包装工具 trusted
   └─ 其他扩展工具 → "No trusted sandbox enforcement for this tool"
```

这意味着：

- allowlist 只是「可见性」；
- 即使模型伪造一个未注册的工具调用，也会在准备阶段被拒绝；
- 在 `read-only` / `workspace-write` 下，第三方注入的任意 Tool 不会被信任，因为它没有对应的沙盒策略；
- MCP 工具是例外：它们在服务器进程执行，不经过本地文件沙盒，因此始终 trusted。

## 5. DSH 权限预设

### 5.1 三个预设

| 预设 | sandbox | approval | 含义 |
| --- | --- | --- | --- |
| `read-only` | `read-only` | `ask` | 文件写入被围栏拒绝；shell 在支持的后端下拒绝写入 |
| `workspace-write` | `workspace-write` | `ask` | 工作区和配置的临时根可写；普通写入不逐次弹窗 |
| `danger-full-access` | `danger-full-access` | `never` | 不应用 DSH 文件沙盒；显式升级请求也不会被自动批准 |

默认预设是 `workspace-write`（新配置未显式设置时）。

### 5.2 事件与投影

权限选择持久化为 `permission/dsh-preset`：

```json
{ "version": 1, "preset": "workspace-write" }
```

`projectDshPermissions()` 的规则：

- 空历史 → `legacy`；
- 数据必须恰好包含 `version` 和 `preset`；
- 最后一个事件决定状态；
- `version === 1` 且 preset 合法 → `ready`；
- 其他 → `invalid`。

`snapshotDshPermissions()` 只接受 `ready`，否则抛 `DSH permission selection is required before execution`。

### 5.3 快照

`Session` 构造时冻结 `{ preset, sandbox, approval }`。普通工具执行不逐次询问用户；只有模型显式请求更宽沙盒时才进入审批。

如果会话没有有效快照，所有工具调用都被拒绝。旧 `mode` / `permissions` 字段不会转成授权。

## 6. 一次性沙盒升级

### 6.1 允许的工具

只有三个工具可以请求更宽沙盒：

- `write_file`
- `edit_file`
- `bash`

其他工具带 `sandbox_permissions` 会被拒绝。

### 6.2 请求条件

`prepareToolCall` 要求：

1. `sandbox_permissions` 和 `justification` 同时出现；
2. target 是合法预设；
3. justification 非空；
4. call id / name 非空；
5. target 严格比当前预设更宽：
   - `read-only` → `workspace-write` 或 `danger-full-access`
   - `workspace-write` → `danger-full-access`
   - 相同或更窄 → 拒绝；
6. 当前 approval 策略是 `ask`，并且注入了审批 handler；
7. 审批结果为 allow。

### 6.3 时序

```text
tool.call
  → prepareToolCall
       ├─ 校验升级请求
       ├─ approve({ id, call, reason })
       │    ├─ TUI: readline 询问
       │    └─ Web: permission.requested SSE + POST /approvals
       ├─ allow: 本次调用使用 target 模式
       └─ deny: 返回 deny observation
  → permission.decided
  → 执行（参数中的 sandbox_permissions / justification 已剥离）
  → tool.result
```

### 6.4 只生效一次

批准不会：

- 修改会话预设；
- 写入 `permission/dsh-preset`；
- 让下一次同类调用自动通过。

下一次需要更宽沙盒的调用必须重新请求。`danger-full-access` 的 approval 是 `never`，因此在该预设下不允许再请求升级。

## 7. 文件围栏

### 7.1 写入检查

`checkDshMutation(path, policy)`（`sandbox/dsh-fs.ts:63-79`）：

| 模式 | 行为 |
| --- | --- |
| `read-only` | 一律 `FS_SANDBOX_DENIED` |
| `danger-full-access` | 原样返回 |
| `workspace-write` + Windows | `SANDBOX_UNAVAILABLE`（无法保证 alias 安全） |
| `workspace-write` + 其他 | 解析物理目标，要求位于工作区或额外可写根下 |

`physicalTarget()`：

- 逐段 `lstat`；
- 遇到的 symlink 立即 `realpath`；
- 缺失的后缀不允许包含 `..`；
- 中间组件必须是目录；最终组件必须是普通文件或目录；
- 最终文件 `nlink > 1` → 拒绝（硬链接别名）；
- 其他 IO 错误 → `FS_SANDBOX_DENIED`。

### 7.2 硬链接预检

`workspace-write` 的 shell 在 spawn 前扫描可写根：

- 最多 100,000 条；
- 不跟随 symlink；
- 普通文件 `nlink > 1` → `SANDBOX_HARDLINK_UNSAFE`；
- 扫描不完整 → `SANDBOX_HARDLINK_CHECK_INCOMPLETE`；
- 不扫描 `/tmp` 或 `$TMPDIR` 中预存的硬链接。

### 7.3 TOCTOU

文件围栏是「检查 → 系统调用」之间的 trusted-code 路径检查，不是原子隔离。攻击者如果在检查后、写入前替换路径，仍可能绕过。文档和代码都明确保留这个窗口。

## 8. Shell 沙盒后端

`sandbox/dsh-sandbox.ts`：

| 平台 | 后端 | 行为 |
| --- | --- | --- |
| macOS | Seatbelt (`/usr/bin/sandbox-exec`) | 只读 profile + 可写根白名单；拒绝 `operation not permitted` |
| Linux | bubblewrap (`/usr/bin/bwrap`) | `--ro-bind / /` + `--bind` 可写根；拒绝 `read-only file system` |
| Linux | Landlock launcher | 由宿主配置绝对路径；`--probe` 输出 `landlock: fully enforced` 才启用 |
| Windows | 无 | `danger-full-access` 可用；受限预设 fail closed |

探测：

- macOS：用只读 seatbelt profile 跑 `/usr/bin/true`；
- Linux：先探测 bwrap，再探测配置的 Landlock launcher；
- 探测只证明可用性，不证明二进制真实性；
- 没有可用后端 → `DshSandboxUnavailableError`，拒绝无约束执行。

### 8.1 沙盒不做什么

- 不隔离网络；
- 不限制所有读取（进程可以读当前 OS 用户能读的文件）；
- 不是容器或 VM；
- 不阻止访问 loopback Web 控制面；
- 进程组清理可能被故意 `setsid` 的后代逃逸。

## 9. MCP 工具的信任模型

MCP 工具：

- 在 MCP server 进程中执行；
- 不经过本地文件围栏或 shell 沙盒；
- 因此被视为 trusted，即使在 `read-only` 下也可调用；
- 服务器配置是用户编写的，必须自行信任；
- 工具名暴露为 `mcp__<server>__<tool>`；
- 受限 agent profile / mode 必须显式列出完整名称或使用 `"*"`。

MCP 结果会被扁平化为文本：文本保留，图片 / 音频 / 资源变成元信息占位，`structuredContent` 追加为 JSON，`isError` 映射为 `ok:false`。

## 10. 安全边界总结

**能防住**

- 模型伪造未授权工具调用；
- 在 `read-only` / `workspace-write` 下写入工作区外路径；
- 通过 symlink 逃逸工作区；
- 通过已有硬链接目标写入外部文件；
- shell 在受限模式下写入不可写路径（在支持的后端上）；
- 模型在 `danger-full-access` 之外静默扩大沙盒。

**防不住**

- 检查与系统调用之间的 TOCTOU；
- 同 OS 用户的其他进程；
- 受限 shell 读取当前用户可读的文件；
- 受限 shell 访问网络或 loopback 服务；
- MCP 服务器自身的行为；
- 恶意 skill 文本对模型的提示注入（它只是模型上下文，不是可信指令）。

## 11. 新增工具的检查清单

1. 在 `tools/builtin/` 实现 `Tool`，参数用 `.strict()` 的 zod schema。
2. 在 `tools/index.ts` 注册默认工具，或在 `Session` 中按会话注入。
3. 在 `tools/names.ts` 增加名称常量并加入 `KNOWN_TOOL_NAMES`，否则 profile / mode 校验会拒绝。
4. 判断它是否 `mutating`。注意：`mutating` 目前只是描述字段，不参与授权。
5. 如果它会写文件或执行命令，必须走 `checkDshMutation` 或 `confineDshArgv`，并考虑是否需要加入 trusted 集合。
6. 如果它是只读工具，仍然要解析物理路径，拒绝 symlink 越界。
7. 控制输出大小，使用 `truncateOutput`。
8. 为它补单元测试，覆盖参数校验、路径逃逸、权限拒绝和超限。
9. 如果它应该出现在 TUI 工具卡摘要中，更新 `packages/tui/src/tools.ts` 的 `PRESENTATION`。
10. 如果它需要出现在 Web 轨迹白名单中，更新 `packages/web/src/trajectory.ts` 的 `TRAJECTORY_TOOL_NAMES`。
