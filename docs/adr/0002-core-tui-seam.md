# ADR-0002：core 与 TUI 分两个包，用事件流通信

状态：已采纳（M1） · 2026-10

## 背景

第一版只是个终端里的 REPL。但终局很可能是：远程跑一个常驻 daemon，前端可以是 TUI、本地 web、或者 Electron 壳。

如果一开始就把 `console.log` 和 `readline` 写进循环里，后面每次换前端都要动核心代码，而且核心变得无法单测（要 mock stdout）。

## 候选方案

**A. 单包，分层目录**：`src/core/`、`src/tui/`，靠约定禁止反向引用。
- 优点：零配置，`tsc --noEmit` 一把跑完。
- 缺点：「core 不 import tui」只是一句口头约定，半年后一定破。

**B. 两个 workspace 包**：`@omniagent/core` + `@omniagent/tui`，core 通过 `index.ts` 暴露契约。
- 优点：边界由模块系统物理保证；TUI 想拿 core 的内部实现得先显式导出。
- 缺点：多一个 `pnpm-workspace.yaml` 和别名配置；dev 时需要让 tsx / vitest 都能解析 TS 源码。

**C. core 直接做成 HTTP/WS daemon**：TUI 是客户端。
- 优点：最接近终局，天然支持多前端。
- 缺点：M1 就要处理端口、进程生命周期、序列化、断线重连——全是和 agent 无关的活。

## 决定

采用 **B**，并且用**异步生成器**作为核心的对外接口：

```ts
for await (const event of session.send('帮我看看这个目录')) { ... }
```

- core 不知道 UI 存在，只 yield `AgentEvent`。
- 权限确认通过**注入的 `approve` 回调**完成，TUI 在回调里渲染提示。这样 core 不需要反向依赖任何 UI，也不需要事件回传机制。
- core 的路径别名同时配置在 `tsconfig.json`（给 tsc）和 `vitest.config.ts`（给测试），dev 时不引入构建步骤。

## 后果

- 好处：核心代码零 I/O 依赖（除了工具和 store），循环测试里没有 stdout mock。换前端 = 换一个消费事件流的函数。
- 代价：`Session.send` 是 async generator，调用方要用 `for await`，不能用回调风格；对不熟悉生成器的读者有一点门槛。
- 为 M6 留的余地：`AgentCommand`（`protocol/events.ts`）已经定义了 UI → core 的指令形状。做成 daemon 时，把 `for await` 换成 WS 消息流即可，事件类型不用改。
- 现在没做的：`approve` 回调是同步阻塞式的（追问 → 等回答）。做成 daemon 后要改成「发 `permission.request` 事件 + 等 `permission.respond` 命令」的异步配对，这需要 request id 和 pending map。已在 `PermissionRequest.id` 预留。
