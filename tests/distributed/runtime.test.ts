import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime, sortByPriority } from '../../src/harness/distributed/runtime.js';
import type { SharedDeps } from '../../src/harness/distributed/runtime.js';
import type { DistributedAgentSpec } from '../../src/harness/distributed/spec.js';

function createMockSharedDeps(): SharedDeps {
  return {
    model: { defaultModel: 'test', getModelInfo: () => null, stream: vi.fn() } as any,
    events: {
      emit: vi.fn(),
      on: vi.fn(() => ({ dispose: vi.fn() })),
      onAll: vi.fn(() => ({ dispose: vi.fn() })),
    } as any,
    errorStrategy: { classify: () => ({ action: 'retry', delayMs: 100 }) } as any,
    mainTools: new Map(),
  };
}

function createCodeSpec(overrides?: Partial<DistributedAgentSpec>): DistributedAgentSpec {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    description: 'A test agent',
    triggers: [{ type: 'event', event: { type: 'test.event' } }],
    inputPolicy: { visible: ['task_summary'], snapshot: 'structured' },
    execution: {
      kind: 'code',
      handler: async (input) => ({
        kind: 'notify' as const,
        content: `processed: ${JSON.stringify(input.taskSummary)}`,
        level: 'info' as const,
      }),
    },
    outputPolicy: { mode: 'notify' },
    ...overrides,
  };
}

describe('AgentRuntime', () => {
  it('register and agentCount', () => {
    const runtime = new AgentRuntime({ deps: createMockSharedDeps() });
    expect(runtime.agentCount).toBe(0);
    runtime.register(createCodeSpec());
    expect(runtime.agentCount).toBe(1);
  });

  it('register duplicate throws', () => {
    const runtime = new AgentRuntime({ deps: createMockSharedDeps() });
    runtime.register(createCodeSpec());
    expect(() => runtime.register(createCodeSpec())).toThrow('already registered');
  });

  it('unregister removes agent', () => {
    const runtime = new AgentRuntime({ deps: createMockSharedDeps() });
    runtime.register(createCodeSpec());
    runtime.unregister('test-agent');
    expect(runtime.agentCount).toBe(0);
  });

  it('resolveTools: no tools inherits main tools', () => {
    const deps = createMockSharedDeps();
    const tool = { definition: { name: 'shell', description: 'run shell', parameters: {} }, execute: vi.fn() };
    deps.mainTools.set('shell', tool as any);
    const runtime = new AgentRuntime({ deps });
    const resolved = runtime.resolveTools();
    expect(resolved.has('shell')).toBe(true);
  });

  it('resolveTools: empty array returns no tools', () => {
    const runtime = new AgentRuntime({ deps: createMockSharedDeps() });
    const resolved = runtime.resolveTools([]);
    expect(resolved.size).toBe(0);
  });

  it('resolveTools: string[] finds by name', () => {
    const deps = createMockSharedDeps();
    const tool = { definition: { name: 'shell', description: '', parameters: {} }, execute: vi.fn() };
    deps.mainTools.set('shell', tool as any);
    const runtime = new AgentRuntime({ deps });
    const resolved = runtime.resolveTools(['shell', 'nonexistent']);
    expect(resolved.size).toBe(1);
    expect(resolved.has('shell')).toBe(true);
  });

  it('applyPendingInjections delegates to InjectionQueue', () => {
    const runtime = new AgentRuntime({ deps: createMockSharedDeps() });
    const messages: any[] = [];
    runtime.injections.enqueue({
      agentId: 'test',
      output: { kind: 'context', messages: [{ role: 'system', content: 'injected' }] },
      mode: 'inject_context',
    });
    runtime.applyPendingInjections(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('injected');
  });

  it('trigger executes code handler', async () => {
    const deps = createMockSharedDeps();
    let handlerCalled = false;
    const runtime = new AgentRuntime({ deps });
    runtime.register(createCodeSpec({
      execution: {
        kind: 'code',
        handler: async () => {
          handlerCalled = true;
          return { kind: 'notify', content: 'done', level: 'info' };
        },
      },
      outputPolicy: { mode: 'notify' },
    }));
    await runtime.trigger('test-agent', {});
    expect(handlerCalled).toBe(true);
  });

  it('trigger respects onTrigger lifecycle hook returning false', async () => {
    const deps = createMockSharedDeps();
    let handlerCalled = false;
    const runtime = new AgentRuntime({ deps });
    runtime.register(createCodeSpec({
      lifecycle: {
        onTrigger: () => false, // cancel
      },
      execution: {
        kind: 'code',
        handler: async () => {
          handlerCalled = true;
          return { kind: 'notify', content: 'done', level: 'info' };
        },
      },
    }));
    await runtime.trigger('test-agent', {});
    expect(handlerCalled).toBe(false);
  });

  it('createAgentInstance creates independent Agent for LLM spec', () => {
    const runtime = new AgentRuntime({ deps: createMockSharedDeps() });
    const spec = createCodeSpec({
      execution: {
        kind: 'llm',
        systemPrompt: 'test prompt',
        tools: [],
      },
    });
    const result = runtime.createAgentInstance(spec);
    expect(result.agent).toBeDefined();
    expect(result.harness).toBeDefined();
  });

  it('dispose cleans up resources', () => {
    const runtime = new AgentRuntime({ deps: createMockSharedDeps() });
    runtime.register(createCodeSpec());
    expect(() => runtime.dispose()).not.toThrow();
    expect(runtime.agentCount).toBe(0);
  });
});

describe('sortByPriority', () => {
  it('sorts by OutputPolicy mode priority', () => {
    const sorted = sortByPriority([
      { id: 'a', mode: 'notify' },
      { id: 'b', mode: 'intercept' },
      { id: 'c', mode: 'inject_context' },
      { id: 'd', mode: 'replace_context' },
    ]);
    expect(sorted.map(a => a.id)).toEqual(['b', 'd', 'c', 'a']);
  });
});
