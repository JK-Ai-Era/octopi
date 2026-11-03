import { describe, expect, it } from 'vitest';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { LLMRequest, ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { PluginToolRecord } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/contribution-registry.js';

function toolProvider(requests: LLMRequest[]): ModelProvider {
  let calls = 0;
  return {
    name: 'plugin-test-model',
    defaultModel: 'm',
    async chat(request: LLMRequest) {
      requests.push(request);
      calls += 1;
      if (calls === 1) {
        return {
          content: '',
          model: 'm',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call-1', name: 'acme_echo', arguments: { text: 'hello', purpose: 'Test plugin tool' } }],
        };
      }
      return { content: 'done', model: 'm', finishReason: 'stop' };
    },
    async *stream() { yield { type: 'done' as const }; },
    async isAvailable() { return true; },
    getModelInfo() { return { name: 'm', contextWindow: 32000 }; },
    getModelInfos() { return [{ name: 'm', contextWindow: 32000 }]; },
  };
}

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function contribution(handler: PluginToolRecord['handler']): PluginToolRecord {
  return {
    pluginId: 'acme.search',
    definition: {
      name: 'acme_echo',
      description: 'Echo through a plugin',
      parameters: { text: { type: 'string', description: 'Text', required: true } },
      capabilities: ['egress'],
      timeoutMs: 1000,
    },
    handler,
    optional: false,
  };
}

describe('Plugin Tool real Runner execution', () => {
  it('hides the plugin with empty allow, then executes with attribution and source after opt-in', async () => {
    const requests: LLMRequest[] = [];
    const calls: Array<Record<string, unknown>> = [];
    const store = new InMemorySessionStore();
    const { wireAgentBuilder } = await import('@octopi-agent/engine/harness/agent/wire-agent-builder.js');
    const build = async (allow: string[]) => {
      const builder = new AgentBuilder()
        .store(store)
        .pluginTools([contribution(async (args, context) => {
          calls.push({ ...args, sessionId: context.sessionId, agentId: context.agentId, runId: context.runId, hasSignal: context.abortSignal instanceof AbortSignal });
          return { echoed: args.text };
        })]);
      const model = toolProvider(requests);
      await wireAgentBuilder(builder, { model, agentId: 'agent-a', tools: { allow }, providers: new Map([['mock', model]]) });
      return builder.build();
    };
    const denied = await build([]);

    const seenSources: unknown[] = [];
    const config = { systemPrompt: '', agentId: 'agent-a', sessionId: 'session-a' };
    for await (const event of denied.runner.handle('session-a', user('call the plugin'), config)) {
      if (event.type === 'tool.exec.end') seenSources.push(event.data?.source);
    }
    const toolNames = requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(toolNames).not.toContain('acme_echo');
    expect(calls).toEqual([]);

    requests.length = 0;
    const allowed = await build(['acme_echo']);
    for await (const event of allowed.runner.handle('session-a', user('call the plugin'), config)) {
      if (event.type === 'tool.exec.end') seenSources.push(event.data?.source);
    }
    expect(requests[0]?.tools?.some((tool) => tool.function.name === 'acme_echo')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionId: 'session-a', agentId: 'agent-a', hasSignal: true });
    expect(calls[0]?.runId).toBeTruthy();
    expect(seenSources.at(-1)).toEqual({ kind: 'plugin', origin: 'acme.search', trustLevel: 'third-party' });
    const session = await store.load('session-a');
    const results = session?.messages.flatMap((message) => message.toolResults ?? []).filter((item) => item.name === 'acme_echo') ?? [];
    expect(results[0]?.error).toContain('not found');
    const result = results.find((item) => !item.error);
    expect(result?.source?.origin).toBe('acme.search');
    expect(result?.result).toEqual({ echoed: 'hello' });
  });

  it('delivers cooperative cancellation to the plugin handler through a real RunScope', async () => {
    const requests: LLMRequest[] = [];
    let resolveEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const { wireAgentBuilder } = await import('@octopi-agent/engine/harness/agent/wire-agent-builder.js');
    const model = toolProvider(requests);
    const builder = new AgentBuilder()
      .store(new InMemorySessionStore())
      .pluginTools([contribution(async (_args, context) => {
        seenSignal = context.abortSignal;
        resolveEntered?.();
        await new Promise<void>((resolve) => context.abortSignal?.addEventListener('abort', () => resolve(), { once: true }));
        return 'handler observed cancellation';
      })]);
    await wireAgentBuilder(builder, { model, agentId: 'agent-a', tools: { allow: ['acme_echo'] }, providers: new Map([['mock', model]]) });
    const { runner } = await builder.build();
    const running = (async () => {
      for await (const _ of runner.handle('session-a', user('cancel'), { systemPrompt: '', agentId: 'agent-a', sessionId: 'session-a' }, controller.signal)) {
        // drain until the abort completes the run
      }
    })();
    await entered;
    controller.abort();
    await running;
    expect(seenSignal?.aborted).toBe(true);
  });
});
