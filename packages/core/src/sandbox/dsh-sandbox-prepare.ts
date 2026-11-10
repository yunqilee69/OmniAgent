import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { probeDshSandbox } from './dsh-sandbox.ts';
import type { DshSandboxCapability } from './dsh-sandbox.ts';

export interface DshSandboxPreparation {
  status: 'ready' | 'unavailable' | 'unsupported';
  capability: DshSandboxCapability;
  detail: string;
}

interface PreparationOptions {
  platform?: string;
  interactive?: boolean;
  probe?: () => DshSandboxCapability;
  exists?: (path: string) => boolean;
  trusted?: (path: string) => boolean;
  confirm?: (message: string) => Promise<boolean>;
  install?: (command: string, args: string[]) => Promise<number | null>;
  uid?: number;
}

const managers = [
  { path: '/usr/bin/apt-get', args: ['install', '-y', 'bubblewrap'] },
  { path: '/usr/bin/dnf', args: ['install', '-y', 'bubblewrap'] },
  { path: '/usr/bin/pacman', args: ['-S', '--needed', '--noconfirm', 'bubblewrap'] },
];

function trustedSystemPath(path: string): boolean {
  try {
    let current = realpathSync(path);
    for (;;) {
      const entry = statSync(current);
      if (entry.uid !== 0 || (entry.mode & 0o022) !== 0) return false;
      if (current === '/') return true;
      current = dirname(current);
    }
  } catch {
    return false;
  }
}

async function confirmInstall(message: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`${message} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function installPackage(command: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: '/', stdio: 'inherit', timeout: 300_000,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: process.env.LANG ?? 'C', TERM: process.env.TERM ?? 'dumb' },
    });
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  });
}

export async function prepareDshSandbox(options: PreparationOptions = {}): Promise<DshSandboxPreparation> {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? probeDshSandbox;
  if (platform !== 'linux') return { status: 'unsupported', capability: { attempts: [] }, detail: 'Linux only' };
  let capability = probe();
  if (capability.selected) return { status: 'ready', capability, detail: `Using ${capability.selected}` };
  const unavailable = (detail: string): DshSandboxPreparation => ({ status: 'unavailable', capability, detail });
  const exists = options.exists ?? existsSync;
  const trusted = options.trusted ?? trustedSystemPath;
  const diagnostics = () => capability.attempts.map((attempt) => attempt.detail).join('; ');
  if (exists('/usr/bin/bwrap')) {
    return unavailable(`Installed bubblewrap is not usable: ${diagnostics()}. Check kernel and user namespace settings or install a trusted Landlock runner (see README).`);
  }
  const manager = managers.find((candidate) => exists(candidate.path) && trusted(candidate.path));
  if (!manager) return unavailable(`No supported trusted package manager found. Install bubblewrap or a trusted Landlock runner; ${diagnostics()}`);
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!interactive) return unavailable(`No interactive terminal for installing bubblewrap. Run ${manager.path} ${manager.args.join(' ')} as administrator and restart; ${diagnostics()}`);
  const uid = options.uid ?? process.getuid?.();
  const sudo = '/usr/bin/sudo';
  if (uid !== 0 && (!exists(sudo) || !trusted(sudo))) return unavailable(`A trusted sudo is unavailable. Run ${manager.path} ${manager.args.join(' ')} as administrator.`);
  const approved = await (options.confirm ?? confirmInstall)(`OmniAgent needs a Linux sandbox. Install bubblewrap with ${uid === 0 ? '' : 'sudo '}${manager.path} ${manager.args.join(' ')}?`);
  if (!approved) return unavailable('Sandbox installation declined. Install bubblewrap or a trusted Landlock runner to enable restricted shell commands.');
  const code = await (options.install ?? installPackage)(uid === 0 ? manager.path : sudo, uid === 0 ? manager.args : [manager.path, ...manager.args]);
  capability = probe();
  if (capability.selected) return { status: 'ready', capability, detail: `Using ${capability.selected}` };
  return unavailable(`bubblewrap installation ${code === 0 ? 'completed but the sandbox is not usable' : `failed (exit ${code ?? 'unknown'})`}: ${diagnostics()}`);
}
