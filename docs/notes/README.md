# 调研笔记

读别人家实现的笔记。规矩：

- 一篇一个主题，标题就是主题，不要按「某天读了什么」组织。
- 结论后面尽量带出处（文件路径或文档链接），方便以后回头核对。
- 明确区分「我读到的」和「我推断的」。推断要标 `[推断]`。

| 文件 | 内容 |
| --- | --- |
| [codex-sandbox.md](codex-sandbox.md) | Codex 的沙盒、approval policy、execpolicy |
| [claude-permissions.md](claude-permissions.md) | Claude Code 的权限规则、模式、沙盒运行时 |

代码里的对应落点：

- 权限规则形状 → `packages/core/src/permissions/rules.ts`
- 复合命令拆解 → `packages/core/src/permissions/bash.ts`
- 求值顺序 → `packages/core/src/permissions/evaluate.ts`
- 沙盒（M3）→ `packages/core/src/sandbox/`
