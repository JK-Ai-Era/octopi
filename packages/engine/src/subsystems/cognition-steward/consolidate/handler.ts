/**
 * cognition.steward.consolidate — 概念图巩固批
 *
 * 本轮实现：衰减 → 指纹冲突 keep_split → 按支撑晋升 → 容量水位。
 * 未实现步骤（LLM 合并裁决 / causal_candidate 转正 / Wisdom 信号 / anchor:missing GC）
 * 显式记入 skipped，不得假装完成规格 §7.2 全部步骤。
 *
 * 只写 ConceptGraphStore；不写 Memory / Wisdom。
 */

import type {
  SubsystemInput,
  SubsystemOutput,
  InjectedDependencies,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/types.js';
import type { ConceptGraphStore } from '@octopi-agent/engine/harness/memory/types.js';

const DEP_CONCEPT_GRAPH = 'conceptGraphStore';
const DEP_CONFIG = '__subsystem_config__';

interface ConsolidateConfig {
  promoteMinSupport?: number;
  warnNodes?: number;
  warnEdges?: number;
  stopNodes?: number;
  stopEdges?: number;
  autoKeepSplitConflicts?: boolean;
}

/** 本 handler 已声明但未执行的规格步骤 */
const SKIPPED_STEPS = [
  'merge_llm_adjudication',
  'causal_candidate_promotion',
  'counter_evidence_scan',
  'wisdom_promotion_signal',
  'anchor_missing_gc',
] as const;

async function handler(
  _input: SubsystemInput,
  deps?: InjectedDependencies,
): Promise<SubsystemOutput> {
  const store = deps?.[DEP_CONCEPT_GRAPH] as ConceptGraphStore | undefined;
  if (!store) {
    throw new Error('cognition.steward.consolidate: conceptGraphStore not injected');
  }
  const config = (deps?.[DEP_CONFIG] as ConsolidateConfig | undefined) ?? {};
  const promoteMinSupport = config.promoteMinSupport ?? 3;

  // 1. 衰减 + 无支撑 GC（store 内）
  const decay = await store.applyDecay();

  // 2. merge candidates：指纹冲突保守 keep_split（禁假合并）
  const candidates = await store.listMergeCandidates(100);
  let keptSplit = 0;
  if (config.autoKeepSplitConflicts !== false) {
    for (const c of candidates) {
      if (
        c.reason.includes('conflict') ||
        c.reason === 'domain_disjoint' ||
        c.reason === 'fingerprint_conflict'
      ) {
        await store.resolveMerge(c.id, 'keep_split');
        keptSplit += 1;
      }
    }
  }

  // 3. 晋升：memoryIds 支撑 ≥ promoteMinSupport 的 shadow 节点
  const graph = await store.getFullGraph();
  const toPromote = graph.nodes
    .filter((n) => n.status === 'shadow' && n.memoryIds.length >= promoteMinSupport)
    .map((n) => n.id);
  if (toPromote.length) {
    await store.promote(toPromote, 'active');
  }

  // 4. 容量水位
  const stats = await store.stats();
  const warnNodes = config.warnNodes ?? 5000;
  const warnEdges = config.warnEdges ?? 20_000;
  const stopNodes = config.stopNodes ?? 10_000;
  const stopEdges = config.stopEdges ?? 40_000;
  const capacity =
    stats.nodes >= stopNodes || stats.edges >= stopEdges
      ? 'admit_stop'
      : stats.nodes >= warnNodes || stats.edges >= warnEdges
        ? 'warn'
        : 'ok';

  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'concept-graph',
      messages: [
        {
          role: 'system',
          content:
            `cognition.steward.consolidated decayed=${decay.decayedEdges} gcNodes=${decay.gcNodes} ` +
            `promoted=${toPromote.length} keptSplit=${keptSplit} capacity=${capacity} ` +
            `nodes=${stats.nodes} edges=${stats.edges} ` +
            `skipped=[${SKIPPED_STEPS.join(',')}]`,
        },
      ],
    },
    signals: [
      {
        action: 'suggest',
        reason: 'consolidated_partial',
        data: {
          decay,
          promoted: toPromote.length,
          keptSplit,
          capacity,
          stats,
          openMergeCandidates: stats.openMergeCandidates,
          skippedSteps: [...SKIPPED_STEPS],
        },
      },
    ],
  };
}

export default handler;
