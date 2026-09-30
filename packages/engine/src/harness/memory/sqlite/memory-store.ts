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
  tokenizeKeywordQuery,
} from './keyword-search.js';
import {
  deleteMemoryVector,
  ensureMemoryVecTable,
  searchMemoryVectors,
  upsertMemoryVector,
} from './sqlite-vec.js';
import type { VectorEngineChoice } from '../../../config.js';

export interface SqliteMemoryStoreOptions {
  embeddingProvider?: EmbeddingProvider | null;
  /** 向量检索 SQL 候选上限（默认 500） */
  candidateCap?: number;
  /** 向量引擎；auto=优先 sqlite-vec（需 db 已 load 扩展），否则 JS */
  vectorEngine?: VectorEngineChoice;
}

function emptyTypes(): Record<MemoryType, number> {
  return { fact: 0, method: 0, norm: 0 };
}

export class SqliteMemoryStore implements MemoryStore {
  readonly name = 'sqlite';

  private db: AgentDatabase;
  private embedding: EmbeddingProvider | null;
  private readonly candidateCap: number;
  private readonly vectorEngine: VectorEngineChoice;
  private vecReady = false;
  private embeddingBackfillScheduled = false;

  constructor(db: AgentDatabase, options?: SqliteMemoryStoreOptions) {
    this.db = db;
    this.embedding = options?.embeddingProvider ?? null;
    this.candidateCap = Math.max(20, options?.candidateCap ?? 500);
    this.vectorEngine = options?.vectorEngine ?? 'auto';

    if (this.embedding && this.vectorEngine !== 'js') {
      const dims = this.embedding.dimensions;
      if (dims > 0 && (db.sqliteVecEnabled || this.vectorEngine === 'sqlite-vec' || this.vectorEngine === 'auto')) {
        // sqlite-vec 已加载时建/验 vec 表；auto 且扩展未加载则保持 false，走 JS hybrid
        if (db.sqliteVecEnabled || this.vectorEngine === 'sqlite-vec') {
          this.vecReady = ensureMemoryVecTable(db.raw, dims);
        }
      }
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
        status, channel, future_use, anchors, evidence, deleted
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1.0, ?, ?, ?, ?, ?, ?, ?, 0)
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
    if (this.embedding && query.text.trim()) {
      await this.maybeBackfillEmbeddings();
      if (this.vecReady && this.vectorEngine !== 'js') {
        const viaVec = await this.vecRetrieveAsync(query);
        if (viaVec.length > 0) return viaVec;
      }
      return this.hybridRetrieve(query);
    }
    return this.structuredRetrieve(query);
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

  /** sqlite-vec KNN 检索（需先 embed 查询文本） */
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
    const hits = searchMemoryVectors(this.db.raw, queryVec, k * 3, vis.sql, vis.params);
    if (hits.length === 0) return [];

    const entries: MemoryEntry[] = [];
    for (const hit of hits) {
      const row = this.db.raw.prepare('SELECT * FROM memories WHERE id = ?').get(hit.id) as any;
      if (!row) continue;
      entries.push(this.rowToEntry(row));
      if (entries.length >= k) break;
    }

    const filtered = this.applyFilters(entries, query);
    if (filtered.length === 0) return [];
    return this.sortAndLimit(filtered, query);
  }

  /**
   * 混合检索：SQL 预筛候选（避免全表载入 embedding）→ JS 余弦 topK
   * candidateCap 默认 500，可通过 SqliteMemoryStoreOptions 覆盖。
   */
  private async hybridRetrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    let queryVec: number[];
    try {
      queryVec = await this.embedding!.embed(query.text);
    } catch {
      // embedding 服务不可用：退回关键词（与 vecRetrieve / store 写入路径对称）
      return this.structuredRetrieve(query);
    }
    const vis = this.visibilityWhere(query);
    const cap = this.candidateCap;

    let sql = `SELECT id, type, content, source, confidence, importance, access_count, last_accessed_at, created_at, decay_factor, tags, embedding, status, channel, future_use, anchors, evidence, deleted, deleted_at, deleted_by, deleted_reason, deleted_meta, reinforced_at
       FROM memories WHERE embedding IS NOT NULL${vis.sql}`;
    const params: unknown[] = [...vis.params];

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

    const vectorResults = searchTopK(queryVec, candidates, Math.min(candidates.length, Math.max(50, (query.limit ?? 10) * 5)));
    let filtered = this.applyFilters(vectorResults.map(r => r.item), query);

    if (filtered.length < (query.limit ?? 10) && candidates.length < cap) {
      // 候选池未打满仍不足 → 结构化降级
      return this.structuredRetrieve(query);
    }
    if (filtered.length === 0) {
      return this.structuredRetrieve(query);
    }
    return this.sortAndLimit(filtered, query);
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

    const tokens = tokenizeKeywordQuery(query.text);
    const like = buildKeywordLikeSql(tokens);
    if (like.sql) {
      sql += like.sql;
      params.push(...like.params);
    }

    const rows = this.db.raw.prepare(sql).all(...(params as never[])) as any[];
    const entries = rows.map(r => this.rowToEntry(r));
    const filtered = this.filterByTags(entries, query);

    if (tokens.length > 0) {
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
        .filter((s) => s.score > 0);

      scored.sort((a, b) => {
        const rankA = a.score * 10 + a.e.importance * a.e.confidence * a.e.decayFactor;
        const rankB = b.score * 10 + b.e.importance * b.e.confidence * b.e.decayFactor;
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

    return Promise.resolve(this.sortAndLimit(filtered, query));
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

  private sortAndLimit(entries: MemoryEntry[], query: MemoryQuery): MemoryEntry[] {
    entries.sort((a, b) => {
      const scoreA = a.importance * a.confidence * a.decayFactor;
      const scoreB = b.importance * b.confidence * b.decayFactor;
      return scoreB - scoreA;
    });

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
      WHERE deleted = 0 AND (embedding IS NULL OR embedding = '')
      ORDER BY last_accessed_at DESC
      LIMIT ?
    `).all(limit) as any[];

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
        this.db.raw.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(serialized, row.id);
        if (this.vecReady) upsertMemoryVector(this.db.raw, row.id, vec);
        ok++;
      } catch {
        // 单条失败不中断批量
      }
    }
    return ok;
  }

  private async maybeBackfillEmbeddings(): Promise<void> {
    if (!this.embedding || !this.embeddingBackfillScheduled) return;
    this.embeddingBackfillScheduled = false;
    try {
      await this.backfillEmbeddings(100);
    } catch {
      // 回填失败不影响本次检索
    }
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
      deleted: !!row.deleted,
      deletedAt: row.deleted_at ?? undefined,
      deletedBy: row.deleted_by ?? undefined,
      deletedReason: row.deleted_reason ?? undefined,
      deletedMeta: row.deleted_meta ? JSON.parse(row.deleted_meta) : undefined,
    };
  }
}
