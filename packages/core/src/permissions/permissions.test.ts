import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '../domain/message';
import type { Rule } from '../protocol/permission';
import { readFileTool } from '../tools/builtin/read-file';
import {
  matchesAllSubcommands,
  matchesAnySubcommand,
  splitCommand,
} from './bash';
import { decide } from './evaluate';
import { parseRule, resolveRulePath } from './rules';

const cwd = '/work/project';

function bashCall(command: string, id = 'c1'): ToolCall {
  return { id, name: 'bash', arguments: { command } };
}

function readCall(path: string, id = 'c1'): ToolCall {
  return { id, name: 'read_file', arguments: { file_path: path } };
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
      call: bashCall('npm install && rm -rf /'),
      mode: 'bypass',
      rules: rules(['bash(npm *)', 'allow'], ['bash(rm *)', 'deny']),
      cwd,
    });
    expect(result.decision).toBe('deny');
  });

  it('ask 优先于 allow', () => {
    const result = decide({
      call: bashCall('git push origin main'),
      mode: 'default',
      rules: rules(['bash(git *)', 'allow'], ['bash(git push *)', 'ask']),
      cwd,
    });
    expect(result.decision).toBe('ask');
  });

  it('allow 放行整条命令的前提是每个子命令都命中', () => {
    const result = decide({
      call: bashCall('npm install && rm -rf build'),
      mode: 'default',
      rules: rules(['bash(npm *)', 'allow']),
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
      decide({ call: bashCall('ls'), mode: 'plan', rules: [], cwd }).decision,
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

  it.each(['deny', 'ask'] as const)(
    '%s conservatively matches case variants ahead of an allow', (decision) => {
      const result = decide({
        call: readCall('secret.txt'),
        mode: 'bypass',
        rules: rules(['read_file(./Secret.txt)', decision], ['read_file(*)', 'allow']),
        cwd,
      });
      expect(result.decision).toBe(decision);
    },
  );

  it('preserves deny over ask when matching case variants', () => {
    const result = decide({
      call: readCall('secret.txt'),
      mode: 'bypass',
      rules: rules(['read_file(./secret.txt)', 'ask'], ['read_file(./Secret.txt)', 'deny']),
      cwd,
    });
    expect(result.decision).toBe('deny');
  });

  it('conservatively matches composed and decomposed Unicode case variants', () => {
    const result = decide({
      call: readCall('cafe\u0301.txt'),
      mode: 'bypass',
      rules: rules(['read_file(./CAFÉ.txt)', 'deny']),
      cwd,
    });
    expect(result.decision).toBe('deny');
  });

  it('does not expand case-variant allow rules', () => {
    const result = decide({
      call: readCall('secret.txt'),
      mode: 'dontAsk',
      rules: rules(['read_file(./Secret.txt)', 'allow']),
      cwd,
    });
    expect(result.decision).toBe('deny');
  });

  it('keeps single-slash rules anchor-relative and double-slash rules absolute', () => {
    expect(resolveRulePath('/var/tmp/file', '/rule-anchor', cwd)).toBe('/rule-anchor/var/tmp/file');
    expect(resolveRulePath('//var/tmp/file', '/rule-anchor', cwd)).toBe('/var/tmp/file');
  });
});

describe('路径规则中的现有别名', () => {
  let fixture: string;
  let workspace: string;
  let alias: string;

  beforeEach(() => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'omniagent-permission-')));
    workspace = join(fixture, 'workspace');
    alias = join(fixture, 'workspace-alias');
    mkdirSync(workspace);
    symlinkSync(workspace, alias, 'dir');
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it.each(['deny', 'ask'] as const)(
    '%s matches an absolute alias with a real workspace and relative call', async (decision) => {
      writeFileSync(join(workspace, 'Secret.txt'), 'content');
      const call = readCall('Secret.txt');
      const rule = parseRule(`read_file(/${join(alias, 'Secret.txt')})`, decision, 'project', workspace);
      const output = await readFileTool.execute(call.arguments, {
        cwd: workspace,
        signal: new AbortController().signal,
      });
      expect(output.content).toContain('content');
      expect(decide({ call, mode: 'bypass', rules: [rule], cwd: workspace }).decision).toBe(decision);
    },
  );

  it('matches aliases before a glob and missing descendants', () => {
    const rule = parseRule(`write_file(/${join(alias, 'Secret', '**')})`, 'deny', 'project', workspace);
    const call: ToolCall = {
      id: 'c1',
      name: 'write_file',
      arguments: { file_path: 'secret/new/file.txt', content: 'x' },
    };
    expect(decide({ call, mode: 'bypass', rules: [rule], cwd: workspace }).decision).toBe('deny');
  });

  it('does not expand allow rules through workspace aliases', () => {
    writeFileSync(join(workspace, 'Secret.txt'), 'content');
    const rule = parseRule(`read_file(/${join(alias, 'Secret.txt')})`, 'allow', 'project', workspace);
    expect(decide({ call: readCall('Secret.txt'), mode: 'dontAsk', rules: [rule], cwd: workspace }).decision)
      .toBe('deny');
  });

  it('treats inaccessible rule prefixes as restrictive matches', (context) => {
    const inaccessible = join(fixture, 'inaccessible');
    mkdirSync(inaccessible);
    chmodSync(inaccessible, 0);
    try {
      try {
        realpathSync(join(inaccessible, 'secret'));
        context.skip();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EACCES') context.skip();
      }
      const rule = parseRule(`read_file(/${join(inaccessible, 'secret')})`, 'deny', 'project', workspace);
      expect(decide({ call: readCall('other.txt'), mode: 'bypass', rules: [rule], cwd: workspace }).decision)
        .toBe('deny');
    } finally {
      chmodSync(inaccessible, 0o700);
    }
  });

  it.skipIf(process.platform !== 'darwin')('matches //var rules for a /private/var workspace', async (context) => {
    if (!workspace.startsWith('/private/var/')) context.skip();
    const aliasWorkspace = workspace.replace(/^\/private\/var\//, '/var/');
    writeFileSync(join(workspace, 'Secret.txt'), 'content');
    const rule = parseRule(`read_file(/${join(aliasWorkspace, 'Secret.txt')})`, 'deny', 'project', workspace);
    const call = readCall('Secret.txt');
    const output = await readFileTool.execute(call.arguments, {
      cwd: workspace,
      signal: new AbortController().signal,
    });
    expect(output.content).toContain('content');
    expect(decide({ call, mode: 'bypass', rules: [rule], cwd: workspace }).decision).toBe('deny');
  });
});

describe('acceptEdits 模式下的受保护路径', () => {
  it('.git 里的写入仍然要问', () => {
    const result = decide({
      call: { id: 'c1', name: 'write_file', arguments: { file_path: '.git/config', content: 'x' } },
      mode: 'acceptEdits',
      rules: [],
      cwd,
    });
    expect(result.decision).toBe('ask');
  });

  it.each(['.GIT/config', '.OmniAgent/settings.json'])(
    'prompts for protected directory case variant %s', (path) => {
      const result = decide({
        call: { id: 'c1', name: 'write_file', arguments: { file_path: path, content: 'x' } },
        mode: 'acceptEdits',
        rules: [],
        cwd,
      });
      expect(result.decision).toBe('ask');
    },
  );

  it('普通文件编辑直接放行', () => {
    const result = decide({
      call: { id: 'c1', name: 'write_file', arguments: { file_path: 'src/a.ts', content: 'x' } },
      mode: 'acceptEdits',
      rules: [],
      cwd,
    });
    expect(result.decision).toBe('allow');
  });
});
