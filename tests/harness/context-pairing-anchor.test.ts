/**
 * 请求级冻结配对槽 + 锚卫生 + wrap-up 实测优先（2026-11-07 尺子事故 #3 回归红线）
 *
 * 事故链：跨请求错位配对（陈旧估算 × 新实测）产出毒 ratio 样本 + 毒锚，
 * 锚外推把每步决策读数放大 5.4×，wrap-up 估算轴 86% 假压力掐死评审 run。
 * 修复四红线：
 *  1. 配对槽消费一次即清，缺对丢样（不拿旧估算配新实测）；
 *  2. 被拒/重锚样本不得冻结锚，入账对（accepted/clamped，含 F1 极端锚定）冻结；
 *  3. 压缩完成即清锚（请求形状已变，旧锚失效）；
 *  4. wrap-up 压力轴实测优先（contextActualTokens ?? contextEstTokens）。
 */

import { describe, it, expect } from 'vitest';
import { makeTokenUsage } from '@octopi-agent/core/types/step.js';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import {
  UsageLedger,
  contextPressureTokens,
} from '@octopi-agent/engine/harness/governance/accounting/usage-ledger.js';

// ── 测试工具 ──

function createMessage(role: Message['role'], content: string): Message {
  return { role, content, timestamp: Date.now() };
}

function createToolResultMessage(toolCallId: string, name: string, result: string): Message {
  return {
    role: 'tool',
    content: '',
    toolResults: [{ toolCallId, name, result }],
    timestamp: Date.now(),
  };
}

interface PairingState {
  pendingUsagePair?: { rawEstimatedTokens: number; modelKey: string };
  lastUsageAnchor?: { actual: number; raw: number; modelKey: string };
  lastModelKey?: string;
}

function statesOf(engine: DefaultContextEngine): Map<string, PairingState> {
  return (engine as unknown as { states: Map<string, PairingState> }).states;
}

function samplesOf(engine: DefaultContextEngine, modelKey: string): number {
  const ledger = (
    engine as unknown as {
      sizeLedger: { samplesByModel: Map<string, number> };
    }
  ).sizeLedger;
  return ledger.samplesByModel.get(modelKey) ?? 0;
}

async function assembleOnce(engine: DefaultContextEngine, sessionId: string): Promise<number> {
  await engine.assemble({
    sessionId,
    modelKey: 'mock/m',
    messages: [createMessage('user', 'hello world')],
    systemPrompt: 'Test',
    tools: [],
    tokenBudget: 100000,
  });
  const state = statesOf(engine).get(sessionId);
  return state?.pendingUsagePair?.rawEstimatedTokens ?? 0;
}

// ── 红线 1：配对槽消费一次即清，缺对丢样 ──

describe('请求级冻结配对槽', () => {
  it('配对槽消费一次即清：第二次 afterStep 无对丢样，不冻结新锚', async () => {
    const engine = new DefaultContextEngine();
    await assembleOnce(engine, 'pair-consume');
    const stateKey = [...statesOf(engine).keys()][0];
    const raw = statesOf(engine).get(stateKey)!.pendingUsagePair!.rawEstimatedTokens;
    expect(raw).toBeGreaterThan(0);

    // 第一次 afterStep：消费配对 → 冻结锚
    await engine.afterStep!({
      sessionId: 'pair-consume',
      step: [createMessage('assistant', 'Response')],
      usage: makeTokenUsage({ promptTokens: raw, completionTokens: 50 }),
    });
    const afterFirst = statesOf(engine).get(stateKey)!;
    expect(afterFirst.pendingUsagePair, '消费后槽必须清空').toBeUndefined();
    expect(afterFirst.lastUsageAnchor?.actual).toBe(raw);

    // 第二次 afterStep（无新 assemble）：缺对丢样，锚不被第二个实测覆盖
    await engine.afterStep!({
      sessionId: 'pair-consume',
      step: [createMessage('assistant', 'Response 2')],
      usage: makeTokenUsage({ promptTokens: raw * 10, completionTokens: 50 }),
    });
    const afterSecond = statesOf(engine).get(stateKey)!;
    expect(afterSecond.pendingUsagePair).toBeUndefined();
    expect(afterSecond.lastUsageAnchor?.actual, '缺对丢样：不得拿旧估算配新实测').toBe(raw);
  });

  it('缺对丢样：无配对槽的 afterStep 不喂校准台账', async () => {
    const engine = new DefaultContextEngine();
    // 不 assemble，直接 afterStep：无配对 → 样本计数不得增长
    await engine.afterStep!({
      sessionId: 'pair-drop',
      step: [createMessage('assistant', 'Response')],
      usage: makeTokenUsage({ promptTokens: 5000, completionTokens: 50 }),
    });
    expect(samplesOf(engine, 'unknown')).toBe(0);
    expect(samplesOf(engine, 'mock/m')).toBe(0);
    const state = statesOf(engine).get([...statesOf(engine).keys()][0] ?? '');
    expect(state?.lastUsageAnchor, '缺对不得冻结锚').toBeUndefined();
  });
});

// ── 红线 2：被拒样本不冻结锚；入账对（含 clamped 极端对）冻结 ──

describe('锚卫生', () => {
  it('入账对冻结锚；被拒样本（错位/敌对证据）不得冻结', async () => {
    const engine = new DefaultContextEngine();
    const raw1 = await assembleOnce(engine, 'anchor-gate');
    const stateKey = [...statesOf(engine).keys()][0];

    // 首样本 ratio=2.0（门内、带内）→ accepted → 冻锚
    await engine.afterStep!({
      sessionId: 'anchor-gate',
      step: [createMessage('assistant', 'r1')],
      usage: makeTokenUsage({ promptTokens: raw1 * 2, completionTokens: 1 }),
    });
    expect(statesOf(engine).get(stateKey)!.lastUsageAnchor?.actual).toBe(raw1 * 2);

    // 第二样本 ratio≈20×（样本门外）→ rejected → 锚保持首对
    const raw2 = await assembleOnce(engine, 'anchor-gate');
    await engine.afterStep!({
      sessionId: 'anchor-gate',
      step: [createMessage('assistant', 'r2')],
      usage: makeTokenUsage({ promptTokens: raw2 * 20, completionTokens: 1 }),
    });
    const after = statesOf(engine).get(stateKey)!;
    expect(after.lastUsageAnchor?.actual, '被拒样本不得覆盖锚').toBe(raw1 * 2);
  });

  it('F1 极端锚定语义保留：冷启动 clamped 对仍冻结锚（不进 EMA 决策但锚定实测）', async () => {
    const engine = new DefaultContextEngine();
    const raw = await assembleOnce(engine, 'anchor-extreme');
    const stateKey = [...statesOf(engine).keys()][0];

    // 冷启动 100× 极端样本：clamp 入账（EMA 被 [0.25,4] 夹住），锚冻结实测对
    await engine.afterStep!({
      sessionId: 'anchor-extreme',
      step: [createMessage('assistant', 'r')],
      usage: makeTokenUsage({ promptTokens: raw * 100, completionTokens: 1 }),
    });
    const state = statesOf(engine).get(stateKey)!;
    expect(state.lastUsageAnchor?.actual, 'clamped 对是合法极端内容锚（F1）').toBe(raw * 100);
  });
});

// ── 红线 3：压缩完成即清锚 ──

describe('压缩完成清锚', () => {
  it('manual/structural 压缩完成后 lastUsageAnchor 清空', async () => {
    const engine = new DefaultContextEngine({ protectFirstN: 1, protectLastN: 1 });
    const raw = await assembleOnce(engine, 'anchor-clear');
    const stateKey = [...statesOf(engine).keys()][0];

    await engine.afterStep!({
      sessionId: 'anchor-clear',
      step: [createMessage('assistant', 'r')],
      usage: makeTokenUsage({ promptTokens: raw, completionTokens: 1 }),
    });
    expect(statesOf(engine).get(stateKey)!.lastUsageAnchor).toBeDefined();

    await (
      engine as unknown as {
        compactStructural: (i: Record<string, unknown>) => Promise<unknown>;
      }
    ).compactStructural({
      sessionId: 'anchor-clear',
      messages: [
        createMessage('user', 'hello world'),
        createMessage('user', 'middle content A'),
        createMessage('user', 'middle content B'),
        createMessage('user', 'more content here'),
      ],
      // 必须产出 fresh 语义摘要（生成转换记录=请求形状改变）才清锚；
      // 无 summarize 的「宁可胖不丢」早退不产记录、形状不变，锚仍有效
      summarize: async () => 'SUMMARY-HANDOFF',
    });
    expect(
      statesOf(engine).get(stateKey)!.lastUsageAnchor,
      '压缩改请求形状，旧锚必须失效',
    ).toBeUndefined();
  });

  it('overflow 压缩完成后 lastUsageAnchor 清空', async () => {
    const engine = new DefaultContextEngine({
      protectFirstN: 1,
      protectLastN: 1,
      targetTokens: 0,
      proactiveCompactRatio: 0,
    });
    // 小预算先装配+锚定
    await engine.assemble({
      sessionId: 'anchor-overflow',
      modelKey: 'mock/m',
      messages: [createMessage('user', 'hello')],
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 100000,
    });
    const stateKey = [...statesOf(engine).keys()][0];
    const raw = statesOf(engine).get(stateKey)!.pendingUsagePair!.rawEstimatedTokens;
    await engine.afterStep!({
      sessionId: 'anchor-overflow',
      step: [createMessage('assistant', 'r')],
      usage: makeTokenUsage({ promptTokens: raw, completionTokens: 1 }),
    });
    expect(statesOf(engine).get(stateKey)!.lastUsageAnchor).toBeDefined();

    // 溢出装配（大工具结果压垮预算）→ overflow 记录生成 → 清锚
    const messages: Message[] = [createMessage('user', 'go')];
    for (let i = 0; i < 6; i++) {
      messages.push(createToolResultMessage(`call_${i}`, 'read_file', 'R'.repeat(3000)));
    }
    messages.push(createMessage('user', 'wrap up'));
    await engine.assemble({
      sessionId: 'anchor-overflow',
      modelKey: 'mock/m',
      messages,
      systemPrompt: 'sys',
      tools: [],
      tokenBudget: 4000,
      contextWindow: 32000,
    });
    expect(
      statesOf(engine).get(stateKey)!.lastUsageAnchor,
      'overflow 记录生成 = 请求形状已变，旧锚必须失效',
    ).toBeUndefined();
  });
});

// ── 红线 4：wrap-up 压力轴实测优先 ──

describe('wrap-up 压力轴实测优先', () => {
  it('contextPressureTokens：实测优先，估算只做前瞻补充', () => {
    // 毒估算场景（事故现场）：估算 5.4× 虚高，实测在手时裁决必须用实测
    expect(
      contextPressureTokens({ contextActualTokens: 173664, contextEstTokens: 941913 }),
      '实测在手时不得用估算（否则 86% 假压力掐死 run）',
    ).toBe(173664);
    // 无实测（首步前）回落估算
    expect(contextPressureTokens({ contextEstTokens: 50000 })).toBe(50000);
    // 两者皆缺
    expect(contextPressureTokens({})).toBeUndefined();
  });

  it('对话调用更新 contextActualTokens；摘要调用不更新', () => {
    const ledger = new UsageLedger();
    ledger.recordUsage(makeTokenUsage({ promptTokens: 300, completionTokens: 10 }));
    expect(ledger.snapshot().contextActualTokens).toBe(300);

    ledger.recordUsage(makeTokenUsage({ promptTokens: 900, completionTokens: 10 }), {
      summary: true,
    });
    expect(
      ledger.snapshot().contextActualTokens,
      '摘要请求的体量不是会话上下文，不得污染压力轴',
    ).toBe(300);

    ledger.recordUsage(makeTokenUsage({ promptTokens: 450, completionTokens: 10 }));
    expect(ledger.snapshot().contextActualTokens).toBe(450);

    ledger.reset();
    expect(ledger.snapshot().contextActualTokens).toBeUndefined();
  });
});
