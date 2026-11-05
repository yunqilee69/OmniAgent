import { textResponse, toolCallResponse } from '../../providers/fake';
import type { EvalCase } from '../harness';

/**
 * 最小任务集：覆盖只读访问、只读写入拒绝和工作区内写入。
 *
 * 这些 case 用 FakeModel，所以断言的是「循环 + DSH 权限 + 工具」而不是模型智商。
 * 要评估真实模型，把 steps 换成 runEvalCase 的 model 参数即可。
 */
export const basicSuite: EvalCase[] = [
  {
    name: '读取文件后回答',
    permissionPreset: 'read-only',
    files: {
      'docs/hello.txt': '你好，OmniAgent\n',
    },
    steps: [
      toolCallResponse([{ name: 'list_dir', args: { path: 'docs' } }]),
      toolCallResponse([{ name: 'read_file', args: { path: 'docs/hello.txt' } }]),
      textResponse('文件内容是：你好，OmniAgent'),
    ],
    expect: {
      stopReason: 'end_turn',
      tools: ['list_dir', 'read_file'],
      finalText: /你好，OmniAgent/,
    },
  },
  {
    name: '只读预设阻止写文件',
    permissionPreset: 'read-only',
    steps: [
      toolCallResponse([{ name: 'write_file', args: { path: 'secret.txt', content: 'x' } }]),
      textResponse('写文件被拒绝了。'),
    ],
    expect: {
      stopReason: 'end_turn',
      decisions: ['allow'],
      absentFiles: ['secret.txt'],
      finalText: /拒绝/,
    },
  },
  {
    name: 'workspace-write 下写文件并落盘',
    permissionPreset: 'workspace-write',
    steps: [
      toolCallResponse([{ name: 'write_file', args: { path: 'out.txt', content: 'hello' } }]),
      textResponse('已写入。'),
    ],
    expect: {
      stopReason: 'end_turn',
      decisions: ['allow'],
      files: { 'out.txt': 'hello' },
    },
  },
];
