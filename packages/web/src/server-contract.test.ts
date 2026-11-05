import { afterEach, describe, expect, it } from 'vitest';
import { startWebHost } from './server';

const hosts: Array<Awaited<ReturnType<typeof startWebHost>>> = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

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

  it('serves the workbench with a restrictive document policy', async () => {
    const host = await startWebHost({
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
    hosts.push(host);
    const response = await fetch(`${host.address()}/`);
    expect(response.status).toBe(200);
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(await response.text()).toContain('id="model-select"');
  });
});
