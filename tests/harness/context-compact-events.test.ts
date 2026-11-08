/**
 * context.compact.* 可观测事件
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type {
  ContextCompactEvent,
  OverflowAlertEvent,
} from '@octopi-agent/engine/harness/context/types.js';
import type { ModelProvider, LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import { makeTokenUsage } from '@octopi-agent/core/types/step.js';
import { HeuristicTokenEstimator } from '@octopi-agent/engine/harness/context/token-estimator.js';

function toolMsg(id: string, chars: number): Message {
  return {
    role: 'tool',
    content: '',
    toolResults: [{ toolCallId: id, name: 'r', result: 'x'.repeat(chars) }],
    timestamp: Date.now(),
  } as Message;
}

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function mockProvider(): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat() {
      return { content: '## Summary\nok', model: 'm', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() { return true; },
    getModelInfo() {
      return { name: 'm', contextWindow: 4000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 4000 }];
    },
  };
}

const summarize = async (_m: LLMMessage[]) => '## Conversation Summary\nhit';

describe('DefaultContextEngine emit', () => {
  it('主动摘要发出 start/end', async () => {
    const events: ContextCompactEvent[] = [];
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
    });
    const msgs: Message[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push(userMsg(`c-${i} ` + 'x'.repeat(400)));
    }

    await engine.assemble({
      sessionId: 's-emit',
      messages: msgs,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
      emit: (e) => {
        if (e.type !== 'context.overflow.alert') events.push(e);
      },
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('context.compact.start');
    expect(types).toContain('context.compact.end');
    const start = events.find((e) => e.type === 'context.compact.start');
    expect(start?.reason).toBe('proactive');
    expect(start?.sessionId).toBe('s-emit');
  });

  it('缓存重建标记 cached=true', async () => {
    const events: ContextCompactEvent[] = [];
    const engine = new DefaultContextEngine({
      proactiveCompactRatio: 0.5,
      targetTokens: 0,
      protectFirstN: 2,
      protectLastN: 4,
    });
    const base: Message[] = [];
    for (let i = 0; i < 26; i++) {
      base.push(userMsg('x'.repeat(400)));
    }
    // 尾部 protectLastN=4 故意放大：压缩后视图仍在线以上，才会走「复用重建」分支
    // （2026-11-07 口径修正后，视图回落到线内就零动作——正是要防的重复压缩）
    for (let i = 0; i < 4; i++) {
      base.push(userMsg('y'.repeat(3000)));
    }
    const params = {
      sessionId: 's-cache-evt',
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      summarize,
      emit: (e: ContextCompactEvent | OverflowAlertEvent) => {
        if (e.type !== 'context.overflow.alert') events.push(e as ContextCompactEvent);
      },
    };

    await engine.assemble({ ...params, messages: base });
    events.length = 0;
    await engine.assemble({ ...params, messages: [...base, userMsg('tiny')] });

    const end = events.find((e) => e.type === 'context.compact.end');
    expect(end?.cached).toBe(true);
    // 复用重建无新压缩计量（与结构回放一致 0/0；2026-11-06 事故的 1ms 误报家族）
    expect(end?.tokensBefore).toBe(0);
    expect(end?.tokensAfter).toBe(0);
  });

  it('compact 计量对 = messages-only 未校准同集合（比率不变性：两条不同 ratio 下读数全等）', async () => {
    async function runGaugeScenario(
      sessionId: string,
      seedMult: number,
    ): Promise<{ start?: ContextCompactEvent; end?: ContextCompactEvent }> {
      const events: ContextCompactEvent[] = [];
      const engine = new DefaultContextEngine({
        proactiveCompactRatio: 0.5,
        targetTokens: 0,
        protectFirstN: 2,
        protectLastN: 4,
      });
      const msgs: Message[] = [];
      for (let i = 0; i < 30; i++) {
        // 工具执行段=可账本化对象（user 消息永不账本化——丢弃次序原则）
        msgs.push(toolMsg(`e${i}`, 50)); // 缩小：校准 ratio=4 时最小 tail 档仍收敛（防 L3）
      }
      // 把校准 ratio 拉离 1.0（seedMult 决定拉到多少）——事件对若混 ratio，两次读数会不同
      const seed = await engine.assemble({
        sessionId,
        modelKey: 'mock/m',
        messages: [userMsg('seed')],
        systemPrompt: 'sys',
        tools: [],
        tokenBudget: 4000,
      });
      await engine.afterStep({
        sessionId,
        step: [],
        usage: makeTokenUsage({ promptTokens: seed.estimatedTokens * seedMult, completionTokens: 1 }),
      });
      await engine.assemble({
        sessionId,
        modelKey: 'mock/m',
        messages: msgs,
        systemPrompt: 'sys',
        tools: [],
        tokenBudget: 4000,
        summarize,
        emit: (e) => {
        if (e.type !== 'context.overflow.alert') events.push(e);
      },
      });
      return {
        start: events.find((e) => e.type === 'context.compact.start'),
        end: events.find((e) => e.type === 'context.compact.end' && !e.cached),
      };
    }

    const a = await runGaugeScenario('s-gauge-a', 2); // ratio → 1.7
    const b = await runGaugeScenario('s-gauge-b', 4); // ratio → 3.1
    const rawBefore = new HeuristicTokenEstimator().estimateMessages(
      Array.from({ length: 30 }, (_, i) => ({
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: `e${i}`, name: 'r', result: 'x'.repeat(50) }],
        timestamp: Date.now() + i,
      })) as Message[],
    );
    // before = 全视图原始估算：不乘校准 ratio、不取溢出子集（事故的 142371 → 1243157 家族）
    expect(a.start?.tokensBefore).toBe(rawBefore);
    expect(a.end?.tokensBefore).toBe(rawBefore);
    // 比率不变性（评审 F4 变异点）：校准污染会让两条读数随 ratio 漂移
    expect(b.start?.tokensBefore).toBe(a.start?.tokensBefore);
    expect(b.end?.tokensBefore).toBe(a.end?.tokensBefore);
    expect(b.end?.tokensAfter).toBe(a.end?.tokensAfter);
    // after 与 before 同口径同集合：真实压缩应当缩水
    expect(a.end?.tokensAfter).toBeGreaterThan(0);
    expect(a.end?.tokensAfter).toBeLessThan(rawBefore);
  });

  it('overflow 压缩对同为原始口径同集合（比率不变性）', async () => {
    async function runOverflowScenario(
      sessionId: string,
      seedMult: number,
    ): Promise<{ start?: ContextCompactEvent; end?: ContextCompactEvent }> {
      const events: ContextCompactEvent[] = [];
      // 头尾保护区自身超预算 → proactive 判「压缩救不了」跳过 → MessageSelector 溢出路径
      const engine = new DefaultContextEngine({
        proactiveCompactRatio: 0, // 关 proactive——本场景纯测 overflow 收敛（proactive 摘要会先拦）
        targetTokens: 0,
        protectFirstN: 8,
        protectLastN: 8,
      });
      const msgs: Message[] = [];
      // 62 条：账本三档（50→20→5）都咬得动（>50 条），确定性收敛成功产出 end 计量对。
      // 150 chars/条：seedMult 校准（×2/×4）后最小档仍放得下——校准尺下不误入 L3
      for (let i = 0; i < 62; i++) {
        msgs.push(toolMsg(`o${i}`, 50)); // 工具执行=可账本化对象（user 永不账本化）
      }
      const seed = await engine.assemble({
        sessionId,
        modelKey: 'mock/m',
        messages: [userMsg('seed')],
        systemPrompt: 'sys',
        tools: [],
        tokenBudget: 100_000,
      });
      await engine.afterStep({
        sessionId,
        step: [],
        usage: makeTokenUsage({ promptTokens: seed.estimatedTokens * seedMult, completionTokens: 1 }),
      });
      await engine.assemble({
        sessionId,
        modelKey: 'mock/m',
        messages: msgs,
        systemPrompt: 'sys',
        tools: [],
        tokenBudget: 5000, // 触发 overflow 且砍满后「tail+账本」在校准尺下真装得下
        summarize,
        emit: (e) => {
        if (e.type !== 'context.overflow.alert') events.push(e);
      },
      });
      return {
        start: events.find((e) => e.type === 'context.compact.start' && e.reason === 'overflow'),
        end: events.find((e) => e.type === 'context.compact.end' && e.reason === 'overflow'),
      };
    }

    const a = await runOverflowScenario('s-ovf-a', 2);
    const b = await runOverflowScenario('s-ovf-b', 4);
    expect(a.end).toBeDefined(); // 场景确实走了 overflow 路径
    expect(a.start?.tokensBefore).toBe(a.end?.tokensBefore); // 同集合（计量对同一集合）
    expect(a.end?.tokensAfter).toBeLessThan(a.end?.tokensBefore!);
    // 比率不变性（口径）：计量对 = messages-only 未校准原始口径——同集合的 raw 读数
    // 不随校准 ratio 变。注意：ratio 参与**决策**（fits 判档）后两 run 收敛档位/产物可不同，
    // 产物的 tokensAfter 不要求相等；不变的是口径（raw 未校准），不是产物。
    expect(b.start?.tokensBefore).toBe(a.start?.tokensBefore); // 口径不变
    expect(b.end).toBeDefined();
    expect(b.end?.tokensAfter).toBeLessThan(b.end?.tokensBefore!);
  });

  it('F3 锚原子对 + 出口顺序：降级/冷启动读数 = 实测 × raw_now/anchor.raw', async () => {
    const cfg = { proactiveCompactRatio: 0.5, targetTokens: 0, protectFirstN: 2, protectLastN: 4 };
    const msgsA = [userMsg('a'.repeat(400))];
    const msgsB = [...msgsA, userMsg('b'.repeat(4000))];
    // 冷引擎读数 = 未校准 raw（取两请求的 raw 基准）
    const engine0 = new DefaultContextEngine(cfg);
    const rawA = (
      await engine0.assemble({ sessionId: 'x0', modelKey: 'mock/m', messages: msgsA, systemPrompt: 'sys', tools: [], tokenBudget: 100_000 })
    ).estimatedTokens;
    const rawB = (
      await engine0.assemble({ sessionId: 'x0', modelKey: 'mock/m', messages: msgsB, systemPrompt: 'sys', tools: [], tokenBudget: 100_000 })
    ).estimatedTokens;
    expect(rawB).toBeGreaterThan(rawA);

    const engine = new DefaultContextEngine(cfg);
    await engine.assemble({ sessionId: 's-anchor', modelKey: 'mock/m', messages: msgsA, systemPrompt: 'sys', tools: [], tokenBudget: 100_000 });
    await engine.afterStep({ sessionId: 's-anchor', step: [], usage: makeTokenUsage({ promptTokens: rawA * 3, completionTokens: 1 }) });
    await engine.afterStep({ sessionId: 's-anchor', step: [], usage: undefined }); // 失败步：锚必须保持冻结对
    const eb = await engine.assemble({ sessionId: 's-anchor', modelKey: 'mock/m', messages: msgsB, systemPrompt: 'sys', tools: [], tokenBudget: 100_000 });
    // 锚 = {actual: 3×rawA, raw: rawA} → 读数 = 3×rawB；
    // 出口顺序 bug（raw 在覆写后读）→ ≈3×rawA；锚拆对错位（F3）→ 同样偏离
    expect(eb.estimatedTokens).toBe(rawB * 3);
  });
});

describe('Builder → EventBus 桥接', () => {
  it('convertToLlm 压缩时 EventBus 收到 context.compact.*（读 ALS snapshot 窗口）', async () => {
    const provider = mockProvider();
    const builder = new AgentBuilder().model(provider).summarize(summarize);
    const { agent, events } = await builder.build();

    const busEvents: AgentEvent[] = [];
    events.onAll((e) => {
      busEvents.push(e);
    });

    const msgs: Message[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push(userMsg('y'.repeat(500)));
    }
    agent.setContextSessionId('sess-bridge');

    // convertToLlm 只读 run snapshot.contextWindow（禁止二次 getModelInfo）
    const { withResolvedModel } = await import('@octopi-agent/engine/harness/run/model/run-scope.js');
    async function* probe() {
      yield await agent.config.convertToLlm!(msgs);
    }
    for await (const _ of withResolvedModel({
      ref: 'mock/m',
      providerName: 'mock',
      modelName: 'm',
      provider,
      contextWindow: 4000,
      source: 'config',
      known: true,
      isOverride: false,
    }, probe())) {
      // drain
    }

    const compact = busEvents.filter((e) => e.type.startsWith('context.compact.'));
    expect(compact.length).toBeGreaterThan(0);
    expect(compact[0]?.sessionId).toBe('sess-bridge');
    expect(
      compact.some((e) => e.type === 'context.compact.start'),
    ).toBe(true);
  });
});
