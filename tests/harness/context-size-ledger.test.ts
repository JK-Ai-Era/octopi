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
    const clampWarns = () => warn.mock.calls.filter((c) => String(c[0]).includes('out of clamp')).length;
    // 越界高估（bootstrap 首样本）：raw 10 → 夹到 4 入账，clamp 告警 1 条
    ledger.observe('mock/m', 1000, 100, { sessionId: 's1', now: t0 });
    expect(clampWarns()).toBe(1);
    expect(ledger.ratio('mock/m')).toBeCloseTo(0.7 * RATIO_CLAMP_MAX + 0.3, 10); // 3.1
    // 一小时内再越界：同 class 不再告警（限频）；方向一致（10 < 3.1×4）仍夹取入账
    // （此样本同时触发预测带降级 warn——F5 降级可见，独立限频键）
    ledger.observe('mock/m', 1000, 100, { sessionId: 's1', now: t0 + 60_000 });
    expect(clampWarns()).toBe(1);
    expect(ledger.ratio('mock/m')).toBeCloseTo(0.7 * RATIO_CLAMP_MAX + 0.3 * (0.7 * RATIO_CLAMP_MAX + 0.3), 10); // 3.73
    // 超 1 小时：再告警
    ledger.observe('mock/m', 1000, 100, { sessionId: 's1', now: t0 + RATIO_WARN_INTERVAL_MS + 1 });
    expect(clampWarns()).toBe(2);
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
    ledger.observe('mock/m', 1, 1000, { sessionId: 's1', now: t0 + 60_000 }); // 出门 → reject 告警 + 降级转换 warn
    const clampCalls = warn.mock.calls.filter((c) => String(c[0]).includes('out of clamp'));
    const rejectCalls = warn.mock.calls.filter((c) => String(c[0]).includes('rejected（'));
    expect(clampCalls).toHaveLength(1);
    expect(rejectCalls).toHaveLength(1); // 不同 class：拒绝不被夹取告警吞掉
    expect(rejectCalls[0][0]).toContain('gate='); // F10：拒绝告警给 gate 而非 clamp 区间
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

  it('integration: 冷启动锚定实测（F1），样本 ≥2 后校准收敛（R1）', async () => {
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
    const raw = first.estimatedTokens; // 冷启动无锚 → 首读数 = 未校准估算
    expect(raw).toBeGreaterThan(0);

    // 实测 = 2× 估算（样本 1，bootstrap → ratio 1.7）
    await engine.afterStep({
      sessionId: 's-cal',
      step: [],
      usage: makeTokenUsage({ promptTokens: raw * 2, completionTokens: 1 }),
    });
    // 单样本（cold，F1）不走校准：锚定实测 × 增长比 = 2R（精确真值），而非 1.7R
    const second = await engine.assemble(params);
    expect(second.estimatedTokens).toBe(raw * 2);

    // 样本 2 入账（2.0 与 1.7 同带 → 可信）；ratio EMA = 0.7×2 + 0.3×1.7 = 1.91
    await engine.afterStep({
      sessionId: 's-cal',
      step: [],
      usage: makeTokenUsage({ promptTokens: raw * 2, completionTokens: 1 }),
    });
    const third = await engine.assemble(params);
    expect(third.estimatedTokens).toBe(Math.ceil(raw * 1.91));
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

  it('B fail-safe：毒化 ratio 降级后决策锚定实测 × 增长比（不再乘可疑 ratio）', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 11014, 1000); // 毒化 bootstrap → ratio 3.1（尚在学习窗口）
    expect(ledger.isDegraded('mock/m')).toBe(false);
    ledger.observe('mock/m', 500, 1000); // 真值 0.5 出门 → 拒绝 → 降级
    expect(ledger.isDegraded('mock/m')).toBe(true);
    const anchor = { actual: 266_000, raw: 280_000, modelKey: 'mock/m' };
    // 决策读数 = 实测 × raw 增长比 = 266k（而非 3.1×280k=868k——事故的假 85% 压力来源）
    expect(ledger.decisionTokens('mock/m', 280_000, anchor)).toBe(266_000);
    // 增量外推：raw 翻倍 → 读数翻倍
    expect(ledger.decisionTokens('mock/m', 560_000, anchor)).toBe(532_000);
    // 无锚：退未校准 raw（诚实估算，不乘可疑 ratio）
    expect(ledger.decisionTokens('mock/m', 12_345)).toBe(12_345);
  });

  it('F1 红线：单样本 ratio 不进决策（cold 即锚定/裸 raw，防首样本毒化直送决策）', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 11014, 1000); // 毒化 bootstrap → ratio 3.1、未降级
    expect(ledger.isDegraded('mock/m')).toBe(false);
    expect(ledger.ratio('mock/m')).toBeCloseTo(3.1, 10);
    // 事故形态：3.1× 若直进决策 = 868k/1M=86.8% 假压力停跑；F1 后 cold 不可信 → 锚定实测
    expect(
      ledger.decisionTokens('mock/m', 280_000, { actual: 266_000, raw: 280_000, modelKey: 'mock/m' }),
    ).toBe(266_000);
    // 无锚：裸 raw（不是 868k）
    expect(ledger.decisionTokens('mock/m', 280_000)).toBe(280_000);
    // 跨 model 锚无效（评审 F3）：回落裸 raw
    expect(
      ledger.decisionTokens('mock/m', 280_000, { actual: 266_000, raw: 280_000, modelKey: 'other/m' }),
    ).toBe(280_000);
  });

  it('F2 红线：不一致垃圾不再永久废掉逃逸（被拒滑窗重开）', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 950, 1000); // 0.95 基准 → 0.965
    ledger.observe('mock/m', 50, 1000); // 垃圾 0.05（出门）→ 拒
    ledger.observe('mock/m', 11000, 1000); // 垃圾 11.0（出门）→ 拒（旧实现全史 min/max 被拉开→逃逸永久失效）
    ledger.observe('mock/m', 100, 1000); // 真值 0.1（出门）→ 拒
    ledger.observe('mock/m', 100, 1000); // 拒（窗 [11.0, 0.1, 0.1]，仍不一致）
    ledger.observe('mock/m', 100, 1000); // 拒（窗 [0.1, 0.1, 0.1] 一致 → 重锚）
    // 重锚值 = 窗心 0.1 夹到接受带下界 0.25（带外真值以带边界落点——分词器极端偏差的既定折衷）
    expect(ledger.ratio('mock/m')).toBeCloseTo(RATIO_CLAMP_MIN, 10);
    expect(ledger.isDegraded('mock/m')).toBe(false); // 重锚清降级（永久降级死角消除）
    expect(ledger.rejectedCount('mock/m')).toBe(5);
    // 逃逸生效的实质：后续真值样本恢复入账（不再永久拒之门外）
    ledger.observe('mock/m', 100, 1000);
    expect(ledger.sampleCount('mock/m')).toBe(3); // bootstrap + 重锚 + 恢复入账
  });

  it('B recovery：重锚清除降级，R1 校准读数恢复', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 11014, 1000); // ratio 3.1
    ledger.observe('mock/m', 500, 1000); // 拒绝 → 降级
    ledger.observe('mock/m', 500, 1000);
    ledger.observe('mock/m', 500, 1000); // 同向一致 → 重锚 0.5（清降级，样本数=2 → 可信）
    expect(ledger.isDegraded('mock/m')).toBe(false);
    // healthy：R1 原语义 = calibrate（0.5×1000=500），不是锚定值 900
    expect(ledger.decisionTokens('mock/m', 1000, { actual: 900, raw: 1000, modelKey: 'mock/m' })).toBe(500);
  });

  it('B 预测带：门内预测失准也降级，带内样本恢复', () => {
    const ledger = new ContextSizeLedger(() => {});
    ledger.observe('mock/m', 3100, 1000); // bootstrap raw 3.1 → ratio 2.47
    ledger.observe('mock/m', 950, 1000); // raw 0.95：门内（0.95 > 2.47/4）但预测带外（<2.47/1.5）→ 降级
    expect(ledger.isDegraded('mock/m')).toBe(true);
    ledger.observe('mock/m', 1000, 1000); // raw 1.0 回到带内（ratio ≈1.406，带 [0.937, 2.109]）→ 恢复
    expect(ledger.isDegraded('mock/m')).toBe(false);
  });
});
