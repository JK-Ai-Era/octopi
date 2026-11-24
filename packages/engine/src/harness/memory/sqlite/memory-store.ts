/**
 * SqliteMemoryStore — SQLite 记忆存储
 *
 * 检索路径：
 * 1. 配置了 embedding + sqlite-vec 可用 → vec0 KNN
 * 2. 配置了 embedding（无 vec）→ SQL 预筛 + JS 余弦 hybrid
 * 3. 未配置 embedding → 多字段关键词（content/tags/future_use/anchors/evidence）
 *
 * shadow/软删过滤 + 治理管理面不变。
 */

import type {
  MemoryStore,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryType,
  MemoryStatus,
  MemoryChannel,
  SoftDeleteReason,
} from '../types.js';
import { MEMORY_TYPES } from '../types.js';
import { mapLegacyType } from '../gates.js';
import { AgentDatabase } from './agent-db.js';
import type { EmbeddingProvider } from './embedding.js';
import { searchTopK, parseEmbedding, serializeEmbedding } from './vector-search.js';
import {
  buildKeywordLikeSql,
  scoreKeywordFields,
  tokenizeKeywordDetail,
  tokenizeKeywordQuery,
} from './keyword-search.js';
import {
  deleteMemoryVector,
  ensureMemoryVecTable,
  searchMemoryVectors,
  upsertMemoryVector,
} from './sqlite-vec.js';
import type { VectorEngineChoice } from '../../../config.js';
import {
  DEFAULT_MIN_KEYWORD_SCORE,
  DEFAULT_MIN_SIMILARITY,
  DEFAULT_SIMILARITY_WEIGHT,
  blendRank,
  qualityScore,
  resolveRetrievalKnobs,
} from '../retrieval-rank.js';

/**
 * 向量重建批次参数。
 *
 * BATCH_SIZE 单批推进的行数；MAX_BATCHES_BG 是 agent 加载时一次推进的批数上限
 * ——不做无限循环，剩余交给后续检索续跑（避免启动期长时间占用 CPU/网络）。
 */
const MemoryBackfill = {
  BATCH_SIZE: 100,
  MAX_BATCHES_BG: 5,
} as const;

export interface SqliteMemoryStoreOptions {
  embeddingProvider?: EmbeddingProvider | null;
  /** 向量检索 SQL 候选上限（默认 500） */
  candidateCap?: number;
  /** 向量引擎；auto=优先 sqlite-vec（需 db 已 load 扩展），否则 JS */
  vectorEngine?: VectorEngineChoice;
  /** 向量路径默认相关性地板（query.minSimilarity 可覆盖） */
  minSimilarity?: number;
  /** 混合排序相似度权重；其余为 quality */
  similarityWeight?: number;
  /** 关键词路径默认最低命中分 */
  minKeywordScore?: number;
  /**
   * 构造时是否自动开始推进向量重建（默认 true）。
   *
   * 生产行为是「Agent 加载即重建」；仅在需要确定性时（测试、或宿主自行编排
   * 重建时机）置 false，改为由调用方显式触发 {@link startBackgroundBackfill}。
   */
  autoBackfill?: boolean;
  /**
   * 当前向量空间签名（缺省取 `embeddingProvider.signature`）。
   *
   * 写入时记入 `memories.embedding_signature`；检索时只认同签名的向量，
   * 签名不符的行视为「待重嵌」并进入回填队列。
   * null/undefined = 不启用签名过滤（第三方 provider 无法自证时的旧行为）。
   */
  embeddingSignature?: string | null;
}

function emptyTypes(): Record<MemoryType, number> {
  return { fact: 0, method: 0, norm: 0 };
}

/** text 为空时仍允许的结构过滤浏览（type/tags/channel/status；min* 单独不算） */
function hasStructuralFilter(query: MemoryQuery): boolean {
  return (
    query.type !== undefined ||
    (query.tags?.length ?? 0) > 0 ||
    query.channel !== undefined ||
    query.status !== undefined
  );
}

export class SqliteMemoryStore implements MemoryStore {
  readonly name = 'sqlite';

  private db: AgentDatabase;
  private embedding: EmbeddingProvider | null;
  private readonly candidateCap: number;
  private readonly vectorEngine: VectorEngineChoice;
  private readonly defaultMinSimilarity: number;
  private readonly similarityWeight: number;
  private readonly defaultMinKeywordScore: number;
  private vecReady = false;
  private embeddingBackfillScheduled = false;
  /** 回填是否在途（防止检索与后台批次并发重算同一批行） */
  private backfillRunning = false;
  /** 当前向量空间签名；null = 不启用签名过滤 */
  private readonly embeddingSignature: string | null;

  constructor(db: AgentDatabase, options?: SqliteMemoryStoreOptions) {
    this.db = db;
    this.embedding = options?.embeddingProvider ?? null;
    this.candidateCap = Math.max(20, options?.candidateCap ?? 500);
    this.vectorEngine = options?.vectorEngine ?? 'auto';
    this.defaultMinSimilarity = options?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    this.similarityWeight = options?.similarityWeight ?? DEFAULT_SIMILARITY_WEIGHT;
    this.defaultMinKeywordScore = options?.minKeywordScore ?? DEFAULT_MIN_KEYWORD_SCORE;
    this.embeddingSignature =
      options?.embeddingSignature !== undefined
        ? options.embeddingSignature
        : (this.embedding?.signature ?? null);

    if (this.embedding && this.vectorEngine !== 'js') {
      const dims = this.embedding.dimensions;
      if (dims > 0 && (db.sqliteVecEnabled || this.vectorEngine === 'sqlite-vec' || this.vectorEngine === 'auto')) {
        // sqlite-vec 已加载时建/验 vec 表；auto 且扩展未加载则保持 false，走 JS hybrid
        if (db.sqliteVecEnabled || this.vectorEngine === 'sqlite-vec') {
          this.vecReady = ensureMemoryVecTable(db.raw, dims);
          // require 档（vectorEngine='sqlite-vec'）覆盖建表失败：不许静默退回 JS（M4）
          if (!this.vecReady && this.vectorEngine === 'sqlite-vec') {
            throw new Error(
              "sqlite_vec_table_failed: memory_vec table creation failed under vectorEngine='sqlite-vec'",
            );
          }
        }
      }
    }

    // Agent 加载即推进向量重建（换模型后重启不依赖「第一次检索」）。
    // 只有确实存在待重嵌条目时才起后台任务，常规启动零成本。
    if (options?.autoBackfill !== false && this.embedding && this.pendingEmbeddingCount() > 0) {
      this.startBackgroundBackfill();
    }
  }

  /** 底层 AgentDatabase（覆盖表 / 治理扩展用） */
  get database(): AgentDatabase {
    return this.db;
  }

  /** 是否启用 sqlite-vec 检索 */
  get vectorEngineActive(): 'sqlite-vec' | 'js' | 'keyword' {
    if (!this.embedding) return 'keyword';
    return this.vecReady && this.vectorEngine !== 'js' ? 'sqlite-vec' : 'js';
  }

  async store(entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>): Promise<string> {
    const id = AgentDatabase.generateId('mem');
    const now = Date.now();

    let embeddingStr: string | null = null;
    if (this.embedding) {
      const text = this.embedText({
        type: entry.type,
        content: entry.content,
        tags: entry.tags ?? [],
        futureUse: entry.futureUse,
        anchors: entry.anchors ?? [],
        evidence: entry.evidence,
      });
      try {
        const vec = await this.embedding.embed(text);
        embeddingStr = serializeEmbedding(vec);
      } catch {
        // embedding 服务不可用：写入仍成功，检索退回关键词
        embeddingStr = null;
      }
    }

    this.db.raw.prepare(`
      INSERT INTO memories (
        id, type, content, source, confidence, importance,
        access_count, last_accessed_at, created_at, decay_factor, tags, embedding,
        status, channel, future_use, anchors, evidence, deleted, as_of, embedding_signature
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1.0, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id,
      mapLegacyType(entry.type),
      entry.content,
      entry.source,
      entry.confidence,
      entry.importance,
      now,
      now,
      JSON.stringify(entry.tags ?? []),
      embeddingStr,
      entry.status ?? 'active',
      entry.channel ?? 'model_inference',
      entry.futureUse ?? null,
      JSON.stringify(entry.anchors ?? []),
      entry.evidence ?? null,
      entry.asOf ?? null,
      // 只有真正拿到向量才记签名；embedding 失败时两者一并留空（该行走关键词路径）
      embeddingStr ? this.embeddingSignature : null,
    );

    if (embeddingStr && this.vecReady) {
      try {
        const vec = parseEmbedding(embeddingStr);
        if (vec) upsertMemoryVector(this.db.raw, id, vec);
      } catch {
        // vec 表异常不影响主写入
      }
    }

    this.embeddingBackfillScheduled = true;
    return id;
  }

  private embedText(parts: {
    type: string;
    content: string;
    tags: string[];
    futureUse?: string;
    anchors: string[];
    evidence?: string;
  }): string {
    const segments = [
      `[${parts.type}] ${parts.content}`,
      parts.tags.length ? `tags: ${parts.tags.join(',')}` : '',
      parts.futureUse ? `future_use: ${parts.futureUse}` : '',
      parts.anchors.length ? `anchors: ${parts.anchors.join(',')}` : '',
      parts.evidence ? `evidence: ${parts.evidence}` : '',
    ].filter(Boolean);
    return segments.join(' | ');
  }

  async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    const knobs = resolveRetrievalKnobs(
      query.minSimilarity,
      query.minKeywordScore,
      this.defaultMinSimilarity,
      this.defaultMinKeywordScore,
    );
    const q: MemoryQuery = { ...query, minSimilarity: knobs.minSimilarity, minKeywordScore: knobs.minKeywordScore };
    if (this.embedding && q.text?.trim()) {
      await this.maybeBackfillEmbeddings();
      // embedding 路径：仅在 embed 硬失败时降级关键词；过不了相关性地板则宁缺返回空
      try {
        if (this.vecReady && this.vectorEngine !== 'js') {
          const viaVec = await this.vecRetrieveAsync(q);
          if (viaVec.length > 0) return viaVec;
          // vec 命中为空：可能是 vec 表稀疏，继续 hybrid（仍用 embedding）；不走关键词填充
        }
        return await this.hybridRetrieve(q, { allowKeywordFallback: false });
      } catch {
        return this.structuredRetrieve(q);
      }
    }
    return this.structuredRetrieve(q);
  }

  private visibilityWhere(query: MemoryQuery): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    let sql = '';
    if (!query.includeDeleted) {
      sql += ' AND deleted = 0';
    }
    if (!query.includeShadow) {
      sql += ` AND (status IS NULL OR status != 'shadow')`;
    }
    if (query.status) {
      const list = Array.isArray(query.status) ? query.status : [query.status];
      sql += ` AND status IN (${list.map(() => '?').join(',')})`;
      params.push(...list);
    }
    return { sql, params };
  }

  /**
   * 检索侧的签名过滤（SQL 片段，作用于 `memories` 列）。
   *
   * 签名不符的向量与当前查询向量不在同一空间，余弦相似度没有意义——必须排除，
   * 否则会出现「换模型后每次检索都报 Vector dimensions must match」这类崩溃。
   *
   * @returns ` AND …` 片段（签名未启用时为空串）
   */
  private signatureFilterSql(): string {
    return this.embeddingSignature ? ' AND embedding_signature = ?' : '';
  }

  private signatureFilterParams(): unknown[] {
    return this.embeddingSignature ? [this.embeddingSignature] : [];
  }

  /** sqlite-vec KNN 检索（需先 embed 查询文本）；过相关性地板后按混合分排序 */
  private async vecRetrieveAsync(query: MemoryQuery): Promise<MemoryEntry[]> {
    if (!this.embedding || !this.vecReady) return [];
    let queryVec: number[];
    try {
      queryVec = await this.embedding.embed(query.text);
    } catch {
      return [];
    }

    const vis = this.visibilityWhere(query);
    const k = Math.max(query.limit ?? 10, 20);
    const minSim = query.minSimilarity ?? this.defaultMinSimilarity;
    const hits = searchMemoryVectors(
      this.db.raw,
      queryVec,
      k * 3,
      // vec 表本身不存签名；签名过滤落在 JOIN 的 memories 侧
      `${vis.sql}${this.signatureFilterSql()}`,
      [...vis.params, ...this.signatureFilterParams()],
    );
    if (hits.length === 0) return [];

    const scored: Array<{ e: MemoryEntry; similarity: number }> = [];
    for (const hit of hits) {
      // vec0 distance_metric=cosine → distance ∈ [0,2]，similarity = 1 - distance
      const similarity = 1 - hit.distance;
      if (similarity < minSim) continue;
      const row = this.db.raw.prepare('SELECT * FROM memories WHERE id = ?').get(hit.id) as any;
      if (!row) continue;
      const entry = this.rowToEntry(row);
      if (!this.passesApplyFilters(entry, query)) continue;
      scored.push({ e: entry, similarity });
      if (scored.length >= (query.limit ?? 10) * 2) break;
    }
    if (scored.length === 0) return [];
    return this.sortLimitScored(scored, query);
  }

  /**
   * 混合检索：SQL 预筛候选 → JS 余弦 topK → 相关性地板。
   * 命中不足 limit 时**不**用无关条目填充。
   * @param options.allowKeywordFallback - 仅 embed 硬失败场景允许；默认 false（宁缺）
   */
  private async hybridRetrieve(
    query: MemoryQuery,
    options?: { allowKeywordFallback?: boolean },
  ): Promise<MemoryEntry[]> {
    let queryVec: number[];
    try {
      queryVec = await this.embedding!.embed(query.text);
    } catch {
      // embedding 服务不可用：仅此时退回关键词
      return this.structuredRetrieve(query);
    }
    const vis = this.visibilityWhere(query);
    const cap = this.candidateCap;
    const minSim = query.minSimilarity ?? this.defaultMinSimilarity;

    let sql = `SELECT id, type, content, source, confidence, importance, access_count, last_accessed_at, created_at, decay_factor, tags, embedding, status, channel, future_use, anchors, evidence, deleted, deleted_at, deleted_by, deleted_reason, deleted_meta, reinforced_at, as_of
       FROM memories WHERE embedding IS NOT NULL${vis.sql}${this.signatureFilterSql()}`;
    const params: unknown[] = [...vis.params, ...this.signatureFilterParams()];

    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }
    if (query.channel) {
      const ch = Array.isArray(query.channel) ? query.channel : [query.channel];
      sql += ` AND channel IN (${ch.map(() => '?').join(',')})`;
      params.push(...ch);
    }
    // 优先最近访问，截断候选池；完整排序仍由向量相似度完成
    sql += ' ORDER BY last_accessed_at DESC LIMIT ?';
    params.push(cap);

    const rows = this.db.raw.prepare(sql).all(...(params as never[])) as any[];

    const candidates = rows
      .map(r => {
        const emb = parseEmbedding(r.embedding);
        if (!emb) return null;
        return { embedding: emb, item: this.rowToEntry(r) };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    // searchTopK 的 maxDistance = 1 - minSimilarity（cosine distance）
    const vectorResults = searchTopK(
      queryVec,
      candidates,
      Math.min(candidates.length, Math.max(50, (query.limit ?? 10) * 5)),
      1 - minSim,
    );
    const scored = vectorResults
      .map(r => ({ e: r.item, similarity: 1 - r.distance }))
      .filter(s => s.similarity >= minSim && this.passesApplyFilters(s.e, query));

    // 有相关命中则只返回这些（宁缺毋滥，不回填关键词噪声）
    if (scored.length > 0) {
      return this.sortLimitScored(scored, query);
    }
    // 地板之下零命中：默认不降级关键词，避免「向量说无关、关键词硬填」
    if (options?.allowKeywordFallback) {
      return this.structuredRetrieve(query);
    }
    return [];
  }

  private structuredRetrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    let sql = 'SELECT * FROM memories WHERE 1=1';
    const params: any[] = [];

    const vis = this.visibilityWhere(query);
    sql += vis.sql;
    params.push(...vis.params);

    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    if (query.channel) {
      const ch = Array.isArray(query.channel) ? query.channel : [query.channel];
      sql += ` AND channel IN (${ch.map(() => '?').join(',')})`;
      params.push(...ch);
    }

    if (query.minConfidence !== undefined) {
      sql += ' AND confidence >= ?';
      params.push(query.minConfidence);
    }

    if (query.minImportance !== undefined) {
      sql += ' AND importance >= ?';
      params.push(query.minImportance);
    }

    const tokens = tokenizeKeywordDetail(query.text);
    const like = buildKeywordLikeSql(tokens.all);
    if (like.sql) {
      sql += like.sql;
      params.push(...like.params);
    }

    const rows = this.db.raw.prepare(sql).all(...(params as never[])) as any[];
    const entries = rows.map(r => this.rowToEntry(r));
    const filtered = this.filterByTags(entries, query);

    const minKeyword = query.minKeywordScore ?? this.defaultMinKeywordScore;
    if (tokens.all.length > 0) {
      const scored = filtered
        .map((e) => ({
          e,
          score: scoreKeywordFields(
            {
              content: e.content,
              tags: e.tags,
              futureUse: e.futureUse,
              anchors: e.anchors,
              evidence: e.evidence,
            },
            tokens,
          ),
        }))
        .filter((s) => s.score >= minKeyword);

      scored.sort((a, b) => {
        const rankA = a.score * 10 + qualityScore(a.e);
        const rankB = b.score * 10 + qualityScore(b.e);
        return rankB - rankA;
      });

      const limit = query.limit ?? 10;
      const results = scored.slice(0, limit).map((s) => s.e);
      if (query.updateAccess !== false) {
        const now = Date.now();
        const stmt = this.db.raw.prepare(
          'UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?'
        );
        for (const entry of results) {
          stmt.run(now, entry.id);
        }
      }
      return Promise.resolve(results);
    }

    // 无检索词：仅结构过滤时浏览；禁止空 query 扫全库
    if (!hasStructuralFilter(query)) return Promise.resolve([]);
    filtered.sort((a, b) => qualityScore(b) - qualityScore(a));
    return Promise.resolve(this.limitAndUpdate(filtered, query));
  }

  /** 单条结构化过滤（向量路径逐条判断） */
  private passesApplyFilters(entry: MemoryEntry, query: MemoryQuery): boolean {
    return this.applyFilters([entry], query).length > 0;
  }

  /** 与 InMemory 对齐：tags 交集过滤 */
  private filterByTags(entries: MemoryEntry[], query: MemoryQuery): MemoryEntry[] {
    if (!query.tags || query.tags.length === 0) return entries;
    return entries.filter((e) => query.tags!.some((t) => e.tags?.includes(t)));
  }

  private applyFilters(entries: MemoryEntry[], query: MemoryQuery): MemoryEntry[] {
    let results = entries;

    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      results = results.filter(e => types.includes(e.type));
    }

    if (query.channel) {
      const ch = Array.isArray(query.channel) ? query.channel : [query.channel];
      results = results.filter((e) => (e.channel ? ch.includes(e.channel) : false));
    }

    if (query.minConfidence !== undefined) {
      results = results.filter(e => e.confidence >= query.minConfidence!);
    }

    if (query.minImportance !== undefined) {
      results = results.filter(e => e.importance >= query.minImportance!);
    }

    return this.filterByTags(results, query);
  }

  /** 向量命中：similarity 参与排序（禁止仅按 quality 顶掉贴题条目） */
  private sortLimitScored(
    scored: Array<{ e: MemoryEntry; similarity: number }>,
    query: MemoryQuery,
  ): MemoryEntry[] {
    const w = this.similarityWeight;
    scored.sort((a, b) => {
      const rankA = blendRank(a.similarity, qualityScore(a.e), w);
      const rankB = blendRank(b.similarity, qualityScore(b.e), w);
      return rankB - rankA;
    });
    return this.limitAndUpdate(scored.map((s) => s.e), query);
  }

  private limitAndUpdate(entries: MemoryEntry[], query: MemoryQuery): MemoryEntry[] {
    const limit = query.limit ?? 10;
    const results = entries.slice(0, limit);

    if (query.updateAccess !== false) {
      const now = Date.now();
      const stmt = this.db.raw.prepare(
        'UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?'
      );
      for (const entry of results) {
        stmt.run(now, entry.id);
      }
    }

    return results;
  }

  /**
   * 回填缺失 embedding（历史数据 / 关键词时代写入）。
   *
   * @param limit - 单次最大处理条数（默认 200）
   * @returns 成功回填条数
   */
  async backfillEmbeddings(limit = 200): Promise<number> {
    if (!this.embedding) return 0;

    const rows = this.db.raw.prepare(`
      SELECT id, type, content, tags, future_use, anchors, evidence, embedding
      FROM memories
      WHERE deleted = 0 AND (${this.backfillPredicate()})
      ORDER BY last_accessed_at DESC
      LIMIT ?
    `).all(...(this.backfillParams(limit) as never[])) as any[];

    let ok = 0;
    for (const row of rows) {
      try {
        const text = this.embedText({
          type: row.type,
          content: row.content,
          tags: row.tags ? JSON.parse(row.tags) : [],
          futureUse: row.future_use ?? undefined,
          anchors: row.anchors ? JSON.parse(row.anchors) : [],
          evidence: row.evidence ?? undefined,
        });
        const vec = await this.embedding.embed(text);
        const serialized = serializeEmbedding(vec);
        this.db.raw.prepare('UPDATE memories SET embedding = ?, embedding_signature = ? WHERE id = ?').run(
          serialized,
          this.embeddingSignature,
          row.id,
        );
        if (this.vecReady) upsertMemoryVector(this.db.raw, row.id, vec);
        ok++;
      } catch {
        // 单条失败不中断批量
      }
    }
    return ok;
  }

  /**
   * 回填选择条件：缺向量，或向量产自另一个空间（换模型/端点/维度）。
   *
   * 签名未启用（null）时只选缺向量的行——无法判定空间时保持旧行为，
   * 宁可少重建也不把仍然可比的向量当垃圾重算。
   */
  private backfillPredicate(): string {
    const base = "embedding IS NULL OR embedding = ''";
    if (!this.embeddingSignature) return base;
    return `${base} OR embedding_signature IS NULL OR embedding_signature <> ?`;
  }

  /**
   * 回填参数：签名启用时补一个占位符（作用于 backfillPredicate 的 `<> ?`）。
   */
  private backfillParams(limit: number): unknown[] {
    return this.embeddingSignature ? [this.embeddingSignature, limit] : [limit];
  }

  /**
   * 推进向量重建（分批，过程中让出事件循环）。
   *
   * 换模型后待重嵌条目可能远多于单批上限；只有「跑一批就收工」会让超出部分
   * 永远不合格（旧实现正是如此：置 false 后不再续排）。这里跑完一批继续下一批，
   * 直到无进展（全部失败时立刻停，避免热循环）或达到本次批次上限。
   *
   * @param maxBatches - 本次最多推进几批（检索路径取 1 以免拖慢会话）
   * @returns 实际成功回填条数
   */
  private async runBackfillLoop(maxBatches: number): Promise<number> {
    if (!this.embedding || this.backfillRunning) return 0;
    this.backfillRunning = true;
    let total = 0;
    try {
      for (let i = 0; i < maxBatches; i++) {
        const filled = await this.backfillEmbeddings(MemoryBackfill.BATCH_SIZE);
        total += filled;
        // 无进展（例如全部失败）立即停：否则 remaining>0 会变成死循环
        if (filled === 0) break;
      }
      // 还有缺口就留给下一次（检索续排 / 下次加载），不在这里无限跑
      this.embeddingBackfillScheduled = this.pendingEmbeddingCount() > 0;
    } catch {
      // 回填失败不影响主流程；保留 scheduled 以便下次续排
      this.embeddingBackfillScheduled = true;
    } finally {
      this.backfillRunning = false;
    }
    return total;
  }

  /** 检索路径：只推进一批，避免把一次会话拖成长时间的 embedding 批量调用 */
  private async maybeBackfillEmbeddings(): Promise<void> {
    if (!this.embedding) return;
    // 不只看一次性标志位：只要仍有积压，每次检索都继续推进下一批，
    // 否则超过单批上限的条目会永远停在第 100 条之后。
    if (!this.embeddingBackfillScheduled && this.pendingEmbeddingCount() === 0) return;
    await this.runBackfillLoop(1);
  }

  /**
   * Agent 加载即开始重建（不阻塞加载）。
   *
   * 由构造器调用：换模型后重启，agent 一被装配就推进，不必等第一次检索。
   * 后台批次上限高于检索路径，因为它不占会话时延。
   */
  startBackgroundBackfill(): void {
    if (!this.embedding) return;
    this.embeddingBackfillScheduled = true;
    void this.runBackfillLoop(MemoryBackfill.MAX_BATCHES_BG);
  }

  /**
   * 等待在途回填结束（测试与优雅停机用）。
   *
   * 没有任何回填在跑时立即 resolve。
   */
  async whenBackfillSettled(): Promise<void> {
    while (this.backfillRunning) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * 待重嵌条数（签名不符或缺向量）。
   *
   * 换模型后 UI 需要告诉用户「有多少条目要重建」——这是可展示的事实，
   * 不是内部估算：条件与 backfillPredicate 同源。
   */
  pendingEmbeddingCount(): number {
    if (!this.embedding) return 0;
    const params = this.embeddingSignature ? [this.embeddingSignature] : [];
    const row = this.db.raw
      .prepare(`SELECT COUNT(*) AS n FROM memories WHERE deleted = 0 AND (${this.backfillPredicate()})`)
      .get(...(params as never[])) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const row = this.db.raw.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    return row ? this.rowToEntry(row) : null;
  }

  async update(id: string, patch: Partial<MemoryEntry>): Promise<void> {
    const fields: string[] = [];
    const params: any[] = [];
    const set = (col: string, value: unknown) => {
      fields.push(`${col} = ?`);
      params.push(value);
    };

    if (patch.type !== undefined) set('type', patch.type);
    if (patch.content !== undefined) set('content', patch.content);
    if (patch.source !== undefined) set('source', patch.source);
    if (patch.confidence !== undefined) set('confidence', patch.confidence);
    if (patch.importance !== undefined) set('importance', patch.importance);
    if (patch.accessCount !== undefined) set('access_count', patch.accessCount);
    if (patch.lastAccessedAt !== undefined) set('last_accessed_at', patch.lastAccessedAt);
    if (patch.createdAt !== undefined) set('created_at', patch.createdAt);
    if (patch.decayFactor !== undefined) set('decay_factor', patch.decayFactor);
    if (patch.tags !== undefined) set('tags', JSON.stringify(patch.tags));
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.channel !== undefined) set('channel', patch.channel);
    if (patch.futureUse !== undefined) set('future_use', patch.futureUse);
    if (patch.anchors !== undefined) set('anchors', JSON.stringify(patch.anchors));
    if (patch.evidence !== undefined) set('evidence', patch.evidence);
    if (patch.reinforcedAt !== undefined) set('reinforced_at', patch.reinforcedAt);
    if (patch.asOf !== undefined) set('as_of', patch.asOf);
    if (patch.deleted !== undefined) set('deleted', patch.deleted ? 1 : 0);
    if (patch.deletedAt !== undefined) set('deleted_at', patch.deletedAt);
    if (patch.deletedBy !== undefined) set('deleted_by', patch.deletedBy);
    if (patch.deletedReason !== undefined) set('deleted_reason', patch.deletedReason);
    if (patch.deletedMeta !== undefined) {
      set('deleted_meta', patch.deletedMeta ? JSON.stringify(patch.deletedMeta) : null);
    }

    if (fields.length === 0) return;

    params.push(id);
    this.db.raw.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    const contentish =
      patch.content !== undefined ||
      patch.tags !== undefined ||
      patch.futureUse !== undefined ||
      patch.anchors !== undefined ||
      patch.evidence !== undefined ||
      patch.type !== undefined;
    if (this.embedding && contentish) {
      this.embeddingBackfillScheduled = true;
      // 内容变更后强制重算该条
      try {
        const row = this.db.raw.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
        if (row) {
          const text = this.embedText({
            type: row.type,
            content: row.content,
            tags: row.tags ? JSON.parse(row.tags) : [],
            futureUse: row.future_use ?? undefined,
            anchors: row.anchors ? JSON.parse(row.anchors) : [],
            evidence: row.evidence ?? undefined,
          });
          const vec = await this.embedding.embed(text);
          this.db.raw.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(serializeEmbedding(vec), id);
          if (this.vecReady) upsertMemoryVector(this.db.raw, id, vec);
        }
      } catch {
        // 重算失败保留旧向量
      }
    }
  }

  async delete(id: string): Promise<void> {
    this.db.raw.prepare('DELETE FROM memories WHERE id = ?').run(id);
    deleteMemoryVector(this.db.raw, id);
  }

  async softDelete(
    id: string,
    meta: { by: string; reason: SoftDeleteReason | string; winnerId?: string },
  ): Promise<void> {
    this.db.raw.prepare(`
      UPDATE memories
      SET deleted = 1, deleted_at = ?, deleted_by = ?, deleted_reason = ?, deleted_meta = ?
      WHERE id = ?
    `).run(
      Date.now(),
      meta.by,
      meta.reason,
      JSON.stringify(meta.winnerId ? { winnerId: meta.winnerId } : {}),
      id,
    );
  }

  async undelete(id: string): Promise<void> {
    this.db.raw.prepare(`
      UPDATE memories
      SET deleted = 0, deleted_at = NULL, deleted_by = NULL, deleted_reason = NULL, deleted_meta = NULL
      WHERE id = ?
    `).run(id);
  }

  async importEntry(entry: MemoryEntry): Promise<void> {
    this.db.raw.prepare(
      `INSERT OR REPLACE INTO memories (
        id, type, content, source, confidence, importance,
        access_count, last_accessed_at, created_at, decay_factor, tags, embedding,
        status, channel, future_use, anchors, evidence, deleted, as_of
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      mapLegacyType(entry.type),
      entry.content,
      entry.source,
      entry.confidence,
      entry.importance,
      entry.accessCount ?? 0,
      entry.lastAccessedAt ?? Date.now(),
      entry.createdAt ?? Date.now(),
      entry.decayFactor ?? 1,
      JSON.stringify(entry.tags ?? []),
      null,
      entry.status ?? 'active',
      entry.channel ?? 'model_inference',
      entry.futureUse ?? null,
      JSON.stringify(entry.anchors ?? []),
      entry.evidence ?? null,
      entry.deleted ? 1 : 0,
      entry.asOf ?? null,
    );
  }

  async listForGovern(filter?: { includeDeleted?: boolean }): Promise<MemoryEntry[]> {
    const sql = filter?.includeDeleted
      ? 'SELECT * FROM memories'
      : 'SELECT * FROM memories WHERE deleted = 0';
    const rows = this.db.raw.prepare(sql).all() as any[];
    return rows.map((r) => this.rowToEntry(r));
  }

  async decay(options?: {
    typeParams?: Partial<Record<MemoryType, { idleDays?: number; factor?: number; min?: number }>>;
  }): Promise<number> {
    const { resolveDecayParams } = await import('../decay-policy.js');
    const params = resolveDecayParams(options?.typeParams);
    const now = Date.now();
    let total = 0;
    for (const type of ['fact', 'method', 'norm'] as MemoryType[]) {
      const p = params[type];
      const cutoff = now - p.idleDays * 86_400_000;
      const result = this.db.raw.prepare(`
        UPDATE memories
        SET decay_factor = MAX(?, decay_factor * ?)
        WHERE type = ? AND last_accessed_at < ? AND decay_factor > ? AND deleted = 0
      `).run(p.min, p.factor, type, cutoff, p.min);
      total += Number(result.changes);
    }
    return total;
  }

  async stats(): Promise<MemoryStats> {
    const total = (this.db.raw.prepare('SELECT COUNT(*) as count FROM memories WHERE deleted = 0').get() as { count: number }).count;
    const deleted = (this.db.raw.prepare('SELECT COUNT(*) as count FROM memories WHERE deleted = 1').get() as { count: number }).count;
    const shadow = (this.db.raw.prepare(`SELECT COUNT(*) as count FROM memories WHERE deleted = 0 AND status = 'shadow'`).get() as { count: number }).count;

    const typeRows = this.db.raw.prepare(
      'SELECT type, COUNT(*) as count FROM memories WHERE deleted = 0 GROUP BY type'
    ).all() as Array<{ type: string; count: number }>;

    const byType = emptyTypes();
    for (const row of typeRows) {
      if ((MEMORY_TYPES as readonly string[]).includes(row.type)) {
        byType[row.type as MemoryType] = row.count;
      }
    }

    const avgRow = this.db.raw.prepare(
      'SELECT AVG(confidence) as avgConf, AVG(importance) as avgImp FROM memories WHERE deleted = 0'
    ).get() as { avgConf: number | null; avgImp: number | null };

    return {
      totalEntries: total,
      byType,
      avgConfidence: avgRow.avgConf ?? 0,
      avgImportance: avgRow.avgImp ?? 0,
      deletedEntries: deleted,
      shadowEntries: shadow,
    };
  }

  private rowToEntry(row: any): MemoryEntry {
    return {
      id: row.id,
      type: mapLegacyType(String(row.type ?? 'fact')) as MemoryType,
      content: row.content,
      source: row.source,
      confidence: row.confidence,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
      createdAt: row.created_at,
      decayFactor: row.decay_factor,
      tags: row.tags ? JSON.parse(row.tags) : [],
      status: (row.status as MemoryStatus) ?? 'active',
      channel: (row.channel as MemoryChannel) ?? 'model_inference',
      futureUse: row.future_use ?? undefined,
      anchors: row.anchors ? JSON.parse(row.anchors) : [],
      evidence: row.evidence ?? undefined,
      reinforcedAt: row.reinforced_at ?? undefined,
      asOf: row.as_of ?? undefined,
      deleted: !!row.deleted,
      deletedAt: row.deleted_at ?? undefined,
      deletedBy: row.deleted_by ?? undefined,
      deletedReason: row.deleted_reason ?? undefined,
      deletedMeta: row.deleted_meta ? JSON.parse(row.deleted_meta) : undefined,
    };
  }
}
