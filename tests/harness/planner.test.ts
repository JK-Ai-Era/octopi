/**
 * Planner + TaskScheduler 测试
 */

import { describe, it, expect, vi } from 'vitest';
import {
  RulePlanner,
  getDefaultRules,
  USER_MESSAGE_RULE,
  SECURITY_EVENT_RULE,
  LLMPlanner,
  HybridPlanner,
  TaskScheduler,
} from '../../src/harness/index.js';
import type { Rule, AgentState } from '../../src/harness/index.js';
import type { EventBusAgentEvent as AgentEvent } from '../../src/core/index.js';
import { DefaultEventBus } from '../../src/core/index.js';

// ── 辅助 ──

function createState(overrides?: Partial<AgentState>): AgentState {
  return {
    agentId: 'test',
    activePlan: null,
    recentExecutions: [],
    stats: { totalEvents: 0, totalExecutions: 0, totalErrors: 0, totalTokensUsed: 0, startTime: Date.now(), lastActiveTime: Date.now() },
    metadata: {},
    ...overrides,
  };
}

function event(type: string, data?: Record<string, unknown>): AgentEvent {
  return { type, timestamp: Date.now(), data };
}

// ── RulePlanner 测试 ──

describe('RulePlanner', () => {
  describe('基本功能', () => {
    it('默认规则集有 3 条规则', () => {
      const rules = getDefaultRules();
      expect(rules.length).toBe(3);
    });

    it('用户消息匹配 USER_MESSAGE_RULE', async () => {
      const planner = new RulePlanner(getDefaultRules());
      const plan = await planner.decide([event('user.message', { content: 'hello' })], createState());
      expect(plan.steps.length).toBe(1);
      expect(plan.steps[0].type).toBe('llm_call');
    });

    it('安全事件匹配 SECURITY_EVENT_RULE', async () => {
      const planner = new RulePlanner(getDefaultRules());
      const plan = await planner.decide([event('injection.detected')], createState());
      expect(plan.steps.length).toBe(1);
      expect(plan.steps[0].type).toBe('custom');
    });

    it('无匹配规则返回空计划', async () => {
      const planner = new RulePlanner([]);
      const plan = await planner.decide([event('unknown.event')], createState());
      expect(plan.steps.length).toBe(0);
    });
  });

  describe('规则匹配', () => {
    it('支持通配符匹配', async () => {
      const planner = new RulePlanner([{
        id: 'test',
        name: 'test',
        priority: 10,
        when: { eventType: 'user.*' },
        then: [{ type: 'llm_call', description: 'handle user event' }],
      }]);

      const plan = await planner.decide([event('user.message')], createState());
      expect(plan.steps.length).toBe(1);

      const plan2 = await planner.decide([event('other.event')], createState());
      expect(plan2.steps.length).toBe(0);
    });

    it('支持自定义条件', async () => {
      const planner = new RulePlanner([{
        id: 'test',
        name: 'test',
        priority: 10,
        when: { custom: (e, s) => e.type === 'test' && s.agentId === 'test' },
        then: [{ type: 'wait', description: 'custom match' }],
      }]);

      const plan = await planner.decide([event('test')], createState());
      expect(plan.steps.length).toBe(1);
    });

    it('按优先级匹配（高优先级先匹配）', async () => {
      const planner = new RulePlanner([
        { id: 'low', name: 'low', priority: 1, when: { eventType: 'test' }, then: [{ type: 'wait', description: 'low' }] },
        { id: 'high', name: 'high', priority: 100, when: { eventType: 'test' }, then: [{ type: 'llm_call', description: 'high' }] },
      ]);

      const plan = await planner.decide([event('test')], createState());
      expect(plan.steps[0].description).toBe('high');
    });

    it('once 规则只触发一次', async () => {
      const planner = new RulePlanner([{
        id: 'once',
        name: 'once',
        priority: 10,
        when: { eventType: 'test' },
        then: [{ type: 'wait', description: 'once' }],
        once: true,
      }]);

      const plan1 = await planner.decide([event('test')], createState());
      expect(plan1.steps.length).toBe(1);

      const plan2 = await planner.decide([event('test')], createState());
      expect(plan2.steps.length).toBe(0);
    });
  });

  describe('addRule / removeRule', () => {
    it('可以动态添加规则', async () => {
      const planner = new RulePlanner([]);
      let plan = await planner.decide([event('test')], createState());
      expect(plan.steps.length).toBe(0);

      planner.addRule({ id: 'new', name: 'new', priority: 10, when: { eventType: 'test' }, then: [{ type: 'wait', description: 'added' }] });
      plan = await planner.decide([event('test')], createState());
      expect(plan.steps.length).toBe(1);
    });

    it('可以移除规则', async () => {
      const planner = new RulePlanner([{ id: 'r1', name: 'r1', priority: 10, when: { eventType: 'test' }, then: [{ type: 'wait', description: 'x' }] }]);
      planner.removeRule('r1');
      const plan = await planner.decide([event('test')], createState());
      expect(plan.steps.length).toBe(0);
    });
  });

  describe('decompose', () => {
    it('返回单步骤 LLM 计划', async () => {
      const planner = new RulePlanner([]);
      const plan = await planner.decompose('分析代码', createState());
      expect(plan.steps.length).toBe(1);
      expect(plan.steps[0].type).toBe('llm_call');
      expect(plan.goal).toBe('分析代码');
    });
  });
});

// ── LLMPlanner 测试 ──

describe('LLMPlanner', () => {
  it('decide 调用 LLM 并解析结果', async () => {
    const mockModel = {
      name: 'mock',
      async chat() {
        return {
          content: JSON.stringify({ goal: 'reply', steps: [{ description: 'say hi', type: 'llm_call', params: {} }] }),
          model: 'mock',
          finishReason: 'stop' as const,
        };
      },
      async *stream() {},
      async isAvailable() { return true; },
    };

    const planner = new LLMPlanner({ model: mockModel });
    const plan = await planner.decide([event('user.message', { content: 'hi' })], createState());
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].description).toBe('say hi');
  });

  it('LLM 返回无效 JSON 时返回空计划', async () => {
    const mockModel = {
      name: 'mock',
      async chat() {
        return { content: '这不是JSON', model: 'mock', finishReason: 'stop' as const };
      },
      async *stream() {},
      async isAvailable() { return true; },
    };

    const planner = new LLMPlanner({ model: mockModel });
    const plan = await planner.decide([event('test')], createState());
    expect(plan.steps.length).toBe(0);
  });

  it('decompose 调用 LLM 分解目标', async () => {
    const mockModel = {
      name: 'mock',
      async chat() {
        return {
          content: JSON.stringify({ goal: '写报告', steps: [{ description: '收集数据', type: 'tool_call', params: {} }, { description: '生成报告', type: 'llm_call', params: {} }] }),
          model: 'mock',
          finishReason: 'stop' as const,
        };
      },
      async *stream() {},
      async isAvailable() { return true; },
    };

    const planner = new LLMPlanner({ model: mockModel });
    const plan = await planner.decompose('写报告', createState());
    expect(plan.steps.length).toBe(2);
    expect(plan.goal).toBe('写报告');
  });
});

// ── HybridPlanner 测试 ──

describe('HybridPlanner', () => {
  it('规则匹配时不用 LLM', async () => {
    const chatSpy = vi.fn().mockResolvedValue({ content: '{}', model: 'm', finishReason: 'stop' });
    const mockModel = { name: 'mock', chat: chatSpy, async *stream() {}, async isAvailable() { return true; } };

    const planner = new HybridPlanner({ llm: { model: mockModel } });
    await planner.decide([event('user.message', { content: 'hi' })], createState());

    expect(chatSpy).not.toHaveBeenCalled();
  });

  it('规则不匹配时 fallback 到 LLM', async () => {
    const chatSpy = vi.fn().mockResolvedValue({
      content: JSON.stringify({ goal: 'handle', steps: [{ description: 'llm step', type: 'llm_call', params: {} }] }),
      model: 'm',
      finishReason: 'stop',
    });
    const mockModel = { name: 'mock', chat: chatSpy, async *stream() {}, async isAvailable() { return true; } };

    const planner = new HybridPlanner({ llm: { model: mockModel } });
    const plan = await planner.decide([event('unknown.event')], createState());

    expect(chatSpy).toHaveBeenCalled();
    expect(plan.steps.length).toBe(1);
  });

  it('禁用 fallback 时返回空计划', async () => {
    const chatSpy = vi.fn();
    const mockModel = { name: 'mock', chat: chatSpy, async *stream() {}, async isAvailable() { return true; } };

    const planner = new HybridPlanner({ llm: { model: mockModel }, enableLLMFallback: false });
    const plan = await planner.decide([event('unknown.event')], createState());

    expect(chatSpy).not.toHaveBeenCalled();
    expect(plan.steps.length).toBe(0);
  });
});

// ── TaskScheduler 测试 ──

describe('TaskScheduler', () => {
  describe('基本功能', () => {
    it('启动和停止', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.running).toBe(false);
      scheduler.start();
      expect(scheduler.running).toBe(true);
      scheduler.stop();
      expect(scheduler.running).toBe(false);
    });

    it('添加任务后 taskCount 增加', () => {
      const scheduler = new TaskScheduler();
      scheduler.scheduleOnce('test', 10000, () => {});
      expect(scheduler.taskCount).toBe(1);
    });
  });

  describe('scheduleOnce', () => {
    it('延迟执行一次', async () => {
      const scheduler = new TaskScheduler();
      const executed: string[] = [];
      scheduler.scheduleOnce('once-task', 20, () => { executed.push('done'); });
      scheduler.start();

      await new Promise(r => setTimeout(r, 50));
      scheduler.stop();

      expect(executed).toEqual(['done']);
    });

    it('执行后自动删除', async () => {
      const scheduler = new TaskScheduler();
      scheduler.scheduleOnce('once-task', 20, () => {});
      scheduler.start();

      await new Promise(r => setTimeout(r, 50));
      scheduler.stop();

      expect(scheduler.taskCount).toBe(0);
    });
  });

  describe('scheduleInterval', () => {
    it('按间隔重复执行', async () => {
      const scheduler = new TaskScheduler({ checkIntervalMs: 10 });
      let count = 0;
      scheduler.scheduleInterval('interval-task', 20, () => { count++; });
      scheduler.start();

      await new Promise(r => setTimeout(r, 80));
      scheduler.stop();

      expect(count).toBeGreaterThanOrEqual(3);
    });

    it('达到最大次数后停止', async () => {
      const scheduler = new TaskScheduler({ checkIntervalMs: 10 });
      let count = 0;
      scheduler.scheduleInterval('limited', 20, () => { count++; }, 2);
      scheduler.start();

      await new Promise(r => setTimeout(r, 100));
      scheduler.stop();

      expect(count).toBe(2);
    });
  });

  describe('cancel / pause / resume', () => {
    it('cancel 删除任务', () => {
      const scheduler = new TaskScheduler();
      const task = scheduler.scheduleOnce('test', 10000, () => {});
      expect(scheduler.cancel(task.id)).toBe(true);
      expect(scheduler.taskCount).toBe(0);
    });

    it('pause 暂停任务', async () => {
      const scheduler = new TaskScheduler({ checkIntervalMs: 10 });
      let count = 0;
      const task = scheduler.scheduleInterval('paused', 20, () => { count++; });
      scheduler.start();

      await new Promise(r => setTimeout(r, 10));
      scheduler.pause(task.id);

      const countAtPause = count;
      await new Promise(r => setTimeout(r, 50));
      scheduler.stop();

      expect(count).toBe(countAtPause); // 暂停后不再执行
    });

    it('resume 恢复任务', async () => {
      const scheduler = new TaskScheduler({ checkIntervalMs: 10 });
      let count = 0;
      const task = scheduler.scheduleInterval('resumable', 20, () => { count++; });
      scheduler.start();

      scheduler.pause(task.id);
      await new Promise(r => setTimeout(r, 30));
      scheduler.resume(task.id);

      const countBeforeResume = count;
      await new Promise(r => setTimeout(r, 50));
      scheduler.stop();

      expect(count).toBeGreaterThan(countBeforeResume);
    });
  });

  describe('事件', () => {
    it('发射 task.completed 事件', async () => {
      const bus = new DefaultEventBus();
      const events: string[] = [];
      bus.onAll(e => events.push(e.type));

      const scheduler = new TaskScheduler({}, bus);
      scheduler.scheduleOnce('event-test', 10, () => {});
      scheduler.start();

      await new Promise(r => setTimeout(r, 30));
      scheduler.stop();

      expect(events).toContain('scheduler.task.completed');
    });
  });

  describe('list / get', () => {
    it('list 返回所有任务', () => {
      const scheduler = new TaskScheduler();
      scheduler.scheduleOnce('a', 10000, () => {});
      scheduler.scheduleInterval('b', 10000, () => {});
      expect(scheduler.list().length).toBe(2);
    });

    it('get 返回指定任务', () => {
      const scheduler = new TaskScheduler();
      const task = scheduler.scheduleOnce('specific', 10000, () => {});
      expect(scheduler.get(task.id)?.name).toBe('specific');
    });
  });
});
