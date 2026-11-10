# 测试与 eval

OmniAgent 的测试分三层：

1. **单元测试**：模块边界内的纯函数、解析、校验、状态机。
2. **集成测试**：真实 `Session` + FakeModel + 临时工作区，验证循环、权限、工具、持久化协同。
3. **eval harness**：把「agent 遇到某任务应该做什么」写成可重复、可断言的用例集。

## 1. 命令

```bash
pnpm test          # vitest run
pnpm test:watch    # vitest watch
pnpm typecheck     # tsc --noEmit
pnpm eval          # 运行内置 eval 套件
pnpm eval -- --keep  # 失败时保留临时工作区
```

Vitest 配置：

- 入口：`vitest.config.ts`；
- 包含：`packages/*/src/**/*.test.ts`；
- 别名：`@omniagent/core` → `packages/core/src/index.ts`。

TypeScript 配置是 strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`。测试代码也受同一套类型检查约束。

## 2. 测试布局

测试与源码同目录，文件名 `*.test.ts`。

### 2.1 core

| 区域 | 测试 |
| --- | --- |
| 主循环 | `loop/agent-loop.test.ts` |
| Session | `session.test.ts`、`session-agent.test.ts`、`session-continuation.test.ts`、`session-dsh-permissions.test.ts`、`session-goal.test.ts`、`session-plan.test.ts`、`session-title.test.ts`、`session-todo.test.ts` |
| 会话子模块 | `session/agent-selection.test.ts`、`goal.test.ts`、`init-command.test.ts`、`mode-selection.test.ts`、`model-binding.test.ts`、`model-replay.test.ts`、`ownership.test.ts`、`plan.test.ts`、`projection.test.ts`、`runtime.test.ts`、`session-management.test.ts`、`store.test.ts`、`todo.test.ts` |
| 配置 | `config/dsh-config.test.ts`、`models.test.ts`、`store.test.ts`、`web-config.test.ts` |
| 智能体 | `agents/catalog.test.ts`、`authoring.test.ts` |
| 模式 | `modes/store.test.ts` |
| Provider | `providers/dsh-deepseek.test.ts`、`dsh-registry.test.ts`、`openai.test.ts`、`pi-model.test.ts` |
| 工具 | `tools/builtin/fs-tools.test.ts`、`search.test.ts`、`skill.test.ts`、`web-fetch.test.ts`、`dsh-shell.test.ts`、`tools/attachment-storage.test.ts`、`tools/paths.test.ts` |
| 权限 | `permissions/dsh-permissions.test.ts`、`dsh-escalation.test.ts` |
| 沙盒 | `sandbox/dsh-fs.test.ts`、`dsh-sandbox.test.ts`、`dsh-sandbox-prepare.test.ts`、`runner.test.ts` |
| 持久化 | `store/audit.test.ts`、`session/store.test.ts` |
| 子代理 | `subagents/runtime-manager.test.ts` |
| 计划任务 | `schedule/schedule.test.ts` |
| MCP | `mcp/config.test.ts`、`mcp/service.test.ts` |
| 压缩 / 投影 | `context/compaction.test.ts`、`context/projection.test.ts` |
| 执行器 | `exec/executor.test.ts` |
| 集成 | `dsh-runtime.integration.test.ts` |

### 2.2 TUI

| 文件 | 覆盖 |
| --- | --- |
| `main.test.ts` | 命令解析、会话切换、模型选择 |
| `sandbox-startup.test.ts` | 启动沙盒准备顺序与失败诊断 |
| `render.test.ts` | 事件 → 终端输出、块间距、工具卡、状态行 |
| `blocks.test.ts` | 纯文本构建、调色板角色 |

### 2.3 Web

| 文件 | 覆盖 |
| --- | --- |
| `server.test.ts` | 路由、SSE、异步 follow、会话生命周期 |
| `server-contract.test.ts` | API 契约 |
| `auth.test.ts` / `ui-auth.test.ts` | 登录 cookie、限流、401 与前端认证状态 |
| `attachments.test.ts` | 附件解析、大小限制、批次清理 |
| `session-metrics.test.ts` / `session-metrics-live.test.ts` | 指标投影与流式增量 |
| `approval.test.ts` / `approval-route.test.ts` | 审批代理与 HTTP 回填 |
| `permissions.test.ts` / `dsh-permission-route.test.ts` | 默认权限设置 |
| `model-settings.test.ts` / `model-route.test.ts` / `model-sources-route.test.ts` | 模型来源与角色 |
| `catalog-settings.test.ts` | 角色目录 |
| `mcp-settings.test.ts` / `mcp-route.test.ts` | MCP 设置 |
| `agent-settings-route.test.ts` | 智能体定义 |
| `schedule-route.test.ts` | 计划任务路由 |
| `session-export.test.ts` / `export-route.test.ts` | 导出 |
| `trajectory.test.ts` / `trajectory-route.test.ts` | 轨迹 |
| `trace-projection.test.ts` | trace 投影 |
| `model-picker.test.ts` | 模型选择器 |
| `workspaces.test.ts` / `workspace-files.test.ts` | 工作区注册、文件搜索、目录浏览与预览 |
| `workspace-file-ui.test.ts` | 文件树 / 预览组件 |
| `sidebar.test.ts` | 多工作区侧栏、默认工作区不可移除 |
| `header-trajectory.test.ts` | Header 状态与轨迹入口 |
| `context-meter.test.ts` | `/context` 估算路由 |
| `todo-dock.test.ts` | 底部 todo 状态 |
| `ui-store.test.ts` / `ui-protocol.test.ts` | 前端状态仓库、run snapshot、事件 reducer |
| `composer-trigger.test.ts` / `matcher.test.ts` | Composer 触发器与 LIKE 匹配 |
| `i18n.test.ts` | 翻译 key |
| `audit.test.ts` | Web 审计 |

## 3. 常见测试模式

### 3.1 临时目录

涉及文件系统的测试使用 `mkdtemp()` 创建临时工作区，结束后清理。不要写用户真实目录。

### 3.2 FakeModel

`FakeModel` 是剧本化模型：

```ts
const model = new FakeModel([
  toolCallResponse([{ name: 'read_file', args: { file_path: 'a.txt' } }]),
  textResponse('完成'),
]);
```

- `complete()` 按顺序消费步骤；
- `stream()` 复用 `complete()`，把文本 / 思考切成 8 字符块；
- 步骤用尽且没有 `onExhausted` 时抛错；
- 记录每次 `ModelRequest`，可用于断言历史。

### 3.3 真实 Session

集成测试通常直接构造 `Session`：

```ts
const session = new Session({
  cwd: workspace,
  model,
  modelId: model.name,
  dshPermissions: snapshot,
  audit,
  // ...
});
for await (const event of session.send('开始')) {
  events.push(event);
}
```

这比走 HTTP 更快，也更容易断言事件顺序。

### 3.4 HTTP 契约测试

Web 路由测试通常：

1. 启动 host 到随机端口；
2. 用 `fetch` 发请求；
3. 断言状态码、响应体和 SSE 帧。

`server-contract.test.ts` 是路由形状的回归网；新增路由时优先补契约测试。

### 3.5 权限测试

权限测试要区分两件事：

- **决策**：`permission.decided` 是 allow / deny；
- **实际效果**：只读预设下 `write_file` 可能 `decision: allow`，但文件系统围栏让它返回失败。

例如 `basicSuite` 的「只读预设阻止写文件」断言 `decisions: ['allow']` 和 `absentFiles: ['secret.txt']`。这不是矛盾：DSH 工具准入允许调用，但真实写入被围栏拒绝。

### 3.6 平台相关测试

- 使用 `it.runIf(...)` / `describe.runIf(...)`，不要假设 Linux 路径语义在 macOS 成立；
- `sandbox/dsh-sandbox.test.ts` 的 `/tmp` 遮蔽用例只在 `/tmp` 是物理路径时运行：macOS 的 `/tmp` 解析为 `/private/tmp`，物理根不可能位于字面量 `/tmp` 之下；
- 原生 Landlock 测试需要 `OMNI_TEST_LANDLOCK=1` 和真实 Linux 主机；
- Seatbelt 测试可以模拟 `platform: 'darwin'`，但实际执行仍需 macOS。

### 3.7 异步回合测试

`Prefer: respond-async` + `GET .../follow` 的测试通常：

1. 用可控 FakeModel / 延迟第一步，让 turn 保持在运行中；
2. POST 消息并断言 `202`；
3. GET follow，解析首帧 `run.snapshot`，断言 baseline 消息 / 指标和已发生事件；
4. 继续推进模型，断言 follower 收到后续事件和 `turn.end`；
5. 断开 POST / follower，断言服务端回合继续并在结束后清理 running 状态。

## 4. eval harness

### 4.1 生命周期

`runEvalCase()`（`eval/harness.ts:105-160`）：

1. `mkdtemp(tmpdir()/omniagent-eval-)`；
2. 用 `resolveInside(workspace, path)` 写 fixture；
3. 有 `steps` → `FakeModel`；否则使用传入的 `model`；
4. 用 `permissionPreset` 生成 DSH 快照；
5. 构造 `Session`；
6. 依次 `send(input)`，收集事件；
7. 断言；
8. 除非 `keepWorkspace`，删除工作区。

`EvalCase` 字段：

```ts
{
  name: string,
  files?: Record<string, string>,
  input?: string | string[],       // 默认 ['开始']
  steps?: FakeStep[],              // FakeModel 剧本
  permissionPreset?: DshPermissionPreset,
  approve?: (request) => ApprovalResponse,
  expect: {
    stopReason?,
    tools?,
    decisions?,
    finalText?: string | RegExp,
    files?: Record<string, string | RegExp | ((content) => boolean)>,
    absentFiles?: string[]
  }
}
```

`permissionPreset` 是唯一授权来源；未指定预设时工具调用会被拒绝。旧的 `mode` / `permissions` 字段已从 `EvalCase` 类型中移除。

### 4.2 断言

`checkExpectations()`：

| 断言 | 规则 |
| --- | --- |
| `stopReason` | 最后一个 `turn.end.reason` |
| `tools` | 所有 `tool.call.name` 的顺序和数量完全一致 |
| `decisions` | 所有 `permission.decided.decision` 的顺序一致 |
| `finalText` | 最后一条 assistant 文本；字符串精确匹配，正则 `test()` |
| `files` | 文件内容精确匹配 / 正则 / 函数 |
| `absentFiles` | 文件必须不存在 |

任何 `error` 事件立即记为失败。所有失败累积到 `failures[]`，`passed = failures.length === 0`。

### 4.3 新增 case

1. 在 `eval/suites/basic.ts` 追加，或新建 suite 文件导出 `EvalCase[]`。
2. 如果新建 suite，在 `eval/run.ts` 里接入；当前 CLI 只跑 `basicSuite`。
3. 优先用 `FakeModel` 测循环 / 权限；真实模型用 `runEvalCase(case, { model })`。
4. 失败调试时用 `{ keepWorkspace: true }` 或 `pnpm eval -- --keep`。
5. 权限 case 必须显式设置 `permissionPreset`。

### 4.4 两种 eval

**能力 eval**

- 任务能不能完成；
- 断言工具调用、文件内容、最终回答；
- 真实模型有随机性，要跑多次看通过率。

**权限 eval**

- 验证 DSH 预设、一次性审批和沙盒围栏在允许与拒绝场景中的实际行为；
- 重点检查不应放行的调用，以及只读 / workspace-write 下写入是否真的被围栏拒绝；
- 需要分类器指标时再引入标注用例，当前 harness 不做混淆矩阵。

当前 harness 覆盖能力和权限决策，也可以通过文件断言验证沙盒结果。设计细节见 [spec/eval-harness.md](../spec/eval-harness.md)。

## 5. 写新测试的检查清单

**改核心逻辑**

- 单元测试覆盖纯函数和状态转换；
- 集成测试覆盖至少一条完整 turn；
- 如果改变事件顺序，更新 `agent-loop.test.ts`；
- 如果改变持久化格式，更新 `session/store.test.ts` 和 `session/projection.test.ts`；
- 如果改变权限行为，更新 `session-dsh-permissions.test.ts`。

**改工具**

- 参数校验：缺字段、错类型、额外字段；
- 路径安全：`..`、symlink、硬链接；
- 输出限制：超长、截断标记；
- 权限：只读 / workspace-write / danger 下的行为；
- 错误：工具抛异常时仍是 `ok:false`。

**改 Web**

- 路由状态码：200 / 201 / 202 / 400 / 404 / 409；
- 请求体非法、超限、Content-Type 错误；
- SSE 事件顺序；
- 审批超时 / 断线 / 重复请求；
- 设置写入后的持久化和外部修改检测。

**改 TUI**

- 命令解析和错误提示；
- 事件 → 输出快照；
- 块间距和颜色角色；
- 非 TTY / `NO_COLOR` 行为。

**改配置 / agent / mode**

- 非法 JSON / schema；
- 未知 role / profile / model；
- 不支持的 effort；
- 内容哈希 revision；
- fail-closed 不返回旧配置。

## 6. 验证流程

在提交前至少运行：

```bash
pnpm typecheck
pnpm test
```

如果改动了 agent 行为或权限，再运行：

```bash
pnpm eval
```

如果改动了 Web UI，启动：

```bash
pnpm web:dev   # Vite HMR
pnpm web:serve # 另一个终端
```

推荐手工检查：

- 新建会话 → 选择模式 → 发送消息；
- 工具调用 → 审批 → 结果；
- plan 模式 → 提交计划 → 审批 / 拒绝；
- 切换权限 / agent / model；
- 刷新页面后会话恢复；
- 导出 Markdown / JSON；
- 计划任务创建 / 立即运行 / 历史。

## 7. 常见陷阱

- **只测 HTTP 200，不测 SSE 事件顺序**：前端依赖顺序，尤其是 `tool.call` → `permission.requested` → `permission.decided`。
- **只测同步 SSE**：Web 现在默认使用 `Prefer: respond-async` + `follow`；异步启动失败会用 `500` + 特殊 code 表达「消息可能已保存」。
- **把 FakeModel 的步骤数写死**：`max_steps` 和 provider 行为可能让实际步骤数不同。
- **忘记设置 `permissionPreset`**：未指定预设时调用会被拒绝，测试会得到与预期不同的结果。
- **在测试中写真实 `~/.omniagent`**：使用临时目录和显式路径。
- **依赖系统时区**：计划任务测试使用显式 `time_zone`。
- **依赖平台 sandbox**：Linux 上的 bwrap / Landlock 测试可能跳过；macOS 的 Seatbelt 行为不能假定在 Linux 存在。需要平台路径语义的用例用 `runIf` 守卫，例如 `/tmp` 在 macOS 是 symlink。
