import { describe, expect, it } from 'vitest';
import { SandboxUnavailableError, createSandboxRunner, sandboxCommand } from './runner';

describe('sandbox runner', () => {
  it('builds a macOS workspace-write profile without shell interpolation', () => {
    expect(sandboxCommand('darwin', 'workspace-write', '/tmp/project', 'sandbox-exec')).toEqual({
      executable: 'sandbox-exec',
      args: ['-p', expect.stringContaining('(allow file-read*)'), 'sh', '-c', 'printf %s "$1"', '--', 'hello'],
    });
  });

  it('fails closed when the required OS runner is unavailable', () => {
    expect(() => createSandboxRunner({ platform: 'linux', executable: undefined })).toThrow(
      SandboxUnavailableError,
    );
  });

  it('does not silently run unsandboxed on unsupported platforms', () => {
    expect(() => createSandboxRunner({ platform: 'freebsd', executable: undefined })).toThrow(
      SandboxUnavailableError,
    );
  });
});
