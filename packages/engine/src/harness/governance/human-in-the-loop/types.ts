/**
 * Human-in-the-Loop 接口定义（SEC-7 单模型）
 *
 * @layer harness/governance/human-in-the-loop — 确认决策契约。
 *
 * 唯一强制面是 `confirmHighRisk` / `confirmEffect` 两条钩子（见 core）；
 * 决策统一为 `HitlDecision`，缓存见 `decision-cache.ts`。
 * 不再保留独立 ApprovalManager / ApprovalProvider 生命周期。
 */

export type {
  HitlDecision,
} from '@octopi-agent/core/types/tools.js';

export type {
  HitlChannel,
  HitlCacheScope,
} from './decision-cache.js';
