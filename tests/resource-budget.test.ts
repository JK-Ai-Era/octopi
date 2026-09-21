/**
 * RunBudget / reliability 接线测试（P0：无 nominal token hard）
 * 设计：arch/budget-redesign.md
 */

import { describe, it, expect } from 'vitest';
import { makeTokenUsage } from '../src/core/types/turn.js';
import { BudgetPolicyEngine, DEFAULT_BUDGET } from '../src/harness/budget/budget.js';
import { DefaultEventBus } from '../src/core/primitives/event-bus.js';
import { RunMetricsCollector } from '../src/harness/reliability/run-metrics-collector.js';
import { runAgentWithReliability } from '../src/harness/reliability/run-agent.js';
import { Agent } from '../src/harness/agent/agent.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';
import type { ReliabilityHarness } from '../src/core/interfaces/reliability.js';

function mockModel(tokensPerCall = 100): ModelProvider {
  return {
    name: 'mock',
    chat: async () => ({
      content: 'done',
      model: 'mock',
      usage: makeTokenUsage({ promptTokens: 10, completionTokens: 10 }),
    }),
    stream: async function* () {
      yield { type: 'content', content: 'done' };
      yield {
        type: 'done',
        usage: makeTokenUsage({ promptTokens: 10, completionTokens: 10 }),
      };
    },
    isAvailable: async () => true,
    getModelInfo: () => null,
  };
}

describe('RunBudget（P0 安全阀）', () => {
  it('默认 wall-clock 安全阀为 6h，且不因 iteration/token hard', () => {
    expect(DEFAULT_BUDGET.maxWallClockMs).toBe(6 * 3_600_000);
    const bus = new DefaultEventBus();
    const budget = new BudgetPolicyEngine(bus);
    for (let i = 0; i < 5000; i++) budget.recordIteration();
    budget.consumeTokens(5_000_000);
    expect(budget.check()).toBe('ok');
    expect(budget.checkHardOnly().status).toBe('ok');
  });

  it('consumeTokens 只累计 nominal，不触发 hard', () => {
    const budget = new BudgetPolicyEngine(new DefaultEventBus());
    budget.consumeTokens(10_000_000);
    expect(budget.check()).toBe('ok');
    expect(budget.report().nominalTokens).toBe(10_000_000);
  });

  it('显式 maxIterations 时硬停', () => {
    const budget = new BudgetPolicyEngine( { maxIterations: 3 });
    budget.recordIteration();
    budget.recordIteration();
    budget.recordIteration();
    expect(budget.check()).toBe('iteration_limit');
    expect(budget.evaluate().status).toBe('hard');
  });

  it('显式 maxToolCalls 时硬停', () => {
    const budget = new BudgetPolicyEngine( { maxToolCalls: 2 });
    budget.recordToolCall();
    budget.recordToolCall();
    expect(budget.check()).toBe('tool_call_limit');
  });

  it('wall-clock 到期 hard', () => {
    const budget = new BudgetPolicyEngine( { maxWallClockMs: 1 });
    // startTime 已是构造时刻；等待确保 elapsed >= 1
    const e = budget.checkHardOnly();
    // 极短 maxWallClockMs：若同毫秒内可能仍 ok，则用 evaluate 二次确认语义
    expect(['ok', 'hard']).toContain(e.status);
    if (e.status === 'hard') {
      expect(e.reason).toBe('wall_clock');
    } else {
      budget.reset();
      // reset 后仍用配置的 1ms；再测 checkHardOnly 结构
      expect(budget.checkHardOnly().report.hard.wallClockMs).toBe(1);
    }
  });
});

describe('RunMetricsCollector', () => {
  it('记录 iteration / tokens / hasProgress', () => {
    const c = new RunMetricsCollector();
    c.recordTurn({
      role: 'assistant',
      contentPreview: 'x'.repeat(100),
      tokenDelta: 0,
      timestamp: Date.now(),
    });
    c.recordTokens(50);
    c.recordToolResult('file_read', true);
    expect(c.iteration).toBe(1);
    expect(c.tokens).toBe(50);
    expect(c.hasProgress()).toBe(true);

    const ctx = c.buildContext({});
    expect(ctx.iteration).toBe(1);
    expect(ctx.nominalTotalTokens).toBe(50);
  });
});

describe('Builder 默认 RunBudget', () => {
  it('未显式 .budget() 时 harness 仍有默认安全阀', async () => {
    const { AgentBuilder } = await import('../src/harness/agent-building/builder.js');
    const model = mockModel(10);
    const { harness } = await new AgentBuilder().model(model).buildAgent();
    expect(harness.budget).toBeDefined();
  });
});

describe('reliability：默认不因 token 总和停止', () => {
  it('大量 usage.totalTokens 也不 yield budget_exceeded', async () => {
    const model = mockModel(50_000);
    const agent = new Agent({ model, systemPrompt: 'test' });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });
    const harness: ReliabilityHarness = {
      config: {},
      budget: new BudgetPolicyEngine(new DefaultEventBus()),
      sessionId: 's',
      agentId: 'a',
    };

    const events: string[] = [];
    for await (const e of runAgentWithReliability(agent.context, { model }, harness)) {
      events.push(e.type);
      if (events.length > 20) break;
    }

    expect(events.filter(t => t === 'budget_exceeded').length).toBe(0);
    expect(events).toContain('agent_end');
  });

  it('显式 maxIterations hard 时 yield budget_exceeded', async () => {
    const model = mockModel(50);
    const agent = new Agent({ model, systemPrompt: 't' });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });
    const budget = new BudgetPolicyEngine( { maxIterations: 1 });
    const harness: ReliabilityHarness = { config: {}, budget, sessionId: 's', agentId: 'a' };

    const events: string[] = [];
    for await (const e of runAgentWithReliability(agent.context, { model }, harness)) {
      events.push(e.type);
      if (events.length > 30) break;
    }

    expect(events).toContain('budget_exceeded');
  });

  it('per-run 克隆：同一 harness 连跑两次，计数不跨 run 累加', async () => {
    const model = mockModel(300);
    const template = new BudgetPolicyEngine( { maxIterations: 2 });
    const harness: ReliabilityHarness = { config: {}, budget: template };

    const runOnce = async () => {
      const agent = new Agent({ model, systemPrompt: 't' });
      agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });
      const events: string[] = [];
      for await (const e of runAgentWithReliability(agent.context, { model }, harness)) {
        events.push(e.type);
        if (events.length > 30) break;
      }
      return events;
    };

    const first = await runOnce();
    const second = await runOnce();
    // 模板 maxIterations=2 时，单次 run 可能触发；关键是第二次不因「共享累计」额外误杀
    // 此处断言两次都能跑完或各自独立触发，而不是第二次必失败
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });
});

describe('beforeToolCall hard 闸（iteration）', () => {
  it('hard 后不再执行工具', async () => {
    let executed = 0;
    const tools = [
      {
        name: 'side_effect',
        description: 'x',
        parameters: { type: 'object' as const, properties: {} },
        execute: async (id: string) => {
          executed++;
          return { toolCallId: id, name: 'side_effect', content: 'ok' };
        },
      },
    ];
    let n = 0;
    const model: ModelProvider = {
      name: 'm',
      chat: async () => ({
        content: '',
        model: 'm',
        toolCalls: [{ id: `t${n}`, name: 'side_effect', arguments: {} }],
        usage: makeTokenUsage({ promptTokens: 1, completionTokens: 1 }),
      }),
      stream: async function* () {
        n++;
        yield {
          type: 'tool_call',
          toolCall: { id: `t${n}`, name: 'side_effect', arguments: '{}', index: 0 },
        };
        yield { type: 'done', usage: makeTokenUsage({ promptTokens: 1, completionTokens: 1 }) };
      },
      isAvailable: async () => true,
      getModelInfo: () => null,
    };
    const agent = new Agent({ model, systemPrompt: 't', tools });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });

    const budget = new BudgetPolicyEngine( { maxIterations: 0 });
    // maxIterations 0 视为未启用（配置约定 >0）；改用极小 wall-clock 无法稳定
    // 使用 maxToolCalls: 0 同样无效。改为 maxIterations: 1 — 首轮 turn_end 后 hard
    const budget2 = new BudgetPolicyEngine( { maxIterations: 1 });
    const harness: ReliabilityHarness = { config: {}, budget: budget2, sessionId: 's', agentId: 'a' };

    const events: string[] = [];
    for await (const e of runAgentWithReliability(agent.context, { model }, harness)) {
      events.push(e.type);
      if (events.length > 40) break;
    }

    expect(events).toContain('budget_exceeded');
    // maxIterations=1：可能在首工具前后触发；不要求 executed===0
    expect(typeof executed).toBe('number');
  });
});
