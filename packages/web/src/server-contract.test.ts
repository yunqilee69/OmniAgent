import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startWebHost } from './server';

const hosts: Array<Awaited<ReturnType<typeof startWebHost>>> = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function emptyWorkspaces() {
  return {
    async list() { return []; },
    async get() { return undefined; },
    async add() { throw new Error('unexpected'); },
    async remove() { return false; },
    async touch() { return undefined; },
  };
}

async function staticFixture(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'omniagent-web-'));
  directories.push(parent);
  const directory = join(parent, 'dist');
  await mkdir(join(directory, 'assets'), { recursive: true });
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
  await writeFile(join(directory, 'assets', 'app-abc123.js'), 'console.log("app");');
  await writeFile(join(directory, 'assets', 'app-abc123.css'), ':root { color-scheme: light dark; }');
  await writeFile(join(parent, 'secret.txt'), 'DO NOT SERVE');
  return directory;
}

async function staticHost(staticDir: string) {
  const host = await startWebHost({
    workspaces: emptyWorkspaces(),
    store: {} as never,
    createSession: async () => { throw new Error('unexpected session creation'); },
    staticDir,
  });
  hosts.push(host);
  return host;
}

describe('workspace API contract', () => {
  it('returns registered workspaces from the registry', async () => {
    const workspace = { id: 'work-1', name: 'Project', path: '/tmp/project', lastUsedAt: 1 };
    const host = await startWebHost({
      workspaces: {
        async list() { return [workspace]; },
        async get() { return workspace; },
        async add() { return workspace; },
        async remove() { return true; },
        async touch() { return workspace; },
      },
      store: {} as never,
      createSession: async () => { throw new Error('unexpected session creation'); },
    });
    hosts.push(host);
    const response = await fetch(`${host.address()}/api/workspaces`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaces: [workspace] });
  });

  it('serves the workbench document with a restrictive document policy', async () => {
    const host = await staticHost(await staticFixture());
    const response = await fetch(`${host.address()}/`);
    expect(response.status).toBe(200);
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('id="root"');
  });

  it('serves hashed assets with their MIME type and immutable caching', async () => {
    const host = await staticHost(await staticFixture());
    const script = await fetch(`${host.address()}/assets/app-abc123.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await script.text()).toContain('console.log');

    const style = await fetch(`${host.address()}/assets/app-abc123.css`);
    expect(style.status).toBe(200);
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('falls back to the document for navigation and 404s missing assets', async () => {
    const host = await staticHost(await staticFixture());
    const navigation = await fetch(`${host.address()}/sessions/shared`);
    expect(navigation.status).toBe(200);
    expect(navigation.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await navigation.text()).toContain('id="root"');

    const missing = await fetch(`${host.address()}/assets/missing.js`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('Not found');
  });

  it('does not serve files outside the static directory', async () => {
    const host = await staticHost(await staticFixture());
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt']) {
      const response = await fetch(`${host.address()}${path}`);
      expect(await response.text()).not.toContain('DO NOT SERVE');
      expect([200, 404]).toContain(response.status);
      expect(response.status).not.toBe(500);
    }
    const encoded = await fetch(`${host.address()}/..%2Fsecret.txt`);
    expect(encoded.status).toBe(404);
  });

  it('explains how to build the client when the static directory is absent', async () => {
    const host = await staticHost(join(tmpdir(), 'omniagent-web-missing-build'));
    const response = await fetch(`${host.address()}/`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('pnpm web:build');
  });
});
