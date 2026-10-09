/**
 * Wisdom policy — 评估/治理确定性策略
 *
 * 弱归因贝叶斯更新、utility 淘汰、priority 衰减、状态迁移规划。
 * 代码执法；不调用 LLM。规范：arch/wisdom-layer-formation.md §5–§8。
 *
 * @module harness/memory/wisdom-policy
 */

import type {
  WisdomEntry,
  WisdomOutcomeEvent,
  WisdomOutcomeSignal,
  WisdomStatus,
} from './types.js';

export interface WisdomEvaluationConfig {
  /** trial 期正向学习率 */
  trialAlpha?: number;
  /** trial 期负向学习率 */
  trialBeta?: number;
  /** active 期 */
  activeAlpha?: number;
  activeBeta?: number;
  /** strengthened 期（更钝，防单次戏剧事件翻盘） */
  strongAlpha?: number;
  strongBeta?: number;
  /** trial→active 最少 applied */
  minAppliesForActive?: number;
  /** contested 触发：窗口内 contested/applied 比例 */
  contestRate?: number;
  /** contested 触发：counterevidence 权重和 */
  counterevidenceWeight?: number;
  /** active→strengthened：最低 applied + 低 contest */
  strengthenMinApplies?: number;
  strengthenMaxContestRate?: number;
}

export const DEFAULT_WISDOM_EVALUATION: Required<WisdomEvaluationConfig> = {
  trialAlpha: 0.18,
  trialBeta: 0.22,
  activeAlpha: 0.1,
  activeBeta: 0.14,
  strongAlpha: 0.05,
  strongBeta: 0.07,
  minAppliesForActive: 3,
  contestRate: 0.5,
  counterevidenceWeight: 2.5,
  strengthenMinApplies: 12,
  strengthenMaxContestRate: 0.15,
};

export interface WisdomGovernConfig {
  /** active+trial+strengthened 软顶 */
  softCap?: number;
  /** 硬顶（admit stop） */
  hardCap?: number;
  /** 零应用衰减 idle（ms） */
  zeroApplyIdleMs?: number;
  /** priority 衰减步长 */
  priorityDecayStep?: number;
  /** priority 触底 → retired */
  priorityFloor?: number;
  dryRun?: boolean;
}

export const DEFAULT_WISDOM_GOVERN: Required<Omit<WisdomGovernConfig, 'dryRun'>> & {
  dryRun: boolean;
} = {
  softCap: 50,
  hardCap: 80,
  zeroApplyIdleMs: 30 * 24 * 3600_000,
  priorityDecayStep: 5,
  priorityFloor: 5,
  dryRun: false,
};

export interface WisdomConfidenceUpdate {
  id: string;
  confidence: number;
  status: WisdomStatus;
  reason: string;
  /** 写回水位，防止终身累计被重复折进 confidence */
  evalAssisted: number;
  evalContested: number;
}

/**
 * 结局事件折叠到条目计数。
 *
 * @param entry - 当前条目（不修改）
 * @param events - 该条相关信号
 * @returns 更新后的 outcomes 计数与时间戳
 */
export function foldOutcomeEvents(
  entry: Pick<WisdomEntry, 'outcomes'>,
  events: Array<Pick<WisdomOutcomeEvent, 'signal' | 'at'>>,
): Pick<WisdomEntry, 'outcomes'> {
  const o = {
    applied: entry.outcomes.applied,
    cited: entry.outcomes.cited,
    assisted: entry.outcomes.assisted,
    contested: entry.outcomes.contested,
    lastAppliedAt: entry.outcomes.lastAppliedAt,
    lastOutcomeAt: entry.outcomes.lastOutcomeAt,
    evalAssisted: entry.outcomes.evalAssisted ?? 0,
    evalContested: entry.outcomes.evalContested ?? 0,
  };
  let maxAt = o.lastOutcomeAt;
  for (const e of events) {
    const at = e.at ?? Date.now();
    if (maxAt == null || at > maxAt) maxAt = at;
    switch (e.signal as WisdomOutcomeSignal) {
      case 'applied':
        o.applied += 1;
        o.lastAppliedAt = at;
        break;
      case 'cited':
        o.cited += 1;
        break;
      case 'assisted':
        o.assisted += 1;
        break;
      case 'contested':
        o.contested += 1;
        break;
      case 'ignored':
        break;
      default:
        break;
    }
  }
  o.lastOutcomeAt = maxAt;
  return { outcomes: o };
}

/**
 * 贝叶斯风格 confidence 弱更新 + 状态迁移规划。
 *
 * **只对增量生效**：`outcomes.assisted/contested` 终身累计，与水位
 * `evalAssisted/evalContested` 之差才是本轮增量。空跑 pulse 不得再拉 confidence。
 * applied=0 只影响 priority（govern），不减 confidence。
 *
 * @param entry - 条目
 * @param cfg - 评估参数
 * @param now - 当前时间
 * @returns 是否需要写回与新值（含水位）；无需写回时 null
 */
export function planConfidenceUpdate(
  entry: WisdomEntry,
  cfg: WisdomEvaluationConfig = {},
  now = Date.now(),
): WisdomConfidenceUpdate | null {
  const c = { ...DEFAULT_WISDOM_EVALUATION, ...cfg };
  const { assisted, contested, applied } = entry.outcomes;
  const trial = entry.status === 'trial';
  const strong = entry.status === 'strengthened';

  const alpha = trial ? c.trialAlpha : strong ? c.strongAlpha : c.activeAlpha;
  const beta = trial ? c.trialBeta : strong ? c.strongBeta : c.activeBeta;

  // 增量：只吃尚未并入 confidence 的部分
  const dPos = Math.max(0, assisted - (entry.outcomes.evalAssisted ?? 0));
  const dNeg = Math.max(0, contested - (entry.outcomes.evalContested ?? 0));

  let confidence = entry.confidence;
  if (dPos > 0) {
    confidence = confidence + alpha * (1 - confidence) * Math.min(dPos, 5);
  }
  if (dNeg > 0) {
    confidence = confidence - beta * confidence * Math.min(dNeg, 5);
  }
  confidence = Math.min(1, Math.max(0, confidence));

  let status = entry.status;
  let reason = 'noop';

  const ceWeight = (entry.counterevidence ?? []).reduce((s, x) => s + (x.weight || 0), 0);
  const contestRate = applied > 0 ? contested / applied : 0;

  if (status !== 'superseded' && status !== 'retired') {
    if (ceWeight >= c.counterevidenceWeight || (applied >= 3 && contestRate >= c.contestRate && contested >= 2)) {
      if (status !== 'contested') {
        status = 'contested';
        reason = 'contest_threshold';
      }
    } else if (status === 'trial' && applied >= c.minAppliesForActive && assisted > contested) {
      status = 'active';
      reason = 'trial_to_active';
    } else if (
      (status === 'active' || status === 'strengthened') &&
      applied >= c.strengthenMinApplies &&
      contestRate <= c.strengthenMaxContestRate &&
      assisted > contested
    ) {
      if (status !== 'strengthened') {
        status = 'strengthened';
        reason = 'strengthened';
      }
    } else if (status === 'contested' && contestRate < c.contestRate / 2 && assisted > contested) {
      status = 'trial';
      reason = 'contested_repair';
    }
  }

  const nextEvalAssisted = assisted;
  const nextEvalContested = contested;
  const watermarkMoved =
    (entry.outcomes.evalAssisted ?? 0) !== nextEvalAssisted ||
    (entry.outcomes.evalContested ?? 0) !== nextEvalContested;
  const changed =
    Math.abs(confidence - entry.confidence) > 1e-6 || status !== entry.status || watermarkMoved;
  if (!changed) return null;
  return {
    id: entry.id,
    confidence,
    status,
    reason,
    evalAssisted: nextEvalAssisted,
    evalContested: nextEvalContested,
  };
}

export interface WisdomGoverPlanItem {
  id: string;
  action: 'decay_priority' | 'retire';
  reason: string;
  priority?: number;
}

/**
 * 容量演化 + 零应用衰减规划。
 *
 * @param entries - 存活条目（不含 retired/superseded）
 * @param cfg - 治理参数
 * @param now - 当前时间
 * @returns 治理动作列表
 */
export function planWisdomGovern(
  entries: WisdomEntry[],
  cfg: WisdomGovernConfig = {},
  now = Date.now(),
): WisdomGoverPlanItem[] {
  const c = { ...DEFAULT_WISDOM_GOVERN, ...cfg };
  const plan: WisdomGoverPlanItem[] = [];
  const alive = entries.filter((e) => e.status !== 'retired' && e.status !== 'superseded');

  // 零应用衰减（保护 strengthened / factory 不轻易退休，但仍降 priority）
  for (const e of alive) {
    const last = e.outcomes.lastAppliedAt ?? e.updatedAt;
    const idle = now - last;
    if (idle >= c.zeroApplyIdleMs && e.outcomes.applied === 0) {
      const next = Math.max(c.priorityFloor, e.priority - c.priorityDecayStep);
      if (next < e.priority) {
        plan.push({
          id: e.id,
          action: 'decay_priority',
          reason: 'zero_apply_idle',
          priority: next,
        });
      }
      // factory 核心不因零应用退休
      if (e.origin !== 'factory' && e.status !== 'strengthened' && next <= c.priorityFloor) {
        plan.push({ id: e.id, action: 'retire', reason: 'zero_apply_floor' });
      }
    }
  }

  // 容量：超 softCap 淘汰最低 utility（保护 factory / strengthened）
  const living = alive.filter((e) => !plan.some((p) => p.id === e.id && p.action === 'retire'));
  if (living.length > c.softCap) {
    const ranked = [...living].sort((a, b) => wisdomUtility(a) - wisdomUtility(b));
    const excess = living.length - c.softCap;
    let dropped = 0;
    for (const e of ranked) {
      if (dropped >= excess) break;
      if (e.origin === 'factory' || e.status === 'strengthened') continue;
      plan.push({ id: e.id, action: 'retire', reason: 'capacity' });
      dropped++;
    }
  }

  return plan;
}

/**
 * utility = confidence × (0.5 + 0.5·normalizedApplies) × (priority/100)
 *
 * @param e - 条目
 * @returns 淘汰排序分
 */
export function wisdomUtility(e: WisdomEntry): number {
  const applies = Math.min(1, e.outcomes.applied / 20);
  return e.confidence * (0.5 + 0.5 * applies) * (e.priority / 100);
}

/**
 * 注入选择打分。
 *
 * @param entry - 条目
 * @param matchScore - 场景匹配分 [0,1]；core 用 1
 * @returns 注入排序分
 */
export function wisdomInjectScore(entry: WisdomEntry, matchScore: number): number {
  const statusBoost =
    entry.status === 'strengthened' ? 1.15 : entry.status === 'active' ? 1 : 0.75;
  return wisdomUtility(entry) * statusBoost * (0.35 + 0.65 * matchScore);
}
