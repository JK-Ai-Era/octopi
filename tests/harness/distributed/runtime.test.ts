/**
 * Tests for AgentRuntime
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRuntime, sortByPriority } from '../../../src/harness/distributed/runtime.js';
import type { SharedDeps } from '../../../src/harness/distributed/runtime.js';
import type { DistributedAgentSpec } from '../../../src/harness/distributed/spec.js';
import type { EventBus } from '../../../src/harness/distributed/../../core/event-bus.js';
import type { RegisteredTool } from '../../../src/harness/distributed/../../core/types.js';

function createMockEventBus(): EventBus & { emit: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn(),
    on: vi.fn(() => ({ dispose: vi.fn() })),
    onAll: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function createMockDeps(events?: EventBus): SharedDeps {
  return {
    model: {
      name: 'test-model',
      chat: vi.fn(),
      stream: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
      getModelInfo: vi.fn().mockReturnValue(null),
      getModelInfos: vi.fn().mockReturnValue([]),
    },
    events: events ?? createMockEventBus(),
    errorStrategy: {
      onModelError: vi.fn().mockReturnValue({ action: 'abort' }),
      onToolError: vi.fn().mockReturnValue({ action: 'skip' }),
      onContextOverflow: vi.fn().mockReturnValue({ action: 'compact' }),
      onSecurityViolation: vi.fn().mockReturnValue({ action: 'warn' }),
    },
    mainTools: new Map<string, RegisteredTool>(),
  };
}

function createCodeAgentSpec(overrides?: Partial<DistributedAgentSpec>): DistributedAgentSpec {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    description: 'A test agent',
    triggers: [{ type: 'condition', condition: { check: () => true } }],
    inputPolicy: { visible: ['task_summary'], snapshot: 'full' },
    execution: {
      kind: 'code',
      handler: async () => ({
        kind: 'notify' as const,
        content: 'test result',
        level: 'info' as const,
      }),
    },
    outputPolicy: { mode: 'notify' },
    ...overrides,
  };
}

describe('AgentRuntime', () => {
  let mockEvents: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    mockEvents = createMockEventBus();
  });

  describe('register', () => {
    it('should register a code agent', () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      const spec = createCodeAgentSpec();

      runtime.register(spec);

      expect(runtime.agentCount).toBe(1);
    });

    it('should emit registered event', () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      runtime.register(createCodeAgentSpec());

      expect(mockEvents.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'distributed_agent.registered',
          data: { agentId: 'test-agent', name: 'Test Agent' },
        })
      );
    });

    it('should throw on duplicate registration', () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      runtime.register(createCodeAgentSpec());

      expect(() => runtime.register(createCodeAgentSpec())).toThrow(
        'Agent "test-agent" already registered'
      );
    });

    it('should register multiple agents', () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });

      runtime.register(createCodeAgentSpec({ id: 'agent-1', name: 'Agent 1' }));
      runtime.register(createCodeAgentSpec({ id: 'agent-2', name: 'Agent 2' }));
      runtime.register(createCodeAgentSpec({ id: 'agent-3', name: 'Agent 3' }));

      expect(runtime.agentCount).toBe(3);
    });
  });

  describe('unregister', () => {
    it('should unregister an agent', () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      runtime.register(createCodeAgentSpec());

      runtime.unregister('test-agent');
      expect(runtime.agentCount).toBe(0);
    });
  });

  describe('resolveTools', () => {
    it('should return empty map for empty array', () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      const tools = runtime.resolveTools([]);

      expect(tools.size).toBe(0);
    });

    it('should inherit main tools when tools is undefined', () => {
      const mainTools = new Map<string, RegisteredTool>();
      mainTools.set('shell', {
        definition: { name: 'shell', description: 'Run shell', parameters: {} },
        handler: vi.fn(),
      });

      const deps = createMockDeps(mockEvents);
      deps.mainTools = mainTools;
      const runtime = new AgentRuntime({ deps });

      const tools = runtime.resolveTools();
      expect(tools.size).toBe(1);
      expect(tools.has('shell')).toBe(true);
    });

    it('should resolve tools by name', () => {
      const mainTools = new Map<string, RegisteredTool>();
      mainTools.set('shell', {
        definition: { name: 'shell', description: 'Run shell', parameters: {} },
        handler: vi.fn(),
      });
      mainTools.set('read', {
        definition: { name: 'read', description: 'Read file', parameters: {} },
        handler: vi.fn(),
      });

      const deps = createMockDeps(mockEvents);
      deps.mainTools = mainTools;
      const runtime = new AgentRuntime({ deps });

      const tools = runtime.resolveTools(['shell']);
      expect(tools.size).toBe(1);
      expect(tools.has('shell')).toBe(true);
      expect(tools.has('read')).toBe(false);
    });

    it('should use provided RegisteredTool objects', () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });

      const customTool: RegisteredTool = {
        definition: { name: 'custom', description: 'Custom tool', parameters: {} },
        handler: vi.fn(),
      };

      const tools = runtime.resolveTools([customTool]);
      expect(tools.size).toBe(1);
      expect(tools.has('custom')).toBe(true);
    });

    it('should skip missing tool names', () => {
      const deps = createMockDeps(mockEvents);
      deps.mainTools = new Map();
      const runtime = new AgentRuntime({ deps });

      const tools = runtime.resolveTools(['nonexistent']);
      expect(tools.size).toBe(0);
    });
  });

  describe('trigger', () => {
    it('should execute a code agent on manual trigger', async () => {
      const handler = vi.fn().mockResolvedValue({
        kind: 'notify',
        content: 'triggered',
        level: 'info',
      });

      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      runtime.register(createCodeAgentSpec({
        execution: { kind: 'code', handler },
      }));

      // Manual trigger
      await runtime.trigger('test-agent', {});

      expect(handler).toHaveBeenCalled();
    });

    it('should call lifecycle onTrigger hook', async () => {
      const onTrigger = vi.fn().mockReturnValue(false); // cancel execution

      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      runtime.register(createCodeAgentSpec({
        lifecycle: { onTrigger },
      }));

      await runtime.trigger('test-agent', {});

      expect(onTrigger).toHaveBeenCalled();
    });

    it('should emit start and complete events', async () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      runtime.register(createCodeAgentSpec());

      await runtime.trigger('test-agent', {});

      expect(mockEvents.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'distributed_agent.start' })
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'distributed_agent.complete' })
      );
    });

    it('should handle errors and emit error event', async () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      runtime.register(createCodeAgentSpec({
        execution: {
          kind: 'code',
          handler: async () => { throw new Error('test error'); },
        },
      }));

      await runtime.trigger('test-agent', {});

      expect(mockEvents.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'distributed_agent.error',
          data: { error: 'test error' },
        })
      );
    });

    it('should call lifecycle onError hook on failure', async () => {
      const onError = vi.fn();

      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      runtime.register(createCodeAgentSpec({
        execution: {
          kind: 'code',
          handler: async () => { throw new Error('fail'); },
        },
        lifecycle: { onError },
      }));

      await runtime.trigger('test-agent', {});

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should skip non-existent agent', async () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });

      // Should not throw
      await runtime.trigger('nonexistent', {});
    });
  });

  describe('applyPendingInjections', () => {
    it('should apply queued injections', () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      const messages: Array<{ role: string; content: string; timestamp: number }> = [];

      // Enqueue an injection
      runtime.injections.enqueue({
        agentId: 'agent-1',
        output: {
          kind: 'context',
          messages: [{ role: 'system', content: 'injected' }],
        },
        mode: 'inject_context',
      });

      runtime.applyPendingInjections(messages as any);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('injected');
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      const runtime = new AgentRuntime({ deps: createMockDeps(mockEvents) });
      runtime.register(createCodeAgentSpec());

      runtime.dispose();
      expect(runtime.agentCount).toBe(0);
    });
  });
});

describe('sortByPriority', () => {
  it('should sort by output mode priority', () => {
    const agents = [
      { id: 'a', mode: 'notify' as const },
      { id: 'b', mode: 'intercept' as const },
      { id: 'c', mode: 'inject_context' as const },
      { id: 'd', mode: 'replace_context' as const },
    ];

    const sorted = sortByPriority(agents);

    expect(sorted[0].mode).toBe('intercept');
    expect(sorted[1].mode).toBe('replace_context');
    expect(sorted[2].mode).toBe('inject_context');
    expect(sorted[3].mode).toBe('notify');
  });

  it('should maintain order for same priority', () => {
    const agents = [
      { id: 'a', mode: 'notify' as const },
      { id: 'b', mode: 'notify' as const },
    ];

    const sorted = sortByPriority(agents);

    expect(sorted[0].id).toBe('a');
    expect(sorted[1].id).toBe('b');
  });
});
