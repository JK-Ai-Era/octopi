/**
 * wisdom.steward.evaluate — 弱归因结局入账 + 状态迁移
 *
 * payload.events 为可选 WisdomOutcomeEvent[]；无事件时对存活条目做批量
 * confidence/状态规划（只基于已入账 outcomes）。不写 Memory / Cognition。
 */

import type {
  SubsystemInput,
  SubsystemOutput,
  InjectedDependencies,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';
import type {
  WisdomOutcomeEvent,
  WisdomStore,
} from '@octopi-agent/engine/harness/memory/types.js';
import {
  planConfidenceUpdate,
  type WisdomEvaluationConfig,
} from '../../../harness/memory/wisdom-policy.js';

const DEP_WISDOM = 'wisdomStore';
const DEP_CONFIG = '__subsystem_config__';

interface EvaluateConfig extends WisdomEvaluationConfig {
  dryRun?: boolean;
}

function isOutcomeEvent(v: unknown): v is WisdomOutcomeEvent {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.wisdomId === 'string' &&
    typeof o.signal === 'string' &&
    ['applied', 'cited', 'assisted', 'contested', 'ignored'].includes(o.signal)
  );
}

async function handler(input: SubsystemInput, deps?: InjectedDependencies): Promise<SubsystemOutput> {
  const store = deps?.[DEP_WISDOM] as WisdomStore | undefined;
  if (!store) throw new Error('wisdom.steward.evaluate: wisdomStore not injected');
  const config = (deps?.[DEP_CONFIG] as EvaluateConfig | undefined) ?? {};
  const dryRun = config.dryRun ?? false;

  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const rawEvents = Array.isArray(payload.events) ? payload.events : [];
  const events = rawEvents.filter(isOutcomeEvent);

  if (events.length > 0 && !dryRun) {
    await store.recordOutcomes(events);
  }

  const entries = await store.listForGovern({ includeRetired: false });
  let updated = 0;
  let statusChanges = 0;
  const planned: Array<{ id: string; status: string; confidence: number; reason: string }> = [];

  for (const e of entries) {
    // 终态不再评估（superseded 链已封；retired 由 govern 处理）
    if (e.status === 'superseded' || e.status === 'retired') continue;
    // recordOutcomes 已增量更新过的条目：水位对齐后 plan 为 null 或仅状态迁移
    const plan = planConfidenceUpdate(e, config);
    if (!plan) continue;
    planned.push({
      id: plan.id,
      status: plan.status,
      confidence: plan.confidence,
      reason: plan.reason,
    });
    if (!dryRun) {
      await store.update(plan.id, {
        confidence: plan.confidence,
        status: plan.status,
        outcomes: {
          ...e.outcomes,
          evalAssisted: plan.evalAssisted,
          evalContested: plan.evalContested,
        },
      });
      updated++;
    }
    if (plan.status !== e.status) statusChanges++;
  }

  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'wisdom-store',
      messages: [{
        role: 'system',
        content: `wisdom.steward.evaluated events=${events.length} updated=${updated} statusChanges=${statusChanges} dryRun=${dryRun}`,
      }],
    },
    signals: [{
      action: 'suggest',
      reason: 'evaluation_completed',
      data: {
        events: events.length,
        updated,
        statusChanges,
        dryRun,
        planned: planned.slice(0, 20),
      },
    }],
  };
}

export default {
  handler,
  contract: { input: 'WisdomEvaluateInput', output: 'WisdomEvaluateResult' },
  dependencies: [DEP_WISDOM],
};

export { handler };
