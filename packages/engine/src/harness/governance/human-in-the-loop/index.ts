/**
 * Human-in-the-Loop 领域 — 人机交互
 *
 * 职责：确认决策缓存（session / always）+ 统一 resolve（SEC-7 单模型）。
 * 强制面在 `confirmHighRisk` / `confirmEffect` 两条钩子，不在本目录另起生命周期。
 */

export {
  HitlDecisionCache,
  defaultHitlCache,
  resolveHitlDecision,
} from './decision-cache.js';
export type { HitlChannel, HitlCacheScope } from './decision-cache.js';
export type { HitlDecision } from './types.js';
