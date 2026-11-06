# 智能体、角色与模型绑定

OmniAgent 把配置分成四层，每一层只回答一个问题：

```text
providers / models  →  连到哪里、模型有哪些元数据、能力与思考字段怎么映射
roles               →  一组 provider + model + reasoningEffort
agentProfiles       →  一个智能体可以看见哪些工具和 skill（config.json）
agents/*.md         →  身份、说明、角色、usage、profile 和 system prompt
```

会话只持久化两个选择：`agent/selected` 和 `model/selected`（v2）。模型 client、工具集合、skill 目录和 system prompt 都在每次开始新回合时由 `RuntimeResolver` 重新解析。运行中的回合使用创建 `Session` 时的快照。

## config.json：模型、角色、profile

```json
{
  "model": "deepseek-flash",
  "provider": "deepseek-official",
  "reasoningEffort": "high",
  "providers": {
    "deepseek-official": {
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": [
        {
          "id": "deepseek-flash",
          "name": "DeepSeek V4.1 Flash",
          "contextWindow": 1048576,
          "maxTokens": 8192,
          "input": ["text", "image"],
          "capabilities": { "imageInput": true },
          "reasoning": {
            "efforts": { "off": null, "low": "low", "high": "high", "max": "max" },
            "budgets": { "high": 16384 },
            "default": "high",
            "wire": {
              "enableField": "thinking.type",
              "enableValue": "enabled",
              "disableField": "thinking.type",
              "disableValue": "disabled",
              "effortField": "output_config.effort",
              "budgetField": "thinking.budget_tokens"
            }
          }
        }
      ]
    }
  },
  "roles": {
    "quick": {
      "name": "快速",
      "provider": "deepseek-official",
      "model": "deepseek-flash",
      "reasoningEffort": "low"
    }
  },
  "agentProfiles": {
    "default": { "tools": "*", "skills": "*" },
    "search-only": { "tools": ["read_file", "list_dir", "skill"], "skills": ["web-research"] }
  }
}
```

字段规则：

- 顶层 `model`、`provider`、`reasoningEffort` 自动合成默认角色，id 为 `default`。
- 显式 `roles.default` 覆盖顶层默认角色。其他自定义角色 id 任意，但不能与已有角色重复。
- `role.provider`、`role.model` 必须存在于模型目录；`role.reasoningEffort` 必须是该模型 `reasoning.efforts` 的键。
- 模型 `capabilities` 当前只支持 `imageInput`。未配置时，DeepSeek 官方模型从 `inputModalities` 推断，pi-ai 模型从模型 input 推断。
- `reasoning.efforts` 把规范等级映射成线缆值；`null` 表示关闭。没有映射时 DeepSeek Messages 使用内置等级，pi-ai 保留适配器默认行为。
- `reasoning.budgets` 可选；有 budget 且配置了 `budgetField` 时优先发送 budget 字段，否则发送 `effortField`。
- `reasoning.default` 必须出现在 `efforts` 中。
- `reasoning.wire` 使用点分路径写入请求体。拒绝 `__proto__`、`constructor`、`prototype`、空路径段，以及顶层保留字段 `model`、`messages`、`stream`、`tools`。
- 模型目录只包含元数据，不包含 endpoint、headers 或 API key；这些只留在 config 的 provider route 和进程环境中。

`agentProfiles` 未配置时，内置一个 `{ "tools": "*", "skills": "*" }` 的 `default`。一旦配置了 `agentProfiles`，就不会再隐式合并 `default`；引用不存在的 profile 的 agent 会失效。

`tools` 可以是 `"*"` 或精确列表。`subagent` 是组名，展开为 `subagent`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`。未知工具名是配置错误。`skills` 可以是 `"*"`、数组；省略等价于 `[]`。

工具 profile 只是 allowlist，不能扩大 DSH 权限预设或沙盒。它最终与权限预设取交集，因此 `tools: ["bash"]` 在 `read-only` 下仍然不能写文件。

## agents/*.md

目录：`~/.omniagent/agents/`。文件名（去掉 `.md`）就是 agent id，例如 `explorer.md` → `explorer`。

```markdown
---
name: Explorer
description: 只读搜索、代码探索和资料定位
role: quick
usage: subagent
profile: search-only
---

你是一个探索型智能体。

- 快速定位文件和代码。
- 搜索资料并整理线索。
- 不修改文件，不执行有副作用的命令。
- 将发现整理成结构化结论返回给父智能体。
```

| 字段 | 规则 |
| --- | --- |
| `name` | 可选，默认文件 id；1–120 字符 |
| `description` | 可选；最多 2000 字符；用于 UI 和 subagent 目录 |
| `role` | 可选，默认 `default`；必须存在于 roles |
| `usage` | 可选，`primary` / `subagent` / `both`，默认 `both` |
| `profile` | 可选，默认 `default`；必须存在于 agentProfiles |

- id 只允许 `[a-z0-9][a-z0-9._-]{0,63}`。
- 只接受普通文件；拒绝符号链接、目录和超过 512 KiB 的文件。
- 未知 frontmatter 字段报错；`x-` 前缀字段被忽略，留给未来扩展。
- 正文就是 system prompt。为空时使用全局 `system`，两者都为空时使用内置默认提示。
- agent 文件不能设置模型、工具、skill、权限或沙盒；这些只能来自 config.json 和角色层。
- 没有 `default.md` 时使用内置 default agent（role `default`、usage `both`、profile `default`、空正文）。如果存在 `default.md` 但无效，不会回退到内置 agent。

`usage` 决定 agent 出现在哪里：

- `primary`：只能作为主智能体。
- `subagent`：只能被子智能体调用；Explorer 这类专用 agent 使用它。
- `both`：两边都可以。

服务端、TUI、子代理启动和懒恢复都会重新校验 usage；把 `subagent` agent 强制用于根会话会失败，而不是降级到其他 agent。

## 会话选择事件

agent 选择：

```json
{ "version": 1, "agent": "default" }
```

模型绑定（v2）：

```json
{ "version": 2, "kind": "agent" }
{ "version": 2, "kind": "role", "role": "quick" }
{ "version": 2, "kind": "model", "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "high" }
```

解析优先级：

1. `kind: "agent"`：使用当前 agent 的 role。
2. `kind: "role"`：使用指定角色。
3. `kind: "model"`：使用指定模型，可覆盖 reasoning effort。

最终 effort 顺序：binding 显式 effort → role effort → 模型 `reasoning.default`。

v1 的 `model/selected` 事件视为 invalid，不会迁移或猜测；旧会话需要重新选择 agent 和模型后才能继续。缺少 agent 事件或缺少模型事件的会话同样不会回退到默认值。

## 热加载与失败策略

- 每次开始新回合、创建会话、打开会话详情时都会重新读取 `config.json` 和 `agents/` 的内容。
- `ConfigStore` 用内容哈希生成 revision；内容不变时复用解析结果。
- 运行中的回合保留原快照。配置或 agent 文件变化在下一回合生效。
- 无效 JSON、schema 错误、未知 role/profile、未知模型、不支持的 effort、图片能力不足都会明确失败，不回退到旧配置或默认模型。
- skill 名按工作区解析。缺失的 skill 只产生 warning，不会授予任何额外能力。
- 不删除、迁移或重写既有会话；旧事件 invalid 时只要求重新选择。

## 常用操作

TUI：

```text
/agent                 列出可作为主智能体的 agent
/agent default         切换 agent（示例；subagent-only agent 会被拒绝）
/model agent           模型跟随当前 agent 的 role
/model role quick      使用角色
/model deepseek-official deepseek-v4-pro
/model                 列出跟随智能体、角色和具体模型
```

Web：

```http
POST /api/workspaces/:id/sessions
{ "agent": "default", "model": { "version": 2, "kind": "agent" } }

POST /api/workspaces/:id/sessions/:sessionId/agent
{ "agent": "default" }

POST /api/workspaces/:id/sessions/:sessionId/model
{ "version": 2, "kind": "role", "role": "quick" }
```
