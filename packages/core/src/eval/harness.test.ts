import { describe, expect, it, vi } from 'vitest';
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
      permissionPreset: 'read-only',
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
      permissionPreset: 'read-only',
      steps: [textResponse('ok')],
      expect: { tools: ['write_file'] },
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('工具调用');
  });

  it('read-only preset prevents writes and reports the denial to the model', async () => {
    const result = await runEvalCase({
      name: 'read-only-write',
      permissionPreset: 'read-only',
      steps: [
        toolCallResponse([{ name: 'write_file', args: { path: 'secret.txt', content: 'x' } }]),
        textResponse('被拒绝了'),
      ],
      expect: {
        stopReason: 'end_turn',
        decisions: ['allow'],
        absentFiles: ['secret.txt'],
        finalText: '被拒绝了',
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.events.filter((event) => event.type === 'tool.result').map((event) =>
      event.type === 'tool.result' ? event.result.ok : undefined,
    )).toEqual([false]);
  });

  it('uses an explicit DSH workspace-write preset without asking for approval', async () => {
    const approve = vi.fn(async () => 'deny' as const);
    const result = await runEvalCase({
      name: 'dsh-workspace-write',
      steps: [
        toolCallResponse([{ name: 'write_file', args: { path: 'out.txt', content: 'hello' } }]),
        textResponse('已写入。'),
      ],
      permissionPreset: 'workspace-write',
      approve,
      expect: { decisions: ['allow'], files: { 'out.txt': 'hello' } },
    });

    expect(approve).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('does not translate legacy permission fields into DSH permission grants', async () => {
    const legacyPermissionFields = {
      mode: 'acceptEdits' as const,
      permissions: { allow: ['write_file'] },
    };
    const result = await runEvalCase({
      name: 'legacy-rules-do-not-authorize',
      permissionPreset: 'read-only',
      steps: [
        toolCallResponse([{ name: 'write_file', args: { path: 'out.txt', content: 'hello' } }]),
        textResponse('拒绝了。'),
      ],
      ...legacyPermissionFields,
      expect: { decisions: ['allow'], absentFiles: ['out.txt'] },
    });

    expect(result.failures).toEqual([]);
    expect(result.events.filter((event) => event.type === 'tool.result').map((event) =>
      event.type === 'tool.result' ? event.result.ok : undefined,
    )).toEqual([false]);
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
