/**
 * P1-a 红线：ContextSizeLedger 校准入决策（arch/context-size-accounting.md §4.3）
 *
 * 1. EMA 平滑 0.7 新 / 0.3 旧；
 * 2. ratio 按 model 分键（跨 session 共享、互不污染）；
 * 3. clamp [0.25, 4.0] + 越界告警限频 1 条/h/(session,model)（不静默夹取）；
 * 4. calibratedEstimator：决策读数 = ceil(raw × ratio)（R1）；
 * 5. 集成：assemble→afterStep→再 assemble，校准读数向实测收敛（δ 递减）。
 */
import { describe, it, expect, vi } from 'vitest';
import { makeTokenUsage } from '@octopi-agent/core/types/step.js';
import type { Message } from '@octopi-agent/core/types.js';
import {
  ContextSizeLedger,
  RATIO_CLAMP_MIN,
  RATIO_CLAMP_MAX,
  RATIO_WARN_INTERVAL_MS,
} from '@octopi-agent/engine/harness/context/context-size-ledger.js';
import { HeuristicTokenEstimator } from '@octopi-agent/engine/harness/context/token-estimator.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';

function userMsg(content: string): Message {
  return { role: 'user', content, timestamp: 1 };
}

describe('ContextSizeLedger (P1-a)', () => {
  it('EMA smoothing: 0.7 new / 0.3 old', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 200, 100); // raw 2.0，首样本 → 0.7*2 + 0.3*1 = 1.7
    expect(ledger.ratio('mock/m')).toBeCloseTo(1.7, 10);
    ledger.observe('mock/m', 200, 100); // → 0.7*2 + 0.3*1.7 = 1.91
    expect(ledger.ratio('mock/m')).toBeCloseTo(1.91, 10);
    ledger.observe('mock/m', 100, 100); // raw 1.0 → 0.7*1 + 0.3*1.91 = 1.273
    expect(ledger.ratio('mock/m')).toBeCloseTo(1.273, 10);
  });

  it('ratio is keyed by model (independent across models)', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('a/m1', 300, 100); // 3.0
    ledger.observe('b/m2', 100, 100); // 1.0
    expect(ledger.ratio('a/m1')).toBeCloseTo(0.7 * 3 + 0.3, 10);
    expect(ledger.ratio('b/m2')).toBeCloseTo(1.0, 10);
    expect(ledger.sampleCount('a/m1')).toBe(1);
  });

  it('clamp [0.25, 4.0] + out-of-bounds warn rate-limited 1/h per (session, model)', () => {
    const warn = vi.fn();
    const ledger = new ContextSizeLedger(warn);
    const t0 = 1_000_000;
    // 越界高估：raw 10 → 夹到 4 入平滑，告警 1 条
    ledger.observe('mock/m', 1000, 100, { sessionId: 's1', now: t0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(ledger.ratio('mock/m')).toBeCloseTo(0.7 * RATIO_CLAMP_MAX + 0.3, 10);
    // 一小时内再越界：不再告警（限频）
    ledger.observe('mock/m', 1000, 100, { sessionId: 's1', now: t0 + 60_000 });
    expect(warn).toHaveBeenCalledTimes(1);
    // 超 1 小时：再告警
    ledger.observe('mock/m', 1000, 100, { sessionId: 's1', now: t0 + RATIO_WARN_INTERVAL_MS + 1 });
    expect(warn).toHaveBeenCalledTimes(2);
    // 越界低估侧同样夹取
    ledger.observe('mock/m', 10, 1000, { sessionId: 's2', now: t0 });
    expect(ledger.ratio('mock/m')).toBeLessThanOrEqual(0.7 * RATIO_CLAMP_MAX + 0.3);
  });

  it('observes nothing on non-positive actual/view (no poison samples)', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 0, 100);
    ledger.observe('mock/m', 100, 0);
    expect(ledger.sampleCount('mock/m')).toBe(0);
    expect(ledger.ratio('mock/m')).toBe(1.0);
  });

  it('calibrate: ceil(viewTokens × ratio)', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 200, 100); // ratio 1.7
    expect(ledger.calibrate('mock/m', 10)).toBe(17);
    expect(ledger.calibrate('mock/m', 11)).toBe(19); // 18.7 → ceil
    expect(ledger.calibrate('unknown', 10)).toBe(10); // 无样本 = 1.0
  });

  it('calibratedEstimator: every reading scaled (R1: decisions read calibrated)', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 200, 100); // ratio 1.7
    const est = ledger.calibratedEstimator('mock/m', new HeuristicTokenEstimator());
    const msgs = [userMsg('hello world')];
    const raw = new HeuristicTokenEstimator().estimateMessages(msgs);
    expect(est.estimateMessages(msgs)).toBe(Math.ceil(raw * 1.7));
    expect(est.estimateText('hello')).toBe(Math.ceil(new HeuristicTokenEstimator().estimateText('hello') * 1.7));
  });

  it('integration: assemble → afterStep → assemble again converges toward the measured value', async () => {
    const engine = new DefaultContextEngine();
    const messages = [userMsg('hello world, 继续'), { role: 'assistant', content: 'hi', timestamp: 2 } as Message];
    const params = {
      sessionId: 's-cal',
      modelKey: 'mock/m',
      messages,
      systemPrompt: 'sys',
      tools: [],
    };
    const first = await engine.assemble(params);
    const raw = first.estimatedTokens; // 冷启动 ratio=1 → 首读数 = 未校准估算
    expect(raw).toBeGreaterThan(0);

    // 实测 = 2× 估算 → ratio 学到 1.7（0.7*2 + 0.3*1）
    await engine.afterStep({
      sessionId: 's-cal',
      step: [],
      usage: makeTokenUsage({ promptTokens: raw * 2, completionTokens: 1 }),
    });

    const second = await engine.assemble(params); // 同形请求
    expect(second.estimatedTokens).toBe(Math.ceil(raw * 1.7));
    // δ 递减：第二读数比第一读数更靠近实测（2R）
    const d1 = Math.abs(raw * 2 - raw);
    const d2 = Math.abs(raw * 2 - second.estimatedTokens);
    expect(d2).toBeLessThan(d1);
  });
});
