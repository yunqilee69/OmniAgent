import { isDeepStrictEqual } from 'node:util';
import { createModels } from '@earendil-works/pi-ai';
import type {
  Api, AssistantMessage as PiAssistant, AssistantMessageEvent, Context, Model,
  Provider, SimpleStreamOptions, Tool as PiTool,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { ProviderReplaySchema, text } from '../domain/message';
import type { AssistantMessage } from '../domain/message';
import type { ModelClient, ModelRequest, ModelResponse, ModelStreamDelta } from './types';
import { resolvePiAiRoute } from './pi-catalog';
import { replayEndpointHash } from './replay-identity';
import type { PiAiConfig, PiAiResolvedRoute } from './pi-catalog';

export { listPiAiCatalogProviders, resolvePiAiRoute } from './pi-catalog';
export type { PiAiConfig, PiAiCustomApi, PiAiModelConfig, PiAiResolvedRoute, PiAiRouteConfig } from './pi-catalog';

export interface PiAiModelDependencies {
  /** Override dispatch for an offline test or an embedding application. */
  stream?: (model: Model<Api>, context: Context, options: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>;
  /** Resolve a route's named credential reference; missing references never fall back. */
  resolveApiKey?: (envName: string, signal: AbortSignal) => Promise<string | undefined>;
  onReplayDegrade?: (detail: { provider: string; model: string; reason: 'missing' | 'invalid' | 'foreign' }) => void;
}

const emptyUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function objectArguments(value: unknown): value is Record<string, never> {
  const result = ProviderReplaySchema.safeParse({
    kind: 'pi-ai', version: 1, api: 'validation', provider: 'validation', model: 'validation', endpoint: 'validation',
    content: [{ type: 'toolCall', id: 'validation', name: 'validation', arguments: value }],
  });
  return result.success;
}

function plainAssistant(message: AssistantMessage): PiAssistant {
  const content: PiAssistant['content'] = message.content.flatMap((part) => part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : []);
  for (const call of message.toolCalls) {
    if (!call.id || !call.name || !objectArguments(call.arguments)) throw new Error('pi-ai history contains invalid tool arguments');
    content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: call.arguments });
  }
  return { role: 'assistant', api: 'omni-foreign', provider: 'omni-foreign', model: 'omni-foreign', content,
    usage: emptyUsage, stopReason: message.toolCalls.length ? 'toolUse' : 'stop', timestamp: 0 };
}

function toPiAssistant(message: AssistantMessage, target: Model<Api>, endpointHash: string, notify: PiAiModelDependencies['onReplayDegrade']): PiAssistant {
  if (message.content.some((part) => part.type !== 'text')) throw new Error('pi-ai does not support assistant image history');
  const visibleText = message.content.map((part) => part.type === 'text' ? part.text : '').join('');
  const result = ProviderReplaySchema.safeParse(message.providerReplay);
  const replay = result.success ? result.data : undefined;
  if (replay === undefined) {
    notify?.({ provider: target.provider, model: target.id, reason: message.providerReplay === undefined ? 'missing' : 'invalid' });
    return plainAssistant(message);
  }
  const nativeCalls = replay.content.filter((block) => block.type === 'toolCall');
  const sameText = replay.content.filter((block) => block.type === 'text').map((block) => block.text).join('') === visibleText;
  const sameCalls = nativeCalls.length === message.toolCalls.length
    && nativeCalls.every((call, index) => {
      const expected = message.toolCalls[index];
      return expected && call.id === expected.id && call.name === expected.name && isDeepStrictEqual(call.arguments, expected.arguments);
    });
  const sameProvenance = replay.provider === target.provider && replay.model === target.id
    && replay.api === target.api && replay.endpoint === endpointHash;
  // Any provenance mismatch falls back to visible text plus ordinary tool
  // calls. Reasoning, signatures and namespaces from another route are never
  // forwarded, and tool calls must survive the fallback.
  if (!sameProvenance || !sameText || !sameCalls) {
    notify?.({ provider: target.provider, model: target.id, reason: sameProvenance ? 'invalid' : 'foreign' });
    return plainAssistant(message);
  }
  return {
    role: 'assistant', provider: replay.provider, model: replay.model, api: replay.api,
    content: replay.content, usage: emptyUsage,
    stopReason: nativeCalls.length ? 'toolUse' : 'stop', timestamp: 0,
  };
}

function toPiContext(
  request: ModelRequest, model: Model<Api>, endpointHash: string, notify: PiAiModelDependencies['onReplayDegrade'],
): Context {
  const messages: Context['messages'] = [];
  for (const message of request.messages) {
    switch (message.role) {
      case 'system': messages.push({ role: 'system', content: message.content, timestamp: 0 }); break;
      case 'user':
        if (!model.input.includes('image') && message.content.some((part) => part.type === 'image')) {
          throw new Error(`pi-ai model "${model.id}" does not support image input`);
        }
        messages.push({ role: 'user', content: message.content.map((part) => part.type === 'text'
          ? { type: 'text', text: part.text } : { type: 'image', mimeType: part.mediaType, data: part.data }), timestamp: 0 });
        break;
      case 'assistant': messages.push(toPiAssistant(message, model, endpointHash, notify)); break;
      case 'tool':
        for (const result of message.results) messages.push({ role: 'toolResult', toolCallId: result.callId,
          toolName: result.name, content: [{ type: 'text', text: result.content || '(no output)' }], isError: !result.ok, timestamp: 0 });
        break;
    }
  }
  return { systemPrompt: request.system, messages,
    ...(request.tools.length ? { tools: request.tools.map((tool) => ({ ...tool, parameters: tool.parameters as PiTool['parameters'] })) } : {}) };
}

function responseOf(
  message: PiAssistant, model: Model<Api>, completed: Map<number, PiAssistant['content'][number]>, endpointHash: string,
): ModelResponse {
  if (message.api !== model.api || message.provider !== model.provider || message.model !== model.id) {
    throw new Error('pi-ai response provenance does not match the requested model');
  }
  if (!['stop', 'toolUse', 'length'].includes(message.stopReason)) throw new Error('pi-ai returned an unsuccessful or unsupported response');
  const calls = message.content.flatMap((block, index) => block.type === 'toolCall' ? [{ block, index }] : []);
  if (message.stopReason !== 'length') {
    if ((calls.length > 0) !== (message.stopReason === 'toolUse')) throw new Error('pi-ai returned inconsistent tool call status');
    for (const { block, index } of calls) {
      if (!block.id || !block.name || block.argumentsError !== undefined || !objectArguments(block.arguments)
        || !isDeepStrictEqual(completed.get(index), block)) {
        throw new Error('pi-ai returned incomplete or invalid tool call arguments');
      }
    }
    if (completed.size !== calls.length) throw new Error('pi-ai returned incomplete tool call content');
  }
  const content = message.content.filter((part) => part.type === 'text').map((part) => text(part.text));
  const toolCalls = message.stopReason === 'length' ? [] : calls.map(({ block }) => ({
    id: block.id, name: block.name, arguments: block.arguments, raw: JSON.stringify(block.arguments),
  }));
  const replayContent = message.content.filter((part) => message.stopReason !== 'length' || part.type !== 'toolCall')
    .map((part) => {
      switch (part.type) {
        case 'text': return { type: 'text' as const, text: part.text, ...(part.textSignature === undefined ? {} : { textSignature: part.textSignature }) };
        case 'thinking': return { type: 'thinking' as const, thinking: part.thinking,
          ...(part.thinkingSignature === undefined ? {} : { thinkingSignature: part.thinkingSignature }),
          ...(part.redacted === undefined ? {} : { redacted: part.redacted }) };
        case 'toolCall': return { type: 'toolCall' as const, id: part.id, name: part.name, arguments: part.arguments,
          ...(part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature }),
          ...(part.namespace === undefined ? {} : { namespace: part.namespace }) };
      }
    });
  const candidate = { kind: 'pi-ai', version: 1, provider: model.provider, model: model.id, api: model.api,
    endpoint: endpointHash, content: replayContent };
  const checked = ProviderReplaySchema.safeParse(candidate);
  if (!checked.success) throw new Error('pi-ai response replay metadata is invalid');
  return { message: { role: 'assistant', content, toolCalls, providerReplay: checked.data },
    usage: { inputTokens: message.usage.input, outputTokens: message.usage.output },
    stopReason: message.stopReason === 'length' ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end_turn' };
}

function dispatcher(route: PiAiResolvedRoute) {
  const models = createModels();
  const { builtin, config } = route;
  const auth: Provider['auth'] = config.auth === 'ambient' && config.apiKey === undefined && config.apiKeyEnv === undefined
    ? builtin!.auth : { apiKey: { name: route.provider, resolve: async ({ credential }) => ({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: route.provider,
    }) } };
  const api = config.api === 'openai-completions' ? openAICompletionsApi()
    : config.api === 'openai-responses' ? openAIResponsesApi()
      : config.api === 'anthropic-messages' ? anthropicMessagesApi() : undefined;
  if (!api && !builtin) throw new Error(`pi-ai provider "${route.provider}" has no dispatch implementation`);
  const provider: Provider = {
    id: route.provider, name: route.provider, auth, getModels: () => route.models,
    stream: (model, context, options) => api ? api.stream(model, context, options) : builtin!.stream(model, context, options),
    streamSimple: (model, context, options) => api ? api.streamSimple(model, context, options) : builtin!.streamSimple(model, context, options),
  };
  models.setProvider(provider);
  return (model: Model<Api>, context: Context, options: SimpleStreamOptions) => models.streamSimple(model, context, options);
}

export class PiAiModel implements ModelClient {
  readonly name: string;
  private readonly route: PiAiResolvedRoute;
  private readonly dispatch: NonNullable<PiAiModelDependencies['stream']>;

  constructor(config: PiAiConfig, private readonly dependencies: PiAiModelDependencies = {}) {
    const route = config.routes[config.provider];
    if (!route) throw new Error(`pi-ai provider "${config.provider}" is not configured`);
    this.route = resolvePiAiRoute(config.provider, route);
    this.name = config.provider;
    this.dispatch = dependencies.stream ?? dispatcher(this.route);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const iterator = this.stream(request);
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
    return next.value;
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamDelta, ModelResponse> {
    const model = this.route.models.find((candidate) => candidate.id === request.model);
    if (!model) throw new Error(`pi-ai provider "${this.name}" has no configured model "${request.model}"`);
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      const { config } = this.route;
      let apiKey = config.apiKey;
      if (apiKey === undefined && config.apiKeyEnv !== undefined) {
        apiKey = this.dependencies.resolveApiKey
          ? await this.dependencies.resolveApiKey(config.apiKeyEnv, signal)
          : process.env[config.apiKeyEnv];
        signal.throwIfAborted();
        if (!apiKey) throw new Error(`pi-ai credential ${config.apiKeyEnv} is missing`);
      }
      if (!apiKey && config.auth !== 'ambient') throw new Error(`pi-ai credential for provider "${this.name}" is missing`);
      const endpointHash = replayEndpointHash(model.baseUrl);
      const context = toPiContext(request, model, endpointHash, this.dependencies.onReplayDegrade);
      const events = this.dispatch(model, context, {
        signal, ...(apiKey === undefined ? {} : { apiKey }),
        ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
        ...(config.reasoning === undefined ? {} : { reasoning: config.reasoning }),
      });
      const completed = new Map<number, PiAssistant['content'][number]>();
      for await (const event of events) {
        signal.throwIfAborted();
        if (event.type === 'text_delta') yield { type: 'text', text: event.delta };
        if (event.type === 'thinking_delta') yield { type: 'reasoning', text: event.delta };
        if (event.type === 'toolcall_end') completed.set(event.contentIndex, structuredClone(event.toolCall));
        if (event.type === 'error') throw new Error(signal.aborted ? 'pi-ai request aborted' : 'pi-ai provider request failed');
        if (event.type === 'done') return responseOf(event.message, model, completed, endpointHash);
      }
      throw new Error('pi-ai event stream ended without a terminal event');
    } finally {
      controller.abort('pi-ai stream consumer stopped');
    }
  }
}
