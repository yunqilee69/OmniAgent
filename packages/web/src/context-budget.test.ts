import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentCatalog,
  ConfigStore,
  createAgentSelectionEvent,
  createModelSelectionEvent,
  estimateModelHistory,
  FakeModel,
  projectMessages,
  RuntimeResolver,
  Session,
  SessionStore,
  snapshotDshPermissions,
  textResponse,
} from '@omniagent/core';
import type { AgentEvent, Message, ModelBinding, ResolvedSessionRuntime, SessionHandle } from '@omniagent/core';
import { modelBudgetOptions } from './session-options';
import { startWebHost } from './server';
import type { WebHost } from './server';
import { WorkspaceRegistry } from './workspaces';

/**
 * Window → runtime → Session → compaction, end to end.
 *
 * The unit tests in `@omniagent/core` pin the budget arithmetic; this file pins
 * the wiring the Web host performs, so a bug in `modelBudgetOptions` (or in the
 * resolved runtime's window) fails here instead of only in production. Every
 * piece below is the real thing — real `RuntimeResolver`, real `ConfigStore`,
 * real `Session`, real HTTP route — except the model client, which is a
 * `FakeModel` recording what it was asked to send.
 */

const LARGE_WINDOW = 1_048_576;
const SMALL_WINDOW = 300_000;
const SMALL_MAX_TOKENS = 32_000;

const hosts: WebHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
});

/** Two catalog models with different windows; the small one declares maxTokens. */
const config = {
  providers: {
    gateway: {
      displayName: 'Gateway',
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'GATEWAY_KEY',
      models: [
        { id: 'model-a', name: 'Model A', contextWindow: LARGE_WINDOW },
        { id: 'model-b', name: 'Model B', contextWindow: SMALL_WINDOW, maxTokens: SMALL_MAX_TOKENS },
      ],
    },
  },
  // The default role is deliberately the *large* model: if the budget came from
  // the agent's role instead of the selected model, the small-window assertions
  // below would silently use 1M and pass for the wrong reason.
  roles: {
    default: { name: 'Default', provider: 'gateway', model: 'model-a' },
  },
  agentProfiles: { default: { tools: '*', skills: '*' } },
  system: 'You are a test assistant.',
};

const largeBinding: ModelBinding = { version: 2, kind: 'model', provider: 'gateway', model: 'model-a' };
const smallBinding: ModelBinding = { version: 2, kind: 'model', provider: 'gateway', model: 'model-b' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omniagent-context-budget-'));
  roots.push(root);
  const configDir = join(root, 'config');
  await mkdir(join(configDir, 'agents'), { recursive: true });
  await writeFile(join(configDir, 'config.json'), JSON.stringify(config));
  await writeFile(join(configDir, 'agents', 'default.md'), '---\nname: Default\n---\nDEFAULT BODY');
  await mkdir(join(root, 'workspace'));
  const workspaces = new WorkspaceRegistry(join(root, 'workspaces.json'));
  const workspace = await workspaces.add(join(root, 'workspace'));
  const store = new SessionStore(join(root, 'sessions'));
  const runtime = new RuntimeResolver({
    configStore: await ConfigStore.open(join(configDir, 'config.json')),
    agents: new AgentCatalog(join(configDir, 'agents')),
  });
  return { root, workspace, workspaces, store, runtime };
}

/**
 * Compose a Session the way `composeSession` in `main.ts` does for the budget:
 * the resolved runtime is the only source of the window and the output reserve.
 * `main.ts` cannot be imported here (it starts a host on import), which is why
 * `session-options.ts` exists.
 */
function composeSession(input: {
  workspace: string;
  resolved: ResolvedSessionRuntime;
  model: FakeModel;
  handle?: SessionHandle;
}): Session {
  const { resolved } = input;
  return new Session({
    cwd: input.workspace,
    workspace: input.workspace,
    model: input.model,
    ...(resolved.modelId === undefined ? {} : { modelId: resolved.modelId }),
    agent: resolved.sessionAgent,
    modelCapabilities: resolved.capabilities,
    dshPermissions: snapshotDshPermissions({ status: 'ready', preset: 'workspace-write' }),
    ...(input.handle === undefined ? {} : { session: input.handle }),
    system: resolved.system,
    ...modelBudgetOptions(resolved),
  });
}

/** The overhead the loop subtracts from the window before any message is sent. */
function overheadOf(session: Session): number {
  const breakdown = session.contextProjection()?.breakdown;
  return (breakdown?.systemTokens ?? 0) + (breakdown?.toolsTokens ?? 0);
}

/**
 * Seed a persisted log big enough to exceed `target` estimated tokens.
 *
 * The estimate is taken with the same function the loop and the meter use, so
 * the seed is defined against the real number instead of a character count. One
 * appended pair is roughly 12k tokens, so the result lands at most that far
 * above `target` — enough precision to stay under the raw window.
 */
async function seedHistory(handle: SessionHandle, target: number): Promise<number> {
  const filler = 'context filler line for the budget test '.repeat(600);
  let estimate = 0;
  for (let turn = 0; estimate <= target; turn += 1) {
    if (turn > 200) throw new Error('seeded history never exceeded its target');
    await handle.append({ type: 'message/user', data: { text: `${turn} ${filler}` } });
    await handle.append({
      type: 'message/assistant',
      data: { role: 'assistant', content: [{ type: 'text', text: `${turn} ${filler}` }], toolCalls: [] },
    });
    estimate = estimateModelHistory(projectMessages(handle.events));
  }
  return estimate;
}

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

/** Visible text of a user/assistant message; system and tool messages have none here. */
function textOf(message: Message | undefined): string {
  if (message === undefined || message.role === 'system' || message.role === 'tool') return '';
  const first = message.content[0];
  return first?.type === 'text' ? first.text : '';
}

describe('context budget wiring', () => {
  // Seeding a prompt that is genuinely over a 300k window means writing a ~1 MB
  // session log through the real store (one fsync per append). That is fast on an
  // idle machine but exceeds Vitest's 5 s default while 130 other files run in
  // parallel, so the budget is explicit rather than the work being faked.
  it('compacts before the first request of a session whose selected model has a small window', { timeout: 30_000 }, async () => {
    const { workspace, workspaces, store, runtime } = await fixture();

    // The selected model is the small one; the default role stays on the large
    // model, so both windows exist in the same catalog.
    const small = await runtime.resolve({
      cwd: workspace.path, workspace: workspace.path, agentId: 'default', binding: smallBinding, isRoot: true,
    });
    const large = await runtime.resolve({
      cwd: workspace.path, workspace: workspace.path, agentId: 'default', binding: largeBinding, isRoot: true,
    });
    const byRole = await runtime.resolve({
      cwd: workspace.path, workspace: workspace.path, agentId: 'default', isRoot: true,
    });
    expect(small.contextWindowTokens).toBe(SMALL_WINDOW);
    expect(small.contextWindowSource).toBe('model');
    expect(small.modelDescriptor?.maxTokens).toBe(SMALL_MAX_TOKENS);
    expect(large.contextWindowTokens).toBe(LARGE_WINDOW);
    // The default role really is the other model — otherwise "not the default
    // role's window" would be untestable.
    expect(byRole.contextWindowTokens).toBe(LARGE_WINDOW);

    const handle = await store.create({ id: 'small-window', workspace: workspace.path, cwd: workspace.path });
    await handle.append(createAgentSelectionEvent('default'));
    await handle.append(createModelSelectionEvent(smallBinding));

    // What the loop will subtract: system prompt + tool disclosure + the model's
    // declared output ceiling. A probe Session reports the first two.
    const options = modelBudgetOptions(small);
    expect(options).toEqual({ contextWindowTokens: SMALL_WINDOW, outputTokenReserve: SMALL_MAX_TOKENS });
    const probe = composeSession({ workspace: workspace.path, resolved: small, model: new FakeModel([]) });
    const messageBudget = SMALL_WINDOW - overheadOf(probe) - SMALL_MAX_TOKENS;
    expect(messageBudget).toBeGreaterThan(0);

    // Over the effective budget but still under the raw window: the history must
    // be compacted, and the request that follows must fit the window.
    const seeded = await seedHistory(handle, messageBudget);
    expect(seeded).toBeGreaterThan(messageBudget);
    expect(seeded).toBeLessThan(SMALL_WINDOW);
    const seededCount = handle.events.length;
    const seededEvents = [...handle.events];

    const model = new FakeModel([textResponse('answered')], { onExhausted: textResponse('again') });
    const session = composeSession({ workspace: workspace.path, resolved: small, model, handle });
    const events = await collect(session.send('continue'));

    // Compaction ran before the provider was called: the first request already
    // carries the summary, and the persisted log was not rewritten.
    const firstRequest = model.requests[0];
    expect(firstRequest).toBeDefined();
    expect(firstRequest?.messages[0]?.role).toBe('user');
    expect(textOf(firstRequest?.messages[0])).toMatch(/^\[conversation summary\]/);
    expect(events.some((event) => event.type === 'context.compacted')).toBe(true);
    expect(firstRequest?.messages.length ?? 0).toBeLessThan(seededCount);
    const firstRequestEstimate = estimateModelHistory(firstRequest?.messages ?? []);
    expect(firstRequestEstimate).toBeLessThan(SMALL_WINDOW);
    expect(firstRequestEstimate).toBeLessThan(messageBudget);
    // The turn still finished normally, and the adopted history is the compacted one.
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', reason: 'end_turn' });
    expect(session.messages[0]?.role).toBe('user');
    expect(textOf(session.messages[0])).toMatch(/^\[conversation summary\]/);
    expect(session.messages.length).toBeLessThan(seededCount);
    // The log keeps the exact record: the seeded events are untouched and no
    // summary or fabricated tool result is written back.
    expect(handle.events.slice(0, seededCount)).toEqual(seededEvents);
    expect(handle.events.some((event) => event.type === 'context.compacted')).toBe(false);
    expect(handle.events.some((event) => event.type === 'message/tool-result')).toBe(false);

    // `/context` reports the same window as the Session's budget, and the
    // derived message budget stays internal.
    const host = await startWebHost({ workspaces, store, runtime });
    hosts.push(host);
    const base = host.address()!;
    const url = `${base}/api/workspaces/${encodeURIComponent(workspace.id)}/sessions/small-window/context`;
    const smallContext = await (await fetch(url)).json() as Record<string, unknown>;
    expect(smallContext).toMatchObject({
      window: { tokens: SMALL_WINDOW, source: 'model' },
      modelWindow: SMALL_WINDOW,
    });
    expect(Object.keys(smallContext).sort()).toEqual(['estimatedMessageTokens', 'modelWindow', 'window']);
    expect(smallContext).not.toHaveProperty('messageBudget');
    expect(JSON.stringify(smallContext)).not.toContain(String(messageBudget));

    // Switching the selected model to the 1M one and rebuilding the Session
    // takes the new window from the new model: same log, no compaction.
    await handle.append(createModelSelectionEvent(largeBinding));
    const reopened = await store.open(workspace.path, 'small-window');
    const historyBeforeSwitch = estimateModelHistory(projectMessages(reopened.events));
    const largeModel = new FakeModel([textResponse('answered again')], { onExhausted: textResponse('again') });
    const rebuilt = composeSession({ workspace: workspace.path, resolved: large, model: largeModel, handle: reopened });
    // The reserve still comes from the descriptor: the catalog supplies the
    // protocol's default output ceiling when the route declares none.
    const largeReserve = large.modelDescriptor?.maxTokens;
    expect(largeReserve).toBe(128_000);
    expect(modelBudgetOptions(large)).toEqual({ contextWindowTokens: LARGE_WINDOW, outputTokenReserve: largeReserve });
    const largeBudget = LARGE_WINDOW - overheadOf(rebuilt) - largeReserve!;
    expect(historyBeforeSwitch).toBeLessThan(largeBudget);

    const switchedEvents = await collect(rebuilt.send('continue'));
    expect(switchedEvents.some((event) => event.type === 'context.compacted')).toBe(false);
    const largeRequest = largeModel.requests[0];
    expect(largeRequest?.messages.length).toBe(projectMessages(reopened.events).length - 1);
    expect(textOf(largeRequest?.messages[0])).not.toMatch(/^\[conversation summary\]/);
    expect(estimateModelHistory(largeRequest?.messages ?? [])).toBeLessThan(LARGE_WINDOW);

    const largeContext = await (await fetch(url)).json() as Record<string, unknown>;
    expect(largeContext).toMatchObject({
      window: { tokens: LARGE_WINDOW, source: 'model' },
      modelWindow: LARGE_WINDOW,
    });
  });
});
