# eval harness v0

实现：`packages/core/src/eval/harness.ts`。内置套件：`packages/core/src/eval/suites/basic.ts`。

## 它解决什么问题

改一句 system prompt、换一个模型、加一条权限规则，agent 的行为都可能变。靠手动聊几条来判断「有没有变差」有两个问题：

1. 不可重复：每次输入、环境、文件状态都不同。
2. 不可比较：没有断言，就没有「通过率」这种东西。

eval harness 把行为写成用例：给定工作区和模型输出，agent 应该调用哪些工具、做哪些权限决策、写出什么文件、最后说什么。跑一遍就能给出通过/失败。

## 一个 case 的生命周期

```
mkdtemp 建临时工作区
  -> 写入 fixture 文件
  -> 构造 FakeModel（或使用传入的真实 provider）
  -> 构造 Session（mode + rules + approve 回调）
  -> 依次 send 输入，收集事件和消息
  -> 断言
  -> 删除工作区（--keep 时保留）
```

每个 case 天然隔离：独立目录、独立 Session、独立模型游标。可以并行化，目前为了输出可读性串行跑。

## 用例结构

```ts
interface EvalCase {
  name: string;
  files?: Record<string, string>;     // 初始工作区
  input?: string | string[];          // 多轮对话
  steps?: FakeStep[];                 // 剧本化模型
  mode?: PermissionMode;              // 默认 default
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  approve?: (request) => 'allow' | 'deny';
  expect: EvalExpectations;
}
```

`steps` 存在时使用 `FakeModel`，断言的是循环、权限、工具；不存在时必须给 `runEvalCase` 传 `model`，通常是真实 provider。

## 断言

| 字段 | 含义 |
| --- | --- |
| `stopReason` | 最后一次 `turn.end` 的原因 |
| `tools` | 工具调用顺序，精确匹配 |
| `decisions` | 每次 `permission.decided` 的 allow/deny 顺序 |
| `finalText` | 最后一条 assistant 文本，字符串精确或正则 |
| `files` | 文件内容，字符串 / 正则 / 自定义函数 |
| `absentFiles` | 这些文件必须不存在 |

另外，任何 `error` 事件都会让 case 直接失败——脚本步数不够、工具崩了、模型调用失败，都不该被静默忽略。

## 接真实模型

```ts
const model = createConfiguredModel(config);
const suite = await runEvalSuite(cases, { model });
```

真实模型有随机性，单次通过不代表稳定。正确做法是同一个 case 跑 N 次，统计通过率，并在温度 0 的前提下比较不同 prompt / 模型。当前 v0 还没有做重复运行和统计聚合。

## 权限 eval 与 auto 模式

`permissions/modes.ts` 里没做 `auto` 模式，原因就在这里：auto 需要一个分类器决定 allow / ask / deny，而分类器的质量只能用标注数据衡量。

最低限度要有的指标：

- **false allow**：应该拒绝却放行了。安全上最致命，优先级最高。
- **false deny**：应该放行却拒绝了。影响体验，但不会造成破坏。
- **ask 的覆盖率**：拿不准时是否愿意交给用户确认。

这需要另一套更窄的 harness：输入是 `ToolCall` + 上下文，输出是 `Decision`，对照人工标注算混淆矩阵。现有的 agent-level harness 可以断言权限决策，但不能替代分类器评测。

## 现在没做的

- 重复运行、通过率、置信区间。
- 真实模型的成本 / 延迟统计。
- LLM-as-judge（主观回答质量）。
- 分类器专用混淆矩阵。
- 并行执行与失败重试。
