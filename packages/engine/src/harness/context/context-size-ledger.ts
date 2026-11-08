/**
 * ContextSizeLedger — 校准后上下文体量台账（P1-a，arch/context-size-accounting.md §4.3）
 *
 * 职责：把 `promptTokensActual`（provider 实测）学到的比率作用到**所有决策读数**（R1：
 * 决策只许用被实测校准过的 viewTokens）。取代旧「只乘展示值 + 逐 session ratio +
 * 静默 [0.5,2.0] 夹取」的三处缺陷：
 * 1. 决策点（smart-router / message-selector / compact / budget-allocator）未受益；
 * 2. clamp [0.5,2.0] 掩盖严重低估（实测偏差 2.9× 被夹到 2.0）；
 * 3. 分母口径漂移（口径对齐后 lastEstimatedTokens 恒为「system+tools+视图」）。
 *
 * 设计要点（拍板）：
 * - ratio **按 model 分 key**（跨 session 共享统计，收敛快）；
 * - EMA 平滑 0.7 新 / 0.3 旧；
 * - 夹取带 [0.25, 4.0] = 入账值域：超出即夹取（方向一致的越界样本可学习），越界**告警而非静默**；
 *   注意偏离门相对「已学 ratio」判，r<1 时带内样本也可能出门——出门不等于越界；
 * - 偏离门（arch §10.14）：新样本偏离已学 ratio 超 RATIO_SAMPLE_MAX_DEVIATION 倍即**拒绝入账**
 *   （错配样本如「陈旧 usage × 当步估算」双向拉扯 ratio 震荡，见 2026-11-06 事故）；
 * - 逃逸重锚（评审 F1）：连续 RATIO_ESCAPE_STREAK 个同向且内部一致的被拒样本 = regime shift
 *   证据，以簇中心重锚——拒绝零状态变化会把真值永久锁在门外（毒化 bootstrap 后 50 个真样本
 *   全拒的实测锁死）；交替垃圾内部永不一致、永远进不来；
 * - 告警按 (session, model, 事件类) 限频 1 条/小时（拒绝告警不被夹取告警吞掉）；
 * - 决策出口 decisionTokens（方案 B，arch §10.16）：≥2 已入账样本且未降级才走 calibrate（R1）；
 *   否则实测锚定（actual × raw/anchor.raw）或裸 raw。
 *
 * 状态为进程内存（ratio 冷启动 1.0，2–3 个样本内收敛）；不落盘。
 */

import type { TokenEstimator } from './types.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';

/** ratio 夹取边界（拍板：[0.25, 4.0]） */
export const RATIO_CLAMP_MIN = 0.25;
export const RATIO_CLAMP_MAX = 4.0;

/** 样本偏离门：新样本偏离已学 ratio 超该倍数（任一方向）即拒绝入账（arch §10.14） */
export const RATIO_SAMPLE_MAX_DEVIATION = 4.0;

/** 逃逸重锚：连续同向且内部一致的被拒簇达该长度即视为 regime shift（评审 F1） */
export const RATIO_ESCAPE_STREAK = 3;

/** 逃逸簇内部一致性：max/min ≤ 该值才算「同向一致」（交替垃圾永不一致） */
export const RATIO_ESCAPE_CONSISTENCY = 2.0;

/** 预测带：入账样本偏离已学 ratio 超该倍数 = 校准预测失准 → 降级（方案 B 门，arch §10.16） */
export const RATIO_PREDICTION_BAND = 1.5;

/** 越界告警限频：每 (session, model) 每小时 1 条 */
export const RATIO_WARN_INTERVAL_MS = 3_600_000;

const EMA_NEW_WEIGHT = 0.7;

export interface SizeLedgerWarn {
  (message: string): void;
}

/**
 * observe 裁决：accepted=干净入账（可作锚）/ clamped=越界夹取入账（禁作锚）/
 * rejected=样本门拒收 / rebased=滑窗重锚 / ignored=无效对（缺一边，丢样）
 */
export type ObserveVerdict = 'accepted' | 'clamped' | 'rejected' | 'rebased' | 'ignored';

/** 校准台账：observe(actual, view) 学 ratio；calibrate(viewTokens) 出校准读数 */
export class ContextSizeLedger {
  private ratioByModel = new Map<string, number>();
  private samplesByModel = new Map<string, number>();
  private rejectedByModel = new Map<string, number>();
  private rejectStreaks = new Map<string, number[]>();
  private degradedByModel = new Map<string, boolean>();
  private lastWarnAt = new Map<string, number>();

  constructor(private readonly warn: SizeLedgerWarn = (m) => console.warn(m)) {}

  /**
   * 记录一对实测/估算样本（分母 view 必须是「system+tools+视图」口径的**未校准**估算）。
   *
   * @param modelKey provider/model 标识（ratio 的分键）
   * @param actual provider 实测 prompt tokens
   * @param view 同一请求的未校准视图估算
   * @param opts sessionId（告警限频键）/ now（测试注入时钟）
   * @returns 裁决（调用方据其决定是否冻结实测锚——夹取/拒收/重锚样本一律不得作锚）
   */
  observe(
    modelKey: string,
    actual: number,
    view: number,
    opts?: { sessionId?: string; now?: number },
  ): ObserveVerdict {
    if (!(actual > 0) || !(view > 0)) return 'ignored';
    const raw = actual / view;
    const prev = this.ratioByModel.get(modelKey) ?? 1.0;
    const hasSamples = (this.samplesByModel.get(modelKey) ?? 0) > 0;
    const outsideGate =
      hasSamples &&
      (raw > prev * RATIO_SAMPLE_MAX_DEVIATION || raw < prev / RATIO_SAMPLE_MAX_DEVIATION);
    if (outsideGate) {
      this.rejectedByModel.set(modelKey, (this.rejectedByModel.get(modelKey) ?? 0) + 1);
      // 滑窗（评审 F2）：只保留最近 RATIO_ESCAPE_STREAK 个被拒样本——全史 min/max 一旦被
      // 一对不一致垃圾拉开就永不收敛，逃逸随之永久失效（实测：0.05+11.0 后 20 个真样本全拒）。
      const recent = this.rejectStreaks.get(modelKey) ?? [];
      recent.push(raw);
      if (recent.length > RATIO_ESCAPE_STREAK) recent.shift();
      this.rejectStreaks.set(modelKey, recent);
      // 逃逸重锚（评审 F1）：窗口内同向且内部一致的被拒样本 = regime shift 证据（真实换挡或
      // 新错配源），以窗心重锚。拒绝零状态变化会把真值永久锁在门外；交替垃圾（0.088↔11.014）
      // 任意 RATIO_ESCAPE_STREAK 连窗 max/min 巨大、永不满足一致性，进不来。
      if (recent.length >= RATIO_ESCAPE_STREAK) {
        const min = Math.min(...recent);
        const max = Math.max(...recent);
        if (max / min <= RATIO_ESCAPE_CONSISTENCY) {
          const rebase = Math.min(RATIO_CLAMP_MAX, Math.max(RATIO_CLAMP_MIN, (min + max) / 2));
          this.ratioByModel.set(modelKey, rebase);
          this.samplesByModel.set(modelKey, (this.samplesByModel.get(modelKey) ?? 0) + 1);
          this.rejectStreaks.set(modelKey, []);
          this.setDegraded(modelKey, false, opts, raw); // 重锚基于新鲜证据窗，预测恢复可信
          this.warnOnce(opts?.sessionId, modelKey, raw, opts?.now, 'rebase', `regime shift: rebase learned=${rebase.toFixed(3)}`);
          return 'rebased';
        }
      }
      this.setDegraded(modelKey, true, opts, raw); // 证据流敌对 → 校准降级（方案 B）
      this.warnOnce(
        opts?.sessionId,
        modelKey,
        raw,
        opts?.now,
        'reject',
        `rejected（已拒绝入账） learned=${prev.toFixed(3)} gate=[${(prev / RATIO_SAMPLE_MAX_DEVIATION).toFixed(3)}, ${(prev * RATIO_SAMPLE_MAX_DEVIATION).toFixed(3)}]`,
      );
      return 'rejected';
    }
    this.rejectStreaks.set(modelKey, []);
    const outOfClamp = raw < RATIO_CLAMP_MIN || raw > RATIO_CLAMP_MAX;
    if (outOfClamp) {
      this.warnOnce(opts?.sessionId, modelKey, raw, opts?.now, 'clamp', `out of clamp（已夹取入账） clamp=[${RATIO_CLAMP_MIN}, ${RATIO_CLAMP_MAX}]`);
    }
    // 预测带（方案 B 门）：入账样本偏离已学 ratio 超 RATIO_PREDICTION_BAND 倍 = 乘数
    // 预测失准（如毒化 ratio 尚未被门拦住的窗口期）→ 降级，直到样本回到带内
    this.setDegraded(
      modelKey,
      hasSamples && (raw > prev * RATIO_PREDICTION_BAND || raw < prev / RATIO_PREDICTION_BAND),
      opts,
      raw,
    );
    const clamped = Math.min(RATIO_CLAMP_MAX, Math.max(RATIO_CLAMP_MIN, raw));
    this.ratioByModel.set(modelKey, EMA_NEW_WEIGHT * clamped + (1 - EMA_NEW_WEIGHT) * prev);
    this.samplesByModel.set(modelKey, (this.samplesByModel.get(modelKey) ?? 0) + 1);
    return outOfClamp ? 'clamped' : 'accepted';
  }

  /** 降级状态写入 + 进入/退出可见（评审 F5）：生产须能从日志判定决策读数是校准还是实测锚定 */
  private setDegraded(
    modelKey: string,
    value: boolean,
    opts: { sessionId?: string; now?: number } | undefined,
    raw: number,
  ): void {
    const was = this.degradedByModel.get(modelKey) ?? false;
    this.degradedByModel.set(modelKey, value);
    if (was !== value) {
      this.warnOnce(
        opts?.sessionId,
        modelKey,
        raw,
        opts?.now,
        value ? 'degrade' : 'recover',
        value ? 'calibration degraded（决策改实测锚定）' : 'calibration recovered（决策回校准）',
      );
    }
  }

  /**
   * 校准一个视图估算（决策与展示读数的唯一出口）。
   *
   * @param modelKey provider/model 标识
   * @param viewTokens 未校准视图估算
   * @returns 校准后的 token 数（向上取整）
   */
  calibrate(modelKey: string, viewTokens: number): number {
    return Math.ceil(viewTokens * this.ratio(modelKey));
  }

  /** 当前平滑 ratio（无样本 = 1.0） */
  ratio(modelKey: string): number {
    return this.ratioByModel.get(modelKey) ?? 1.0;
  }

  /** 已学习样本数（收敛观测用；只计已入账样本） */
  sampleCount(modelKey: string): number {
    return this.samplesByModel.get(modelKey) ?? 0;
  }

  /** 被样本门拒绝的样本数（校准停学/锁死观测与 fail-safe 判定用） */
  rejectedCount(modelKey: string): number {
    return this.rejectedByModel.get(modelKey) ?? 0;
  }

  /** 校准是否降级（证据流敌对/预测带外；方案 B 触发位） */
  isDegraded(modelKey: string): boolean {
    return this.degradedByModel.get(modelKey) ?? false;
  }

  /**
   * 决策读数出口（R1 + 降级 B，arch §10.16）。
   *
   * - 校准可信（≥2 个已入账样本且未降级）：ceil(raw × ratio)（R1 原语义）；
   * - 不可信（冷启动单样本 / 降级，评审 F1）且有实测锚：ceil(actual × raw / anchor.raw)
   *   ——实测是滞后一个请求的硬真值，乘 raw 增长比外推本步增量（拍板方案 B）；
   *   锚为 {actual, raw, modelKey} 冻结对（同请求同源，评审 F3），跨 model 无效；
   * - 不可信无锚：raw（诚实估算，不乘可疑 ratio）。
   *
   * @param modelKey provider/model 标识
   * @param rawTokens 本次请求口径的未校准估算
   * @param anchor 实测锚（冻结对：actual=该请求实测 prompt，raw=同请求未校准估算）
   * @returns 决策用 token 读数
   */
  decisionTokens(
    modelKey: string,
    rawTokens: number,
    anchor?: { actual: number; raw: number; modelKey: string },
  ): number {
    return this.decisionTokensWithSource(modelKey, rawTokens, anchor).tokens;
  }

  /**
   * decisionTokens 的带来源变体（可观测：pressure 快照 readingSource，评审 F5）。
   *
   * @param modelKey provider/model 标识
   * @param rawTokens 本次请求口径的未校准估算
   * @param anchor 实测锚（冻结对）
   * @returns 决策读数 + 读数来源（calibrated=校准 / anchored=实测锚定 / raw=裸估算）
   */
  decisionTokensWithSource(
    modelKey: string,
    rawTokens: number,
    anchor?: { actual: number; raw: number; modelKey: string },
  ): { tokens: number; source: 'calibrated' | 'anchored' | 'raw' } {
    const trusted = (this.samplesByModel.get(modelKey) ?? 0) >= 2 && !this.isDegraded(modelKey);
    if (trusted) return { tokens: this.calibrate(modelKey, rawTokens), source: 'calibrated' };
    if (anchor && anchor.modelKey === modelKey && anchor.actual > 0 && anchor.raw > 0) {
      // 锚卫生（2026-11-07）：锚是同请求实测对的外推（配对槽保证同源）。不做比率带拒用——
      // ratio 远离 1 可能是合法极端内容（图片/大 schema，F1 冷锚定语义），带检查会把这种
      // 内容的决策砸回裸估算（低估 → 压缩触发漏报）。
      // 夹取（2026-11-08，生产现场 0.185 毒读数）：clamped 样本 EMA 吃夹取值而锚冻结的是
      // 原始值——极端比率（大 tools schema 本地估算偏高 5×）以原始值外推会毒化读数。
      // 与 EMA 同 guard 夹取 [RATIO_CLAMP_MIN, RATIO_CLAMP_MAX]：不拒极端锚（极端内容仍
      // 锚定），但比率不越过与 EMA 相同的界——两把尺同界。
      const anchorRatio = Math.min(
        RATIO_CLAMP_MAX,
        Math.max(RATIO_CLAMP_MIN, anchor.actual / anchor.raw),
      );
      return { tokens: Math.ceil(anchorRatio * rawTokens), source: 'anchored' };
    }
    return { tokens: rawTokens, source: 'raw' };
  }

  /**
   * 包装一个原始估算器为「校准读数」估算器（R1：决策路径读校准值）。
   * 读数 = calibrate(raw)；形状归一与计数仍在原始估算器（P1-c 单实现）。
   */
  calibratedEstimator(modelKey: string, raw: TokenEstimator): TokenEstimator {
    const ledger = this;
    return {
      estimateMessage(message: Message): number {
        return ledger.calibrate(modelKey, raw.estimateMessage(message));
      },
      estimateMessages(messages: Message[]): number {
        return ledger.calibrate(modelKey, raw.estimateMessages(messages));
      },
      estimateText(text: string): number {
        return ledger.calibrate(modelKey, raw.estimateText(text));
      },
      estimateTools(tools: LLMToolDefinition[]): number {
        return ledger.calibrate(modelKey, raw.estimateTools(tools));
      },
    };
  }

  /** 样本告警：每 (session, model, 事件类) 每小时至多 1 条（reject/clamp/rebase 分键，拒绝不被夹取吞掉） */
  private warnOnce(
    sessionId: string | undefined,
    modelKey: string,
    raw: number,
    now: number | undefined,
    cls: 'reject' | 'clamp' | 'rebase' | 'degrade' | 'recover',
    detail: string,
  ): void {
    const key = `${sessionId ?? '—'}|${modelKey}|${cls}`;
    const ts = now ?? Date.now();
    const last = this.lastWarnAt.get(key);
    if (last !== undefined && ts - last < RATIO_WARN_INTERVAL_MS) return;
    this.lastWarnAt.set(key, ts);
    this.warn(
      `[ctx-cal] ratio sample ${cls}: session=${sessionId ?? '—'} model=${modelKey} raw=${raw.toFixed(3)} ${detail}（系统性偏差请校正估算器比率；错配请查 usage/估算配对，arch §10.14）`,
    );
  }
}
