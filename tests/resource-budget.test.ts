/**
 * ResourceBudget soft/hard + reliability 接线测试
 */

import { describe, it, expect } from 'vitest';
import { IterationBudget, DEFAULT_BUDGET } from '../src/harness/budget/budget.js';
import { DefaultEventBus } from '../src/core/primitives/event-bus.js';
import { RunMetricsCollector } from '../src/harness/reliability/run-metrics-collector.js';
import { runAgentWithReliability } from '../src/harness/reliability/run-agent.js';
import { Agent } from '../src/loop/agent.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';
import type { ReliabilityHarness } from '../src/core/interfaces/reliability.js';

function mockModel(tokensPerCall = 100): ModelProvider {
  return {
    name: 'mock',
    chat: async () => ({
      content: 'done',
      model: 'mock',
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: tokensPerCall },
    }),
    stream: async function* () {
      yield { type: 'content', content: 'done' };
      yield {
        type: 'done',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: tokensPerCall },
      };
    },
    isAvailable: async () => true,
    getModelInfo: () => null,
  };
}

describe('IterationBudget soft/hard', () => {
  it('默认不硬停 iteration', () => {
    const bus = new DefaultEventBus();
    const budget = new IterationBudget(bus);
    for (let i = 0; i < 5000; i++) budget.recordIteration();
    expect(budget.check()).toBe('ok');
  });

  it('显式 maxIterations 时硬停', () => {
    const bus = new DefaultEventBus();
    const budget = new IterationBudget(bus, { maxIterations: 3 });
    budget.recordIteration();
    budget.recordIteration();
    budget.recordIteration();
    expect(budget.check()).toBe('iteration_limit');
    expect(budget.evaluate().status).toBe('hard');
  });

  it('token hard 触发', () => {
    const bus = new DefaultEventBus();
    const budget = new IterationBudget(bus, { maxTokens: 1000, softTokens: 500 });
    budget.consumeTokens(1000);
    const e = budget.evaluate(true);
    expect(e.status).toBe('hard');
    expect(e.reason).toBe('tokens');
  });

  it('soft + hasProgress → 静默续租', () => {
    const bus = new DefaultEventBus();
    const budget = new IterationBudget(bus, {
      maxTokens: 10_000,
      softTokens: 100,
      renewGrantTokens: 500,
    });
    budget.consumeTokens(150);
    const e = budget.evaluate(true);
    expect(e.status).toBe('ok');
    expect(e.report.renews).toBe(1);
  });

  it('soft + 无进展 → soft（不 hard）', () => {
    const bus = new DefaultEventBus();
    const budget = new IterationBudget(bus, {
      maxTokens: 10_000,
      softTokens: 100,
      autoRenewOnProgress: false,
    });
    budget.consumeTokens(150);
    const e = budget.evaluate(false);
    expect(e.status).toBe('soft');
    expect(e.legacyStatus).toBe('soft');
  });

  it('checkHardOnly 不触发 soft 续租', () => {
    const bus = new DefaultEventBus();
    const budget = new IterationBudget(bus, {
      maxTokens: 10_000,
      softTokens: 100,
    });
    budget.consumeTokens(150);
    const e = budget.checkHardOnly();
    expect(e.status).toBe('ok');
    // soft 仍未续租
    expect(budget.evaluate(false).status).toBe('soft');
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
    expect(ctx.totalTokens).toBe(50);
    expect(ctx.metrics.hasProgress).toBe(true);
    expect(ctx.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('连续错误后 hasProgress 为 false', () => {
    const c = new RunMetricsCollector();
    for (let i = 0; i < 5; i++) {
      c.recordTurn({
        role: 'assistant',
        contentPreview: 'short',
        tokenDelta: 0,
        timestamp: Date.now(),
      });
      c.recordToolResult('shell', false);
    }
    expect(c.hasProgress()).toBe(false);
  });
});

describe('Builder 默认 ResourceBudget', () => {
  it('未显式 .budget() 时 harness 仍有默认 budget', async () => {
    const { AgentBuilder } = await import('../src/harness/agent-building/builder.js');
    const model = mockModel(10);
    const { harness } = await new AgentBuilder().model(model).buildAgent();
    expect(harness.budget).toBeDefined();
  });
});

describe('soft + Guard 接线', () => {
  it('soft 无进展且有 Guard 时进入 Guard 路径，不直接 budget_exceeded', async () => {
    const { DefaultRunGuard } = await import('../src/harness/run-guard/default-run-guard.js');
    let call = 0;
    const model: ModelProvider = {
      name: 'mock',
      chat: async () => ({
        content: '',
        model: 'mock',
        toolCalls: [{ id: `c${call}`, name: 'fail_tool', arguments: {} }],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 80 },
      }),
      stream: async function* () {
        call++;
        yield { type: 'tool_call', toolCall: { id: `c${call}`, name: 'fail_tool', arguments: '{}', index: 0 } };
        yield { type: 'done', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 80 } };
      },
      isAvailable: async () => true,
      getModelInfo: () => null,
    };
    const tools = [
      {
        name: 'fail_tool',
        description: 'always fails',
        parameters: { type: 'object' as const, properties: {} },
        execute: async (id: string) => ({
          toolCallId: id,
          name: 'fail_tool',
          content: 'err',
          isError: true,
        }),
      },
    ];
    const agent = new Agent({ model, systemPrompt: 't', tools });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });

    const budget = new IterationBudget(new DefaultEventBus(), {
      maxTokens: 10_000,
      softTokens: 50,
      autoRenewOnProgress: true,
    });
    const guard = new DefaultRunGuard({ enableLLMReview: false, checkpointInterval: 100 });
    const harness: ReliabilityHarness = {
      config: {},
      budget,
      runGuard: guard,
      sessionId: 's',
      agentId: 'a',
    };

    const events: string[] = [];
    let recovered = 0;
    for await (const e of runAgentWithReliability(agent.context, { model }, harness)) {
      events.push(e.type);
      if (e.type === 'run_guard_recovered') recovered++;
      if (events.length > 50) break;
    }

    expect(events.filter(t => t === 'budget_exceeded').length).toBe(0);
    expect(recovered).toBeGreaterThanOrEqual(1);
  });
});

describe('runAgentWithReliability + Budget hard', () => {
  it('token hard 时 yield budget_exceeded 并停止', async () => {
    const model = mockModel(500);
    const agent = new Agent({
      model,
      systemPrompt: 'test',
    });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });
    const budget = new IterationBudget(new DefaultEventBus(), {
      maxTokens: 400,
      softTokens: 10_000, // 不触发 soft
    });
    const harness: ReliabilityHarness = {
      config: {},
      budget,
      sessionId: 's',
      agentId: 'a',
    };

    const events: string[] = [];
    for await (const e of runAgentWithReliability(
      agent.context,
      { model },
      harness,
    )) {
      events.push(e.type);
    }

    expect(events).toContain('budget_exceeded');
    expect(events.indexOf('budget_exceeded')).toBeLessThan(events.indexOf('agent_end'));
  });
});

describe('per-run Budget 隔离', () => {
  it('同一 harness 模板连跑两次，计数不跨 run 累加', async () => {
    const model = mockModel(300);
    const template = new IterationBudget(new DefaultEventBus(), {
      maxTokens: 500,
      softTokens: 10_000,
    });
    const harness: ReliabilityHarness = { config: {}, budget: template };

    const runOnce = async () => {
      const agent = new Agent({ model, systemPrompt: 't' });
      agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });
      const events: string[] = [];
      for await (const e of runAgentWithReliability(agent.context, { model }, harness)) {
        events.push(e.type);
      }
      return events;
    };

    const first = await runOnce();
    expect(first.filter(t => t === 'budget_exceeded').length).toBe(0);

    // 若共享模板：第二次 300+300≥500 会 hard；per-run 克隆则仍从 0 计
    const second = await runOnce();
    expect(second.filter(t => t === 'budget_exceeded').length).toBe(0);
  });
});

describe('soft 无 Guard 必须 yield budget_exceeded', () => {
  it('soft 升 hard 时用户可见 budget_exceeded', async () => {
    const model = mockModel(200);
    const agent = new Agent({ model, systemPrompt: 't' });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });
    const budget = new IterationBudget(new DefaultEventBus(), {
      maxTokens: 10_000,
      softTokens: 100,
      autoRenewOnProgress: false, // 禁止续租，soft 直接暴露
    });
    const harness: ReliabilityHarness = { config: {}, budget };

    const events: string[] = [];
    for await (const e of runAgentWithReliability(agent.context, { model }, harness)) {
      events.push(e.type);
    }

    expect(events).toContain('budget_exceeded');
  });
});

describe('beforeToolCall hard 闸', () => {
  it('hard 后不再执行工具，且 yield budget_exceeded', async () => {
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
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 50 },
      }),
      stream: async function* () {
        n++;
        yield {
          type: 'tool_call',
          toolCall: { id: `t${n}`, name: 'side_effect', arguments: '{}', index: 0 },
        };
        yield { type: 'done', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 50 } };
      },
      isAvailable: async () => true,
      getModelInfo: () => null,
    };
    const agent = new Agent({ model, systemPrompt: 't', tools });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });

    // 第一轮 hard：soft 很高，hard 很低
    const budget = new IterationBudget(new DefaultEventBus(), {
      maxTokens: 40,
      softTokens: 10_000,
    });
    const harness: ReliabilityHarness = { config: {}, budget };

    const events: string[] = [];
    for await (const e of runAgentWithReliability(agent.context, { model }, harness)) {
      events.push(e.type);
    }

    expect(events).toContain('budget_exceeded');
    // hard 在 turn_end（工具前）触发：工具不应执行
    expect(executed).toBe(0);
  });
});
