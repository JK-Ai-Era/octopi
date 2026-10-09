/**
 * wisdom.steward.govern — 零应用衰减 + 容量演化 + 软退休
 *
 * 只写 WisdomStore；可 dryRun。不写 Memory / Cognition。
 */

import type {
  SubsystemInput,
  SubsystemOutput,
  InjectedDependencies,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';
import type { WisdomStore } from '@octopi-agent/engine/harness/memory/types.js';
import {
  planWisdomGovern,
  wisdomUtility,
  type WisdomGovernConfig,
} from '../../../harness/memory/wisdom-policy.js';

const DEP_WISDOM = 'wisdomStore';
const DEP_CONFIG = '__subsystem_config__';

async function handler(_input: SubsystemInput, deps?: InjectedDependencies): Promise<SubsystemOutput> {
  const store = deps?.[DEP_WISDOM] as WisdomStore | undefined;
  if (!store) throw new Error('wisdom.steward.govern: wisdomStore not injected');
  const config = (deps?.[DEP_CONFIG] as WisdomGovernConfig | undefined) ?? {};
  const dryRun = config.dryRun ?? false;

  const entries = await store.listForGovern({ includeRetired: false });
  const plan = planWisdomGovern(entries, config);

  let decayed = 0;
  let retired = 0;
  if (!dryRun) {
    for (const item of plan) {
      if (item.action === 'decay_priority' && item.priority != null) {
        await store.update(item.id, { priority: item.priority });
        decayed++;
      } else if (item.action === 'retire') {
        await store.softRetire(item.id, { by: 'wisdom.steward.govern', reason: item.reason });
        retired++;
      }
    }
  } else {
    decayed = plan.filter((p) => p.action === 'decay_priority').length;
    retired = plan.filter((p) => p.action === 'retire').length;
  }

  const stats = await store.stats();
  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'wisdom-store',
      messages: [{
        role: 'system',
        content:
          `wisdom.steward.governed decayed=${decayed} retired=${retired} total=${stats.total} ` +
          `live=${stats.byStatus.trial + stats.byStatus.active + stats.byStatus.strengthened} dryRun=${dryRun}`,
      }],
    },
    signals: [{
      action: 'suggest',
      reason: 'govern_completed',
      data: {
        decayed,
        retired,
        dryRun,
        plan: plan.slice(0, 30),
        stats,
        utilities: entries
          .slice(0, 10)
          .map((e) => ({ id: e.id, utility: wisdomUtility(e), status: e.status })),
      },
    }],
  };
}

export default {
  handler,
  contract: { input: 'WisdomGovernInput', output: 'WisdomGovernResult' },
  dependencies: [DEP_WISDOM],
};

export { handler };
