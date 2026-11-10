import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type SandboxResult = { status: 'ready' | 'unavailable' | 'unsupported'; detail: string };
type SandboxLoader = () => Promise<{ prepareDshSandbox: () => Promise<SandboxResult> }>;

export async function prepareLinuxSandbox(options: {
  platform?: NodeJS.Platform;
  load?: SandboxLoader;
  warn?: (message: string) => void;
} = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== 'linux') return;

  const warn = options.warn ?? ((message: string) => console.error(message));
  try {
    const { prepareDshSandbox } = await (options.load ?? (() => import('../packages/core/src/sandbox/dsh-sandbox-prepare.ts')))();
    const result = await prepareDshSandbox();
    if (result.status !== 'ready') warn(`[OmniAgent] Linux sandbox preparation failed: ${result.detail || 'unknown reason'}`);
  } catch (error) {
    warn(`[OmniAgent] Linux sandbox preparation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareLinuxSandbox();
}
