export type SandboxProfile = 'read-only' | 'workspace-write' | 'danger-full-access';
export type SandboxPlatform = NodeJS.Platform | string;

export interface SandboxCommand {
  executable: string;
  args: string[];
}

export class SandboxUnavailableError extends Error {
  constructor(platform: string) {
    super(`No supported OS sandbox runner is available for ${platform}`);
    this.name = 'SandboxUnavailableError';
  }
}

export function sandboxCommand(
  platform: SandboxPlatform,
  profile: SandboxProfile,
  workspace: string,
  executable: string,
  command = 'printf %s "$1"',
  args: string[] = ['hello'],
): SandboxCommand {
  if (platform === 'darwin') {
    return {
      executable,
      args: ['-p', seatbeltProfile(profile, workspace), 'sh', '-c', command, '--', ...args],
    };
  }
  if (platform === 'linux') {
    return {
      executable,
      args: bubblewrapArgs(profile, workspace, command, args),
    };
  }
  throw new SandboxUnavailableError(platform);
}

export function createSandboxRunner(options: {
  platform?: SandboxPlatform;
  executable?: string;
  workspace?: string;
  profile?: SandboxProfile;
} = {}): (command: string, args: string[]) => SandboxCommand {
  const platform = options.platform ?? process.platform;
  const expectedExecutable = platform === 'darwin' ? 'sandbox-exec' : platform === 'linux' ? 'bwrap' : undefined;
  const executable = options.executable;
  if (!executable || !expectedExecutable) throw new SandboxUnavailableError(platform);
  return (command, args) => sandboxCommand(
    platform,
    options.profile ?? 'workspace-write',
    options.workspace ?? process.cwd(),
    executable,
    command,
    args,
  );
}

function seatbeltProfile(profile: SandboxProfile, workspace: string): string {
  if (profile === 'danger-full-access') return '(version 1)\n(allow default)';
  const escaped = workspace.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const writeRule = profile === 'workspace-write'
    ? `\n(allow file-write* (subpath "${escaped}"))`
    : '';
  return `(version 1)\n(deny default)\n(allow process*)\n(allow sysctl-read)\n(allow file-read*)${writeRule}`;
}

function bubblewrapArgs(
  profile: SandboxProfile,
  workspace: string,
  command: string,
  args: string[],
): string[] {
  if (profile === 'danger-full-access') return ['--dev-bind', '/', '/', '--', command, ...args];
  const result = ['--die-with-parent', '--unshare-all', '--proc', '/proc', '--dev', '/dev', '--ro-bind', '/usr', '/usr'];
  if (profile === 'workspace-write') result.push('--bind', workspace, workspace);
  else result.push('--ro-bind', workspace, workspace);
  result.push('--', command, ...args);
  return result;
}
