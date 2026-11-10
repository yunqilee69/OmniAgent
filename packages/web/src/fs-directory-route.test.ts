import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
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

async function host() {
  const started = await startWebHost({
    workspaces: {
      async list() { return []; },
      async get() { return undefined; },
      async add() { throw new Error('unexpected'); },
      async remove() { return false; },
      async touch() { return undefined; },
    },
    store: {} as never,
    createSession: async () => { throw new Error('unexpected session creation'); },
  });
  hosts.push(started);
  return started;
}

describe('directory picker API', () => {
  it('lists the folders of an absolute path so a workspace can be chosen, not typed', async () => {
    const created = await mkdtemp(join(tmpdir(), 'omniagent-fs-route-'));
    directories.push(created);
    const root = await realpath(created);
    await mkdir(join(root, 'project'));
    const server = await host();

    const response = await fetch(`${server.address()}/api/fs/directories?${new URLSearchParams({ path: root })}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { path: string; parent: string | null; entries: Array<{ name: string }>; roots: unknown[] };
    expect(body.path).toBe(root);
    expect(body.entries.map((entry) => entry.name)).toEqual(['project']);
    expect(body.roots.length).toBeGreaterThan(0);
  });

  it('starts at the home directory when no path is given', async () => {
    const server = await host();
    const response = await fetch(`${server.address()}/api/fs/directories`);
    expect(response.status).toBe(200);
    const body = await response.json() as { path: string; entries: unknown[] };
    expect(body.path.length).toBeGreaterThan(1);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('rejects a relative path and hides filesystem detail for a missing folder', async () => {
    const server = await host();
    const relative = await fetch(`${server.address()}/api/fs/directories?${new URLSearchParams({ path: 'relative/dir' })}`);
    expect(relative.status).toBe(400);
    const missing = await fetch(`${server.address()}/api/fs/directories?${new URLSearchParams({ path: '/definitely/not/here' })}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Directory not found' });
  });
});
