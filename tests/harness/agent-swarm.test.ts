/**
 * AgentSwarm 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSwarm, RoundRobinStrategy, CapabilityStrategy, PipelineStrategy } from '../../src/harness/multi-agent/swarm.js';
import { DefaultAgentRegistry } from '../../src/harness/multi-agent/registry.js';
import { DefaultEventBus } from '../../src/core/event-bus.js';
import { Agent } from '../../src/core/loop/agent.js';
import type { ReliabilityHarness } from '../../src/harness/reliability/run-agent.js';
import { SwarmEvents } from '../../src/harness/multi-agent/types.js';
import type { SwarmAgent, SwarmTask } from '../../src/harness/multi-agent/types.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../../src/core/interfaces/model-provider.js';
import type { AgentInfo } from '../../src/core/interfaces/agent-registry.js';
import type { Message } from '../../src/core/types.js';

// ── Mock 工厂 ──

function createMockModelProvider(response?: string): ModelProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: response ?? 'Task completed successfully.',
      model: 'mock-model',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
    stream: async function* (req: LLMRequest): AsyncGenerator<LLMStreamChunk> {
      yield { type: 'content' as const, content: response ?? 'Task completed successfully.' };
      yield { type: 'done' as const };
    },
    isAvailable: async () => true,
    getModelInfo: () => null,
  };
}

function createMockAgent(response?: string): { agent: Agent; harness: ReliabilityHarness } {
  const agent = new Agent({
    model: createMockModelProvider(response),
    systemPrompt: '',
  });
  const harness: ReliabilityHarness = {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
    },
  };
  return { agent, harness };
}

function createSwarmAgent(id: string, name: string, capabilities: string[] = []): SwarmAgent {
  return {
    info: {
      id,
      name,
      capabilities,
      status: 'active',
      registeredAt: Date.now(),
      lastActiveAt: Date.now(),
    },
    ...createMockAgent(`Response from ${name}`),
  };
}

// ── 测试 ──

describe('AgentSwarm', () => {
  let swarm: AgentSwarm;
  let registry: DefaultAgentRegistry;
  let events: DefaultEventBus;

  beforeEach(() => {
    events = new DefaultEventBus();
    registry = new DefaultAgentRegistry(events);
    swarm = new AgentSwarm(
      { name: 'test-swarm', topology: 'hierarchical' },
      registry,
      events,
    );
  });

  // ── Agent 管理 ──

  describe('agent management', () => {
    it('should add an agent', () => {
      const agent = createSwarmAgent('a1', 'Agent 1', ['coding']);
      swarm.addAgent(agent);

      expect(swarm.listAgents()).toHaveLength(1);
      expect(swarm.getAgent('a1')).toBeDefined();
    });

    it('should register agent in registry when adding', () => {
      const agent = createSwarmAgent('a1', 'Agent 1', ['coding']);
      swarm.addAgent(agent);

      expect(registry.get('a1')).toBeDefined();
      expect(registry.get('a1')!.name).toBe('Agent 1');
    });

    it('should emit AGENT_ADDED event', () => {
      const handler = vi.fn();
      events.on(SwarmEvents.AGENT_ADDED, handler);

      swarm.addAgent(createSwarmAgent('a1', 'Agent 1'));

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should remove an agent', () => {
      swarm.addAgent(createSwarmAgent('a1', 'Agent 1'));
      swarm.removeAgent('a1');

      expect(swarm.listAgents()).toHaveLength(0);
      expect(registry.get('a1')).toBeUndefined();
    });

    it('should emit AGENT_REMOVED event', () => {
      const handler = vi.fn();
      events.on(SwarmEvents.AGENT_REMOVED, handler);

      swarm.addAgent(createSwarmAgent('a1', 'Agent 1'));
      swarm.removeAgent('a1');

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ── 任务管理 ──

  describe('task management', () => {
    it('should submit a task', () => {
      const task = swarm.submitTask('Do something', 'input data');

      expect(task.id).toBeDefined();
      expect(task.description).toBe('Do something');
      expect(task.input).toBe('input data');
      expect(task.status).toBe('pending');
    });

    it('should emit TASK_CREATED event', () => {
      const handler = vi.fn();
      events.on(SwarmEvents.TASK_CREATED, handler);

      swarm.submitTask('Do something', 'input');

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should get a task by id', () => {
      const task = swarm.submitTask('Do something', 'input');
      expect(swarm.getTask(task.id)).toBeDefined();
    });

    it('should list all tasks', () => {
      swarm.submitTask('Task 1', 'input 1');
      swarm.submitTask('Task 2', 'input 2');

      expect(swarm.listTasks()).toHaveLength(2);
    });
  });

  // ── 任务执行 ──

  describe('task execution', () => {
    it('should execute a task with an agent', async () => {
      swarm.addAgent(createSwarmAgent('a1', 'Worker', ['coding']));
      const task = swarm.submitTask('Write code', 'Create a hello world');

      const result = await swarm.executeTask(task);

      expect(result.status).toBe('completed');
      expect(result.result).toBe('Response from Worker');
      expect(result.assignedTo).toBe('a1');
      expect(result.completedAt).toBeDefined();
    });

    it('should fail when no suitable agent', async () => {
      const task = swarm.submitTask('Do something', 'input');
      const result = await swarm.executeTask(task);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('No suitable agent');
    });

    it('should emit TASK_ASSIGNED event', async () => {
      const handler = vi.fn();
      events.on(SwarmEvents.TASK_ASSIGNED, handler);

      swarm.addAgent(createSwarmAgent('a1', 'Worker', ['coding']));
      const task = swarm.submitTask('Write code', 'input');
      await swarm.executeTask(task);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should emit TASK_COMPLETED event', async () => {
      const handler = vi.fn();
      events.on(SwarmEvents.TASK_COMPLETED, handler);

      swarm.addAgent(createSwarmAgent('a1', 'Worker', ['coding']));
      const task = swarm.submitTask('Write code', 'input');
      await swarm.executeTask(task);

      expect(handler).toHaveBeenCalledOnce();
    });

    it('should update agent status during execution', async () => {
      const agent = createSwarmAgent('a1', 'Worker', ['coding']);
      swarm.addAgent(agent);

      // 监听状态变更
      const statusChanges: string[] = [];
      events.on('registry.agent.status_changed', (event) => {
        statusChanges.push(event.data.newStatus as string);
      });

      const task = swarm.submitTask('Write code', 'input');
      await swarm.executeTask(task);

      expect(statusChanges).toContain('busy');
      expect(statusChanges).toContain('idle');
    });
  });

  // ── 广播任务 ──

  describe('broadcastTask', () => {
    it('should execute task on all active agents', async () => {
      swarm.addAgent(createSwarmAgent('a1', 'Worker 1', ['coding']));
      swarm.addAgent(createSwarmAgent('a2', 'Worker 2', ['analysis']));

      const results = await swarm.broadcastTask('Analyze data', 'input data');

      expect(results).toHaveLength(2);
      expect(results.every(t => t.status === 'completed')).toBe(true);
    });

    it('should skip busy agents', async () => {
      swarm.addAgent(createSwarmAgent('a1', 'Worker 1', ['coding']));
      const agent2 = createSwarmAgent('a2', 'Worker 2', ['analysis']);
      agent2.info.status = 'busy';
      swarm.addAgent(agent2);

      const results = await swarm.broadcastTask('Analyze data', 'input');

      expect(results).toHaveLength(1);
    });
  });

  // ── 编排策略 ──

  describe('strategies', () => {
    describe('RoundRobinStrategy', () => {
      it('should distribute tasks round-robin', async () => {
        const strategy = new RoundRobinStrategy();
        swarm.setStrategy(strategy);

        swarm.addAgent(createSwarmAgent('a1', 'Worker 1', ['coding']));
        swarm.addAgent(createSwarmAgent('a2', 'Worker 2', ['coding']));

        const task1 = swarm.submitTask('Task 1', 'input');
        const task2 = swarm.submitTask('Task 2', 'input');

        const result1 = await swarm.executeTask(task1);
        const result2 = await swarm.executeTask(task2);

        expect(result1.assignedTo).toBe('a1');
        expect(result2.assignedTo).toBe('a2');
      });
    });

    describe('CapabilityStrategy', () => {
      it('should match agent capabilities to task description', async () => {
        const strategy = new CapabilityStrategy();
        swarm.setStrategy(strategy);

        swarm.addAgent(createSwarmAgent('a1', 'Coder', ['coding']));
        swarm.addAgent(createSwarmAgent('a2', 'Analyst', ['analysis']));

        const task = swarm.submitTask('analysis report', 'data');
        const result = await swarm.executeTask(task);

        expect(result.assignedTo).toBe('a2');
      });
    });

    describe('PipelineStrategy', () => {
      it('should chain agents in order', async () => {
        const strategy = new PipelineStrategy(['a1', 'a2']);
        swarm.setStrategy(strategy);

        swarm.addAgent(createSwarmAgent('a1', 'Step 1', ['step1']));
        swarm.addAgent(createSwarmAgent('a2', 'Step 2', ['step2']));

        const task = swarm.submitTask('Pipeline task', 'initial input');
        const result = await swarm.executeTask(task);

        // 流水线应该先执行 a1，然后 a2
        expect(result.status).toBe('completed');
        // 检查是否创建了后续任务
        const tasks = swarm.listTasks();
        expect(tasks.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // ── 策略切换 ──

  describe('strategy management', () => {
    it('should get default strategy based on topology', () => {
      const strategy = swarm.getStrategy();
      expect(strategy.name).toBeDefined();
    });

    it('should allow strategy change', () => {
      const newStrategy = new RoundRobinStrategy();
      swarm.setStrategy(newStrategy);
      expect(swarm.getStrategy().name).toBe('round-robin');
    });
  });
});
