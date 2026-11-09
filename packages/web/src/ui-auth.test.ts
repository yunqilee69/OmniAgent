import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../ui/src/lib/auth.ts';
import * as appStore from '../ui/src/lib/store.ts';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const status = (enabled: boolean, authenticated: boolean): Response => json({ enabled, authenticated });

afterEach(() => { vi.unstubAllGlobals(); });

describe('authentication gate', () => {
  it('replaces the workspace store and discards in-memory session data on reset', () => {
    const old = appStore.store;
    old.showAlert('previous user');
    appStore.resetStore();
    expect(appStore.store).not.toBe(old);
    expect(appStore.store.getSnapshot().alert).toBe('');
    expect(appStore.store.getSnapshot().entries).toEqual({});
  });
  it('prevents a disposed workspace from sending requests', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const old = new appStore.AppStore();
    old.dispose();
    await old.loadWorkspaces();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[false, false], [true, true]])('allows verified status enabled=%s authenticated=%s', async (enabled, authenticated) => {
    const fetcher = vi.fn().mockResolvedValue(status(enabled, authenticated));
    vi.stubGlobal('fetch', fetcher);
    const auth = new AuthController();
    expect(auth.getSnapshot()).toEqual({ phase: 'checking' });
    await auth.check();
    expect(auth.getSnapshot()).toEqual({ phase: 'ready', enabled });
    expect(fetcher).toHaveBeenCalledWith('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' });
  });

  it('fails closed on network errors, HTTP errors and malformed status, and can retry', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ enabled: false })).mockResolvedValueOnce(status(false, false));
    vi.stubGlobal('fetch', fetcher);
    const auth = new AuthController();
    for (let i = 0; i < 3; i++) {
      await auth.check();
      expect(auth.getSnapshot()).toEqual({ phase: 'error' });
      await expect(auth.request('/api/workspaces')).rejects.toThrow('Authentication required');
    }
    await auth.check();
    expect(auth.getSnapshot()).toEqual({ phase: 'ready', enabled: false });
  });

  it('submits credentials, handles failure and verifies status after successful login', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(status(true, false)).mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({})).mockResolvedValueOnce(status(true, true));
    vi.stubGlobal('fetch', fetcher);
    const auth = new AuthController();
    await auth.check();
    await auth.login('user', 'wrong');
    expect(auth.getSnapshot()).toEqual({ phase: 'login', expired: false, busy: false, error: 'credentials' });
    await auth.login('user', 'secret');
    expect(fetcher.mock.calls[2]).toEqual(['/api/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'user', password: 'secret' }),
    }]);
    expect(auth.getSnapshot()).toEqual({ phase: 'ready', enabled: true });
  });

  it('does not trust a successful login when subsequent status fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(status(true, false)).mockResolvedValueOnce(json({})).mockRejectedValueOnce(new Error('offline')));
    const auth = new AuthController();
    await auth.check();
    await auth.login('user', 'secret');
    expect(auth.getSnapshot()).toEqual({ phase: 'error' });
  });

  it('locks on 401, aborts concurrent work, and never retries a mutation', async () => {
    let pendingSignal: AbortSignal | undefined;
    const fetcher = vi.fn().mockResolvedValueOnce(status(true, true)).mockImplementationOnce((_url, init) => {
      pendingSignal = init.signal;
      return new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }).mockResolvedValueOnce(json({}, 401));
    vi.stubGlobal('fetch', fetcher);
    const auth = new AuthController();
    await auth.check();
    const pending = auth.request('/api/stream');
    const pendingResult = expect(pending).rejects.toThrow('aborted');
    const response = await auth.request('/api/mutate', { method: 'POST' });
    await pendingResult;
    expect(response.status).toBe(401);
    expect(pendingSignal?.aborted).toBe(true);
    expect(auth.getSnapshot()).toEqual({ phase: 'login', expired: true, busy: false, error: null });
    await expect(auth.request('/api/mutate', { method: 'POST' })).rejects.toThrow('Authentication required');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('ignores an old 401 after a new login', async () => {
    let resolveOld!: (response: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(status(true, true))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({})).mockResolvedValueOnce(status(true, true));
    vi.stubGlobal('fetch', fetcher);
    const auth = new AuthController();
    await auth.check();
    const old = auth.request('/api/old');
    await auth.logout();
    await auth.login('user', 'secret');
    resolveOld(json({}, 401));
    await expect(old).rejects.toThrow('Authentication state changed');
    expect(auth.getSnapshot()).toEqual({ phase: 'ready', enabled: true });
  });

  it('locks immediately during logout and stays locked if it fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(status(true, true)).mockResolvedValueOnce(json({}, 500)));
    const auth = new AuthController();
    await auth.check();
    const result = auth.logout();
    expect(auth.getSnapshot()).toEqual({ phase: 'login', expired: false, busy: true, error: null });
    await result;
    expect(auth.getSnapshot()).toEqual({ phase: 'login', expired: false, busy: false, error: 'network' });
    await expect(auth.request('/api/workspaces')).rejects.toThrow();
  });
});
