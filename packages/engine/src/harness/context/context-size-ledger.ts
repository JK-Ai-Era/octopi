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
 * - EMA 平滑 0.7 新 / 0.3 旧；样本先夹取再入平滑（单次野值不掀桌）；
 * - clamp 放宽至 [0.25, 4.0]，越界**告警而非静默夹取**——夹取会让系统性偏差永久隐身；
 * - 告警按 (session, model) 限频 1 条/小时。
 *
 * 状态为进程内存（ratio 冷启动 1.0，2–3 个样本内收敛）；不落盘。
 */

import type { TokenEstimator } from './types.js';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage, LLMToolDefinition } from '@octopi-agent/core/interfaces/model-provider.js';

/** ratio 夹取边界（拍板：[0.25, 4.0]） */
export const RATIO_CLAMP_MIN = 0.25;
export const RATIO_CLAMP_MAX = 4.0;

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
    if (raw < RATIO_CLAMP_MIN || raw > RATIO_CLAMP_MAX) {
      this.warnOnce(opts?.sessionId, modelKey, raw, opts?.now);
    }
    // 越界样本夹取后入平滑（防单次野值掀桌）；越界本身由告警负责可见
    const clamped = Math.min(RATIO_CLAMP_MAX, Math.max(RATIO_CLAMP_MIN, raw));
    const prev = this.ratioByModel.get(modelKey) ?? 1.0;
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

  /** 已学习样本数（收敛观测用） */
  sampleCount(modelKey: string): number {
    return this.samplesByModel.get(modelKey) ?? 0;
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

  /** 越界告警：每 (session, model) 每小时至多 1 条 */
  private warnOnce(sessionId: string | undefined, modelKey: string, raw: number, now?: number): void {
    const key = `${sessionId ?? '—'}|${modelKey}`;
    const ts = now ?? Date.now();
    const last = this.lastWarnAt.get(key);
    if (last !== undefined && ts - last < RATIO_WARN_INTERVAL_MS) return;
    this.lastWarnAt.set(key, ts);
    this.warn(
      `[ctx-cal] ratio out of clamp: session=${sessionId ?? '—'} model=${modelKey} raw=${raw.toFixed(3)} clamp=[${RATIO_CLAMP_MIN}, ${RATIO_CLAMP_MAX}]（已夹取入平滑；系统性偏差请校正估算器比率）`,
    );
  }
}
