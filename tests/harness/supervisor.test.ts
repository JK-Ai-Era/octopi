/**
 * AgentSupervisor 测试
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DefaultEventBus,
  ProcessModel,
} from '../../src/core/index.js';
import type { EventBus, EventBusAgentEvent as AgentEvent } from '../../src/core/index.js';
import { Agent } from '../../src/loop/agent.js';
import type { Agent as AgentType } from '../../src/loop/agent.js';
import type { Message } from '../../src/core/types.js';
import {
  AgentSupervisor as Supervisor,
  EventCollector,
  SupervisorEvents,
  startSupervisor,
} from '../../src/harness/task-system/supervisor/index.js';
import type {
  Planner,
  Plan,
  AgentState,
  StepResult,
  Reflector,
  ExecutionRecord,
  Pattern,
} from '../../src/harness/task-system/supervisor/index.js';

// ── 辅助 ──

function createEvents(): { bus: EventBus; events: AgentEvent[] } {
  const bus = new DefaultEventBus();
  const events: AgentEvent[] = [];
  bus.onAll((e) => events.push(e));
  return { bus, events };
}

function createPlanner(overrides?: Partial<Planner>): Planner {
  return {
    name: 'test-planner',
    async decide(events, state): Promise<Plan> {
      // 默认：将每个事件转换为一个 llm_call 步骤
      return {
        id: `plan-${Date.now()}`,
        goal: 'handle events',
        steps: events.map((e, i) => ({
          id: `step-${i}`,
          description: `Handle ${e.type}`,
          type: 'llm_call' as const,
          params: { prompt: `Process: ${e.type}` },
          status: 'pending' as const,
        })),
        currentStepIndex: 0,
        status: 'pending',
        createdAt: Date.now(),
      };
    },
    async decompose(goal): Promise<Plan> {
      return {
        id: `plan-${Date.now()}`,
        goal,
        steps: [{
          id: 'step-0',
          description: goal,
          type: 'llm_call',
          params: {},
          status: 'pending',
        }],
        currentStepIndex: 0,
        status: 'pending',
        createdAt: Date.now(),
      };
    },
    ...overrides,
  };
}

function createEmptyPlanner(): Planner {
  return createPlanner({
    name: 'empty-planner',
    async decide() {
      return {
        id: 'empty-plan',
        goal: 'do nothing',
        steps: [],
        currentStepIndex: 0,
        status: 'pending',
        createdAt: Date.now(),
      };
    },
  });
}

function createReflector(): Reflector & { assessments: unknown[]; patterns: Pattern[] } {
  const assessments: unknown[] = [];
  const patterns: Pattern[] = [];
  return {
    name: 'test-reflector',
    assessments,
    patterns,
    async assess(record) {
      const assessment = { quality: 0.8, success: record.result.success };
      assessments.push(assessment);
      return assessment;
    },
    async detectPatterns() {
      return patterns;
    },
  };
}

// ── EventCollector 测试 ──

describe('EventCollector', () => {
  it('创建后队列为空', () => {
    const collector = new EventCollector();
    expect(collector.pendingCount).toBe(0);
  });

  it('inject 后事件入队', () => {
    const collector = new EventCollector();
    collector.inject({ type: 'test', timestamp: Date.now() });
    expect(collector.pendingCount).toBe(1);
  });

  it('collect 立即返回队列中的事件', async () => {
    const collector = new EventCollector();
    collector.inject({ type: 'a', timestamp: 1 });
    collector.inject({ type: 'b', timestamp: 2 });

    const events = await collector.collect(1000);
    expect(events.length).toBe(2);
    expect(collector.pendingCount).toBe(0);
  });

  it('collect 阻塞等待新事件', async () => {
    const collector = new EventCollector();

    // 延迟注入
    setTimeout(() => {
      collector.inject({ type: 'delayed', timestamp: Date.now() });
    }, 20);

    const events = await collector.collect(5000);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('delayed');
  });

  it('collect 超时返回空数组', async () => {
    const collector = new EventCollector();
    const events = await collector.collect(30);
    expect(events).toEqual([]);
  });

  it('安全事件排在前面', async () => {
    const collector = new EventCollector();
    collector.inject({ type: 'normal', timestamp: 1 });
    collector.inject({ type: 'injection.detected', timestamp: 2 });
    collector.inject({ type: 'another', timestamp: 3 });

    const events = await collector.collect(100);
    expect(events[0].type).toBe('injection.detected');
  });

  it('订阅 EventBus 事件', () => {
    const { bus } = createEvents();
    const collector = new EventCollector(bus);
    collector.subscribeEventBus();

    bus.emit({ type: 'test.event', timestamp: Date.now() });
    expect(collector.pendingCount).toBe(1);
  });

  it('stop 清空所有等待者', async () => {
    const collector = new EventCollector();

    // 开始一个会阻塞的 collect
    const collectPromise = collector.collect(10000);

    // 立即 stop
    await collector.stop();

    const events = await collectPromise;
    expect(events).toEqual([]);
  });
});

// ── AgentSupervisor 测试 ──

describe('AgentSupervisor', () => {
  describe('基本生命周期', () => {
    it('创建后未运行', () => {
      const { bus } = createEvents();
      const planner = createPlanner();
      const supervisor = new Supervisor({ agentId: 'test', planner }, bus);
      expect(supervisor.running).toBe(false);
    });

    it('有正确的 id 和 name', () => {
      const planner = createPlanner();
      const supervisor = new Supervisor({ agentId: 'test', planner, name: 'my-agent' });
      expect(supervisor.name).toBe('my-agent');
      expect(supervisor.agentId).toBe('test');
      expect(supervisor.id).toBeDefined();
    });

    it('state 包含初始值', () => {
      const planner = createPlanner();
      const supervisor = new Supervisor({ agentId: 'test', planner });
      expect(supervisor.state.agentId).toBe('test');
      expect(supervisor.state.activePlan).toBeNull();
      expect(supervisor.state.recentExecutions).toEqual([]);
    });
  });

  describe('事件注入', () => {
    it('injectMessage 将消息转为事件', () => {
      const planner = createPlanner();
      const supervisor = new Supervisor({ agentId: 'test', planner });

      supervisor.injectMessage({
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
      });

      expect(supervisor.collector.pendingCount).toBe(1);
    });
  });

  describe('空计划', () => {
    it('Planner 返回空计划时不执行任何步骤', async () => {
      const { bus, events } = createEvents();
      const planner = createEmptyPlanner();
      const supervisor = new Supervisor({
        agentId: 'test',
        planner,
        idleTimeoutMs: 30,
      }, bus);

      // 注入一个事件
      supervisor.injectMessage({
        role: 'user',
        content: 'test',
        timestamp: Date.now(),
      });

      // mock agent
      const mockModel = {
        name: 'mock',
        chat: vi.fn(),
        stream: async function* () { yield { type: 'done' as const }; },
        isAvailable: async () => true,
        getModelInfo: () => null,
      };
      const mockAgent = new Agent({ model: mockModel, systemPrompt: '' });
      const mockHarness = { config: { planningRetry: { maxAttempts: 0, steerInstruction: '' }, emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' }, noopThreshold: 3, loopDetection: { enabled: false } } };

      // 启动 supervisor，等待一个循环
      const startPromise = supervisor.start(mockAgent, mockHarness);
      await new Promise(r => setTimeout(r, 100));
      await supervisor.stop();

      // 不应该调用 model
      expect(mockModel.chat).not.toHaveBeenCalled();
    });
  });

  describe('SupervisorEvents', () => {
    it('定义了所有预期事件类型', () => {
      expect(SupervisorEvents.CYCLE_START).toBe('supervisor.cycle.start');
      expect(SupervisorEvents.CYCLE_END).toBe('supervisor.cycle.end');
      expect(SupervisorEvents.PLAN_CREATED).toBe('supervisor.plan.created');
      expect(SupervisorEvents.PLAN_COMPLETED).toBe('supervisor.plan.completed');
      expect(SupervisorEvents.PLAN_FAILED).toBe('supervisor.plan.failed');
      expect(SupervisorEvents.STEP_EXECUTING).toBe('supervisor.step.executing');
      expect(SupervisorEvents.STEP_COMPLETED).toBe('supervisor.step.completed');
      expect(SupervisorEvents.IDLE).toBe('supervisor.idle');
    });
  });
});
