# Web 对话失败提示开发计划

| 项 | 内容 |
| --- | --- |
| 模块 | `web` |
| 范围 | fullstack |
| 类型 | bug-fix |
| 日期 | 2026-11-26 |
| 需求文档 | 无独立需求文档，范围以本文为准 |
| 代码基线 | 仓库当前工作区 |

## 1. 目标与范围

本次只覆盖用户直接发送消息时的三类结果。

1. 回合被接受前的准入拒绝，在输入区保留草稿并给出原因与动作。
2. 启动结果尚不确定时，保留草稿、刷新会话详情，并提示先确认消息去向。
3. 已接受回合的运行失败或刷新后的历史失败，显示在该回合内并保留已有输出。

每类提示同时给出原因、下一步和建议后的消息去向。

团队成员模型失败由该成员的子会话承载。父会话只把子会话的 `subagent/end(status:failed)` 记为该成员的结果，父回合保持自身状态。首期在打开的成员子会话中复用同一套历史失败展示。父会话团队卡片上的失败摘要留待后续范围确认。

当前没有与这次报错对应的截图、时间或会话记录。现场的具体原因待取得可关联证据后再定位。

ZCode 的官方资料只提供可借鉴的公开交互。v3.18.2 在模型不可用时提示重新选择，v3.16.2 修复模型创建失败造成的输入丢失和对话卡住，v3.19.1 修正模型限流后的重试等待，反馈入口自动附带错误摘要和截图。本机 ZCode 源码未核实，这些资料不作为本仓缺陷的现场证据。

范围约束如下。

- 本次只处理 Composer 的直接发送。排队、插话及其独立提交路径保持现有行为。
- 自动重试继续使用 [`agent-loop.ts:226`](../../packages/core/src/loop/agent-loop.ts:226) 的既有预算、条件和等待时序。
- 模型限流按其自身原因展示。
- 正常停止保持停止状态。
- resolver 只有可靠的 typed 凭据类别才进入凭据分支，其他泛化异常进入 `runtime_unavailable`。
- 浏览器只接收稳定公开 code、已验证状态、受控 failure 类别和固定安全文案。
- 公开诊断保持 [`docs/web-api.md:207`](../web-api.md:207) 的既有白名单。
- 新旧服务端、新旧前端和无 code 的旧历史都按缺字段安全兜底，持久化格式保持不变。

## 2. 已核实依据

### 2.1 仓内行为

| 关注点 | 位置 | 当前行为 |
| --- | --- | --- |
| 已有回合 | [`server.ts:2052`](../../packages/web/src/server.ts:2052) | 返回 409，正文是 `Session already has an active turn` |
| 权限未选 | [`server.ts:2098`](../../packages/web/src/server.ts:2098) | 返回 409，正文是 `A permission preset must be selected` |
| 模型未选或失效 | [`server.ts:2108`](../../packages/web/src/server.ts:2108) | 返回 409，但没有稳定公开错误码 |
| resolver 异常 | [`server.ts:2124`](../../packages/web/src/server.ts:2124) | 409 直接采用 `Error.message` |
| 启动结果不确定 | [`server.ts:2227`](../../packages/web/src/server.ts:2227) | 500，固定码 `turn_start_failed_message_may_be_saved` |
| 流内错误投影 | [`server.ts:2479`](../../packages/web/src/server.ts:2479) | 无 code 且无 status 时只公开固定文案 |
| 历史脱敏 | [`docs/web-api.md:207`](../web-api.md:207) | `trace/error` 只保留有界文本及已验证的 code、status、retryable |
| 未确认失败 | [`store.ts:2510`](../../packages/web/ui/src/lib/store.ts:2510) | 状态小于 500 且不是特殊启动码才算明确拒绝。500 及以上、特殊启动码和随后的网络异常都进入 uncertain |
| 全部 409 包装 | [`store.ts:2520`](../../packages/web/ui/src/lib/store.ts:2520) | 所有 409 都套上“已有回合正在运行” |
| 乐观气泡回滚 | [`store.ts:2532`](../../packages/web/ui/src/lib/store.ts:2532) | catch 一律恢复发送前 transcript。uncertain 额外保留空 outcome、通知调用方并读取会话详情 |
| 流结束后告警 | [`store.ts:2845`](../../packages/web/ui/src/lib/store.ts:2845) | 用 `run.error` 再弹一次顶栏告警 |
| 自动重试事件 | [`events.ts:651`](../../packages/web/ui/src/lib/events.ts:651) | 记录 attempt 和 maxAttempts，不记录原因与 delayMs |
| 重试提示消失 | [`events.ts:519`](../../packages/web/ui/src/lib/events.ts:519) | 下一条 assistant 消息会清除 retry |
| 无回复失败 | [`events.ts:660`](../../packages/web/ui/src/lib/events.ts:660) | 现有逻辑会补一个 assistant 来承载错误 |
| 回合结束 | [`events.ts:672`](../../packages/web/ui/src/lib/events.ts:672) | 只记录 reason，单独的 `turn.end(error)` 没有通用失败提示 |
| 历史失败归属 | [`events.ts:854`](../../packages/web/ui/src/lib/events.ts:854) | 仅把 `trace/error` 挂到已有且无工具调用的 assistant |
| 原因标题 | [`ConversationView.tsx:249`](../../packages/web/ui/src/components/ConversationView.tsx:249) | 仅识别少量 code 和 HTTP 状态 |
| 失败只挂在回复上 | [`ConversationView.tsx:497`](../../packages/web/ui/src/components/ConversationView.tsx:497) | 没有 final assistant 时失败不可见 |
| 草稿清理 | [`Composer.tsx:826`](../../packages/web/ui/src/components/Composer.tsx:826) | 仅在 accepted 后清理文本和附件 |
| 现有模型入口 | [`Composer.tsx:1242`](../../packages/web/ui/src/components/Composer.tsx:1242) | 模型选择器已在输入区 |
| 模型设置入口 | [`ModelPicker.tsx:453`](../../packages/web/ui/src/components/ModelPicker.tsx:453) | `Manage models` 调用 `openSettings('models')` |
| 重试预算 | [`agent-loop.ts:226`](../../packages/core/src/loop/agent-loop.ts:226) | `maxRetries` 钳制后只重试未开始输出且可重试的请求，等待由 core 执行 |
| typed 凭据错误 | [`dsh-deepseek.ts:81`](../../packages/core/src/providers/dsh-deepseek.ts:81) | 缺少凭据时抛出 `MISSING_CREDENTIAL` |
| 子会话结果 | [`subagent-summaries.ts:46`](../../packages/web/src/subagent-summaries.ts:46) | 父会话按 childId 投影 `subagent/end.status`，`failed` 属于该成员 |

### 2.2 官方公开依据

- [ZCode 更新日志 v3.18.2](https://zcode.z.ai/cn/changelog) 记录，模型不可用时发送会提示重新选择，已关闭的提示不会错误地再次出现。
- [ZCode 更新日志 v3.16.2](https://zcode.z.ai/cn/changelog) 记录，模型创建失败曾造成输入丢失和对话卡住，该版本已修复。
- [ZCode 更新日志 v3.19.1](https://zcode.z.ai/en/changelog?page=2) 记录，模型限流后的重试等待更为准确，从而减少连续失败。
- [ZCode 反馈与支持](https://zcode.z.ai/cn/docs/feedback) 记录，错误条目中的反馈入口会自动附带错误摘要和截图。没有该入口时改走帮助菜单。

以上均来自 ZCode 官方公开页面。本机 ZCode 源码未核实。

## 3. 对外行为

### 3.1 直接发送的错误分类

| 场景 | 公开 code | 输入区动作 |
| --- | --- | --- |
| 已有回合 | `turn_in_progress` | 保留草稿，提示等待当前回合 |
| 未选模型 | `model_selection_required` | 保留草稿，打开现有模型选择器 |
| 模型绑定失效 | `model_selection_invalid` | 保留草稿，打开现有模型选择器重新选择 |
| 运行时不可用 | `runtime_unavailable` | 保留草稿，提示稍后重试 |
| typed 凭据缺失 | `MISSING_CREDENTIAL` | 保留草稿，打开模型设置 |
| 权限未选 | `permission_preset_required` | 保留草稿，打开权限选择 |
| Agent 未选 | `agent_selection_required` | 保留草稿，打开 Agent 选择 |
| Agent 选择失效 | `agent_selection_invalid` | 保留草稿，重新选择 Agent |
| 初始化期间取消 | `turn_initialization_cancelled` | 保留草稿，按取消结果处理 |
| 未知 409 | 保持服务端原 code | 使用统一安全文案 |
| 启动结果不确定 | `turn_start_failed_message_may_be_saved` | 保留草稿并刷新详情 |
| 网络异常或其他 5xx | 无新增 code | 与特殊启动码一样保留草稿并刷新详情 |
| 无 code 的旧记录 | 无 | 使用安全兜底文案 |

本表列出的稳定 code 和错误类别只用于本次直接发送路径。未知 409 不再包装成已有回合，也不再新增一个专用 code，前端统一显示安全文案。

`MISSING_CREDENTIAL` 只在错误来源已经是可靠的 typed 类别时使用，当前依据见 [`dsh-deepseek.ts:81`](../../packages/core/src/providers/dsh-deepseek.ts:81)。没有可靠 typed 来源时归入 `runtime_unavailable`。

### 3.2 启动结果与可选 failure

明确的 4xx 拒绝停在输入区，草稿和附件保持不动。

以下结果使用同一组处理。

- `turn_start_failed_message_may_be_saved`。
- 其他 5xx。
- 提交后的网络异常。

处理方式是保留 Composer 草稿与附件、刷新会话详情，并提示先检查消息是否已经出现。刷新发现已有消息时，草稿仍保留，由用户决定是否继续编辑。客户端不做自动重放，也不用草稿文本比对推断那条消息是否就是本次提交。

既有 500、SSE 结构和 `turn_start_failed_message_may_be_saved` 保持原样。已知首帧失败或同一轮异常在能够安全取得类别时，增加可选 `failure` 字段。该字段使用固定白名单，只补充类别，不改变原 status 和 code，也不把“是否已保存”改成确定结论。缺少该字段时按原响应处理。

### 3.3 已接受后的失败

- 失败绑定该回合的真实 turn index、起止时间和结束原因。
- 已产生的用户消息、工具过程和部分回复保持原位。
- 回合显示为未完成。
- 只收到 `turn.end(error)` 时显示通用失败提示。
- 刷新后只有 `trace/error` 与 `turn.end` 的历史也按同一回合还原。
- 连续失败分别绑定各自回合，前一个终态保持不变。
- 正常停止只显示停止。
- 对话内已经显示该失败时，顶栏不再重复告警。

### 3.4 子会话

- 首期在打开的成员子会话内复用历史失败展示。
- 父会话通过 [`projectSubagentStatuses`](../../packages/web/src/subagent-summaries.ts:46) 按 childId 读取 `subagent/end(status:failed)`。
- 父回合的 outcome、失败标记和顶栏告警保持该父回合自身的结果。
- 父团队卡片的成员失败摘要待后续范围确认。

## 4. 提示映射与文案

映射集中在一处，并同时提供中文和英文。

1. 已识别的明确 code 优先。
2. 其次使用已知 provider 上下文中的 HTTP 状态。
3. 最后使用安全兜底。

判定规则如下。

- 401 和 403 表示鉴权失败。
- `QUOTA` 优先于 429。
- 429 或 `RATE_LIMIT` 表示模型限流。
- 上游超时与上游不可用分别给出提示。
- 上下文超限与上下文预算配置不足分别给出提示。
- 模型未选或绑定失效指向现有模型选择器。
- `MISSING_CREDENTIAL` 指向模型设置。
- 限流建议等待或核查配额。
- 只有上下文窗口超限才建议缩短输入。

建议文案如下。

| 场景 | 中文建议 |
| --- | --- |
| 模型失效 | 当前模型已失效，请重新选择模型。 |
| 权限未选 | 请先选择本会话的权限。 |
| 已有回合 | 当前已有回合正在运行，请等待它结束后再发送。 |
| 限流自动重试 | 模型正在限流，系统会自动重试，当前为第 {attempt}/{total} 次。 |
| 限流终态 | 模型限流尚未恢复，请稍后重试或核查配额。 |
| 启动状态不明 | 发送结果尚未确认，请先检查消息是否已出现。 |
| 有诊断的流内失败 | 这次回复没有完成，可展开查看已公开的诊断信息。 |
| 无诊断的流内失败 | 这次回复没有完成，请稍后重试。 |
| 保留不完整回复 | 已生成的内容已保留，本回合尚未完成。 |

`model.retry` 的原因取自 `event.error` 的受控 code 或 status。`attempt/maxAttempts` 显示进度，合法的 `delayMs` 只用于可选等待文案。实际等候仍由 core 决定。后续 assistant 输出、最终 error 或 turn end 到达后，等待提示消失。终态限流只说明当前结果，文案不声称重试已经耗尽。`maxAttempts` 是自动重试次数，界面中的总次数按“第 N 次重试 / 共 M 次重试”映射。

有可公开诊断时，回合内使用折叠区域展示类别、已验证 code 和可选 HTTP 状态。没有可展示的诊断时，只显示通用失败提示。诊断内容继续受既有公开字段白名单约束。

## 5. 实施步骤

### 5.1 Web API 与契约测试

调用提示词使用 `/sinicube-back-code`。

- 为直接发送的准入与初始化分支返回第 3.1 节列出的稳定 code。
- 未知 409 保留原响应身份，并返回固定安全文案。
- 仅对可靠 typed 的 `MISSING_CREDENTIAL` 返回凭据类别。
- 其他 resolver 异常返回 `runtime_unavailable` 和固定安全文案。
- 已知首帧或同轮异常仅在类别可安全取得时附加可选 `failure` 白名单字段。
- 保持原 HTTP status、SSE 结构和 `turn_start_failed_message_may_be_saved`。
- 保持 [`docs/web-api.md:207`](../web-api.md:207) 的 trace 脱敏契约。
- 先补 [`server.test.ts`](../../packages/web/src/server.test.ts) 与 [`trace-projection.test.ts`](../../packages/web/src/trace-projection.test.ts)。

### 5.2 状态映射与本地化

调用提示词使用 `/sinicube-front-code`。

- 在 Web client 集中实现 code、provider HTTP 状态和兜底文案映射。
- `model.retry` 消费 `event.error` 的受控分类、attempt、maxAttempts 和可选 delayMs。
- 中英文文案同步落到 [`i18n.ts`](../../packages/web/ui/src/lib/i18n.ts)。
- 用 [`ui-store.test.ts`](../../packages/web/src/ui-store.test.ts) 和 [`ui-protocol.test.ts`](../../packages/web/src/ui-protocol.test.ts) 锁定映射。

### 5.3 输入区与回合视图

调用提示词使用 `/sinicube-front-code`。

- 明确拒绝时把原因和建议显示在 Composer 输入区，并保留草稿和附件。
- 特殊启动码、其他 5xx 和网络异常都保留草稿、刷新详情并显示状态未确认提示。
- 回合视图使用真实回合元数据展示失败、未完成和已保留输出。
- 无 assistant 的失败直接挂在该回合上。
- 有公开诊断时折叠展示，没有诊断时使用通用短句。
- 对话内失败存在时抑制重复顶栏告警。
- 将子会话回归加入 [`ui-store.test.ts`](../../packages/web/src/ui-store.test.ts)。

### 5.4 回归与文档收口

调用提示词使用 `/sinicube-back-code` 与 `/sinicube-front-code`。

- 按第 6 节运行定向测试。
- 同步 [`docs/web-api.md`](../web-api.md) 中新增公开 code 与可选 `failure` 字段。
- 检查中英文键覆盖、缺字段兜底和既有客户端兼容。

## 6. 测试、验收与风险

| 场景 | 预期 | 主要测试 |
| --- | --- | --- |
| 各稳定 409/取消分支 | 返回对应 code 和固定安全文案 | [`server.test.ts`](../../packages/web/src/server.test.ts) |
| 未知 409 | 原 code 保留，前端不再显示成已有回合 | [`server.test.ts`](../../packages/web/src/server.test.ts)、[`ui-store.test.ts`](../../packages/web/src/ui-store.test.ts) |
| 首帧失败与同轮异常 | 原 status/code 不变，可安全取得时才有 `failure` | [`server.test.ts`](../../packages/web/src/server.test.ts) |
| 已保存与未保存的不确定启动 | 草稿保留，详情刷新，提示先检查消息 | [`ui-store.test.ts`](../../packages/web/src/ui-store.test.ts) |
| 断线、限流恢复、限流终态 | 重试期间显示原因和进度，终态不声称耗尽 | [`server.test.ts`](../../packages/web/src/server.test.ts)、[`ui-store.test.ts`](../../packages/web/src/ui-store.test.ts) |
| 已输出后失败、无 assistant 历史、旧记录 | 输出保留，失败绑定真实回合，旧记录安全兜底 | [`ui-protocol.test.ts`](../../packages/web/src/ui-protocol.test.ts) |
| 中断与连续回合 | 停止不显示失败，连续失败不串回合 | [`ui-store.test.ts`](../../packages/web/src/ui-store.test.ts) |
| 子会话失败 | 父回合 outcome 和告警保持不变 | [`ui-store.test.ts`](../../packages/web/src/ui-store.test.ts) |
| 脱敏 | 只出现白名单中的公开字段 | [`trace-projection.test.ts`](../../packages/web/src/trace-projection.test.ts) |
| 中英文 | 所有新增键都有中文和英文 | [`ui-protocol.test.ts`](../../packages/web/src/ui-protocol.test.ts)、[`i18n.test.ts`](../../packages/web/src/i18n.test.ts) |

定向命令如下。

```bash
pnpm vitest run packages/web/src/server.test.ts packages/web/src/ui-store.test.ts packages/web/src/ui-protocol.test.ts packages/web/src/trace-projection.test.ts packages/web/src/i18n.test.ts
```

验收风险如下。

- 刷新详情只能证明会话中出现了消息，不能用草稿文本比对证明它就是这次未确认提交。重复消息的最终判断留在输入区提示和用户确认。
- 连续回合的失败必须使用持久 turn index 与 turn end 配对。缺少配对信息时保持上一个已确认回合不变。
- 旧客户端会忽略新增 code 和可选 `failure`。新客户端遇到缺字段的旧服务端或旧历史时使用安全兜底，两类客户端都保持原有读取能力。

## 7. 回退与后续确认

回退按两层进行。

1. 先回退 Web UI 的交互增量。
2. 再撤销 Web Host 的公共响应增量。

撤销后端增量后，旧 UI 与新 UI 对缺少 code 或 `failure` 的响应使用同一套兜底。回退不改变已保存会话。

后续确认项如下。

- 父会话团队卡片是否在后续版本显示成员失败摘要。
- 取得与现场报错可关联的截图、时间或会话记录后，再定位具体触发原因。
