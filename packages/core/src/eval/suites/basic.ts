import { textResponse, toolCallResponse } from '../../providers/fake';
import type { EvalCase } from '../harness';

/**
 * 最小任务集：覆盖「读文件」「deny 规则」「acceptEdits 写文件」三条路径。
 *
 * 这些 case 用 FakeModel，所以断言的是「循环 + 权限 + 工具」而不是模型智商。
 * 要评估真实模型，把 steps 换成 runEvalCase 的 model 参数即可。
 */
export const basicSuite: EvalCase[] = [
  {
    name: '读取文件后回答',
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
    name: 'deny 规则阻止写文件',
    steps: [
      toolCallResponse([{ name: 'write_file', args: { path: 'secret.txt', content: 'x' } }]),
      textResponse('写文件被拒绝了。'),
    ],
    permissions: {
      deny: ['write_file(./secret.txt)'],
    },
    expect: {
      stopReason: 'end_turn',
      decisions: ['deny'],
      absentFiles: ['secret.txt'],
      finalText: /拒绝/,
    },
  },
  {
    name: 'acceptEdits 下写文件并落盘',
    steps: [
      toolCallResponse([{ name: 'write_file', args: { path: 'out.txt', content: 'hello' } }]),
      textResponse('已写入。'),
    ],
    mode: 'acceptEdits',
    expect: {
      stopReason: 'end_turn',
      decisions: ['allow'],
      files: { 'out.txt': 'hello' },
    },
  },
];
