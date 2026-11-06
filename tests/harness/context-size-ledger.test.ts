/**
 * P1-a 红线：ContextSizeLedger 校准入决策（arch/context-size-accounting.md §4.3 / §10.14）
 *
 * 1. EMA 平滑 0.7 新 / 0.3 旧；
 * 2. ratio 按 model 分键（跨 session 共享、互不污染）；
 * 3. 夹取带 [0.25, 4.0] + 越界告警限频 1 条/h/(session,model,事件类)（不静默夹取）；
 * 4. calibratedEstimator：决策读数 = ceil(raw × ratio)（R1）；
 * 5. 集成：assemble→afterStep→再 assemble，校准读数向实测收敛（δ 递减）；
 * 6. 偏离门（§10.14）：偏离已学 ratio 超倍数的样本拒绝入账，双向垃圾样本不震荡；
 * 7. 逃逸重锚（评审 F1）：同向一致被拒簇触发 regime shift 重锚——真值永不被永久锁死；
 *    交替垃圾簇内永不一致、不得逃逸；
 * 8. 防过度拦截守卫：门内的好样本照常纠偏（这两条守的是「门别拦过头」，不是事故回归）；
 * 9. 无新鲜 usage 的 afterStep 不喂样本（引擎兜底；runner 缝隙红线见
 *    tests/harness/afterstep-usage-pairing.test.ts）。
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

  it('clamp [0.25, 4.0] as admission band: consistent out-of-bounds samples clamped in, warn rate-limited 1/h per (session, model, class)', () => {
    const warn = vi.fn();
    const ledger = new ContextSizeLedger(warn);
    const t0 = 1_000_000;
    // 越界高估（bootstrap 首样本）：raw 10 → 夹到 4 入账，告警 1 条
    ledger.observe('mock/m', 1000, 100, { sessionId: 's1', now: t0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(ledger.ratio('mock/m')).toBeCloseTo(0.7 * RATIO_CLAMP_MAX + 0.3, 10); // 3.1
    // 一小时内再越界：同 class 不再告警（限频）；方向一致（10 < 3.1×4）仍夹取入账
    ledger.observe('mock/m', 1000, 100, { sessionId: 's1', now: t0 + 60_000 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(ledger.ratio('mock/m')).toBeCloseTo(0.7 * RATIO_CLAMP_MAX + 0.3 * (0.7 * RATIO_CLAMP_MAX + 0.3), 10); // 3.73
    // 超 1 小时：再告警
    ledger.observe('mock/m', 1000, 100, { sessionId: 's1', now: t0 + RATIO_WARN_INTERVAL_MS + 1 });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('clamp band low side: raw 0.01 (bootstrap) clamps to 0.25 and enters smoothing', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 10, 1000); // raw 0.01 → 夹 0.25 → 0.7*0.25 + 0.3*1 = 0.475
    expect(ledger.ratio('mock/m')).toBeCloseTo(0.7 * RATIO_CLAMP_MIN + 0.3, 10);
    expect(ledger.sampleCount('mock/m')).toBe(1);
    expect(ledger.rejectedCount('mock/m')).toBe(0);
  });

  it('rejects samples deviating beyond the gate from the learned ratio (2026-11-06 incident pair)', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 950, 1000); // raw 0.95 建立基准 → 0.965
    // 事故序列（arch §10.14）：双向错配样本交替——旧「夹取后入平滑」会把 ratio 在 clamp 两端拉扯震荡
    ledger.observe('mock/m', 88, 1000); // raw 0.088，偏离 ≈11× → 拒绝
    ledger.observe('mock/m', 11014, 1000); // raw 11.014，偏离 ≈11× → 拒绝
    ledger.observe('mock/m', 88, 1000);
    ledger.observe('mock/m', 11014, 1000);
    expect(ledger.ratio('mock/m')).toBeCloseTo(0.965, 10); // 不震荡
    expect(ledger.sampleCount('mock/m')).toBe(1); // 垃圾样本不入账
    expect(ledger.rejectedCount('mock/m')).toBe(4);
  });

  it('F1 escape: poisoned low bootstrap + consistent out-of-gate truth rebases and learns', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 88, 1000); // 毒化 bootstrap：raw 0.088 → 夹 0.25 → 0.475
    ledger.observe('mock/m', 460, 100); // 真值 raw 4.6：4.6 > 0.475×4 → 拒绝
    ledger.observe('mock/m', 460, 100); // 拒绝
    ledger.observe('mock/m', 460, 100); // 连续 3 个同向一致 → 重锚 clamp(4.6) = 4.0
    expect(ledger.ratio('mock/m')).toBeCloseTo(4.0, 10);
    expect(ledger.rejectedCount('mock/m')).toBe(3);
    ledger.observe('mock/m', 460, 100); // 门 [1.0, 16] 内 → 正常入账
    expect(ledger.ratio('mock/m')).toBeCloseTo(4.0, 10);
    expect(ledger.sampleCount('mock/m')).toBe(3); // bootstrap + 重锚 + 1 正常
  });

  it('F1 escape: poisoned high bootstrap + consistent low truth rebases (no 6.2× lockup)', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 11014, 1000); // 毒化 bootstrap：raw 11.014 → 夹 4 → 3.1
    expect(ledger.ratio('mock/m')).toBeCloseTo(3.1, 10);
    ledger.observe('mock/m', 500, 1000); // 真值 raw 0.5：0.5 < 3.1/4 → 拒绝
    ledger.observe('mock/m', 500, 1000);
    ledger.observe('mock/m', 500, 1000); // 连续 3 个同向一致 → 重锚 0.5
    expect(ledger.ratio('mock/m')).toBeCloseTo(0.5, 10);
    ledger.observe('mock/m', 500, 1000);
    expect(ledger.ratio('mock/m')).toBeCloseTo(0.5, 10);
    expect(ledger.rejectedCount('mock/m')).toBe(3);
  });

  it('alternating garbage never escapes (cluster never internally consistent)', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 950, 1000); // 健康基准 → 0.965
    for (let i = 0; i < 4; i++) {
      ledger.observe('mock/m', 88, 1000); // 0.088 ↔ 11.014 交替
      ledger.observe('mock/m', 11014, 1000);
    }
    expect(ledger.ratio('mock/m')).toBeCloseTo(0.965, 10); // 不震荡也不重锚
    expect(ledger.sampleCount('mock/m')).toBe(1);
    expect(ledger.rejectedCount('mock/m')).toBe(8);
  });

  it('gate boundary: exactly 4× deviation accepted, just beyond rejected', () => {
    const a = new ContextSizeLedger(() => {});
    a.observe('mock/m', 1000, 1000); // ratio 1.0
    a.observe('mock/m', 400, 100); // raw 4.0 = 恰好 4× → 入账（夹 4）
    expect(a.rejectedCount('mock/m')).toBe(0);
    expect(a.ratio('mock/m')).toBeCloseTo(0.7 * RATIO_CLAMP_MAX + 0.3, 10);

    const b = new ContextSizeLedger(() => {});
    b.observe('mock/m', 1000, 1000);
    b.observe('mock/m', 401, 100); // raw 4.01 > 4× → 拒绝
    expect(b.rejectedCount('mock/m')).toBe(1);
    expect(b.ratio('mock/m')).toBeCloseTo(1.0, 10);
  });

  it('reject and clamp warns both fire within the same hour (class-scoped rate keys) with honest detail', () => {
    const warn = vi.fn();
    const ledger = new ContextSizeLedger(warn);
    const t0 = 2_000_000;
    ledger.observe('mock/m', 1000, 100, { sessionId: 's1', now: t0 }); // bootstrap 越界 → clamp 告警
    ledger.observe('mock/m', 1, 1000, { sessionId: 's1', now: t0 + 60_000 }); // 出门 → reject 告警
    expect(warn).toHaveBeenCalledTimes(2); // 不同 class：拒绝不被夹取告警吞掉
    expect(warn.mock.calls[0][0]).toContain('clamp');
    expect(warn.mock.calls[0][0]).toContain('out of clamp');
    expect(warn.mock.calls[1][0]).toContain('reject');
    expect(warn.mock.calls[1][0]).toContain('rejected');
    expect(warn.mock.calls[1][0]).toContain('gate='); // F10：拒绝告警给 gate 而非 clamp 区间
  });

  it('anti-over-block guard: a poisoned bootstrap sample is corrected by in-gate good samples', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 88, 1000); // 垃圾首样本：bootstrap 入账（夹 0.25）→ 0.475
    ledger.observe('mock/m', 950, 1000); // 好样本 0.95（0.95 < 0.475×4，门内）→ 0.7*0.95 + 0.3*0.475 = 0.8075
    ledger.observe('mock/m', 950, 1000); // → 0.7*0.95 + 0.3*0.8075 = 0.907
    expect(ledger.ratio('mock/m')).toBeGreaterThan(0.85);
  });

  it('anti-over-block guard: sustained same-direction out-of-clamp signal learns via bootstrap clamp', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 460, 100); // raw 4.6（bootstrap）→ 夹 4 → 0.7*4 + 0.3*1 = 3.1
    ledger.observe('mock/m', 755, 100); // raw 7.55（7.55 < 3.1×4，门内）→ 夹 4 → 0.7*4 + 0.3*3.1 = 3.73
    ledger.observe('mock/m', 755, 100); // → 0.7*4 + 0.3*3.73 = 3.919
    expect(ledger.ratio('mock/m')).toBeGreaterThan(3.5);
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

  it('engine 兜底：undefined usage 不喂样本（runner 缝隙红线见 afterstep-usage-pairing.test.ts）', async () => {
    const engine = new DefaultContextEngine();
    const params = {
      sessionId: 's-stale',
      modelKey: 'mock/m',
      messages: [userMsg('hello')],
      systemPrompt: 'sys',
      tools: [],
    };
    const first = await engine.assemble(params);
    await engine.afterStep({ sessionId: 's-stale', step: [], usage: undefined });
    const second = await engine.assemble(params);
    expect(second.estimatedTokens).toBe(first.estimatedTokens); // 无样本 → ratio 未动
  });
});
