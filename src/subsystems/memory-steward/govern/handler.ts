/**
 * memory.steward.govern — 记忆库软删治理
 */

import type { SubsystemInput, SubsystemOutput, InjectedDependencies } from '../../../harness/autonomous-subsystem/types.js';
import type { MemoryStore } from '../../../harness/memory/types.js';
import { applySoftDeletes, planSoftDeletes, resolvePolicy, type SoftDeletePolicyConfig } from '../shared/policy.js';

const DEP_MEMORY_STORE = 'memoryStore';
const DEP_CONFIG = '__subsystem_config__';

interface GovernConfig {
  softDelete?: SoftDeletePolicyConfig;
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

  const entries = await memoryStore.listForGovern({ includeDeleted: false });
  const plan = planSoftDeletes(entries, policyCfg);
  const result = await applySoftDeletes(memoryStore, plan, dryRun);

  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'memory-store',
      messages: [{
        role: 'system',
        content: `memory.steward.governed planned=${plan.length} applied=${result.applied} dryRun=${dryRun}`,
      }],
      ops: plan.map((p) => ({
        op: 'soft_delete' as const,
        ids: [p.id],
        reason: p.reason,
        meta: { ruleId: p.ruleId, winnerId: p.winnerId },
      })),
    },
    signals: [{
      action: 'suggest',
      reason: `Memory govern completed planned=${plan.length} applied=${result.applied}`,
      data: {
        planned: plan.length,
        applied: result.applied,
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
