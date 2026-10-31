import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../domain/message';
import type { Rule } from '../protocol/permission';
import {
  matchesAllSubcommands,
  matchesAnySubcommand,
  splitCommand,
} from './bash';
import { decide } from './evaluate';
import { parseRule } from './rules';

const cwd = '/work/project';

function shellCall(command: string, id = 'c1'): ToolCall {
  return { id, name: 'shell', arguments: { command } };
}

function readCall(path: string, id = 'c1'): ToolCall {
  return { id, name: 'read_file', arguments: { path } };
}

function rules(...entries: Array<[string, 'allow' | 'ask' | 'deny']>): Rule[] {
  return entries.map(([raw, decision]) => parseRule(raw, decision, 'project', cwd));
}

describe('splitCommand', () => {
  it('拆开复合命令', () => {
    expect(splitCommand('npm install && npm test')).toEqual(['npm install', 'npm test']);
    expect(splitCommand('a; b | c || d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('引号里的操作符不拆', () => {
    expect(splitCommand('echo "a && b" && ls')).toEqual(['echo "a && b"', 'ls']);
    expect(splitCommand("echo 'x; y'")).toEqual(["echo 'x; y'"]);
  });
});

describe('复合命令的匹配语义', () => {
  it('deny / ask：任一子命令命中就算命中', () => {
    expect(matchesAnySubcommand('rm *', 'npm install && rm -rf build')).toBe(true);
    expect(matchesAnySubcommand('rm *', 'npm install && npm test')).toBe(false);
  });

  it('allow：必须每个子命令都命中', () => {
    expect(matchesAllSubcommands('npm *', 'npm install && npm test')).toBe(true);
    expect(matchesAllSubcommands('npm *', 'npm install && rm -rf /')).toBe(false);
  });

  it('剥掉 timeout / nohup 之类的 wrapper 再匹配', () => {
    expect(matchesAnySubcommand('npm test', 'timeout 30 npm test')).toBe(true);
    expect(matchesAnySubcommand('npm test', 'nohup npm test')).toBe(true);
  });
});

describe('decide 的求值顺序', () => {
  it('deny 优先于更精确的 allow', () => {
    const result = decide({
      call: shellCall('npm install && rm -rf /'),
      mode: 'bypass',
      rules: rules(['shell(npm *)', 'allow'], ['shell(rm *)', 'deny']),
      cwd,
    });
    expect(result.decision).toBe('deny');
  });

  it('ask 优先于 allow', () => {
    const result = decide({
      call: shellCall('git push origin main'),
      mode: 'default',
      rules: rules(['shell(git *)', 'allow'], ['shell(git push *)', 'ask']),
      cwd,
    });
    expect(result.decision).toBe('ask');
  });

  it('allow 放行整条命令的前提是每个子命令都命中', () => {
    const result = decide({
      call: shellCall('npm install && rm -rf build'),
      mode: 'default',
      rules: rules(['shell(npm *)', 'allow']),
      cwd,
    });
    // rm 没被 allow 覆盖，落到模式默认 -> ask
    expect(result.decision).toBe('ask');
  });

  it('没有命中任何规则时按模式兜底', () => {
    expect(decide({ call: readCall('a.txt'), mode: 'plan', rules: [], cwd }).decision).toBe(
      'allow',
    );
    expect(
      decide({ call: shellCall('ls'), mode: 'plan', rules: [], cwd }).decision,
    ).toBe('deny');
    expect(decide({ call: readCall('a.txt'), mode: 'dontAsk', rules: [], cwd }).decision).toBe(
      'deny',
    );
  });
});

describe('路径规则', () => {
  it('./ 相对工作区，** 跨目录', () => {
    const result = decide({
      call: readCall('secrets/prod/keys.txt'),
      mode: 'bypass',
      rules: rules(['read_file(./secrets/**)', 'deny']),
      cwd,
    });
    expect(result.decision).toBe('deny');
  });

  it('deny 只命中指定文件，不误伤同级', () => {
    const denied = decide({
      call: readCall('.env'),
      mode: 'bypass',
      rules: rules(['read_file(./.env)', 'deny']),
      cwd,
    });
    const allowed = decide({
      call: readCall('.env.example'),
      mode: 'bypass',
      rules: rules(['read_file(./.env)', 'deny']),
      cwd,
    });
    expect(denied.decision).toBe('deny');
    expect(allowed.decision).toBe('allow');
  });
});

describe('workspace-write 模式', () => {
  it.each(['read_file', 'list_dir', 'write_file', 'edit_file'])(
    '自动允许普通工作区文件操作 %s',
    (name) => {
      const call = { id: 'c1', name, arguments: { path: 'src/a.ts' } };
      expect(decide({ call, mode: 'workspace-write', rules: [], cwd }).decision).toBe('allow');
    },
  );

  it.each(['.git/config', '.omniagent/config.json'])(
    '访问受保护路径 %s 仍需确认',
    (path) => {
      for (const name of ['read_file', 'list_dir', 'write_file', 'edit_file']) {
        const call = { id: 'c1', name, arguments: { path } };
        expect(decide({ call, mode: 'workspace-write', rules: [], cwd }).decision).toBe('ask');
      }
    },
  );

  it.each(['shell', 'unknown_tool'])(
    '其他工具 %s 仍需确认',
    (name) => {
      const call = { id: 'c1', name, arguments: {} };
      expect(decide({ call, mode: 'workspace-write', rules: [], cwd }).decision).toBe('ask');
    },
  );

  it('显式 deny 和 ask 优先于自动读写及 allow 规则', () => {
    for (const decision of ['deny', 'ask'] as const) {
      const result = decide({
        call: readCall('a.txt'),
        mode: 'workspace-write',
        rules: rules(['read_file', 'allow'], ['read_file', decision]),
        cwd,
      });
      expect(result.decision).toBe(decision);
    }
  });

  it('显式 allow 优先于模式的确认默认值', () => {
    const result = decide({
      call: { id: 'c1', name: 'write_file', arguments: { path: '.git/config' } },
      mode: 'workspace-write',
      rules: rules(['write_file', 'allow']),
      cwd,
    });
    expect(result.decision).toBe('allow');
  });
});

describe('acceptEdits 模式下的受保护路径', () => {
  it('.git 里的写入仍然要问', () => {
    const result = decide({
      call: { id: 'c1', name: 'write_file', arguments: { path: '.git/config', content: 'x' } },
      mode: 'acceptEdits',
      rules: [],
      cwd,
    });
    expect(result.decision).toBe('ask');
  });

  it('普通文件编辑直接放行', () => {
    const result = decide({
      call: { id: 'c1', name: 'write_file', arguments: { path: 'src/a.ts', content: 'x' } },
      mode: 'acceptEdits',
      rules: [],
      cwd,
    });
    expect(result.decision).toBe('allow');
  });
});
