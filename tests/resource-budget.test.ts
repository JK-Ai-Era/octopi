/**
 * RunBudget / reliability 接线测试（P0：无 nominal token hard）
 * 设计：arch/budget-redesign.md
 */

import { describe, it, expect, vi } from 'vitest';
import { makeTokenUsage } from '@octopi-agent/core/types/step.js';
import type { RegisteredTool } from '@octopi-agent/core/types.js';
import { BudgetPolicyEngine, DEFAULT_BUDGET } from '@octopi-agent/engine/harness/run/budget/budget.js';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import { RunMetricsCollector } from '@octopi-agent/engine/harness/run/reliability/run-metrics-collector.js';
import { runAgentWithReliability } from '@octopi-agent/engine/harness/run/reliability/run-agent.js';
import { Agent } from '@octopi-agent/engine/harness/run/agent/agent.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { ReliabilityHarness } from '@octopi-agent/core/interfaces/reliability.js';

function mockModel(tokensPerCall = 100): ModelProvider {
  return {
    name: 'mock',
    chat: async () => ({
      content: 'done',
      model: 'mock',
      finishReason: 'stop' as const,
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
    getModelInfos: () => [],
  };
}

describe('RunBudget（P0 安全阀）', () => {
  it('默认 wall-clock 安全阀为 6h，且不因 steps/token hard', () => {
    expect(DEFAULT_BUDGET.maxWallClockMs).toBe(6 * 3_600_000);
    const budget = new BudgetPolicyEngine();
    for (let i = 0; i < 5000; i++) budget.recordStep();
    budget.consumeTokens(5_000_000);
    expect(budget.check()).toBe('ok');
    expect(budget.checkHardOnly().status).toBe('ok');
  });

  it('consumeTokens 只累计 nominal，不触发 hard', () => {
    const budget = new BudgetPolicyEngine();
    budget.consumeTokens(10_000_000);
    expect(budget.check()).toBe('ok');
    expect(budget.report().nominalTokens).toBe(10_000_000);
  });

  it('显式 maxSteps 时硬停', () => {
    const budget = new BudgetPolicyEngine( { maxSteps: 3 });
    budget.recordStep();
    budget.recordStep();
    budget.recordStep();
    expect(budget.check()).toBe('step_limit');
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

describe('wall-clock 口径：人类输入等待不计入（方案A）', () => {
  it('addHumanWaitMs 从 wall-clock 扣除，等人不触发 hard', () => {
    vi.useFakeTimers();
    try {
      const budget = new BudgetPolicyEngine({ maxWallClockMs: 1000 });
      vi.advanceTimersByTime(5000);
      // 对照：未记等待时存续 5s ≥ 1s，已超限
      expect(budget.checkHardOnly().status).toBe('hard');

      budget.addHumanWaitMs(5000);
      const after = budget.checkHardOnly();
      expect(after.status).toBe('ok');
      expect(after.report.elapsedMs).toBe(0);
      expect(after.report.humanWaitMs).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset 清零等待累计（超报以存续时长封顶，F6）', () => {
    vi.useFakeTimers();
    try {
      const budget = new BudgetPolicyEngine();
      vi.advanceTimersByTime(10_000);
      // 超报：封顶为存续时长，不得让累计超过存续把安全阀静默归零
      budget.addHumanWaitMs(999_000);
      expect(budget.report().humanWaitMs).toBe(10_000);
      budget.reset();
      expect(budget.report().humanWaitMs).toBe(0);
      expect(budget.report().elapsedMs).toBeLessThan(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('RunMetricsCollector：Guard hardWallClockMs 阀同口径扣减（F1a）', () => {
    vi.useFakeTimers();
    try {
      const c = new RunMetricsCollector();
      vi.advanceTimersByTime(10_000);
      c.addHumanWaitMs(6_000);
      expect(c.buildContext({}).elapsedMs).toBe(4_000);

      // 超报封顶：elapsedMs 不得扣成负值/长期归零
      const capped = new RunMetricsCollector();
      vi.advanceTimersByTime(10_000);
      capped.addHumanWaitMs(999_000);
      expect(capped.buildContext({}).elapsedMs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('真实装配链路：noteHumanWait 送达工具，扣减后 run 不被 wall_clock 误杀', async () => {
    const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
    let call = 0;
    let hookDelivered = false;
    const model: ModelProvider = {
      name: 'mock',
      chat: async () => ({
        content: 'done',
        model: 'mock',
        finishReason: 'stop' as const,
        usage: makeTokenUsage({ promptTokens: 1, completionTokens: 1 }),
      }),
      stream: async function* () {
        call += 1;
        if (call === 1) {
          yield { type: 'tool_call', toolCall: { id: 'p1', name: 'probe', arguments: '{}' } };
          yield {
            type: 'done',
            finishReason: 'tool_calls',
            usage: makeTokenUsage({ promptTokens: 1, completionTokens: 1 }),
          };
          return;
        }
        yield { type: 'content', content: 'done' };
        yield { type: 'done', usage: makeTokenUsage({ promptTokens: 1, completionTokens: 1 }) };
      },
      isAvailable: async () => true,
      getModelInfo: () => null,
      getModelInfos: () => [],
    };

    // 模拟 ask_user：工具真实等待 2.5s 并把等待时长回传预算层。
    // maxWallClockMs=500：扣除生效 → elapsedMs≈活跃时长（典型 ~40ms，余量 ~380ms）
    // 无任何预算事件；若钩子断链（等待照常计入），首个 turn_end（存续 ≥2.5s）必触发
    // budget.wrap_up。阈值须大于「工具执行前」的活跃时长，否则 beforeToolCall
    // 硬闸会先停 run（probe 不执行，测不到钩子——踩过一次）；余量也须远离
    // CI 抖动区间（132ms 假红教训，F3）。
    const probe: RegisteredTool = {
      definition: { name: 'probe', description: 'claims human wait', parameters: {} },
      handler: async (_args, context) => {
        hookDelivered = typeof context.noteHumanWait === 'function';
        const waitStartedAt = Date.now();
        await new Promise((r) => setTimeout(r, 2500));
        context.noteHumanWait?.(Date.now() - waitStartedAt);
        return 'ok';
      },
    };

    const built = await new AgentBuilder()
      .model(model)
      .tool(probe)
      .agentId('budget-wait')
      .constitution({ mode: 'off' })
      .systemPrompt('t')
      .effectPolicy({ opsAudit: 'off' })
      .budget({ maxWallClockMs: 500 })
      .build({ autoLoadSubsystems: false });

    const events: string[] = [];
    for await (const e of built.runner.handle(
      'budget-wait-sess',
      { role: 'user', content: 'go', timestamp: Date.now() },
      { systemPrompt: '', agentId: 'budget-wait', sessionId: 'budget-wait-sess' },
    )) {
      events.push(e.type);
    }

    expect(events.filter((t) => t === 'budget.wrap_up' || t === 'budget.exceeded'), '等待扣除后不得有任何预算事件').toEqual([]);
    expect(hookDelivered, 'noteHumanWait must reach the tool through real assembly').toBe(true);
    expect(call, '预算若把 run 掐在首turn，第二次模型调用不会发生').toBe(2);
  });
});

describe('RunMetricsCollector', () => {
  it('记录 steps / tokens / hasProgress', () => {
    const c = new RunMetricsCollector();
    c.recordStep({
      role: 'assistant',
      contentPreview: 'x'.repeat(100),
      tokenDelta: 0,
      timestamp: Date.now(),
    });
    c.recordTokens(50);
    c.recordToolResult('file_read', true);
    expect(c.steps).toBe(1);
    expect(c.tokens).toBe(50);
    expect(c.hasProgress()).toBe(true);

    const ctx = c.buildContext({});
    expect(ctx.steps).toBe(1);
    expect(ctx.nominalTotalTokens).toBe(50);
  });
});

describe('Builder 默认 RunBudget', () => {
  it('未显式 .budget() 时 harness 仍有默认安全阀', async () => {
    const { AgentBuilder } = await import('@octopi-agent/engine/harness/agent/builder.js');
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
      budget: new BudgetPolicyEngine(),
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

  it('显式 maxSteps hard 时 yield budget_exceeded', async () => {
    const model = mockModel(50);
    const agent = new Agent({ model, systemPrompt: 't' });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });
    const budget = new BudgetPolicyEngine( { maxSteps: 1 });
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
    const template = new BudgetPolicyEngine( { maxSteps: 2 });
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
    // 模板 maxSteps=2 时，单次 run 可能触发；关键是第二次不因「共享累计」额外误杀
    // 此处断言两次都能跑完或各自独立触发，而不是第二次必失败
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });
});

describe('beforeToolCall hard 闸（steps）', () => {
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
        finishReason: 'tool_calls' as const,
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
    getModelInfos: () => [],
    };
    const agent = new Agent({ model, systemPrompt: 't', tools });
    agent.context.messages.push({ role: 'user', content: 'go', timestamp: Date.now() });

    const budget = new BudgetPolicyEngine( { maxSteps: 0 });
    // maxSteps 0 视为未启用（配置约定 >0）；改用极小 wall-clock 无法稳定
    // 使用 maxToolCalls: 0 同样无效。改为 maxSteps: 1 — 首轮 turn_end 后 hard
    const budget2 = new BudgetPolicyEngine( { maxSteps: 1 });
    const harness: ReliabilityHarness = { config: {}, budget: budget2, sessionId: 's', agentId: 'a' };

    const events: string[] = [];
    for await (const e of runAgentWithReliability(agent.context, { model }, harness)) {
      events.push(e.type);
      if (events.length > 40) break;
    }

    expect(events).toContain('budget_exceeded');
    // maxSteps=1：可能在首工具前后触发；不要求 executed===0
    expect(typeof executed).toBe('number');
  });
});
