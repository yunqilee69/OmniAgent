import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from '../../domain/tool';
import { DshSandboxError, DshSandboxUnavailableError, dshWorkspaceWritableRoots } from '../../sandbox/dsh-policy';
import type { DshSandboxPolicy } from '../../sandbox/dsh-policy';
import { assertNoHardlinkedFiles } from '../../sandbox/dsh-hardlinks';
import { confineDshArgv } from '../../sandbox/dsh-sandbox';
import type { DshSandboxOptions } from '../../sandbox/dsh-sandbox';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_BYTES = 16_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 500;

export interface DshShellRequest {
  readonly command: string;
  /** Supplied by trusted host code for this call, never by the model. */
  readonly policy: DshSandboxPolicy;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Per-stream retained byte limit, with no spill file. */
  readonly maxOutputBytes?: number;
  /** Extra arguments after bash -c's command; not exposed by the Tool. */
  readonly shellArgs?: readonly string[];
  readonly sandbox?: DshSandboxOptions;
}

export interface DshShellResult {
  readonly argv: readonly string[];
  readonly backend: 'seatbelt' | 'bwrap' | 'landlock' | 'none';
  readonly enforcement: 'full' | 'none';
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

function budget(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new DshSandboxError(`${name} must be an integer between 1 and ${max}`, 'SANDBOX_INVALID_REQUEST');
  }
  return value;
}

/** Match DSH's ambient credential scrub and prevent loader injection into the sandbox runner. */
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /KEY|PASSWORD|SECRET|TOKEN/i.test(key) || /^DSH_/i.test(key)
      || /^(LD_|DYLD_)/i.test(key) || /^(BASH_ENV|ENV|NODE_OPTIONS)$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' };
}

/**
 * Run bash through the exact confined argv. The file sandbox does not restrict reads,
 * network, or access to local web/control-plane endpoints. A process group is signalled
 * on cancellation, timeout, or shell exit; a descendant that deliberately creates a new
 * session can escape process-group cleanup. This is not a container or hostile-code VM.
 */
export async function executeDshShell(request: DshShellRequest): Promise<DshShellResult> {
  const timeoutMs = budget('timeoutMs', request.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxOutputBytes = budget('maxOutputBytes', request.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
  if (typeof request.command !== 'string' || request.command.includes('\0')) {
    throw new DshSandboxError('Invalid shell command', 'SANDBOX_INVALID_REQUEST');
  }
  const policy: DshSandboxPolicy = {
    ...request.policy,
    additionalWritableRoots: request.policy.additionalWritableRoots?.slice(),
  };
  const cwd = request.cwd ?? policy.workspaceRoot;
  const signal = request.signal;
  signal?.throwIfAborted();
  const wrapped = await confineDshArgv(['/bin/bash', '-c', request.command, ...(request.shellArgs ?? [])], policy, request.sandbox);
  signal?.throwIfAborted();
  if (policy.mode === 'workspace-write' && process.platform !== 'win32') {
    // Path-based sandboxes cannot distinguish a writable path from an external
    // inode reached through a pre-existing hard link. Scan immediately before
    // spawning; a same-user race after this check remains possible.
    await assertNoHardlinkedFiles(await dshWorkspaceWritableRoots(policy));
  }

  return new Promise<DshShellResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let finished = false;
    let childExited = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
      cwd, env: childEnvironment(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const send = (signalName: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signalName);
      }
    };
    const terminate = (): void => {
      if (escalation) return;
      send('SIGTERM');
      escalation = setTimeout(() => {
        send('SIGKILL');
        // A detached descendant can keep inherited pipes open after its group dies.
        drainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, KILL_GRACE_MS);
        drainTimer.unref();
      }, KILL_GRACE_MS);
      escalation.unref();
    };
    const onAbort = (): void => {
      if (timedOut || aborted || finished) return;
      aborted = true;
      terminate();
    };
    const deadline = setTimeout(() => {
      if (aborted || finished) return;
      timedOut = true;
      terminate();
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) stdoutTruncated = true;
      if (remaining > 0) {
        const retained = Buffer.from(chunk.subarray(0, remaining));
        stdout.push(retained);
        stdoutBytes += retained.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = maxOutputBytes - stderrBytes;
      if (chunk.length > remaining) stderrTruncated = true;
      if (remaining > 0) {
        const retained = Buffer.from(chunk.subarray(0, remaining));
        stderr.push(retained);
        stderrBytes += retained.length;
      }
    });
    child.once('exit', () => {
      childExited = true;
      if (!timedOut && !aborted) terminate();
    });
    const cleanup = (): void => {
      finished = true;
      clearTimeout(deadline);
      // Once the leader has exited, kill its group immediately before reaping the
      // handle. A delayed group signal after settlement could hit a reused PID.
      if (childExited && escalation) send('SIGKILL');
      if (escalation) clearTimeout(escalation);
      if (drainTimer) clearTimeout(drainTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (exitCode, exitSignal) => {
      if (finished) return;
      cleanup();
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      const lower = err.toLowerCase();
      const runnerFailure = exitCode !== 0 && exitCode !== null && (
        (wrapped.backend === 'bwrap' && lower.includes('bwrap: '))
        || (wrapped.backend === 'seatbelt' && lower.includes('sandbox-exec: '))
        || (wrapped.backend === 'landlock' && exitCode === 125 && lower.includes('landlock-run: '))
      );
      if (runnerFailure && !timedOut && !aborted) {
        reject(new DshSandboxUnavailableError(`${wrapped.backend} rejected execution: ${err}`));
        return;
      }
      resolve({
        argv: wrapped.argv, backend: wrapped.backend, enforcement: wrapped.enforcement,
        stdout: out, stderr: err, stdoutTruncated, stderrTruncated, exitCode, signal: exitSignal, timedOut, aborted,
      });
    });
  });
}

const ShellParameters = z.object({
  command: z.string().describe('Bash command to execute.'),
  timeout_ms: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
  sandbox_permissions: z.enum(['workspace-write', 'danger-full-access']).optional()
    .describe('Request a wider sandbox for this call; subject to approval.'),
  justification: z.string().optional().describe('Reason for the requested sandbox escalation.'),
}).strict();

const ExecutableParameters = z.object({
  command: z.string(),
  timeout_ms: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
}).strict();

/**
 * The loop must validate/approve and remove escalation fields before calling execute,
 * then construct a new tool for the approved policy. Unprocessed fields fail closed.
 */
export function createDshShellTool(options: { readonly policy: DshSandboxPolicy; readonly sandbox?: DshSandboxOptions }): Tool {
  const policy = { ...options.policy, additionalWritableRoots: options.policy.additionalWritableRoots?.slice() };
  const sandbox = options.sandbox && { ...options.sandbox };
  return {
    name: 'bash',
    description: 'Execute a bash command under the approved sandbox policy.',
    parameters: ShellParameters,
    mutating: true,
    async execute(args, ctx) {
      if (args && typeof args === 'object' && ('sandbox_permissions' in args || 'justification' in args)) {
        throw new DshSandboxError('Sandbox escalation arguments must be approved and removed before execution', 'SANDBOX_ESCALATION_UNPROCESSED');
      }
      const parsed = ExecutableParameters.parse(args);
      const result = await executeDshShell({ command: parsed.command, timeoutMs: parsed.timeout_ms, cwd: ctx.cwd, signal: ctx.signal, policy, sandbox });
      const status = result.timedOut ? 'timed out' : result.aborted ? 'cancelled' : `exit code: ${result.exitCode ?? result.signal}`;
      const content = `${status}\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}`;
      return {
        content,
        ...(result.exitCode !== 0 || result.signal !== null || result.timedOut || result.aborted ? { ok: false } : {}),
        ...(result.stdoutTruncated || result.stderrTruncated ? { truncated: true } : {}),
      };
    },
  };
}
