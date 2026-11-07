/**
 * 计量四件套（2026-11-08 拍板）红线：
 *
 * 1. callId 同源配对：冻结 seq 单调递增；覆盖未消费 pair 即作废（告警）；
 *    重复消费/缺对丢样——外来 usage 永不喂 observe
 * 2. outputTokens 真值：摘要产物体量以 provider 实测输出 tokens 替换估算
 * 3. L1 调表：tool_result 1.7 / JSON 2 chars/token（2026-11-08 生产样本拟合）
 * 4. 压缩 before/after = 请求口径（fold+老化+system+tools），不再用「未老化 messages-only」
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { InMemoryTransformStore } from '@octopi-agent/engine/harness/session/transform-store.js';
import { HeuristicTokenEstimator } from '@octopi-agent/engine/harness/context/token-estimator.js';
import { JSON_CHARS_PER_TOKEN } from '@octopi-agent/engine/harness/context/token-constants.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function toolRound(i: number, resultChars: number): Message[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call-${i}`, name: 'shell', arguments: { cmd: 'noop' } }],
      timestamp: Date.now(),
    },
    {
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: `call-${i}`, name: 'shell', result: 'r'.repeat(resultChars) }],
      timestamp: Date.now(),
    },
  ];
}

const usage = (input: number) =>
  ({
    inputReportedTokens: input,
    inputUncachedTokens: input,
    inputCachedTokens: 0,
    inputCacheWriteTokens: 0,
    outputTokens: 10,
    cacheAware: false,
  }) as import('@octopi-agent/core/types/step.js').TokenUsage;

describe('① callId 同源配对', () => {
  it('缺对丢样：未 assemble 的 usage 不喂 observe', async () => {
    const engine = new DefaultContextEngine({ transformStore: new InMemoryTransformStore() });
    // 无任何装配（无 pair）直接喂 usage：不得产出 ratio 样本（decisionTokens 不受影响）
    await engine.afterStep({ sessionId: 's1', agentId: 'a', step: [], usage: usage(5000) });
    // 可观测后果：再次装配时 decisionTokens == 裸估算（无样本 → raw 路）
    const res = await engine.assemble({
      sessionId: 's1',
      agentId: 'a',
      messages: [userMsg('hi')],
      systemPrompt: '',
      tools: [],
      modelKey: 'm',
    });
    expect(res.readingSource).toBe('raw');
  });

  it('重复消费丢样：同一 pair 只允许消费一次', async () => {
    const engine = new DefaultContextEngine({ transformStore: new InMemoryTransformStore() });
    await engine.assemble({
      sessionId: 's2',
      agentId: 'a',
      messages: [userMsg('hi')],
      systemPrompt: '',
      tools: [],
      modelKey: 'm',
    });
    await engine.afterStep({ sessionId: 's2', agentId: 'a', step: [], usage: usage(5000) });
    // 第二次 usage（外来/重复）到达时 pair 已消费：丢样，不得再喂 observe。
    // 三态判别：丢样生效=1 样本+锚 → anchored；若错喂第二样本 → trusted(≥2) → calibrated
    await engine.afterStep({ sessionId: 's2', agentId: 'a', step: [], usage: usage(5001) });
    const res = await engine.assemble({
      sessionId: 's2',
      agentId: 'a',
      messages: [userMsg('hi2')],
      systemPrompt: '',
      tools: [],
      modelKey: 'm',
    });
    expect(res.readingSource).toBe('anchored');
  });

  it('覆盖未消费 pair：作废告警，只认最新发送', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new DefaultContextEngine({ transformStore: new InMemoryTransformStore() });
    const params = {
      sessionId: 's3',
      agentId: 'a',
      messages: [userMsg('hi')],
      systemPrompt: '',
      tools: [],
      modelKey: 'm',
    };
    await engine.assemble(params); // pair seq=1
    await engine.assemble({ ...params, messages: [userMsg('hi2')] }); // 覆盖 seq=1 → seq=2
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[ctx-pair] overwrite unconsumed pair'))).toBe(true);
    warn.mockRestore();
  });
});

describe('② outputTokens 真值', () => {
  it('摘要产物体量用 provider 实测输出 tokens 替换估算', async () => {
    const store = new InMemoryTransformStore();
    const SUMMARY = 'SUMMARY-TEXT';
    const makeEngine = () =>
      new DefaultContextEngine({
        protectFirstN: 1,
        protectLastN: 2,
        transformStore: store,
      });
    const messages: Message[] = [userMsg('GO')];
    for (let i = 0; i < 30; i++) messages.push(...toolRound(i, 400));

    // 对照组：summarize 不回传 usage → tokensAfter 纯估算
    const engine0 = makeEngine();
    const r0 = await engine0.compactStructural({
      sessionId: 'n1',
      messages,
      summarize: async () => SUMMARY,
      systemPrompt: 'SYS',
      tools: [],
    });
    // 实验组：回传 outputTokens=1000 → after 的摘要段=真值
    const engine1 = makeEngine();
    const r1 = await engine1.compactStructural({
      sessionId: 'n2',
      messages,
      summarize: async (_m, opts) => {
        opts?.onUsage?.({ outputTokens: 1000 });
        return SUMMARY;
      },
      systemPrompt: 'SYS',
      tools: [],
    });
    expect(r0.fresh).toBe(true);
    expect(r1.fresh).toBe(true);
    const est = new HeuristicTokenEstimator();
    // tokensAfter 差 = 1000（真值）- estimateText(SUMMARY)（被换掉的估算段）
    expect((r1.tokensAfter ?? 0) - (r0.tokensAfter ?? 0)).toBe(1000 - est.estimateText(SUMMARY));
    // 绝对值 sanity：真值主导（1000 输出 tokens 一定压过摘要文本的估算段）
    expect(r1.tokensAfter).toBeGreaterThan(r0.tokensAfter! + 900);
  });

  it('tools schema 估算走 JSON 档（L1 调表后 = 2 chars/token）', () => {
    const est = new HeuristicTokenEstimator();
    const tools = [
      {
        type: 'function',
        function: {
          name: 'shell',
          description: 'run a command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
      },
    ] as import('@octopi-agent/core/interfaces/model-provider.js').LLMToolDefinition[];
    // estimateTools 同式：name/desc text 档 + parameters json 档（2 chars/token），总量一次取整
    const expected = Math.ceil(
      'shell'.length / 4 +
        'run a command'.length / 4 +
        JSON.stringify(tools[0]!.function.parameters).length / JSON_CHARS_PER_TOKEN,
    );
    expect(est.estimateTools(tools)).toBe(expected);
  });
});

describe('③ L1 调表', () => {
  it('tool_result 1.7 chars/token（生产样本拟合档）', () => {
    const est = new HeuristicTokenEstimator();
    const msg: Message = {
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: 'c', name: 'shell', result: 'r'.repeat(170) }],
      timestamp: Date.now(),
    };
    // tool_result 段 = 170/1.7 = 100 + 消息开销 12
    expect(est.estimateMessages([msg])).toBe(112);
  });
});

describe('④ 压缩 before/after 请求口径', () => {
  it('tokensBefore = fold+老化+system+tools（请求口径），system/tools 差值精确', async () => {
    const make = () =>
      new DefaultContextEngine({
        protectFirstN: 1,
        protectLastN: 2,
        transformStore: new InMemoryTransformStore(),
      });
    // too_short 形态（≤ protectHead+protectTail）：不发摘要、before=after=纯口径值，
    // 无压缩噪声——对照法精确锁「请求口径含 system+tools」
    const messages: Message[] = [userMsg('GO'), userMsg('more')];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'shell',
          description: 'run a command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
      },
    ] as import('@octopi-agent/core/interfaces/model-provider.js').LLMToolDefinition[];

    const rFull = await make().compactStructural({
      sessionId: 'm1',
      messages,
      summarize: async () => 'S',
      systemPrompt: 'SYSTEM-PROMPT-CONTENT',
      tools,
    });
    const rBare = await make().compactStructural({
      sessionId: 'm2',
      messages,
      summarize: async () => 'S',
      systemPrompt: '',
      tools: [],
    });
    const est = new HeuristicTokenEstimator();
    // 差值恰为 system（含消息开销）+ tools schema 的估算（旧口径 messages-only 差值=0，锁死口径）；
    // ±1 容差=「总量一次取整」的边界效应
    const expectedDelta =
      est.estimateMessages([{ role: 'system', content: 'SYSTEM-PROMPT-CONTENT', timestamp: 1 }]) +
      est.estimateTools(tools);
    expect(
      Math.abs((rFull.tokensBefore ?? 0) - (rBare.tokensBefore ?? 0) - expectedDelta),
    ).toBeLessThanOrEqual(1);
    expect(rFull.compacted).toBe(false); // too_short 无压缩，before=after 同口径
    expect(rFull.tokensAfter).toBe(rFull.tokensBefore);
  });
});
