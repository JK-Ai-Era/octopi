/**
 * Legacy compact-snapshot migration — one-shot conversion of the old
 * `ContextCompactSnapshot` (previousSummary + coverEnd cursor) into initial
 * transform records.
 *
 * Mapping: the legacy sticky view rendered `head + summary + [coverEnd..tailStart)
 * + tail`, i.e. the summary replaced the raw originals in `[headEnd, coverEnd)`
 * while the head stayed verbatim (cache-prefix anchor). The migrated record
 * therefore covers exactly `[headEnd, coverEnd)`, reproducing the legacy view
 * byte-for-byte through the fold.
 *
 * Counter-only legacy states ("compacted, no summary") migrate to a `degrade`
 * gate-anchor record with empty covers: the legacy behavior covered nothing
 * (products refilled), so no coverage may be claimed — only the growth-gate
 * base is carried over.
 *
 * Idempotence is owned by the caller: migrate only when the ledger is empty.
 *
 * @module harness/context/transform/migrate
 */

import type { Message } from '@octopi-agent/core/types.js';
import type { ContextCompactSnapshot } from '../types.js';
import { alignViewSplit } from '../capabilities/compact/index.js';
import { anchorRange } from './anchors.js';
import type { NewTransformRecord, TransformRun } from './types.js';

export interface LegacyMigrateParams {
  sessionId: string;
  agentId: string;
  snapshot: ContextCompactSnapshot;
  messages: Message[];
  protectFirstN: number;
  protectLastN: number;
  now?: number;
}

/**
 * Convert a legacy snapshot into initial transform records.
 *
 * @param params - migration inputs
 * @returns records to append, or undefined when the snapshot holds nothing migratable
 */
export function legacySnapshotToRecords(params: LegacyMigrateParams): NewTransformRecord[] | undefined {
  const { sessionId, agentId, snapshot, messages, protectFirstN, protectLastN } = params;
  const hasSummary = Boolean(snapshot.summary);
  const hasCounters = snapshot.lastProactiveMessageCount != null;
  if (!hasSummary && !hasCounters) return undefined;

  const meta = {
    reason: 'manual' as const,
    fresh: hasSummary,
    summarizeAttempted: false,
    messageCount: snapshot.lastProactiveMessageCount ?? messages.length,
    ...(snapshot.lastProactiveTokens != null ? { viewTokens: snapshot.lastProactiveTokens } : {}),
  };

  const covers: TransformRun[] = [];
  if (hasSummary && (snapshot.lastProactiveCoverEnd ?? 0) > 0 && messages.length > 0) {
    // legacy coverage: [headEnd, coverEnd); head stays verbatim (see module doc)
    const { headEnd } = alignViewSplit(messages, protectFirstN, protectLastN);
    const coverEnd = Math.min(snapshot.lastProactiveCoverEnd!, messages.length);
    const run = coverEnd > headEnd ? anchorRange(messages, headEnd, coverEnd - 1) : undefined;
    if (run) covers.push(run);
  }

  // 残缺快照（summary 但覆盖未知/无计数）：照样迁移——零覆盖 summary 记录在 fold
  // 渲染为无覆盖行的摘要占位（legacy 视图同样注入该摘要；信息等价，评审 F9）
  const record: NewTransformRecord = {
    sessionId,
    agentId,
    type: hasSummary ? 'summary' : 'degrade',
    createdAt: params.now ?? Date.now(),
    covers,
    ...(hasSummary ? { text: snapshot.summary } : {}),
    placeholder: hasSummary
      ? { role: 'user', source: 'contextSummary' }
      : { role: 'user', source: 'contextLedger' },
    meta,
  };
  return [record];
}
