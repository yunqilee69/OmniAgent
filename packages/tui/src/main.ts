import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  AuditLog,
  FakeModel,
  Session,
  createConfiguredModel,
  loadConfig,
  textResponse,
  toolCallResponse,
} from '@omniagent/core';
import type { ApprovalResponse, PermissionRequest } from '@omniagent/core';
import { clip, renderEvent } from './render';

/**
 * 最小 TUI。
 *
 * 配了 ~/.omniagent/config.json 的 provider 时走真实模型（OpenAI 兼容）；
 * 没配时退回 FakeModel 演示剧本，零 token 就能观察完整事件流。
 */

const cwd = process.cwd();

function createDemoModel(): FakeModel {
  return new FakeModel(
    [
      toolCallResponse([{ name: 'list_dir', args: { path: '.' } }], '先看一下工作区里有什么。'),
      toolCallResponse(
        [{ name: 'read_file', args: { path: 'README.md' } }],
        '再看一眼 README。',
      ),
      textResponse(
        '以上就是演示：模型发起了两次工具调用，每次都被权限门拦下来问过你。\n配置真实 provider 后，这段剧本就会被真正的推理替代。',
      ),
    ],
    {
      onExhausted: textResponse(
        '（演示剧本已结束。在 ~/.omniagent/config.json 里配置 provider 后即可接真模型。）',
      ),
    },
  );
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function approve(request: PermissionRequest): Promise<ApprovalResponse> {
  const args = clip(JSON.stringify(request.call.arguments), 120);
  const answer = await rl.question(
    `\n\x1b[33m? 权限确认\x1b[0m ${request.call.name} ${args}\n  原因：${request.reason}\n  执行？(y/N) `,
  );
  return answer.trim().toLowerCase() === 'y' ? 'allow' : 'deny';
}

async function main(): Promise<void> {
  const { config, rules } = await loadConfig();
  const configured = createConfiguredModel(config);
  const model = configured ?? createDemoModel();

  const audit = new AuditLog(join(cwd, '.omniagent', 'audit.jsonl'));
  const session = new Session({
    cwd,
    model,
    modelId: config.model,
    mode: config.mode,
    rules,
    maxSteps: config.maxSteps,
    approve,
    audit: (entry) => audit.record(entry),
    ...(config.system !== undefined ? { system: config.system } : {}),
  });

  const label = configured
    ? `OpenAI 兼容 · ${config.model}`
    : 'FakeModel 演示（未配置 provider）';
  console.log(`\x1b[1mOmniAgent\x1b[0m · ${label}`);
  console.log('输入任意内容开始，输入 exit 退出。\n');

  for (;;) {
    const line = (await rl.question('\x1b[2m>\x1b[0m ')).trim();
    if (line.length === 0) {
      continue;
    }
    if (line === 'exit' || line === 'q') {
      break;
    }

    // 流式文本要逐段写、不换行；assistant.message 只负责收尾，避免整段重复输出。
    let streaming = false;

    for await (const event of session.send(line)) {
      if (event.type === 'turn.start') {
        streaming = false;
      }

      if (event.type === 'assistant.delta') {
        streaming = true;
        process.stdout.write(event.text);
        continue;
      }

      if (event.type === 'assistant.message' && streaming) {
        process.stdout.write('\n');
        streaming = false;
        continue;
      }

      const rendered = renderEvent(event);
      if (rendered !== undefined) {
        if (streaming) {
          process.stdout.write('\n');
          streaming = false;
        }
        console.log(rendered);
      }
    }
  }

  rl.close();
}

main().catch((error: unknown) => {
  console.error('启动失败：', error);
  process.exitCode = 1;
});
