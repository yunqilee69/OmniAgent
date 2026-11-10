import { describe, expect, it, vi } from 'vitest';
import { prepareDshSandbox } from './dsh-sandbox-prepare';
import type { DshSandboxCapability } from './dsh-sandbox';

const unavailable: DshSandboxCapability = { attempts: [{ backend: 'bwrap', usable: false, detail: 'namespace denied' }] };
const ready: DshSandboxCapability = { selected: 'bwrap', attempts: [{ backend: 'bwrap', usable: true, detail: 'usable' }] };
const defaults = {
  platform: 'linux', interactive: true, uid: 1000,
  exists: (path: string) => path === '/usr/bin/apt-get' || path === '/usr/bin/sudo',
  trusted: () => true,
};

describe('Linux sandbox preparation', () => {
  it('does nothing outside Linux', async () => {
    const probe = vi.fn();
    expect((await prepareDshSandbox({ platform: 'darwin', probe })).status).toBe('unsupported');
    expect(probe).not.toHaveBeenCalled();
  });

  it('uses a working backend without installing', async () => {
    const install = vi.fn();
    const result = await prepareDshSandbox({ ...defaults, probe: () => ready, install });
    expect(result.status).toBe('ready');
    expect(install).not.toHaveBeenCalled();
  });

  it('installs the distribution package only after confirmation and verifies it', async () => {
    const probe = vi.fn().mockReturnValueOnce(unavailable).mockReturnValueOnce(ready);
    const install = vi.fn().mockResolvedValue(0);
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await prepareDshSandbox({ ...defaults, probe, install, confirm });
    expect(result.status).toBe('ready');
    expect(confirm).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith('/usr/bin/sudo', ['/usr/bin/apt-get', 'install', '-y', 'bubblewrap']);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not prompt or install without a terminal', async () => {
    const confirm = vi.fn();
    const install = vi.fn();
    const result = await prepareDshSandbox({ ...defaults, interactive: false, probe: () => unavailable, confirm, install });
    expect(result.status).toBe('unavailable');
    expect(result.detail).toContain('No interactive terminal');
    expect(confirm).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('does not install if the user declines or the manager is untrusted', async () => {
    const install = vi.fn();
    const declined = await prepareDshSandbox({ ...defaults, probe: () => unavailable, confirm: async () => false, install });
    const untrusted = await prepareDshSandbox({ ...defaults, probe: () => unavailable, trusted: () => false, install });
    expect(declined.detail).toContain('declined');
    expect(untrusted.detail).toContain('trusted package manager');
    expect(install).not.toHaveBeenCalled();
  });

  it('reports an unusable installed backend without reinstalling', async () => {
    const install = vi.fn();
    const result = await prepareDshSandbox({ ...defaults, exists: () => true, probe: () => unavailable, install });
    expect(result.status).toBe('unavailable');
    expect(result.detail).toContain('namespace denied');
    expect(install).not.toHaveBeenCalled();
  });

  it('fails closed if installation fails or the installed backend cannot run', async () => {
    for (const exit of [0, 1, null]) {
      const result = await prepareDshSandbox({ ...defaults, probe: () => unavailable, confirm: async () => true, install: async () => exit });
      expect(result.status).toBe('unavailable');
      expect(result.detail).toContain('namespace denied');
    }
  });
});
