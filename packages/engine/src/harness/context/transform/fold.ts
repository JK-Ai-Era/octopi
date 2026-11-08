/**
 * Deterministic fold — the sole view implementation in the transform-record
 * model: `view = originals with every effective record's runs replaced by its
 * placeholder`.
 *
 * No cursors, no incremental rescue: any message not covered by an effective
 * record is verbatim in the view. The same (messages, ledger) always yields
 * the same view — that identity is the operational definition of the red line
 * 「压缩产物跨装配永久生效」.
 *
 * Overlap composition: a later record wins the overlapping span **only when
 * its text represents the subsumed content** — a fresh summary was merged from
 * the previous summary at creation. A `degrade` record's mechanical text does
 * NOT represent subsumed records, so the translation layer
 * (`appendRecordFromProduct`) never lets degrade records cover placeholder
 * spans; by the time spans reach this fold, later-seq-wins is safe.
 *
 * Orphan handling is **per run** (review F3): a record applies every run that
 * still resolves; only a record with zero resolvable runs is fully orphaned.
 * Edit-resend truncates the message stream — run-level application keeps the
 * surviving coverage instead of refilling it.
 *
 * @module harness/context/transform/fold
 */

import type { Message } from '@octopi-agent/core/types.js';
import { asSummaryMessage } from '../capabilities/compact/messages.js';
import type { TransformLedger, TransformRecord } from './types.js';
import { resolveRun } from './anchors.js';

export interface FoldOptions {
  /** Called once per fully-orphaned record (no run resolves anymore) */
  onOrphan?: (record: TransformRecord) => void;
  /** Called per record whose runs were partially dropped (some runs no longer resolve) */
  onPartialOrphan?: (record: TransformRecord, droppedRuns: number) => void;
}

export interface FoldRun {
  record: TransformRecord;
  /** resolved inclusive raw ranges (original index space) */
  spans: Array<[number, number]>;
}

export interface FoldResult {
  /** the deterministic assembled view (originals + placeholders) */
  view: Message[];
  /** effective records with resolved spans (for translation/events) */
  applied: FoldRun[];
  /** effective records with zero resolvable spans (skipped entirely) */
  orphans: TransformRecord[];
  /** rendered placeholder message → its record (product translation identity map) */
  placeholderOf: Map<Message, FoldRun>;
}

/**
 * Apply effective records over the original messages.
 *
 * @param messages - full original stream (may include ephemeral entries)
 * @param ledger - transform ledger (records ordered by seq)
 * @param options - orphan sinks
 * @returns fold result
 */
export function foldTransformView(
  messages: Message[],
  ledger: TransformLedger,
  options: FoldOptions,
): FoldResult {
  const applied: FoldRun[] = [];
  const orphans: TransformRecord[] = [];
  // span assignment in original index space; later seq overwrites (see module doc)
  const coverAt: Array<TransformRecord | undefined> = new Array(messages.length).fill(undefined);
  // first/last covered index per record (placeholder position / coverage line)
  const firstIndex = new Map<TransformRecord, number>();
  const lastIndex = new Map<TransformRecord, number>();

  for (const record of ledger.records) {
    if (record.revoked) continue;

    // per-run resolution（F3）：能解析的 run 生效；整记录零可解析才算孤儿
    const spans: Array<[number, number]> = [];
    let droppedRuns = 0;
    for (const run of record.covers) {
      const resolved = resolveRun(messages, run);
      if (resolved === undefined) {
        droppedRuns += 1;
        continue;
      }
      spans.push(resolved);
    }
    if (record.covers.length > 0 && spans.length === 0) {
      orphans.push(record);
      options.onOrphan?.(record);
      continue;
    }
    if (droppedRuns > 0) {
      options.onPartialOrphan?.(record, droppedRuns);
    }
    applied.push({ record, spans });
    for (const [a, b] of spans) {
      for (let i = a; i <= b; i++) {
        coverAt[i] = record;
        const f = firstIndex.get(record);
        const l = lastIndex.get(record);
        if (f === undefined || i < f) firstIndex.set(record, i);
        if (l === undefined || i > l) lastIndex.set(record, i);
      }
    }
  }

  // 零覆盖记录（covers:[]，legacy 迁移的「覆盖未知」残缺快照）：summary 型且有正文时
  // 渲染在视图最前（旧粘滞视图把它插在 head 之后；fold 无 protectFirstN 概念，
  // 位置取确定性的起点——信息等价、位置不同，仅此一形）。
  const zeroCover = applied.filter((r) => r.spans.length === 0 && r.record.type === 'summary' && r.record.text);

  const view: Message[] = [];
  const placeholderOf = new Map<Message, FoldRun>();
  const rendered = new Set<TransformRecord>();
  // zero-cover summary 占位映射到其记录（spans 空）；翻译需要身份映射
  for (const zc of zeroCover) {
    rendered.add(zc.record);
    // 无覆盖行（coveredEnd 省略，与 legacy 缺 coverEnd 的渲染同形）
    const msg = asSummaryMessage(zc.record.text!);
    const placeholder = { ...msg, timestamp: messages[0]?.timestamp ?? 0 };
    placeholderOf.set(placeholder, zc);
    view.push(placeholder);
  }
  for (let i = 0; i < messages.length; i++) {
    const record = coverAt[i];
    if (record === undefined) {
      view.push(messages[i]!);
      continue;
    }
    if (rendered.has(record)) continue;
    rendered.add(record);
    const run = applied.find((r) => r.record === record)!;
    const placeholder = renderPlaceholder(
      record,
      messages[firstIndex.get(record)!]!,
      lastIndex.get(record)!,
    );
    placeholderOf.set(placeholder, run);
    view.push(placeholder);
  }

  return { view, applied, orphans, placeholderOf };
}

/**
 * Render the placeholder message for a record at its first covered index.
 *
 * Summary records render through the single-source wrapper (marker + dynamic
 * `[Coverage]` line, F11); degrade records render their honest mechanical text
 * as-is. Timestamp = first covered message's timestamp — deterministic (the
 * timestamp is not part of the LLM request anyway).
 *
 * @param record - the record being rendered
 * @param at - first covered message (timestamp source)
 * @param lastCoveredIdx - last covered raw index (coverage line)
 * @returns placeholder message
 */
function renderPlaceholder(
  record: TransformRecord,
  at: Message,
  lastCoveredIdx: number,
): Message {
  const text = record.text ?? '';
  if (record.type === 'summary') {
    const msg = asSummaryMessage(text, lastCoveredIdx + 1);
    return { ...msg, timestamp: at.timestamp };
  }
  return {
    role: record.placeholder.role,
    content: text,
    timestamp: at.timestamp,
    ...(record.placeholder.source ? { metadata: { source: record.placeholder.source } } : {}),
  };
}
