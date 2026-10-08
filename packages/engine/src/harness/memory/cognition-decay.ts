/**
 * Cognition 边衰减曲线 — 按 relationType 的日衰减率
 *
 * @module harness/memory/cognition-decay
 */

import type { ConceptRelationType, ConceptStatus } from './types.js';

/** 每日衰减乘数（0–1；越小越快弱） */
export const DEFAULT_EDGE_DECAY_PER_DAY: Record<ConceptRelationType, number> = {
  related: 0.05,
  similar_to: 0.03,
  opposes: 0.02,
  causes: 0.01,
  part_of: 0.01,
  evolves_to: 0.01,
};

export const DEFAULT_EDGE_DECAY_FLOOR = 0.02;

export type EdgeDecayConfig = Partial<Record<ConceptRelationType, number>>;

/**
 * 将日衰减率换算到时间间隔后的乘数。
 *
 * @param rate - 每日衰减比例（0.05 表示每日 ×0.95）
 * @param days - 经过的天数
 * @returns 乘数（≥0）
 */
export function decayMultiplier(rate: number, days: number): number {
  if (days <= 0) return 1;
  const dailyKeep = Math.max(0, 1 - rate);
  return Math.pow(dailyKeep, days);
}

/**
 * 下一强度 = max(floor, w × mult)
 */
export function nextEdgeStrength(
  current: number,
  relationType: ConceptRelationType,
  days: number,
  config?: EdgeDecayConfig,
  floor = DEFAULT_EDGE_DECAY_FLOOR,
): number {
  const rate = config?.[relationType] ?? DEFAULT_EDGE_DECAY_PER_DAY[relationType];
  return Math.max(floor, current * decayMultiplier(rate, days));
}

/**
 * Hebbian 异步累积：w' = 1 - (1-w)(1-η·e)
 *
 * @param current - 当前边权
 * @param eta - 学习率（默认 0.15）
 * @param evidence - 证据强度 0–1
 */
export function hebbianStrengthen(
  current: number,
  evidence: number,
  eta = 0.15,
): number {
  const e = Math.min(1, Math.max(0, evidence));
  const w = Math.min(1, Math.max(0, current));
  return 1 - (1 - w) * (1 - eta * e);
}

/**
 * 反证降权：w' = w × (1-ρ)
 */
export function counterEvidenceWeaken(
  current: number,
  rho = 0.3,
): number {
  return Math.max(0, current * (1 - Math.min(1, Math.max(0, rho))));
}

/** Layer 默认只吃 active / strengthened */
export const DEFAULT_RETRIEVE_STATUSES: ConceptStatus[] = ['active', 'strengthened'];
