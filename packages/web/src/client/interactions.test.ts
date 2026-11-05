import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { WEB_CLIENT_HTML } from '../client';

class FakeElement {
  id = '';
  className = '';
  textContent = '';
  value = '';
  title = '';
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  tabIndex = 0;
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  childNodes: FakeElement[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event: any) => void>> = {};
  classes = new Set<string>();
  classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
  };
  constructor(public tag = 'div') {}
  append(...items: FakeElement[]) { this.childNodes.push(...items); }
  replaceChildren(...items: FakeElement[]) { this.childNodes = items; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, listener: (event: any) => void) { (this.listeners[name] ??= []).push(listener); }
  dispatch(name: string, event: Record<string, unknown> = {}) { for (const listener of this.listeners[name] ?? []) listener({ target: this, preventDefault() {}, ...event }); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  reset() {}
}

function harness(fetcher: typeof fetch) {
  const script = WEB_CLIENT_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Client script not found');
  const nodes = new Map<string, FakeElement>();
  const document = {
    getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, new FakeElement());
      return nodes.get(id)!;
    },
    createElement(tag: string) { return new FakeElement(tag); },
    addEventListener() {},
    documentElement: new FakeElement('html'),
  };
  const context = {
    document,
    fetch: fetcher,
    TextDecoder,
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback: () => void) => callback(),
  };
  const client = runInNewContext(script.replace(/\nboot\(\);\s*$/, '') + '\n({ state, boot, getEntry, sessionKey, sendMessage, stopTurn, selectWorkspace, selectSession, loadDetail, loadPermissions: typeof loadPermissions === "function" ? loadPermissions : undefined, resolveApproval: typeof resolveApproval === "function" ? resolveApproval : undefined, togglePlan: typeof togglePlan === "function" ? togglePlan : undefined, resolvePlanReview: typeof resolvePlanReview === "function" ? resolvePlanReview : undefined, renderComposer, renderObserve, renderSidebar })', context) as {
    state: any;
    boot: () => void;
    getEntry: (workspace: string, session: string) => any;
    sessionKey: (workspace: string, session: string) => string;
    sendMessage: (event: { preventDefault: () => void }) => Promise<void>;
    stopTurn: () => Promise<void>;
    selectWorkspace: (workspace: string) => Promise<void>;
    selectSession: (session: string) => void;
    loadDetail: (workspace: string, session: string) => Promise<boolean>;
    loadPermissions: () => Promise<void>;
    resolveApproval: (decision: string) => Promise<void>;
    togglePlan: () => Promise<void>;
    resolvePlanReview: (approved: boolean) => Promise<void>;
    renderComposer: () => void;
    renderObserve: () => void;
    renderSidebar: () => void;
  };
  const node = (id: string) => document.getElementById(id);
  node('event-filter').value = 'all';
  client.state.workspacesLoading = false;
  client.state.workspaces = [{ id: 'a', name: 'Alpha', path: '/a' }, { id: 'b', name: 'Beta', path: '/b' }];
  client.state.workspaceId = 'a';
  client.state.sessionId = 'shared';
  client.state.sessions = [{ id: 'shared', updatedAt: 1 }];
  const initial = client.getEntry('a', 'shared');
  initial.loaded = true;
  initial.permission = { preset: 'workspace-write' };
  initial.transcript = [{ kind: 'user', text: 'Alpha history' }];
  return { ...client, node };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function detail(text: string) {
  return { header: { cwd: '/workspace' }, permission: { preset: 'workspace-write' }, messages: [{ role: 'user', content: [{ type: 'text', text }] }], events: [], audit: [] };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const treeText = (node: FakeElement): string => [node.textContent, ...node.childNodes.map(treeText)].join(' ');
const rowText = (node: FakeElement): string[] => node.childNodes.map(treeText);

function clientFetcher(input: Parameters<typeof fetch>[0]) {
  const url = String(input);
  if (url === '/api/workspaces') return json({ workspaces: [{ id: 'a', name: 'Alpha', path: '/a' }] });
  if (url === '/api/settings/permissions') return json({ settings: { defaultPreset: 'workspace-write', requiresSelection: false } });
  if (url === '/api/models') return json({ models: [
    { provider: 'provider-a', model: 'model-1', name: 'Model One' },
    { provider: 'provider-a', model: 'model-2', name: 'Model Two', reasoning: true },
  ] });
  throw new Error('Unexpected request: ' + url);
}

function trajectoryFixture() {
  return {
    version: 1, records: [
      { id: 'input:0', kind: 'input', seq: 0, timestamp: 1000 },
      { id: 'tool:1', kind: 'tool', seq: 1, timestamp: 2000, name: 'read_file' },
    ],
    timeline: { sequence: [{ recordId: 'input:0', lane: 'input', start: 0, end: 1 }, { recordId: 'tool:1', lane: 'tools', start: 1, end: 2 }], time: [] },
  };
}

describe('workbench interaction state', () => {
  it('renders the configured model catalog and persists a session model switch', async () => {
    const switches: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/workspaces/a/sessions/shared/model' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        switches.push(body);
        return json({ model: { version: 1, provider: body.provider, model: body.model } });
      }
      return clientFetcher(input);
    };
    const client = harness(fetcher);
    client.boot();
    await tick();
    const entry = client.getEntry('a', 'shared');
    entry.model = { version: 1, provider: 'provider-a', model: 'model-1' };
    client.renderComposer();

    const select = client.node('model-select');
    expect(select.disabled).toBe(false);
    expect(select.childNodes.map((option) => [option.value, option.textContent])).toContainEqual([
      JSON.stringify(['provider-a', 'model-1']), 'provider-a · Model One',
    ]);

    select.value = JSON.stringify(['provider-a', 'model-1']);
    select.dispatch('change');
    expect(switches).toHaveLength(0);
    expect(entry.modelSaving).toBe(false);

    select.value = JSON.stringify(['provider-a', 'model-2']);
    select.dispatch('change');
    await tick();
    await tick();
    expect(switches).toEqual([{ provider: 'provider-a', model: 'model-2' }]);
    expect(entry.model).toEqual({ version: 1, provider: 'provider-a', model: 'model-2' });
    expect(entry.modelSaving).toBe(false);
    expect(entry.modelError).toBe('');
  });

  it('switches between independent record and event inspection without losing the timeline', async () => {
    const client = harness(async (input) => clientFetcher(input));
    client.boot();
    await tick();
    const entry = client.getEntry('a', 'shared');
    entry.trajectory = trajectoryFixture();
    entry.events = [
      { type: 'trace/turn.start', seq: 1, ts: 1000, data: { step: 0 } },
      { type: 'trace/context.compacted', seq: 2, ts: 2000, data: { beforeTokens: 100, afterTokens: 20 } },
      { type: 'trace/error', seq: 3, ts: 3000, data: { message: 'SECRET_PROVIDER' } },
    ];
    entry.audit = [{ ts: '2026-01-01T00:00:00Z', tool: 'read_file', callId: 'SECRET_ID', decision: 'deny', step: 0, ok: false, durationMs: 5 }];
    client.renderObserve();
    expect(client.node('timeline-track').childNodes).toHaveLength(2);
    expect(client.node('event-rows').childNodes).toHaveLength(2);
    client.node('event-rows').childNodes[1]!.dispatch('click');
    expect(treeText(client.node('inspector-body'))).toContain('read_file');
    client.node('event-filter').value = 'tools';
    client.node('event-filter').dispatch('change');
    expect(client.node('timeline-track').childNodes).toHaveLength(1);

    client.node('trajectory-events').dispatch('click');
    expect(client.node('trajectory-events').attributes['aria-pressed']).toBe('true');
    expect(client.node('trajectory-records').attributes['aria-pressed']).toBe('false');
    expect(client.node('timeline-track').childNodes).toHaveLength(2);
    expect(client.node('event-rows').childNodes).toHaveLength(4);
    expect(client.node('ledger-count').textContent).toBe('4 of 4 events');
    expect(treeText(client.node('event-rows'))).toContain('trace/context.compacted');
    expect(treeText(client.node('event-rows'))).toContain('100 → 20 tokens');
    expect(treeText(client.node('event-rows'))).toContain('audit.tool');
    expect(treeText(client.node('event-rows'))).toContain('read_file · deny · failed · step 0 · 5 ms');
    client.node('event-rows').childNodes[1]!.dispatch('keydown', { key: 'Enter' });
    expect(treeText(client.node('inspector-body'))).toContain('Before tokens');
    expect(treeText(client.node('inspector-body'))).toContain('100');
    expect(treeText(client.node('inspector-body'))).not.toContain('SECRET');

    client.node('trace-filter').value = 'audit';
    client.node('trace-filter').dispatch('change');
    expect(client.node('event-rows').childNodes).toHaveLength(1);
    expect(treeText(client.node('event-rows'))).toContain('audit.tool');
    client.node('trace-search').value = 'deny';
    client.node('trace-search').dispatch('input');
    expect(client.node('event-rows').childNodes).toHaveLength(1);
    client.node('trace-search').value = 'failed';
    client.node('trace-search').dispatch('input');
    expect(client.node('event-rows').childNodes).toHaveLength(1);
    client.node('trace-search').value = 'SECRET_ID';
    client.node('trace-search').dispatch('input');
    expect(client.node('event-rows').childNodes).toHaveLength(0);
    expect(client.node('ledger-empty').textContent).toMatch(/no events match/i);

    client.node('trajectory-records').dispatch('click');
    expect(client.node('timeline-track').childNodes).toHaveLength(1);
    expect(client.node('event-rows').childNodes).toHaveLength(1);
    expect(treeText(client.node('inspector-body'))).toContain('read_file');
    expect(rowText(client.node('event-rows').childNodes[0]!)).toContain('read_file');
    client.node('trajectory-events').dispatch('click');
    client.node('timeline-track').childNodes[0]!.dispatch('click');
    expect(client.node('trajectory-records').attributes['aria-pressed']).toBe('true');
    expect(client.node('event-filter').value).toBe('all');
    expect(client.node('event-rows').childNodes).toHaveLength(2);
    expect(treeText(client.node('inspector-body'))).toContain('User input');
  });

  it('renders only allowlisted trace and audit facts and never searches private fields', async () => {
    const client = harness(async (input) => clientFetcher(input));
    client.boot();
    await tick();
    const entry = client.getEntry('a', 'shared');
    const secret = 'SECRET_sensitive_value';
    entry.events = [
      { type: 'trace/tool.call', seq: 1, ts: 1000, data: { id: secret, name: secret, arguments: secret, source: secret } },
      { type: 'trace/permission.decided', seq: 2, ts: 2000, data: { callId: secret, decision: secret, source: secret } },
      { type: 'trace/error', seq: 3, ts: 3000, data: { error: { message: secret, code: secret }, message: secret } },
      { type: 'trace/' + secret, seq: 4, ts: 4000, data: { text: secret } },
    ];
    entry.audit = [{ ts: secret, tool: secret, callId: secret, decision: secret, source: secret, argsDigest: secret, step: 1 }];
    client.node('trajectory-events').dispatch('click');
    expect(client.node('event-rows').childNodes).toHaveLength(5);
    for (const row of [...client.node('event-rows').childNodes]) {
      row.dispatch('click');
      expect(treeText(client.node('inspector-body'))).not.toContain(secret);
    }
    expect(treeText(client.node('event-rows'))).not.toContain(secret);
    client.node('trace-search').value = secret;
    client.node('trace-search').dispatch('input');
    expect(client.node('event-rows').childNodes).toHaveLength(0);
  });

  it('keeps raw live stream events out of inspection until persisted data reloads', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/messages') && init?.method === 'POST') return new Response(stream);
      if (url.endsWith('/sessions/shared')) return json({ ...detail('Reconciled'), events: [{ type: 'trace/error', seq: 5, ts: 1000, data: { message: 'SECRET_PERSISTED' } }] });
      if (url.endsWith('/sessions')) return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      return clientFetcher(input);
    };
    const client = harness(fetcher);
    client.boot();
    await tick();
    client.node('trajectory-events').dispatch('click');
    client.node('prompt').value = 'Work';
    const sending = client.sendMessage({ preventDefault() {} });
    await tick();
    controller.enqueue(new TextEncoder().encode('data: {"type":"error","error":{"message":"SECRET_LIVE","code":"SECRET_CODE"}}\n\n'));
    await tick();
    expect(client.node('event-rows').childNodes).toHaveLength(0);
    expect(treeText(client.node('event-rows'))).not.toContain('SECRET');
    controller.enqueue(new TextEncoder().encode('data: {"type":"turn.end","reason":"error"}\n\n'));
    controller.close();
    await sending;
    expect(client.node('event-rows').childNodes).toHaveLength(1);
    client.node('event-rows').childNodes[0]!.dispatch('click');
    expect(treeText(client.node('inspector-body'))).toContain('trace/error');
    expect(treeText(client.node('inspector-body'))).not.toContain('SECRET');
  });
  it('keeps approval requests scoped to their running session and renders untrusted text safely', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const approvals: Array<{ url: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/workspaces/a/sessions/shared/messages') return new Response(stream);
      if (url.endsWith('/approvals')) { approvals.push({ url, body: JSON.parse(String(init?.body)) }); return json({ ok: true }); }
      if (url === '/api/workspaces/b/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 2 }] });
      if (url === '/api/workspaces/b/sessions/shared') return json(detail('Beta history'));
      if (url === '/api/workspaces/a/sessions/shared') return json(detail('Alpha history'));
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      throw new Error('Unexpected request: ' + url);
    };
    const client = harness(fetcher);
    client.node('prompt').value = 'Work';
    const sending = client.sendMessage({ preventDefault() {} });
    await tick();
    const request = { type: 'permission.requested', requestId: 'r1', call: { id: 'c1', name: '<tool>', arguments: { path: '<img src=x onerror=alert(1)>' } }, reason: '<b>Needs approval</b>' };
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(request) + '\n\n'));
    await tick();
    expect(client.node('approval').hidden).toBe(false);
    expect(client.node('approval-reason').textContent).toBe('<b>Needs approval</b>');
    expect(client.node('approval-arguments').textContent).toContain('<img src=x onerror=alert(1)>');
    expect(client.node('status-text').textContent).toMatch(/approval/i);
    client.node('prompt').value = 'Draft for Alpha';
    client.state.drafts.set(client.sessionKey('a', 'shared'), 'Draft for Alpha');
    await client.selectWorkspace('b');
    await tick();
    expect(client.node('approval').hidden).toBe(true);
    await client.resolveApproval('allow');
    expect(approvals).toHaveLength(0);
    await client.selectWorkspace('a');
    await tick();
    expect(client.node('prompt').value).toBe('Draft for Alpha');
    expect(client.node('approval').hidden).toBe(false);
    await client.resolveApproval('allow');
    expect(approvals).toEqual([{ url: '/api/workspaces/a/sessions/shared/approvals', body: { requestId: 'r1', decision: 'allow' } }]);
    expect(client.node('approval').hidden).toBe(true);
    controller.enqueue(new TextEncoder().encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await sending;
  });

  it('dismisses an outstanding approval immediately on stop', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/messages')) return new Response(stream);
      if (url.endsWith('/interrupt')) return json({ ok: true });
      if (url.endsWith('/sessions/shared')) return json(detail('Stopped'));
      if (url.endsWith('/sessions')) return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      throw new Error(url);
    };
    const client = harness(fetcher);
    client.node('prompt').value = 'Work';
    const sending = client.sendMessage({ preventDefault() {} });
    await tick();
    controller.enqueue(new TextEncoder().encode('data: {"type":"permission.requested","requestId":"r1","call":{"id":"c1","name":"bash","arguments":{}},"reason":"approval"}\n\n'));
    await tick();
    expect(client.node('approval').hidden).toBe(false);
    await client.stopTurn();
    expect(client.node('approval').hidden).toBe(true);
    controller.enqueue(new TextEncoder().encode('data: {"type":"turn.end","reason":"interrupted"}\n\n'));
    controller.close();
    await sending;
  });

  it('restores an approval when an interrupt request fails', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/messages')) return new Response(stream);
      if (url.endsWith('/interrupt')) return json({ error: 'Interrupt failed' }, 500);
      if (url.endsWith('/approvals')) return json({ ok: true });
      if (url.endsWith('/sessions/shared')) return json(detail('Completed'));
      if (url.endsWith('/sessions')) return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      throw new Error(url);
    };
    const client = harness(fetcher);
    client.node('prompt').value = 'Work';
    const sending = client.sendMessage({ preventDefault() {} });
    await tick();
    controller.enqueue(new TextEncoder().encode('data: {"type":"permission.requested","requestId":"r1","call":{"id":"c1","name":"bash","arguments":{}},"reason":"approval"}\n\n'));
    await tick();
    await client.stopTurn();
    expect(client.node('approval').hidden).toBe(false);
    expect(client.state.alert).toContain('Interrupt failed');
    await client.resolveApproval('deny');
    controller.enqueue(new TextEncoder().encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await sending;
  });

  it('presents only the DSH preset choices and explains their filesystem scope', () => {
    expect(WEB_CLIENT_HTML).toContain('Read Only');
    expect(WEB_CLIENT_HTML).toContain('Workspace Write');
    expect(WEB_CLIENT_HTML).toContain('Full access');
    expect(WEB_CLIENT_HTML).toMatch(/network (?:access|is not)/i);
    expect(WEB_CLIENT_HTML).toMatch(/new sessions/i);
    expect(WEB_CLIENT_HTML).not.toMatch(/value="(?:acceptEdits|dontAsk|bypass|plan)"/);
    expect(WEB_CLIENT_HTML).not.toMatch(/id="permission-(?:allow|ask|deny)"/);
    expect(WEB_CLIENT_HTML).not.toContain('Auto review');
  });

  it('updates the new-session default independently and confirms Full access', async () => {
    const writes: unknown[] = [];
    let defaultPreset: string | null = null;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input) === '/api/settings/permissions') {
        if (init?.method === 'PUT') { writes.push(JSON.parse(String(init.body))); defaultPreset = (writes.at(-1) as { defaultPreset: string }).defaultPreset; }
        return json({ settings: { defaultPreset, requiresSelection: defaultPreset === null } });
      }
      return clientFetcher(input);
    };
    const client = harness(fetcher);
    client.getEntry('a', 'shared').permission = { preset: 'read-only' };
    client.boot();
    await tick();
    expect(client.node('permission-default-current').textContent).toMatch(/select/i);
    expect(client.node('permission-current').textContent).toBe('Read Only');
    expect(client.node('permission-icon').attributes.href).toBe('#icon-permission-read-only');
    client.node('permission-default-workspace-write').dispatch('click');
    await tick();
    expect(writes).toEqual([{ defaultPreset: 'workspace-write' }]);
    expect(client.node('permission-default-current').textContent).toBe('Workspace Write');
    expect(client.node('permission-current').textContent).toBe('Read Only');
    client.node('permission-default-danger-full-access').dispatch('click');
    expect(client.node('permission-risk-dialog').open).toBe(true);
    client.node('permission-risk-confirm').dispatch('click');
    await tick();
    expect(writes).toHaveLength(1);
    client.node('permission-risk-ack').checked = true;
    client.node('permission-risk-ack').dispatch('change');
    client.node('permission-risk-confirm').dispatch('click');
    await tick();
    expect(writes).toEqual([{ defaultPreset: 'workspace-write' }, { defaultPreset: 'danger-full-access' }]);
    expect(client.node('permission-default-current').textContent).toBe('Full access');
    expect(client.node('permission-current').textContent).toBe('Read Only');
  });

  it('requires an explicit current-session choice before sending a legacy session', async () => {
    const writes: unknown[] = [];
    let messages = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/sessions/shared/permission')) { writes.push(JSON.parse(String(init?.body))); return json({ permission: { preset: 'read-only' } }); }
      if (url.endsWith('/sessions/shared/messages')) { messages++; return new Response('data: {"type":"turn.end","reason":"end_turn"}\n\n'); }
      if (url.endsWith('/sessions/shared')) return json({ ...detail('Legacy'), permission: { preset: null } });
      if (url.endsWith('/sessions')) return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      return clientFetcher(input);
    };
    const client = harness(fetcher);
    client.boot();
    await tick();
    await client.loadDetail('a', 'shared');
    client.node('prompt').value = 'Keep this draft';
    client.renderComposer();
    expect(client.node('permission-current').textContent).toMatch(/select/i);
    expect(client.node('send').disabled).toBe(true);
    await client.sendMessage({ preventDefault() {} });
    expect(messages).toBe(0);
    expect(client.node('prompt').value).toBe('Keep this draft');
    client.node('permission-session-read-only').dispatch('click');
    await tick();
    expect(writes).toEqual([{ preset: 'read-only' }]);
    expect(client.node('permission-current').textContent).toBe('Read Only');
    expect(client.node('permission-default-current').textContent).toBe('Workspace Write');
    expect(client.node('send').disabled).toBe(false);
  });

  it('confirms Full access for the current session and blocks switching while a turn runs', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const writes: Array<{ url: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/permission')) { writes.push({ url, body: JSON.parse(String(init?.body)) }); return json({ permission: { preset: 'danger-full-access' } }); }
      if (url.endsWith('/messages')) return new Response(stream);
      if (url.endsWith('/sessions/shared')) return json({ ...detail('Completed'), permission: { preset: 'danger-full-access' } });
      if (url.endsWith('/sessions')) return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      return clientFetcher(input);
    };
    const client = harness(fetcher);
    client.boot();
    await tick();
    client.node('permission-session-danger-full-access').dispatch('click');
    expect(client.node('permission-risk-dialog').open).toBe(true);
    client.node('permission-risk-confirm').dispatch('click');
    await tick();
    expect(writes).toHaveLength(0);
    client.node('permission-risk-ack').checked = true;
    client.node('permission-risk-ack').dispatch('change');
    client.node('permission-risk-confirm').dispatch('click');
    await tick();
    expect(writes).toEqual([{ url: '/api/workspaces/a/sessions/shared/permission', body: { preset: 'danger-full-access' } }]);
    expect(client.node('permission-current').textContent).toBe('Full access');
    expect(client.node('permission-icon').attributes.href).toBe('#icon-permission-danger-full-access');
    client.node('prompt').value = 'Work';
    const sending = client.sendMessage({ preventDefault() {} });
    await tick();
    expect(client.node('permission-entry').disabled).toBe(true);
    client.node('permission-session-read-only').dispatch('click');
    await tick();
    expect(writes).toHaveLength(1);
    controller.enqueue(new TextEncoder().encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await sending;
    expect(client.node('permission-entry').disabled).toBe(false);
  });

  it('keeps the previous session preset on a failed or malformed change', async () => {
    let badResponse = false;
    const client = harness(async (input) => {
      if (String(input).endsWith('/permission')) return badResponse ? json({ permission: { preset: '<secret>' } }) : json({ error: '<b>Permission failed</b>' }, 500);
      return clientFetcher(input);
    });
    client.boot();
    await tick();
    client.node('permission-session-read-only').dispatch('click');
    await tick();
    expect(client.node('permission-current').textContent).toBe('Workspace Write');
    expect(client.node('session-permission-error').textContent).toContain('<b>Permission failed</b>');
    badResponse = true;
    client.node('permission-session-read-only').dispatch('click');
    await tick();
    expect(client.node('permission-current').textContent).toBe('Workspace Write');
    expect(client.node('session-permission-error').textContent).toMatch(/invalid/i);
    expect(client.node('session-permission-error').textContent).not.toContain('<secret>');
  });

  it('preserves visible history but blocks sending after a failed session refresh', async () => {
    const client = harness(async () => json({ error: 'Refresh failed' }, 500));
    client.node('prompt').value = 'Draft';
    expect(await client.loadDetail('a', 'shared')).toBe(false);
    expect(client.getEntry('a', 'shared').transcript[0].text).toBe('Alpha history');
    expect(treeText(client.node('transcript'))).toContain('Alpha history');
    expect(client.node('send').disabled).toBe(true);
    expect(client.node('composer-state').textContent).toMatch(/permission/i);
  });

  it('keeps an in-flight session change scoped while switching workspaces', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const writes: string[] = [];
    const client = harness(async (input) => {
      const url = String(input);
      if (url.endsWith('/a/sessions/shared/permission')) { writes.push(url); return pending; }
      if (url === '/api/workspaces/b/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      if (url === '/api/workspaces/b/sessions/shared') return json({ ...detail('Beta'), permission: { preset: 'read-only' } });
      return clientFetcher(input);
    });
    client.boot();
    await tick();
    client.state.workspaces.push({ id: 'b', name: 'Beta', path: '/b' });
    client.node('permission-session-read-only').dispatch('click');
    expect(client.node('permission-entry').disabled).toBe(true);
    client.node('prompt').value = 'Blocked while saving';
    await client.sendMessage({ preventDefault() {} });
    expect(writes).toHaveLength(1);
    await client.selectWorkspace('b');
    await tick();
    expect(client.node('permission-current').textContent).toBe('Read Only');
    release(json({ permission: { preset: 'read-only' } }));
    await tick();
    expect(client.getEntry('a', 'shared').permission.preset).toBe('read-only');
    expect(client.getEntry('b', 'shared').permission.preset).toBe('read-only');
    expect(client.state.workspaceId).toBe('b');
  });

  it('cancels Full access confirmation when the session changes', async () => {
    const writes: string[] = [];
    const client = harness(async (input) => {
      const url = String(input);
      if (url.endsWith('/permission')) { writes.push(url); return json({ permission: { preset: 'danger-full-access' } }); }
      if (url === '/api/workspaces/b/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      if (url === '/api/workspaces/b/sessions/shared') return json(detail('Beta'));
      return clientFetcher(input);
    });
    client.boot();
    await tick();
    client.state.workspaces.push({ id: 'b', name: 'Beta', path: '/b' });
    client.node('permission-session-danger-full-access').dispatch('click');
    client.node('permission-risk-ack').checked = true;
    client.node('permission-risk-ack').dispatch('change');
    await client.selectWorkspace('b');
    expect(client.node('permission-risk-dialog').open).toBe(false);
    expect(client.node('permission-risk-ack').checked).toBe(false);
    client.node('permission-risk-confirm').dispatch('click');
    await tick();
    expect(writes).toHaveLength(0);
  });

  it('shows permission service failures without replacing the form with defaults', async () => {
    const client = harness(async () => json({ error: 'Configuration unavailable' }, 500));
    await client.loadPermissions();
    expect(client.node('permission-error').hidden).toBe(false);
    expect(client.node('permission-error').textContent).toContain('Configuration unavailable');
    expect(client.node('permission-default-entry').disabled).toBe(true);
  });
  it('keeps a running turn isolated while switching to a workspace with the same session id', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/workspaces/a/sessions/shared/messages' && init?.method === 'POST') return new Response(stream);
      if (url === '/api/workspaces/b/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 2 }] });
      if (url === '/api/workspaces/b/sessions/shared') return json(detail('Beta history'));
      if (url === '/api/workspaces/a/sessions/shared') return json(detail('Alpha reconciled'));
      throw new Error('Unexpected request: ' + url);
    };
    const client = harness(fetcher);
    client.node('prompt').value = 'Question for Alpha';
    const sending = client.sendMessage({ preventDefault() {} });
    await tick();
    await client.selectWorkspace('b');
    await tick();
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: {"type":"assistant.delta","text":"你好"}\n\ndata: {"type":"assistant.message","message":{"content":[{"type":"text","text":"你好"}],"toolCalls":[]}}\n\n');
    const multibyte = bytes.findIndex((byte) => byte > 127);
    controller.enqueue(bytes.slice(0, multibyte + 1));
    controller.enqueue(bytes.slice(multibyte + 1));
    await tick();
    expect(client.getEntry('a', 'shared').transcript.map((item: any) => item.text)).toEqual(['Alpha history', 'Question for Alpha', '你好']);
    expect(client.getEntry('b', 'shared').transcript.map((item: any) => item.text)).toEqual(['Beta history']);
    expect(client.state.workspaceId).toBe('b');
    controller.enqueue(new TextEncoder().encode('data: {"type":"turn.end","reason":"end_turn"}\n\n'));
    controller.close();
    await sending;
    expect(client.getEntry('a', 'shared').transcript.map((item: any) => item.text)).toEqual(['Alpha reconciled']);
    expect(client.getEntry('b', 'shared').transcript.map((item: any) => item.text)).toEqual(['Beta history']);
    expect(client.state.runs.size).toBe(0);
  });

  it('restores a rejected 409 message as a draft and exposes the error', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/messages') && init?.method === 'POST') return json({ error: 'Session already has an active turn' }, 409);
      if (url === '/api/workspaces/a/sessions/shared') return json(detail('Alpha history'));
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      throw new Error('Unexpected request: ' + url);
    };
    const client = harness(fetcher);
    client.node('prompt').value = 'Try again';
    await client.sendMessage({ preventDefault() {} });
    expect(client.node('prompt').value).toBe('Try again');
    expect(client.state.drafts.get(client.sessionKey('a', 'shared'))).toBe('Try again');
    expect(client.state.alert).toContain('Another turn is already running');
    expect(client.getEntry('a', 'shared').transcript.map((item: any) => item.text)).toEqual(['Alpha history']);
  });

  it('sends an interrupt while the stream remains active and reconciles the result', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    let interrupts = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/messages') && init?.method === 'POST') return new Response(stream);
      if (url.endsWith('/interrupt') && init?.method === 'POST') { interrupts++; return json({ ok: true }); }
      if (url === '/api/workspaces/a/sessions/shared') return json(detail('Interrupted turn'));
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      throw new Error('Unexpected request: ' + url);
    };
    const client = harness(fetcher);
    client.node('prompt').value = 'Work';
    const sending = client.sendMessage({ preventDefault() {} });
    await tick();
    await client.stopTurn();
    expect(interrupts).toBe(1);
    expect(client.state.runs.get(client.sessionKey('a', 'shared')).stopping).toBe(true);
    controller.enqueue(new TextEncoder().encode('data: {"type":"turn.end","reason":"interrupted"}\n\n'));
    controller.close();
    await sending;
    expect(client.getEntry('a', 'shared').outcome).toBe('interrupted');
    expect(client.state.runs.size).toBe(0);
  });

  it('reports a stream that ends before a terminal event while still reconciling history', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/messages') && init?.method === 'POST') return new Response('data: {"type":"assistant.delta","text":"partial"}\n\n');
      if (url === '/api/workspaces/a/sessions/shared') return json(detail('Saved history'));
      if (url === '/api/workspaces/a/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 1 }] });
      throw new Error('Unexpected request: ' + url);
    };
    const client = harness(fetcher);
    client.node('prompt').value = 'Work';
    await client.sendMessage({ preventDefault() {} });
    expect(client.state.alert).toContain('ended before');
    expect(client.getEntry('a', 'shared').outcome).toBe('error');
    expect(client.getEntry('a', 'shared').transcript.map((item: any) => item.text)).toEqual(['Saved history']);
  });

  it('ignores a delayed sessions response from a previously selected workspace', async () => {
    let release!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => { release = resolve; });
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url === '/api/workspaces/a/sessions') return delayed;
      if (url === '/api/workspaces/b/sessions') return json({ sessions: [{ id: 'shared', updatedAt: 2 }] });
      if (url === '/api/workspaces/b/sessions/shared') return json(detail('Beta history'));
      throw new Error('Unexpected request: ' + url);
    };
    const client = harness(fetcher);
    const first = client.selectWorkspace('a');
    await client.selectWorkspace('b');
    release(json({ sessions: [{ id: 'wrong', updatedAt: 3 }] }));
    await first;
    await tick();
    expect(client.state.workspaceId).toBe('b');
    expect(client.state.sessions.map((item: any) => item.id)).toEqual(['shared']);
    expect(client.state.sessionId).toBe('shared');
  });

  it('toggles plan mode through the session endpoint and reflects it in the composer', async () => {
    const changes: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/workspaces/a/sessions/shared/plan' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        changes.push(body);
        return json({ plan: { active: body.active } });
      }
      throw new Error('Unexpected request: ' + url);
    };
    const client = harness(fetcher);
    const entry = client.getEntry('a', 'shared');
    entry.plan = { active: false };
    client.renderComposer();
    expect(client.node('plan-toggle').disabled).toBe(false);
    expect(client.node('plan-toggle').attributes['aria-pressed']).toBe('false');

    await client.togglePlan();
    expect(changes).toEqual([{ active: true }]);
    expect(entry.plan).toEqual({ active: true });
    expect(entry.planSaving).toBe(false);
    expect(client.node('plan-toggle').attributes['aria-pressed']).toBe('true');
    expect(client.node('plan-toggle').textContent).toBe('Planning');
  });

  it('renders the todo list and submits plan review decisions with feedback', async () => {
    const reviews: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/workspaces/a/sessions/shared/plan-review' && init?.method === 'POST') {
        reviews.push(JSON.parse(String(init.body)));
        return json({ ok: true });
      }
      throw new Error('Unexpected request: ' + url);
    };
    const client = harness(fetcher);
    const entry = client.getEntry('a', 'shared');
    entry.todos = [
      { content: 'Inspect the code', status: 'completed' },
      { content: 'Implement the change', status: 'in_progress' },
    ];
    client.renderComposer();
    expect(client.node('todo-panel').hidden).toBe(false);
    expect(client.node('todo-counts').textContent).toBe('1/2 done · 1 in progress');
    expect(treeText(client.node('todo-list'))).toContain('Implement the change');

    const run = {
      transcript: entry.transcript, streamItem: null, stopping: false, finishing: false,
      error: '', reason: '', approval: null,
      planReview: { requestId: 'plan-1', plan: '# Plan\n\nDo it.', pending: false, error: '', feedback: '' },
    };
    client.state.runs.set(client.sessionKey('a', 'shared'), run);
    client.renderComposer();
    expect(client.node('plan-review').hidden).toBe(false);
    expect(client.node('plan-review-content').textContent).toBe('# Plan\n\nDo it.');
    client.node('plan-review-feedback').value = 'Add failure-path tests';
    client.node('plan-review-feedback').dispatch('input');
    await client.resolvePlanReview(false);
    expect(reviews).toEqual([{
      requestId: 'plan-1', approved: false, feedback: 'Add failure-path tests',
    }]);
    expect(run.planReview).toBeNull();
    expect(client.node('plan-review').hidden).toBe(true);

    entry.todos = null;
    client.renderComposer();
    expect(client.node('todo-panel').hidden).toBe(true);
  });

  it('labels subagent sessions in the sidebar with their description and depth', () => {
    const client = harness(async (input) => clientFetcher(input));
    client.state.sessions = [
      { id: 'child', parentSessionId: 'root', depth: 1, description: 'Research the API', eventCount: 3, updatedAt: 1 },
    ];
    client.renderSidebar();
    const text = treeText(client.node('session-list'));
    expect(text).toContain('Research the API');
    expect(text).toContain('subagent · depth 1');
  });
});
