/**
 * Transform records — persistent compaction products.
 *
 * Model (arch/context-size-accounting.md §10.18「持久转换记录」拍板):
 * a compaction product is a **fact**, not a temporary view. Once a record is
 * appended it is permanently effective; the original text only returns to the
 * view on an explicit revocation entry. Assembly = deterministic application
 * of effective records over the append-only original messages (fold).
 *
 * - Per-agent ledger: records are keyed (sessionId, agentId) (E4 shape); agents
 *   never see each other's compaction views.
 * - Coordinates are message content anchors (hash + occurrence), never array
 *   indices — indices survive neither fork/copy nor re-indexing.
 * - `type` is honest: `summary` only for fresh semantic summaries (the fresh
 *   gate's sole remaining job); mechanical products are `degrade`.
 *
 * @module harness/context/transform/types
 */

// ── 锚点 ──

/**
 * Stable coordinate of one original message.
 *
 * `hash` is the canonical identity hash of the persisted message; `occurrence`
 * disambiguates byte-identical duplicates in stream order; `indexHint` is the
 * raw index at creation time (fast path only — never authoritative).
 */
export interface MessageAnchor {
  /** sha256 hex of the canonical message identity */
  hash: string;
  /** 0-based occurrence of this hash in the message stream at creation */
  occurrence: number;
  /** raw index at creation (resolution fast path) */
  indexHint: number;
}

/** One covered run: inclusive original-message range `[from, to]`. */
export interface TransformRun {
  from: MessageAnchor;
  to: MessageAnchor;
}

// ── 记录 ──

export type TransformRecordType = 'summary' | 'degrade';

/** Rendering shape of the replacement placeholder message. */
export interface TransformPlaceholder {
  role: 'user' | 'system' | 'assistant';
  /** Message.metadata.source marker (e.g. 'contextSummary' / 'contextLedger') */
  source?: string;
}

/**
 * One compaction product. Created only by compaction paths (proactive /
 * overflow / manual); appended durably before the compacted view is returned.
 *
 * `covers` may be empty: a pure growth-gate anchor (a completed compaction
 * round that produced no durable coverage — legacy migrate / counters-only).
 */
export interface TransformRecord {
  /** per-(sessionId, agentId) monotonic sequence, assigned by the store */
  seq: number;
  sessionId: string;
  agentId: string;
  type: TransformRecordType;
  createdAt: number;
  /** covered original-message runs (inclusive; usually exactly one run) */
  covers: TransformRun[];
  /** content-addressed replacement text ref (`sha256:<hex>`); undefined iff covers is empty */
  blobRef?: string;
  /** replacement text (hydrated at load / consumed at append; persisted via blobRef) */
  text?: string;
  /** replacement message shape (text comes from the blob) */
  placeholder: TransformPlaceholder;
  /** appended revocation entry flipped this flag at load (append-only ledger) */
  revoked: boolean;
  meta: TransformRecordMeta;
}

export interface TransformRecordMeta {
  reason: 'proactive' | 'overflow' | 'manual';
  /** fresh semantic summary at creation (record type gate) */
  fresh: boolean;
  /** a summarize LLM call was actually issued (success or failure) */
  summarizeAttempted: boolean;
  /** messages.length at creation (growth-gate base) */
  messageCount: number;
  /** raw-history token estimate at creation — 仅诊断口径（有多段历史时远大于实际请求）
   *  ：**不作增长门基数**（2026-11-07 起，改用 viewTokens） */
  fullTokens?: number;
  /** post-compaction view token estimate = 实际请求口径（fold + 老化） */
  viewTokens?: number;
  /** viewTokens 的计量口径版本：缺省 = 旧口径（fold 视图未老化、且非请求形状）。
   *  增长门只认可 'request' 基；旧记录视为无基数（允许一次压缩自愈），
   *  否则两种口径互比会永久压制压缩。 */
  viewTokensSource?: 'request';
}

/** Record as handed to the store (seq assigned by the store; text goes to a blob). */
export type NewTransformRecord = Omit<TransformRecord, 'seq' | 'blobRef' | 'revoked'>;

// ── 账本 ──

export interface TransformLedger {
  /** ordered by seq；`revoked` 已折叠 */
  records: TransformRecord[];
  /**
   * 账本文件曾有任何条目（含损坏行 / blob 丢失被丢弃的）。
   * 迁移幂等门用它而不是 records.length——「行在 blob 全丢」不得被当成空账本
   * 而重放旧快照迁移（评审 F7）。
   */
  hadEntries?: boolean;
}

/**
 * Persistence port for transform records.
 *
 * Appends are durable-before-return: a compaction product must hit the store
 * before the compacted view is sent (otherwise a crash refills the raw text —
 * exactly the defect this model exists to remove).
 */
export interface TransformStore {
  /**
   * Load the ledger for (sessionId, agentId).
   *
   * @param sessionId - session id
   * @param agentId - agent id ("" for legacy single-agent)
   * @returns ledger (empty when none)
   */
  load(sessionId: string, agentId: string): Promise<TransformLedger>;
  /**
   * Durably append records (and optional revocations).
   *
   * @param sessionId - session id
   * @param agentId - agent id
   * @param records - new records (seq assigned by the store)
   * @param revokeSeqs - seqs of existing records to revoke (explicit revocation)
   * @returns the appended records with seq assigned
   */
  append(
    sessionId: string,
    agentId: string,
    records: NewTransformRecord[],
    revokeSeqs?: number[],
  ): Promise<TransformRecord[]>;
}
