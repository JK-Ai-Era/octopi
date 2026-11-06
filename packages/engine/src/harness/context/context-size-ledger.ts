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
 * - 告警按 (session, model, 事件类) 限频 1 条/小时（拒绝告警不被夹取告警吞掉）。
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

/** 越界告警限频：每 (session, model) 每小时 1 条 */
export const RATIO_WARN_INTERVAL_MS = 3_600_000;

const EMA_NEW_WEIGHT = 0.7;

export interface SizeLedgerWarn {
  (message: string): void;
}

/** 校准台账：observe(actual, view) 学 ratio；calibrate(viewTokens) 出校准读数 */
export class ContextSizeLedger {
  private ratioByModel = new Map<string, number>();
  private samplesByModel = new Map<string, number>();
  private rejectedByModel = new Map<string, number>();
  private rejectStreaks = new Map<string, { count: number; min: number; max: number }>();
  private lastWarnAt = new Map<string, number>();

  constructor(private readonly warn: SizeLedgerWarn = (m) => console.warn(m)) {}

  /**
   * 记录一对实测/估算样本（分母 view 必须是「system+tools+视图」口径的**未校准**估算）。
   *
   * @param modelKey provider/model 标识（ratio 的分键）
   * @param actual provider 实测 prompt tokens
   * @param view 同一请求的未校准视图估算
   * @param opts sessionId（告警限频键）/ now（测试注入时钟）
   */
  observe(modelKey: string, actual: number, view: number, opts?: { sessionId?: string; now?: number }): void {
    if (!(actual > 0) || !(view > 0)) return;
    const raw = actual / view;
    const prev = this.ratioByModel.get(modelKey) ?? 1.0;
    const hasSamples = (this.samplesByModel.get(modelKey) ?? 0) > 0;
    const outsideGate =
      hasSamples &&
      (raw > prev * RATIO_SAMPLE_MAX_DEVIATION || raw < prev / RATIO_SAMPLE_MAX_DEVIATION);
    if (outsideGate) {
      this.rejectedByModel.set(modelKey, (this.rejectedByModel.get(modelKey) ?? 0) + 1);
      const streak = this.rejectStreaks.get(modelKey) ?? { count: 0, min: Number.POSITIVE_INFINITY, max: 0 };
      streak.count += 1;
      streak.min = Math.min(streak.min, raw);
      streak.max = Math.max(streak.max, raw);
      this.rejectStreaks.set(modelKey, streak);
      // 逃逸重锚（评审 F1）：连续同向且内部一致的被拒簇 = regime shift 证据（真实换挡或
      // 新错配源），以簇中心重锚。拒绝零状态变化会把真值永久锁在门外；交替垃圾（0.088↔11.014）
      // 簇内 max/min 巨大、永不满足一致性，进不来。
      if (streak.count >= RATIO_ESCAPE_STREAK && streak.max / streak.min <= RATIO_ESCAPE_CONSISTENCY) {
        const rebase = Math.min(RATIO_CLAMP_MAX, Math.max(RATIO_CLAMP_MIN, (streak.min + streak.max) / 2));
        this.ratioByModel.set(modelKey, rebase);
        this.samplesByModel.set(modelKey, (this.samplesByModel.get(modelKey) ?? 0) + 1);
        this.rejectStreaks.set(modelKey, { count: 0, min: Number.POSITIVE_INFINITY, max: 0 });
        this.warnOnce(opts?.sessionId, modelKey, raw, opts?.now, 'rebase', `regime shift: rebase learned=${rebase.toFixed(3)}`);
        return;
      }
      this.warnOnce(
        opts?.sessionId,
        modelKey,
        raw,
        opts?.now,
        'reject',
        `rejected（已拒绝入账） learned=${prev.toFixed(3)} gate=[${(prev / RATIO_SAMPLE_MAX_DEVIATION).toFixed(3)}, ${(prev * RATIO_SAMPLE_MAX_DEVIATION).toFixed(3)}]`,
      );
      return;
    }
    this.rejectStreaks.set(modelKey, { count: 0, min: Number.POSITIVE_INFINITY, max: 0 });
    if (raw < RATIO_CLAMP_MIN || raw > RATIO_CLAMP_MAX) {
      this.warnOnce(opts?.sessionId, modelKey, raw, opts?.now, 'clamp', `out of clamp（已夹取入账） clamp=[${RATIO_CLAMP_MIN}, ${RATIO_CLAMP_MAX}]`);
    }
    const clamped = Math.min(RATIO_CLAMP_MAX, Math.max(RATIO_CLAMP_MIN, raw));
    this.ratioByModel.set(modelKey, EMA_NEW_WEIGHT * clamped + (1 - EMA_NEW_WEIGHT) * prev);
    this.samplesByModel.set(modelKey, (this.samplesByModel.get(modelKey) ?? 0) + 1);
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
    cls: 'reject' | 'clamp' | 'rebase',
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
