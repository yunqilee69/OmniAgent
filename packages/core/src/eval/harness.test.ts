import { describe, expect, it } from 'vitest';
import { textResponse, toolCallResponse } from '../providers/fake';
import { runEvalCase, runEvalSuite } from './harness';

/**
 * harness 自己也要有测试：它会跑真实的 Session、权限门和文件系统。
 */

describe('eval harness', () => {
  it('跑通一个读取文件的用例', async () => {
    const result = await runEvalCase({
      name: 'read',
      files: { 'docs/hello.txt': '你好\n' },
      steps: [
        toolCallResponse([{ name: 'list_dir', args: { path: 'docs' } }]),
        toolCallResponse([{ name: 'read_file', args: { path: 'docs/hello.txt' } }]),
        textResponse('内容是：你好'),
      ],
      expect: {
        stopReason: 'end_turn',
        tools: ['list_dir', 'read_file'],
        finalText: /你好/,
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('断言不通过时给出具体原因', async () => {
    const result = await runEvalCase({
      name: 'wrong-expectation',
      steps: [textResponse('ok')],
      expect: { tools: ['write_file'] },
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('工具调用');
  });

  it('deny 规则阻止文件落盘，模型能看到拒绝结果', async () => {
    const result = await runEvalCase({
      name: 'deny-write',
      steps: [
        toolCallResponse([{ name: 'write_file', args: { path: 'secret.txt', content: 'x' } }]),
        textResponse('被拒绝了'),
      ],
      permissions: { deny: ['write_file(./secret.txt)'] },
      expect: {
        stopReason: 'end_turn',
        decisions: ['deny'],
        absentFiles: ['secret.txt'],
        finalText: '被拒绝了',
      },
    });

    expect(result.failures).toEqual([]);
  });

  it('suite 汇总通过数', async () => {
    const suite = await runEvalSuite([
      { name: 'pass', steps: [textResponse('ok')], expect: {} },
      { name: 'fail', steps: [textResponse('ok')], expect: { stopReason: 'max_steps' } },
    ]);

    expect(suite.passed).toBe(1);
    expect(suite.failed).toBe(1);
  });
});
