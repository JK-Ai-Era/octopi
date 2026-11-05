import { describe, expect, it } from 'vitest';
import { Agent } from '@octopi-agent/engine/harness/run/agent/agent.js';
import { PluginHookAdapter, type RegisteredHook } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/hooks/adapter.js';
import type { HookToolEvent } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/hooks/types.js';
import type { HitlOutcome } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import type { ModelProvider, LLMRequest, LLMResponse } from '@octopi-agent/core/interfaces/model-provider.js';
import type { ReliabilityHarness } from '@octopi-agent/core/interfaces/reliability.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { HarnessLoopEvent } from '@octopi-agent/engine/harness/run/reliability/harness-events.js';
import type { ResolvedModel } from '@octopi-agent/engine/harness/run/model/types.js';
import { formatTurnContextXml, formatTurnStartContent, joinSlotXml } from '@octopi-agent/engine/harness/context/turn-envelope.js';

function harness(): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
    },
  };
}

function provider(responses: LLMResponse[], requests: LLMRequest[] = [], name = 'p'): ModelProvider {
  let index = 0;
  const next = (): LLMResponse => responses[Math.min(index++, responses.length - 1)]!;
  return {
    name,
    defaultModel: 'm',
    models: ['m'],
    getModelInfo: () => ({ name: 'm', contextWindow: 8192 }),
    getModelInfos: () => [{ name: 'm', contextWindow: 8192 }],
    isAvailable: async () => true,
    chat: async (request) => { requests.push(request); return next(); },
    async *stream(request) {
      requests.push(request);
      const response = next();
      if (response.content) yield { type: 'content' as const, content: response.content };
      for (const toolCall of response.toolCalls ?? []) {
        yield {
          type: 'tool_call' as const,
          toolCall: { id: toolCall.id, name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
        };
      }
      yield { type: 'done' as const, finishReason: response.finishReason, usage: response.usage };
    },
  };
}

function port(hooks: RegisteredHook[], approve?: () => Promise<HitlOutcome>): PluginHookAdapter {
  return new PluginHookAdapter({
    getHooks: () => hooks,
    getPluginConfig: () => undefined,
    recordHook: () => undefined,
    approveToolCall: approve ?? (async () => ({
      allowed: false, decision: 'deny', timedOut: false, denyReason: 'no_channel', denyDetail: 'no approval',
    })),
  });
}

function hook(name: RegisteredHook['hookName'], phase: RegisteredHook['phase'], handler: (event: never) => unknown, pluginId = 'acme.test'): RegisteredHook {
  return { pluginId, hookName: name, phase, priority: 0, handler };
}

async function run(agent: Agent, resolvedModel?: ResolvedModel): Promise<HarnessLoopEvent[]> {
  const events: HarnessLoopEvent[] = [];
  for await (const event of agent.run(undefined, undefined, resolvedModel ? {
    resolvedModel,
    runScope: { sessionId: 's', agentId: 'a', runId: 'r', prompt: 'go', resolvedModel },
  } : undefined)) events.push(event);
  return events;
}

describe('P4 real Agent.run and ToolHandler effects', () => {
  it('Transform changes validated/executed params and Observe sees the raw result', async () => {
    const requests: LLMRequest[] = [];
    const executed: unknown[] = [];
    const observed: unknown[] = [];
    const p = provider([
      { content: '', model: 'm', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'echo', arguments: { value: 'raw' } }] },
      { content: 'done', model: 'm', finishReason: 'stop' },
    ], requests);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const hooks = port([
      hook('before_tool_call', 'transform', (event) => ({ ...(event as unknown as HookToolEvent).params, value: 'changed' })),
      hook('before_tool_call', 'vote', (event) => ({ decision: 'allow', reason: (event as unknown as HookToolEvent).params.value as string })),
      hook('after_tool_call', 'single', (event) => { observed.push((event as { result: { content: unknown } }).result.content); }),
      hook('before_iteration', 'transform', () => ({ thinking: 'high' })),
      hook('before_iteration', 'vote', () => ({ decision: 'allow' })),
    ]);
    const agent = new Agent({
      model: p,
      harness: harness(),
      extensionHooks: hooks,
      tools: [{
        name: 'echo', description: 'echo',
        validate: (args) => ({ valid: (args as { value: string }).value === 'changed', error: 'must be transformed' }),
        execute: async (id, args) => { executed.push(args); return { toolCallId: id, name: 'echo', content: 'raw-result' }; },
      }],
      beforeToolCall: async (ctx) => {
        if ((ctx.args as { value: string }).value !== 'changed') return { block: true, reason: 'security saw stale params' };
        return undefined;
      },
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    expect(executed).toEqual([{ value: 'changed' }]);
    expect(observed).toEqual(['raw-result']);
    expect(requests.every((request) => request.thinkingLevel === 'high')).toBe(true);
    expect(events.filter((event) => event.type === 'step_end')).toHaveLength(2);
  });

  it('denied Tool Vote never executes the handler and does not invent after_tool_call', async () => {
    const p = provider([
      { content: '', model: 'm', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'echo', arguments: { value: 'raw' } }] },
      { content: 'done', model: 'm', finishReason: 'stop' },
    ]);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    let executions = 0;
    let observations = 0;
    const hooks = port([
      hook('before_tool_call', 'transform', () => ({ value: 'changed' })),
      hook('before_tool_call', 'vote', () => ({ decision: 'deny', reason: 'not allowed' })),
      hook('after_tool_call', 'single', () => { observations++; }),
    ]);
    const agent = new Agent({
      model: p, harness: harness(), extensionHooks: hooks,
      tools: [{ name: 'echo', description: 'echo', execute: async (id) => { executions++; return { toolCallId: id, name: 'echo', content: 'should not execute' }; } }],
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    await run(agent, resolved);
    expect(executions).toBe(0);
    expect(observations).toBe(0);
  });

  it('Run Vote fails closed without a model call; Observe retains denial reason', async () => {
    const requests: LLMRequest[] = [];
    const p = provider([{ content: 'should not happen', model: 'm', finishReason: 'stop' }], requests);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const ends: unknown[] = [];
    const hooks = port([
      hook('before_agent_run', 'single', () => ({ decision: 'deny', reason: 'run denied' })),
      hook('agent_end', 'single', (event) => { ends.push(event); }),
    ]);
    const agent = new Agent({ model: p, harness: harness(), extensionHooks: hooks });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    expect(requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'error' });
    expect(ends[0]).toMatchObject({ reason: 'denied', success: false, error: 'run denied' });
  });

  it('Reply Override replaces this Run candidate and Finalize transforms the selected reply', async () => {
    const requests: LLMRequest[] = [];
    const p = provider([{ content: 'original', model: 'm', finishReason: 'stop' }], requests);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const override: Message = { role: 'assistant', content: 'overridden', timestamp: 1 };
    const hooks = port([
      hook('before_agent_reply', 'single', () => override),
      hook('before_agent_finalize', 'single', () => 'final'),
    ]);
    const agent = new Agent({ model: p, harness: harness(), extensionHooks: hooks });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    expect(requests).toHaveLength(0);
    expect(agent.context.messages.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual(['final']);
    expect(events.filter((event) => event.type === 'assistant_message').map((event) => event.message.content)).toEqual(['final']);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'completed' });
  });

  it('delivers per-Iteration Runtime snapshots to the Provider without rewriting Discourse', async () => {
    const requests: LLMRequest[] = [];
    const seenModels: Array<string | undefined> = [];
    const p = provider([
      { content: 'intermediate', model: 'm', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] },
      { content: 'final', model: 'm', finishReason: 'stop' },
    ], requests);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const hooks = port([
      hook('before_iteration', 'transform', (event) => {
        const current = event as unknown as { iteration: number; messages: Message[] };
        seenModels.push(current.messages.at(-1)?.role);
        return { snapshot: `state:${current.iteration}` };
      }, 'acme.one'),
      hook('before_iteration', 'transform', () => ({ snapshot: 'second-source' }), 'acme.two'),
    ]);
    const original = formatTurnStartContent({
      turnId: 't1', at: '2026-01-01T00:00:00.000Z',
      turnContextXml: formatTurnContextXml({ turnId: 't1', slotsXml: joinSlotXml([{ tag: 'runtime_snapshot', body: 'base' }]) }),
      userText: 'go',
    });
    const agent = new Agent({
      model: p, harness: harness(), extensionHooks: hooks,
      tools: [{ name: 'echo', description: 'echo', execute: async (id) => ({ toolCallId: id, name: 'echo', content: 'done' }) }],
    });
    agent.context.messages.push({ role: 'user', content: original, timestamp: 1 });
    await run(agent, resolved);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.messages.filter((message) => message.role === 'system').every((message) => !String(message.content).includes('acme.one'))).toBe(true);
    expect(String(requests[0]!.messages.at(-1)!.content)).toContain('plugin="acme.one"');
    expect(String(requests[0]!.messages.at(-1)!.content)).toContain('state:0');
    expect(String(requests[0]!.messages.at(-1)!.content)).toContain('plugin="acme.two"');
    const secondTurn = requests[1]!.messages.findLast((message) => String(message.content).includes('<turn_start'));
    expect(String(secondTurn!.content)).toContain('state:1');
    expect(String(secondTurn!.content)).not.toContain('state:0');
    expect(seenModels).toEqual(['user', 'tool']);
    expect(agent.context.messages[0]!.content).toBe(original);
    expect(agent.context.messages.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual(['intermediate', 'final']);
  });

  it('resolves an Iteration model through the Host allowlist and sends its bound model name', async () => {
    const requests: LLMRequest[] = [];
    const initial = provider([{ content: 'initial', model: 'm', finishReason: 'stop' }], [], 'initial');
    const alternate: ModelProvider = {
      ...provider([{ content: 'alternate', model: 'alternate', finishReason: 'stop' }], requests, 'alternate'),
      defaultModel: 'alternate',
    };
    const resolved: ResolvedModel = { ref: 'initial/m', providerName: 'initial', modelName: 'm', provider: initial, source: 'config', known: true, isOverride: false };
    const hooks = port([
      hook('before_iteration', 'transform', () => ({ model: { provider: 'alternate', model: 'alternate' }, thinking: 'low' })),
    ]);
    const agent = new Agent({ model: initial, harness: harness(), extensionHooks: hooks });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events: HarnessLoopEvent[] = [];
    for await (const event of agent.run(undefined, undefined, {
      resolvedModel: resolved,
      runScope: {
        sessionId: 's', agentId: 'a', runId: 'r', prompt: 'go', resolvedModel: resolved,
        resolveConfiguredModel: (selection) => selection.provider === 'alternate' && selection.model === 'alternate'
          ? { ref: 'alternate/alternate', providerName: 'alternate', modelName: 'alternate', provider: alternate, source: 'config', known: true, isOverride: false }
          : null,
      },
    })) events.push(event);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'alternate', thinkingLevel: 'low' });
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'completed' });
  });

  it('fails closed on an unconfigured Iteration model without falling back to the default provider', async () => {
    const requests: LLMRequest[] = [];
    const p = provider([{ content: 'must not run', model: 'm', finishReason: 'stop' }], requests);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const agent = new Agent({
      model: p, harness: harness(), extensionHooks: port([
        hook('before_iteration', 'transform', () => ({ model: { provider: 'unknown', model: 'unauthorized' } })),
      ]),
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events: HarnessLoopEvent[] = [];
    for await (const event of agent.run(undefined, undefined, {
      resolvedModel: resolved,
      runScope: { sessionId: 's', agentId: 'a', runId: 'r', prompt: 'go', resolvedModel: resolved, resolveConfiguredModel: () => null },
    })) events.push(event);
    expect(requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'error' });
  });

  it('denies an Iteration once without model retries or a duplicate terminal event', async () => {
    const requests: LLMRequest[] = [];
    const p = provider([{ content: 'must not run', model: 'm', finishReason: 'stop' }], requests);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const observed: Array<{ hook: string; reason: string; success: boolean; error?: string }> = [];
    const capture = (name: string) => (event: never) => {
      const e = event as { reason: string; success: boolean; error?: string };
      observed.push({ hook: name, reason: e.reason, success: e.success, ...(e.error === undefined ? {} : { error: e.error }) });
    };
    const agent = new Agent({ model: p, harness: harness(), extensionHooks: port([
      hook('before_iteration', 'vote', () => ({ decision: 'deny', reason: 'iteration policy' })),
      hook('loop_end', 'single', capture('loop_end')),
      hook('agent_end', 'single', capture('agent_end')),
    ]) });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    expect(requests).toHaveLength(0);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'error' });
    expect(observed).toEqual([
      { hook: 'loop_end', reason: 'denied', success: false, error: 'iteration policy' },
      { hook: 'agent_end', reason: 'denied', success: false, error: 'iteration policy' },
    ]);
  });

  it('reports a clean should_stop as successful in both Run-end observations', async () => {
    const p = provider([
      { content: '', model: 'm', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'stopper', arguments: {} }] },
    ]);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const observed: Array<{ hook: string; reason: string; success: boolean }> = [];
    const capture = (name: string) => (event: never) => {
      const e = event as { reason: string; success: boolean };
      observed.push({ hook: name, reason: e.reason, success: e.success });
    };
    const agent = new Agent({
      model: p, harness: harness(),
      extensionHooks: port([
        hook('loop_end', 'single', capture('loop_end')),
        hook('agent_end', 'single', capture('agent_end')),
      ]),
      tools: [{
        name: 'stopper', description: 'stops the run cleanly',
        execute: async (id) => ({ toolCallId: id, name: 'stopper', content: 'done', terminate: true }),
      }],
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'should_stop' });
    expect(observed).toEqual([
      { hook: 'loop_end', reason: 'should_stop', success: true },
      { hook: 'agent_end', reason: 'should_stop', success: true },
    ]);
  });

  it('reports a plain model failure as error with success=false in both observations', async () => {
    const base = provider([]);
    const p: ModelProvider = {
      ...base,
      async *stream() { throw Object.assign(new Error('401 unauthorized'), { status: 401 }); },
      chat: async () => { throw Object.assign(new Error('401 unauthorized'), { status: 401 }); },
    };
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const observed: Array<{ hook: string; reason: string; success: boolean; error?: string }> = [];
    const capture = (name: string) => (event: never) => {
      const e = event as { reason: string; success: boolean; error?: string };
      observed.push({ hook: name, reason: e.reason, success: e.success, ...(e.error === undefined ? {} : { error: e.error }) });
    };
    const agent = new Agent({ model: p, harness: harness(), extensionHooks: port([
      hook('loop_end', 'single', capture('loop_end')),
      hook('agent_end', 'single', capture('agent_end')),
    ]) });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'error' });
    expect(observed).toEqual([
      { hook: 'loop_end', reason: 'error', success: false, error: '401 unauthorized' },
      { hook: 'agent_end', reason: 'error', success: false, error: '401 unauthorized' },
    ]);
  });

  it('executes the Tool after a granted Host approval instead of blocking the approved call', async () => {
    const executed: string[] = [];
    const p = provider([
      { content: '', model: 'm', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] },
      { content: 'done', model: 'm', finishReason: 'stop' },
    ]);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const agent = new Agent({
      model: p, harness: harness(),
      extensionHooks: port([
        hook('before_tool_call', 'vote', () => ({ decision: 'require_approval', approval: { title: 'Run echo', description: 'execute echo' } })),
        hook('after_tool_call', 'single', () => { executed.push('observed'); }),
      ], async () => ({ allowed: true, decision: 'approve', timedOut: false })),
      tools: [{
        name: 'echo', description: 'echo',
        execute: async (id) => { executed.push('run'); return { toolCallId: id, name: 'echo', content: 'ok' }; },
      }],
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    expect(executed).toEqual(['run', 'observed']);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'completed' });
  });

  it('turns a failed Reply Override into one error event rather than an empty successful Run', async () => {
    const requests: LLMRequest[] = [];
    const p = provider([{ content: 'must not run', model: 'm', finishReason: 'stop' }], requests);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const agent = new Agent({ model: p, harness: harness(), extensionHooks: port([
      hook('before_agent_reply', 'single', () => { throw new Error('override failed'); }),
    ]) });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    expect(requests).toHaveLength(0);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'error' });
  });

  it('keeps Run-level Hooks outside an ordinary model retry', async () => {
    let calls = 0;
    let starts = 0;
    let loops = 0;
    const base = provider([]);
    const p: ModelProvider = {
      ...base,
      async *stream(request) {
        calls++;
        if (calls === 1) throw Object.assign(new Error('429 rate limit'), { status: 429, retryAfterMs: 1 });
        yield { type: 'done' as const, finishReason: 'stop' as const };
      },
      async chat() {
        if (calls === 1) throw Object.assign(new Error('429 rate limit'), { status: 429, retryAfterMs: 1 });
        return { content: 'recovered', model: 'm', finishReason: 'stop' };
      },
    };
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const agent = new Agent({ model: p, harness: harness(), extensionHooks: port([
      hook('before_agent_run', 'single', () => { starts++; return { decision: 'allow' }; }),
      hook('loop_end', 'single', () => { loops++; }),
    ]) });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    expect(calls).toBe(2);
    expect(starts).toBe(1);
    expect(loops).toBe(1);
    expect(events.some((event) => event.type === 'model_retry')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'completed' });
  });

  it('does not apply Finalize to intermediate tool-call messages', async () => {
    const replies: unknown[] = [];
    const p = provider([
      { content: 'working', model: 'm', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] },
      { content: 'done', model: 'm', finishReason: 'stop' },
    ]);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const agent = new Agent({
      model: p, harness: harness(), extensionHooks: port([
        hook('before_agent_finalize', 'single', (event) => { replies.push(event); return 'finalized'; }),
      ]),
      tools: [{ name: 'echo', description: 'echo', execute: async (id) => ({ toolCallId: id, name: 'echo', content: 'ok' }) }],
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    await run(agent, resolved);
    expect(replies).toHaveLength(1);
    expect((replies[0] as { reply: Message }).reply).toMatchObject({ role: 'assistant', toolCalls: undefined });
    expect(agent.context.messages.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual(['working', 'finalized']);
  });

  it('re-checks SecurityGuard on the transformed arguments and blocks the dangerous call', async () => {
    const checked: Array<Record<string, unknown>> = [];
    const executed: string[] = [];
    const p = provider([
      { content: '', model: 'm', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'echo', arguments: { path: './safe' } }] },
      { content: 'done', model: 'm', finishReason: 'stop' },
    ]);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const agent = new Agent({
      model: p,
      harness: {
        ...harness(),
        security: {
          checkToolCall: (call: { arguments: Record<string, unknown> }) => {
            checked.push({ ...call.arguments });
            return call.arguments.path === '/etc/passwd'
              ? { isClean: false, violations: [{ type: 'path_traversal', severity: 'critical', description: 'sensitive path' }] }
              : { isClean: true, violations: [] };
          },
          checkUserInput: () => ({ isClean: true, violations: [] }),
          checkToolOutput: () => ({ isClean: true, violations: [] }),
          checkModelOutput: () => ({ isClean: true, violations: [] }),
          checkBehavior: () => ({ isClean: true, violations: [] }),
        },
      },
      extensionHooks: port([
        hook('before_tool_call', 'transform', () => ({ path: '/etc/passwd' })),
      ]),
      tools: [{
        name: 'echo', description: 'echo',
        execute: async (id) => { executed.push('run'); return { toolCallId: id, name: 'echo', content: 'ok' }; },
      }],
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    expect(checked).toEqual([{ path: '/etc/passwd' }]);
    expect(executed).toEqual([]);
    // A critical SecurityGuard violation blocks and terminates the Run (fail-closed).
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'should_stop' });
  });

  it('emits the finalized reply on assistant_message and persists the same content', async () => {
    const p = provider([{ content: 'raw reply', model: 'm', finishReason: 'stop' }]);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const agent = new Agent({ model: p, harness: harness(), extensionHooks: port([
      hook('before_agent_finalize', 'single', () => '[redacted]'),
    ]) });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    const assistant = events.find((event) => event.type === 'assistant_message') as { message: { content: unknown } } | undefined;
    expect(assistant?.message.content).toBe('[redacted]');
    const persisted = agent.context.messages.at(-1);
    expect(persisted?.role).toBe('assistant');
    expect(persisted?.content).toBe('[redacted]');
  });

  it('judges empty replies on the finalized content instead of the raw model output', async () => {
    const requests: LLMRequest[] = [];
    const p = provider([{ content: '', model: 'm', finishReason: 'stop' }], requests);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const agent = new Agent({
      model: p,
      harness: {
        config: {
          planningRetry: { maxAttempts: 0, steerInstruction: '' },
          emptyResponseRetry: { maxAttempts: 1, steerInstruction: 'reply now' },
          noopThreshold: 3,
          loopDetection: { enabled: false },
        },
      },
      extensionHooks: port([
        hook('before_agent_finalize', 'single', () => 'filled by plugin'),
      ]),
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    // The raw reply was empty but the finalized one is not: no empty-reply retry.
    expect(events.filter((event) => event.type === 'step_end')).toHaveLength(1);
    expect(agent.context.messages.some((message) => message.metadata?.source === 'engineHint')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'completed' });
    expect(agent.context.messages.at(-1)?.content).toBe('filled by plugin');
  });

  it('keeps one message identity across events, hooks and persistence when Finalize returns an object', async () => {
    const p = provider([{ content: 'raw', model: 'm', finishReason: 'stop' }]);
    const resolved: ResolvedModel = { ref: 'p/m', providerName: 'p', modelName: 'm', provider: p, source: 'config', known: true, isOverride: false };
    const observed: Array<{ event: Message; stored: Message | undefined }> = [];
    const agent = new Agent({ model: p, harness: harness(), extensionHooks: port([
      hook('before_agent_finalize', 'single', () => ({ role: 'assistant', content: '[object-finalized]' })),
      hook('after_iteration', 'single', (event) => {
        const e = event as { assistantMessage: Message; messages: Message[] };
        observed.push({ event: e.assistantMessage, stored: e.messages.at(-1) });
      }),
    ]) });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: 1 });
    const events = await run(agent, resolved);
    const assistant = events.find((event) => event.type === 'assistant_message') as { message: Message } | undefined;
    const persisted = agent.context.messages.at(-1)!;
    // The plugin's bare object must not replace the stored message: events, hook
    // observations and persistence share one identity, and bookkeeping fields survive.
    expect(assistant?.message).toBe(persisted);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.event).toBe(persisted);
    expect(observed[0]!.stored).toBe(persisted);
    expect(persisted.content).toBe('[object-finalized]');
    expect(persisted.timestamp).toBeTypeOf('number');
  });
});
