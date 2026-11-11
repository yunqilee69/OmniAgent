# 开发与扩展指南

本文面向准备修改 OmniAgent 的开发者，说明环境、命令、代码约定、常见扩展路径和排查方法。设计细节见 [design/](design/)，模块地图见 [implementation/core.md](implementation/core.md)。

## 1. 环境要求

- Node.js >= 22.19.0；
- pnpm 10.17.0（`packageManager` 已固定）；
- macOS 或 Linux；Windows 可用于 `danger-full-access`，但受限沙盒会 fail closed。

```bash
pnpm install
```

`postinstall` 会在 Linux 上调用 `scripts/prepare-linux-sandbox.ts`，尝试探测或安装 bubblewrap；macOS 等平台直接跳过。TUI 和 Web 启动时也会再准备一次。自动准备失败不会阻断应用，但没有可用受限后端时 shell 仍会 fail closed。

## 2. 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 直接运行 TUI |
| `pnpm web` | 构建 Web UI 并在 `http://127.0.0.1:4317` 启动 Host |
| `pnpm web:build` | 只构建 Web UI |
| `pnpm web:dev` | Vite HMR，端口 4318，`/api` 代理到 4317 |
| `pnpm web:serve` | 只启动 Host，不构建 |
| `pnpm test` | 运行全部测试 |
| `pnpm test:watch` | 监听模式 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm eval` | 运行 eval 套件 |
| `pnpm eval -- --keep` | 失败时保留临时工作区 |

端口：

- Web Host：`web.port`（默认 4317），`OMNIAGENT_PORT` 覆盖；
- Vite dev：4318。

Web 认证默认关闭。需要时在 `config.json` 中设置 `web.auth.enabled`、`username`、`password`，重启 Host 后生效；账号密码明文保存，建议 `chmod 600 ~/.omniagent/config.json`。

## 3. 配置

首次运行前：

```bash
cp config.example.json ~/.omniagent/config.json
```

然后：

- 填写 `providers` 中的 API key 或 `apiKeyEnv`；
- 确认 `model` / `provider` 指向存在的模型；
- 需要 Web 模式时检查 `~/.omniagent/modes.json`（可选）；
- 需要自定义智能体时在 `~/.omniagent/agents/` 写 `<id>.md`。

没有 provider 时：

- 应用会使用 `FakeModel` 演示流程；
- 不会产生真实模型调用；
- 适合跑测试和前端开发。

### 3.1 目录

```text
~/.omniagent/
├── config.json          providers / models / roles / profiles / 默认权限 / MCP / web
├── modes.json           Web 模式预设
├── agents/              智能体定义
├── sessions/            会话 JSONL
├── schedules.json       计划任务
├── workspaces.json      Web 工作区（含默认工作区）
├── default-workspace/   Web 默认工作区
└── web-audit/           Web 审计

~/.omniagent-attachments/<batch>/                Web 附件（图片 / 文件 / 文本）
/var/tmp/omniagent-attachments-<uid>/<batch>/     home 不可用时的备选
```

TUI 的审计在 `<workspace>/.omniagent/audit.jsonl`。附件批次由 Web 回合创建；在写入用户消息前失败或取消的回合会自动清理，成功写入后批次保留，需用户自行清理。

## 4. 代码约定

### 4.1 TypeScript

- strict；
- `noUncheckedIndexedAccess: true`；
- `noImplicitOverride: true`；
- `verbatimModuleSyntax: true`：类型导入必须用 `import type`；
- `allowImportingTsExtensions: true`：相对导入可以带 `.ts`；
- `noEmit: true`：运行时用 tsx / Vite，不做 tsc 编译。

### 4.2 导入

- 包内相对导入；
- 包边界只通过 `src/index.ts`；
- 不要在模块之间 `export *` 满天飞；
- TUI / Web 通过 `@omniagent/core` 导入，不直接跨包引用内部文件。

### 4.3 命名

- 文件名 kebab-case；
- 类型 PascalCase；
- 函数 / 变量 camelCase；
- 工具名 snake_case（与模型契约一致）；
- 事件类型 `noun.verb` 或 `noun/path` 风格，参考现有事件。

### 4.4 错误处理

- 工具错误 → 返回 `ok:false` 的 `ToolOutput`，不要抛穿主循环；
- 配置 / schema 错误 → 明确失败，不回退旧值；
- 前端 HTTP 错误 → `HttpError(status, message)`；
- 内部异常 → 脱敏后返回固定文案，原始错误只写本地日志 / trace 固定文案。

### 4.5 注释

- 注释解释「为什么」和「约束」，不解释「这行在做什么」；
- 安全边界、approval、fail-closed 等不变量必须有注释；
- 不要写与代码同步会过时的注释。

## 5. 常见扩展

### 5.1 新增工具

1. 在 `packages/core/src/tools/builtin/` 新建文件。
2. 用 zod 定义 `.strict()` 参数。
3. 实现 `execute(args, ctx)`，返回 `ToolOutput`。
4. 在 `tools/builtin/index.ts` 导出。
5. 在 `tools/index.ts` 的 `createDefaultRegistry()` 注册，或在 `Session` 中按会话注入。
6. 在 `tools/names.ts` 加常量并加入 `KNOWN_TOOL_NAMES`。
7. 如果工具会写文件 / 执行命令，接入 `checkDshMutation` / `confineDshArgv`。
8. 更新 TUI `tools.ts` 的展示；如需要轨迹，更新 `web/src/trajectory.ts` 白名单。
9. 加单元测试。

### 5.2 新增 provider

1. 在 `config/load.ts` 的 `api` 枚举中加协议。
2. 在 `providers/create.ts` 加分支。
3. 实现 `ModelClient`：

   ```ts
   interface ModelClient {
     readonly name: string;
     complete(request: ModelRequest): Promise<ModelResponse>;
     stream?(request: ModelRequest): AsyncGenerator<ModelStreamDelta, ModelResponse>;
   }
   ```

4. 处理：
   - system / user / assistant / tool 消息转换；
   - tool calls 分片累积；
   - usage；
   - stop reason；
   - reasoning effort wire；
   - provider replay（如果需要精确重放）。
5. 在 `config/models.ts` 生成 descriptor。
6. 加测试：请求体、流解析、错误分类、replay 降级。

### 5.3 新增智能体

在 `~/.omniagent/agents/` 写：

```markdown
---
name: Explorer
description: 只读搜索和代码探索
role: quick
usage: subagent
profile: search-only
---

你是一个探索型智能体。只做只读调查，把结构化结论返回给父智能体。
```

- `role` 必须存在于 `config.roles`；
- `profile` 必须存在于 `config.agentProfiles`；
- `usage` 决定能否作为主智能体 / 子代理；
- 正文就是 system prompt。

验证：

```bash
curl -s http://127.0.0.1:4317/api/agents | jq
```

### 5.4 新增模式

在 Web 设置 → 模式，或直接编辑 `~/.omniagent/modes.json`：

```json
{
  "version": 1,
  "defaultMode": "standard",
  "modes": {
    "readonly": {
      "name": "只读",
      "agent": "default",
      "tools": ["read_file", "list_dir", "glob", "grep"],
      "skills": ["docs"]
    }
  }
}
```

- 模式只影响新会话；
- agent / tools / skills 在创建时固化；
- 模型仍可在会话内切换。

### 5.5 新增 skill

在工作区创建：

```text
.agents/skills/my-skill/SKILL.md
```

或扁平文件：

```text
.agents/skills/my-skill.md
```

frontmatter 可选：

```markdown
---
name: my-skill
description: 一句话说明
---

完整说明...
```

- 目录注入系统提示的是 name + description；
- 完整正文通过 `skill` 工具加载；
- 文件最大 1 MiB；
- 同名时工作区优先于用户目录。

### 5.6 新增 Web 路由

1. 在 `packages/web/src/server.ts` 加分支。
2. 使用 `readJson()` 和 `json()`。
3. 涉及配置写入时走 Settings 服务。
4. 涉及运行中会话时检查 `running` / `withPermissionLock`，必要时返回 409。
5. 更新 `docs/web-api.md`。
6. 加 route 测试或 `server-contract.test.ts`。

### 5.7 新增 Web 页面

1. `SettingsPage.tsx` 的 rail 加 tab，或 `app.tsx` 加 tab。
2. 新建组件。
3. 在 `store.ts` 加加载 / 保存 action。
4. 样式放 CSS Modules。
5. 文案加到 `i18n.ts`。
6. 加 `ui-store.test.ts` / `ui-protocol.test.ts`。

### 5.8 新增 TUI 命令

1. `main.ts` 的 REPL 分支加解析。
2. 更新 `blocks.ts` 的帮助。
3. 状态变化时 `resetSession()` / `refreshStatus()`。
4. 加 `main.test.ts`。

### 5.9 新增计划任务时间规则

1. `schedule/types.ts` 加类型。
2. `schedule/domain.ts` 加解析 / 规范化 / 下一次 occurrence。
3. `schedule/update.ts` 加编辑重算。
4. `schedule/service.ts` 加校验。
5. Web API 和模型工具按需暴露。
6. 加 `schedule.test.ts` 覆盖 DST、边界和非法输入。

## 6. 调试

### 6.1 TUI

```bash
pnpm dev
```

- `/help` 查看命令；
- `/sessions` 查看会话；
- `/permission workspace-write` 切换权限；
- `/verbose` 展开工具输出；
- `NO_COLOR=1 pnpm dev` 关闭颜色；
- `FORCE_COLOR=1 pnpm dev | cat` 在管道里强制颜色。

### 6.2 Web

```bash
pnpm web          # 构建 + Host
pnpm web:dev      # 另开终端，HMR
```

- `/health` 检查 Host；
- 浏览器 DevTools 看 SSE；
- `OMNIAGENT_PORT=4320 pnpm web:serve` 换端口。

### 6.3 查看会话

```bash
find ~/.omniagent/sessions -name session.jsonl
tail -n 20 <path> | jq -c '.type'
```

不要手工编辑会话文件。需要重置时删除整个会话目录，并确保没有进程正在使用。

### 6.4 查看计划任务

```bash
jq . ~/.omniagent/schedules.json
```

### 6.5 模型调用失败

检查：

- `apiKeyEnv` 对应的环境变量是否存在；
- provider 的 `api` / `baseURL` 是否正确；
- 模型 id 是否在 `models` 中；
- reasoning effort 是否被模型支持；
- 是否被配置为 `fake`；
- Web 设置页的「测试连接」是否通过（MCP 也适用）。

### 6.6 权限拒绝

检查：

- 会话是否有 `permission/dsh-preset`；
- preset 是否比预期更窄；
- agent profile / mode 是否允许该工具；
- 工具是否在 trusted 集合；
- 路径是否在可写根内；
- 是否通过 symlink / 硬链接逃逸；
- shell 后端是否可用（`bwrap` / `sandbox-exec` / Landlock）。

### 6.7 前端状态异常

- 刷新页面，让 `loadDetail()` 与服务器对账；
- 检查 SSE 是否在 `turn.end` 后仍有事件；
- 检查 `approval` 是否在断线后仍显示；
- 检查 localStorage 中的 composerDraft / queue / activeSessions；
- 用 `pnpm test -- ui-store ui-protocol` 跑前端状态测试。

## 7. 安全评审清单

修改以下内容时，按清单自查：

**权限**

- 新工具是否在受限预设下 trusted？如果否，是否应该被拒绝？
- 是否允许通过参数请求更宽沙盒？是否只允许严格更宽？
- 审批是否只生效一次？是否从参数中剥离？
- 缺少权限快照时是否 fail closed？

**文件**

- 是否解析物理路径？
- 是否拒绝 symlink 逃逸？
- 是否拒绝硬链接目标？
- 是否保留原文件 mode？
- 是否使用原子写？

**Shell**

- 是否经过 `confineDshArgv`？
- 是否清洗危险环境变量？
- 是否使用进程组终止？
- 无可用后端时是否拒绝执行？

**Web**

- 是否校验 Host / Origin？
- 认证开启时，新路由是否落在 `/api/*` 的 cookie 保护内？
- 是否限制请求体大小？
- 是否校验 Content-Type？
- 是否对 500 脱敏？
- 是否在运行中拒绝权限 / agent / model / plan 变更？
- 是否避免返回 API key、headers、argsDigest、规则文本、认证密码？
- 附件是否写入工作区外、校验权限和 symlink、失败时清理？

**持久化**

- 是否使用临时文件 + fsync + rename？
- 是否在锁内重新读取？
- 是否校验元数据？
- 新文件是否 `0600`、新目录 `0700`？
- 是否避免把敏感内容写进 trace / 导出？

## 8. 文档维护

- 行为变化 → 更新对应 `docs/design/*.md`。
- 路由变化 → 更新 `docs/web-api.md`。
- 配置 / agent / mode 规则变化 → 更新 `docs/agents.md`。
- 安全边界变化 → 更新根 README 的「已知边界」和 `docs/design/tools-permissions-sandbox.md`。
- 新增文档 → 在 `docs/README.md` 的文档地图中登记。
- 文档中的代码引用使用 `path:line`，重构后尽量同步。

## 9. 已知限制

- Windows 上没有受限文件沙盒；`read-only` / `workspace-write` 会 fail closed。
- Linux 的 Landlock 后备已在 x86-64 验证；bubblewrap 和其他原生架构仍需真实 Linux 主机验证。
- 会话 append 每次复制整个日志，长会话写入成本线性增长。
- 工作区注册表只保证单进程写入，没有 fsync。
- 自动压缩没有真实摘要，且不持久化。
- `wait_agent` 等待调用者下一步输入，不是等待子代理完成。
- 计划任务错过的触发只补最近一次，崩溃可能重复投递。
- Web 认证默认关闭；启用后也只保护 HTTP 访问，不能隔离同 OS 用户的其他进程，且使用明文配置和 HTTP 传输。
- 附件保存在工作区外，成功回合不会自动清理。
- MCP 工具不受本地沙盒约束，必须信任服务器配置。
- agent profile / mode 的 allowlist 只减少暴露面，不授予权限。
- 不支持图片的模型会把图片投影为文本占位；历史中仍保留图片字节。
