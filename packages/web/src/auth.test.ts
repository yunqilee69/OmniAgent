import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '@omniagent/core';
import { PermissionSettings } from './permissions';
import { ModelSettings } from './model-settings';
import { RoleSettings } from './catalog-settings';
import { parseWebPort, startWebHost, createWebHost } from './server';
import type { WebHost, WebHostOptions } from './server';
import { WorkspaceRegistry } from './workspaces';

const hosts: WebHost[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(extra: Partial<WebHostOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'omni-web-auth-'));
  roots.push(root);
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const workspace = await workspaces.add(root);
  const store = new SessionStore(join(root, 'sessions'));
  const host = await startWebHost({ workspaces, store, ...extra });
  hosts.push(host);
  return { root, workspace, host, base: host.address()! };
}

function rawStatus(base: string, host: string): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: Number(url.port), path: '/api/auth/status', headers: { host } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end();
  });
}

function post(base: string, body: unknown, cookie?: string): RequestInit {
  return { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) };
}

const auth = { enabled: true, username: 'alice', password: 'password-secret' };
async function login(base: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/login`, post(base, { username: 'alice', password: 'password-secret' }));
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!;
}

describe('web authentication', () => {
  it('validates port overrides', () => {
    expect(parseWebPort(undefined, 5000)).toBe(5000);
    expect(parseWebPort('4321', 5000)).toBe(4321);
    for (const value of ['', '0', '65536', '-1', '1.5', 'NaN', ' 123', '1e3']) expect(() => parseWebPort(value, 4317)).toThrow();
  });

  it('supports disabled auth and validates configured credentials', async () => {
    expect(() => createWebHost({ auth: { enabled: true } } as WebHostOptions)).toThrow();
    const { base } = await setup();
    expect(await (await fetch(`${base}/api/auth/status`)).json()).toEqual({ enabled: false, authenticated: true });
    expect((await fetch(`${base}/api/models`)).status).toBe(200);
  });

  it('protects APIs, validates Origin, rotates sessions and logs out', async () => {
    const { base } = await setup({ auth });
    expect(await (await fetch(`${base}/api/auth/status`)).json()).toEqual({ enabled: true, authenticated: false });
    for (const path of ['/api/models', '/api/workspaces', '/api/workspaces/x/sessions/y/messages']) {
      expect((await fetch(`${base}${path}`)).status).toBe(401);
    }
    expect((await fetch(`${base}/api/auth/login`, { ...post(base, auth), headers: { 'content-type': 'application/json' } })).status).toBe(403);
    expect((await fetch(`${base}/api/auth/login`, { ...post(base, auth), headers: { origin: 'http://evil.example', 'content-type': 'application/json' } })).status).toBe(403);
    expect((await fetch(`${base}/api/auth/login`, post(base, { username: 'alice', password: 'wrong' }))).status).toBe(401);
    const cookie = await login(base);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Max-Age=43200/);
    const token = cookie.split(';')[0]!;
    expect(await (await fetch(`${base}/api/auth/status`, { headers: { cookie: token } })).json()).toEqual({ enabled: true, authenticated: true });
    expect((await fetch(`${base}/api/models`, { headers: { cookie: token } })).status).toBe(200);
    expect((await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { cookie: token, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const rotated = await fetch(`${base}/api/auth/login`, post(base, { username: 'alice', password: 'password-secret' }, token));
    expect((await fetch(`${base}/api/models`, { headers: { cookie: token } })).status).toBe(401);
    const newToken = rotated.headers.get('set-cookie')!.split(';')[0]!;
    const logout = await fetch(`${base}/api/auth/logout`, post(base, {}, newToken));
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(`${base}/api/models`, { headers: { cookie: newToken } })).status).toBe(401);
  });

  it('rate limits failed and malformed login requests', async () => {
    const { base } = await setup({ auth });
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/api/auth/login`, post(base, { password: 'bad' }))).status).toBe(401);
    const limited = await fetch(`${base}/api/auth/login`, post(base, auth));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('accepts only local interface addresses on wildcard binding', async () => {
    const { base } = await setup({ host: '0.0.0.0', auth });
    expect((await fetch(`${base}/api/auth/status`)).status).toBe(200);
    const port = new URL(base).port;
    for (const host of [`attacker.example:${port}`, `192.0.2.1:${port}`, `127.0.0.1:${port}/x`]) {
      expect(await rawStatus(base, host)).toBe(403);
    }
  });

  it('expires and revokes an active SSE response', async () => {
    let interrupt!: () => void;
    const stopped = new Promise<void>((resolve) => { interrupt = resolve; });
    const { base, workspace, host } = await setup({ auth, createSession: (_workspace, handle) => ({
      id: handle.id,
      async *send() { await stopped; },
      interrupt,
    }) });
    const token = (await login(base)).split(';')[0]!;
    const created = await fetch(`${base}/api/workspaces/${workspace.id}/sessions`, post(base, {}, token));
    const { session } = await created.json() as { session: { id: string } };
    const url = `${base}/api/workspaces/${workspace.id}/sessions/${session.id}/messages`;
    const stream = await fetch(url, post(base, { text: 'hello' }, token));
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 12 * 60 * 60 * 1000 + 1);
    expect((await fetch(`${base}/api/models`, { headers: { cookie: token } })).status).toBe(401);
    await expect(stream.text()).rejects.toThrow();
    expect(host.server.listening).toBe(true);
    vi.restoreAllMocks();
  });

  it('validates the Vite proxy origin and forwards authenticated requests to the configured port', async () => {
    const { base: backend } = await setup({ auth });
    const originalPort = process.env.OMNIAGENT_PORT;
    process.env.OMNIAGENT_PORT = new URL(backend).port;
    let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
    try {
      vite = await createViteServer({
        configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
        logLevel: 'silent',
        server: { port: 18181, host: '127.0.0.1', strictPort: false },
      });
      await vite.listen();
      const address = vite.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Missing Vite address');
      const base = `http://127.0.0.1:${address.port}`;
      expect(await (await fetch(`${base}/api/auth/status`)).json()).toEqual({ enabled: true, authenticated: false });
      expect((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
      expect((await fetch(`${base}/api/auth/login`, { ...post(base, auth), headers: { origin: 'http://evil.example', 'content-type': 'application/json' } })).status).toBe(403);
      expect(await rawStatus(base, `attacker.example:${address.port}`)).toBe(403);
      const token = (await login(base)).split(';')[0]!;
      expect((await fetch(`${base}/api/models`, { headers: { cookie: token } })).status).toBe(200);
    } finally {
      await vite?.close();
      if (originalPort === undefined) delete process.env.OMNIAGENT_PORT;
      else process.env.OMNIAGENT_PORT = originalPort;
    }
  });

  it('does not expose web password through settings or model APIs', async () => {
    const { root } = await setup();
    const path = join(root, 'config.json');
    await writeFile(path, JSON.stringify({ web: { auth } }));
    const settings = await PermissionSettings.open(path);
    const modelSettings = await ModelSettings.open(path);
    const roleSettings = await RoleSettings.open(path);
    expect(settings.configSnapshot().web.auth.enabled).toBe(true);
    const { base } = await setup({ auth, permissionSettings: settings, modelSettings, roleSettings });
    const token = (await login(base)).split(';')[0]!;
    for (const route of ['/api/models', '/api/settings/permissions', '/api/settings/model-sources', '/api/settings/roles']) {
      const response = await fetch(`${base}${route}`, { headers: { cookie: token } });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(auth.password);
    }
    await writeFile(path, `{"web":"${auth.password}" invalid`);
    const failed = await fetch(`${base}/api/settings/model-sources`, { headers: { cookie: token } });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await failed.text()).not.toContain(auth.password);
  });
});
