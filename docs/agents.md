# 智能体、角色与模型绑定

OmniAgent 把配置分成五层，每一层只回答一个问题：

```text
providers / models  →  连到哪里、模型有哪些元数据、能力与思考字段怎么映射
roles               →  一组 provider + model + reasoningEffort
agentProfiles       →  一个智能体可以看见哪些工具和 skill（config.json）
agents/*.md         →  身份、说明、角色、usage、profile 和 system prompt
modes.json          →  Web 新会话选择的 agent + 模型 + tools + skills 组合
```

会话持久化 `agent/selected` 和 `model/selected`（v2）。通过 Web 模式创建的会话还会写入不可变的 `mode/selected`，其中记录模式 id、agent、模型绑定、工具与 skill 选择。模型 client、工具集合、skill 目录和 system prompt 都在每次开始新回合时由 `RuntimeResolver` 重新解析；模式会话的 tools/skills 以快照为准，之后修改 `modes.json` 只影响新会话。运行中的回合使用创建 `Session` 时的快照。

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
    "search-only": { "tools": ["read_file", "list_dir", "glob", "grep", "web_fetch", "skill"], "skills": ["web-research"] }
  },
  "todo": {
    "allowParallelInProgress": true
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
- `todo.allowParallelInProgress` 默认 `false`；设为 `true` 后允许 `todo_write` 同时保留多个 `in_progress`，适用于把任务分派给多个子智能体并行执行的场景。

Web 的「模型配置」页直接编辑 `providers` 和 `roles`，规则如下：

- 一个模型来源对应 `providers` 中的一条 route，也可来自历史顶层 `provider` 对象；后者第一次保存时会迁移为 `providers.openai`，并把顶层 `provider` 改为 `"openai"`，当前模型和角色不变。
- 模型来源可编辑显示名、协议、接口地址、API Key、API Key 环境变量、`auth: "ambient"` 与模型列表；`headers`、`timeoutMs`、`maxRetries` 等页面未暴露的 route 字段在保存时保留。
- API Key 是只写字段：GET 只返回 `apiKeyConfigured`，不会返回 key。页面留空表示保持已有 key，显式清除使用 `clearApiKey`。
- 模型可编辑 id、显示名、上下文窗口、最大输出 token、输入类型（text/image）、思考等级和默认等级。未在页面显示的 `reasoning.budgets`、`reasoning.wire` 以及匹配 id 的未知模型字段会在保存时保留。
- 内置 pi-ai 服务商可以省略协议和接口地址，继承适配器目录；自定义来源必须同时提供协议与接口地址。
- 删除来源会拒绝当前默认来源、内置来源，以及仍被有效角色引用的来源；修改模型列表也不能让已有有效角色失效。
- 模型列表可以从 OpenAI 兼容接口的 `/models` 或 Anthropic Messages 的 `/v1/models` 拉取；拉取失败不会修改配置。

`agentProfiles` 未配置时，内置一个 `{ "tools": "*", "skills": "*" }` 的 `default`。一旦配置了 `agentProfiles`，就不会再隐式合并 `default`；引用不存在的 profile 的 agent 会失效。

`tools` 可以是 `"*"` 或精确列表。`subagent` 是组名，展开为 `subagent`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`；`todo_write`、`exit_plan_mode`、`get_goal`、`create_goal`、`update_goal` 都是独立的精确工具名，需要逐项授权。未知工具名是配置错误。`skills` 可以是 `"*"`、数组；省略等价于 `[]`。

工具 profile 只是 allowlist，不能扩大 DSH 权限预设或沙盒。它最终与权限预设取交集，因此 `tools: ["bash"]` 在 `read-only` 下仍然不能写文件。

MCP 服务器的工具会以 `mcp__<server-id>__<tool-name>` 的形式注册到会话中，profile 和模式既可以用 `"*"` 也可以用完整工具名授权。MCP 调用在配置的服务器进程内执行，不经过本地文件沙箱；因此这些工具在 `read-only` 下也可调用。服务器未连接时，其工具不会出现在会话里。配置格式和 Web 设置页见 [web-api.md](web-api.md#mcp-servers)。

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
- 内置 `creator`（创造智能体，role `default`、usage `primary`、profile `default`）始终可用，除非目录中存在同名的 `creator.md`。它用于通过对话调整 OmniAgent 本身：`schedule_*` 工具创建自动化任务，`list_agent_definitions` / `write_agent_definition` 读取和写入 `~/.omniagent/agents/*.md`。这两个定义工具只注册在创造模式的主会话中；标准模式不会暴露它们。
- `default` 和 `creator` 是保留 id；`write_agent_definition` 拒绝覆盖内置定义。自定义智能体使用独立 id。
- Web 的「设置 → 智能体」提供人工编辑表单，走同一套校验与写入逻辑（`~/.omniagent/agents/<id>.md`）：可以新建、修改和删除自定义定义，内置定义只读。创造模式则通过对话调用 `list_agent_definitions` / `write_agent_definition` 完成同样的写入。

`usage` 决定 agent 出现在哪里：

- `primary`：只能作为主智能体。
- `subagent`：只能被子智能体调用；Explorer 这类专用 agent 使用它。
- `both`：两边都可以。

服务端、TUI、子代理启动和懒恢复都会重新校验 usage；把 `subagent` agent 强制用于根会话会失败，而不是降级到其他 agent。

## 模式预设（modes.json）

模式是 Web 新会话的组合快照：一个 agent、初始模型绑定来源、工具 allowlist 和 skill allowlist。创建会话后 agent、工具和 skill 固定，模型可在会话内切换。内置模式定义在代码中：

- `standard`（标准模式）：`default` 智能体，跟随智能体角色，全部工具和 skill。
- `creator`（创造模式）：`creator` 智能体，跟随智能体角色，仅暴露调研、计划、自动化任务和智能体定义相关工具。

用户覆盖和自定义模式保存在 `~/.omniagent/modes.json`：

```json
{
  "version": 1,
  "defaultMode": "standard",
  "modes": {
    "my-mode": {
      "name": "我的模式",
      "description": "可选说明",
      "agent": "default",
      "model": { "version": 2, "kind": "role", "role": "quick" },
      "tools": ["read_file", "grep"],
      "skills": ["docs"]
    }
  }
}
```

- `name` 必填，最多 120 字符；`description` 可选，最多 2000 字符。
- `agent` 必须是可作为主智能体使用的有效 id。
- `model` 省略时等价于 `{ "version": 2, "kind": "agent" }`；也可以使用 role 绑定或具体模型。
- `tools` / `skills` 可以是 `"*"` 或字符串数组。未知工具会让模式无效；未知 skill 在会话中只产生 warning。
- 内置 id `standard` / `creator` 可以在 `modes.json` 中覆盖，删除覆盖项即可恢复内置定义。
- `defaultMode` 只决定新会话选择器的默认项；会话创建后模式不可更改，只能新开会话选择其他模式。

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
/model deepseek-official deepseek-v4-pro
/model                 列出跟随智能体和具体模型
```

角色（roles）是配置层概念：智能体和模式通过 role 引用模型与思考强度，运行时解析为实际模型；用户选择模型时只看到具体模型。

Web：

```http
# 推荐：按模式创建，服务端固化 agent/tools/skills，模型默认取模式配置
POST /api/workspaces/:id/sessions
{ "mode": "standard" }

# 创建时覆盖模式默认模型；agent 仍由模式固定
POST /api/workspaces/:id/sessions
{
  "mode": "standard",
  "model": { "version": 2, "kind": "model", "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "high" }
}

# 兼容无模式的显式选择（不写入 mode/selected，仍可切换）
POST /api/workspaces/:id/sessions
{ "agent": "default", "model": { "version": 2, "kind": "agent" } }

# 仅无模式会话可切换 agent；mode 会话返回 409，必须新建会话
POST /api/workspaces/:id/sessions/:sessionId/agent
{ "agent": "default" }

# 任意会话都可切换模型；mode 会话的 agent/tools/skills 仍保持快照
POST /api/workspaces/:id/sessions/:sessionId/model
{ "version": 2, "kind": "model", "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "high" }

# 回复进行中：把消息插入当前回合的下一步
POST /api/workspaces/:id/sessions/:sessionId/messages
{ "text": "补充要求", "mode": "steer" }
```
