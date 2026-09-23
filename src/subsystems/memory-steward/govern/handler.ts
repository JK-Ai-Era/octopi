/**
 * memory.steward.govern — 记忆库衰减 + 软删治理 + 挣得 boost
 *
 * 每轮先 `decay()` 再规划 softDelete：`scoreOf = importance * confidence * decayFactor`，
 * 避免用旧 decayFactor 做衰减淘汰。幸存条目做弱 boost / shadow 晋升；method/norm
 * 晋升候选只出信号，不写 Wisdom。
 */

import type { SubsystemInput, SubsystemOutput, InjectedDependencies } from '../../../harness/autonomous-subsystem/types.js';
import type { MemoryStore } from '../../../harness/memory/types.js';
import {
  applyBoosts,
  applySoftDeletes,
  planBoosts,
  planPromotionCandidates,
  planSoftDeletes,
  resolvePolicy,
  type SoftDeletePolicyConfig,
} from '../shared/policy.js';

const DEP_MEMORY_STORE = 'memoryStore';
const DEP_MEMORY_DECAY = 'memoryDecayParams';
const DEP_CONFIG = '__subsystem_config__';

interface GovernConfig {
  softDelete?: SoftDeletePolicyConfig;
  decayTypeParams?: Partial<Record<'fact' | 'method' | 'norm', { idleDays?: number; factor?: number; min?: number }>>;
}

async function handler(_input: SubsystemInput, deps?: InjectedDependencies): Promise<SubsystemOutput> {
  const memoryStore = deps?.[DEP_MEMORY_STORE] as MemoryStore | undefined;
  if (!memoryStore) {
    throw new Error('memory.steward.govern: memoryStore not injected');
  }
  const config = (deps?.[DEP_CONFIG] as GovernConfig | undefined) ?? {};
  const policyCfg = config.softDelete;
  const policy = resolvePolicy(policyCfg);
  const dryRun = policy.dryRun ?? false;

  // dryRun 只预览，不写 decayFactor / boost / softDelete
  const typeParams =
    (deps?.[DEP_MEMORY_DECAY] as GovernConfig['decayTypeParams'] | undefined) ?? config.decayTypeParams;
  const decayed = dryRun ? 0 : await memoryStore.decay({ typeParams });

  const entries = await memoryStore.listForGovern({ includeDeleted: false });
  const plan = planSoftDeletes(entries, policyCfg);
  const result = await applySoftDeletes(memoryStore, plan, dryRun);

  const deletedIds = new Set(plan.map((p) => p.id));
  const survivors = entries.filter((e) => !deletedIds.has(e.id));
  const boostPlan = planBoosts(survivors);
  const boostResult = await applyBoosts(memoryStore, boostPlan, dryRun);
  const promotionCandidates = planPromotionCandidates(survivors);

  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'memory-store',
      messages: [{
        role: 'system',
        content: `memory.steward.governed decayed=${decayed} planned=${plan.length} applied=${result.applied} boosted=${boostResult.applied} promotions=${promotionCandidates.length} dryRun=${dryRun}`,
      }],
      ops: [
        ...plan.map((p) => ({
          op: 'soft_delete' as const,
          ids: [p.id],
          reason: p.reason,
          meta: { ruleId: p.ruleId, winnerId: p.winnerId },
        })),
        ...boostPlan.map((b) => ({
          op: 'boost' as const,
          ids: [b.id],
          reason: b.reason,
          meta: { kind: b.op, confidence: b.confidence, status: b.status },
        })),
      ],
    },
    signals: [{
      action: 'suggest',
      reason: `Memory govern completed decayed=${decayed} planned=${plan.length} applied=${result.applied} boosted=${boostResult.applied}`,
      data: {
        decayed,
        planned: plan.length,
        applied: result.applied,
        boosted: boostResult.applied,
        promotionCandidates,
        dryRun,
        byRule: plan.reduce<Record<string, number>>((acc, p) => {
          acc[p.ruleId] = (acc[p.ruleId] ?? 0) + 1;
          return acc;
        }, {}),
      },
    }],
  };
}

export default {
  handler,
  contract: { input: 'GovernInput', output: 'GovernResult' },
  dependencies: [DEP_MEMORY_STORE],
};

export { handler };
