# OmniAgent 文档

这套文档从「设计」和「实现」两个视角说明 OmniAgent：它想解决什么问题、核心不变量是什么、一次对话在代码里如何流动，以及各个前端和外围能力如何接在同一条运行时上。

根目录的 [README](../README.md) 适合快速上手；本目录适合在改代码、做评审或排查行为前系统阅读。

## 文档地图

### 设计

| 文档 | 回答的问题 |
| --- | --- |
| [design/overview.md](design/overview.md) | 项目定位、设计原则、运行时全景、分层与安全模型 |
| [design/runtime-loop.md](design/runtime-loop.md) | 一次 turn 如何执行；事件协议、工具批处理、中断与审计 |
| [design/session-state.md](design/session-state.md) | Session 如何投影历史、压缩上下文、处理 todo/plan/goal/title 和后台回合 |
| [design/tools-permissions-sandbox.md](design/tools-permissions-sandbox.md) | 工具契约、内置工具、DSH 权限预设、一次性升级与沙盒边界 |
| [design/configuration-agents-modes.md](design/configuration-agents-modes.md) | providers/models → roles → profiles → agents → modes 的配置分层与解析顺序 |
| [design/subagents-and-schedules.md](design/subagents-and-schedules.md) | 子代理协作树、生命周期、计划任务与无人值守投递 |
| [design/persistence-and-observation.md](design/persistence-and-observation.md) | 会话 JSONL、工作区注册表、审计、轨迹、导出与隐私边界 |

### 实现

| 文档 | 回答的问题 |
| --- | --- |
| [implementation/core.md](implementation/core.md) | `packages/core` 的模块分工、关键类型、依赖方向与组合根 |
| [implementation/tui.md](implementation/tui.md) | 终端前端的 REPL、渲染管线、块模型、审批和流式 Markdown |
| [implementation/web.md](implementation/web.md) | Web Host、路由、SSE、审批代理、运行时缓存，以及 React 工作台 |
| [implementation/testing.md](implementation/testing.md) | 测试布局、集成测试写法、eval harness 与验收命令 |

### 参考与决策记录

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 英文架构笔记，偏运行时行为与安全边界的逐条说明 |
| [agents.md](agents.md) | 配置分层、`agents/*.md`、`modes.json`、会话选择事件的详细规则 |
| [web-api.md](web-api.md) | 本地 Web API 的路由、请求体、响应体和状态码参考 |
| [adr/](adr/) | 已做出的架构决策：背景、候选、结论、后果 |
| [notes/](notes/) | 对 Codex、Claude Code 等外部实现的调研笔记 |
| [spec/](spec/) | 事件协议、eval harness 等自有规格 |

## 推荐阅读路线

**第一次接触代码**

1. [design/overview.md](design/overview.md)
2. [design/runtime-loop.md](design/runtime-loop.md)
3. [implementation/core.md](implementation/core.md)
4. 根目录 [README](../README.md) 的「快速开始」

**准备改核心运行时**

1. [design/runtime-loop.md](design/runtime-loop.md)
2. [design/session-state.md](design/session-state.md)
3. [design/tools-permissions-sandbox.md](design/tools-permissions-sandbox.md)
4. [implementation/core.md](implementation/core.md)
5. [implementation/testing.md](implementation/testing.md)

**准备改 Web / TUI**

1. [design/runtime-loop.md](design/runtime-loop.md)（先理解事件流）
2. [implementation/tui.md](implementation/tui.md) 或 [implementation/web.md](implementation/web.md)
3. [web-api.md](web-api.md)（改路由时）

**做安全评审**

1. [design/tools-permissions-sandbox.md](design/tools-permissions-sandbox.md)
2. [design/persistence-and-observation.md](design/persistence-and-observation.md) 的隐私边界
3. [architecture.md](architecture.md) 的 Known limitations
4. 根目录 README 的「已知边界」

**配置或接入新模型 / 新智能体**

1. [design/configuration-agents-modes.md](design/configuration-agents-modes.md)
2. [agents.md](agents.md)
3. [config.example.json](../config.example.json)

## 文档约定

- 代码引用写成 `packages/core/src/loop/agent-loop.ts:64` 形式，便于直接跳转。
- 「设计」文档描述稳定的意图和不变量；「实现」文档描述当前代码如何做到，可能随重构变化。
- 已知偏差与限制集中在各文档末尾的「实现备注」或「已知限制」，不混进主流程描述。
- 行为、协议或安全边界变化时，至少同步更新对应设计文档和根 README 的「已知边界」。
- 文档中的「当前」均指仓库当前提交状态，而不是某个历史版本。
