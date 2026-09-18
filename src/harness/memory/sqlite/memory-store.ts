/**
 * SqliteMemoryStore — SQLite 记忆存储
 *
 * 混合检索 + shadow/软删过滤 + 治理管理面。
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

export interface SqliteMemoryStoreOptions {
  embeddingProvider?: EmbeddingProvider | null;
  /** 向量检索 SQL 候选上限（默认 500） */
  candidateCap?: number;
}

function emptyTypes(): Record<MemoryType, number> {
  return { fact: 0, method: 0, norm: 0 };
}

export class SqliteMemoryStore implements MemoryStore {
  readonly name = 'sqlite';

  private db: AgentDatabase;
  private embedding: EmbeddingProvider | null;
  private readonly candidateCap: number;

  constructor(db: AgentDatabase, options?: SqliteMemoryStoreOptions) {
    this.db = db;
    this.embedding = options?.embeddingProvider ?? null;
    this.candidateCap = Math.max(20, options?.candidateCap ?? 500);
  }

  async store(entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>): Promise<string> {
    const id = AgentDatabase.generateId('mem');
    const now = Date.now();

    let embeddingStr: string | null = null;
    if (this.embedding) {
      const text = `[${entry.type}] ${entry.content} tags: ${entry.tags.join(',')}`;
      const vec = await this.embedding.embed(text);
      embeddingStr = serializeEmbedding(vec);
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

    return id;
  }

  async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    if (this.embedding && query.text.trim()) {
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

  /**
   * 混合检索：SQL 预筛候选（避免全表载入 embedding）→ JS 余弦 topK
   * candidateCap 默认 500，可通过 SqliteMemoryStoreOptions 覆盖。
   */
  private async hybridRetrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    const queryVec = await this.embedding!.embed(query.text);
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

    const rows = this.db.raw.prepare(sql).all(...params) as any[];

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

    if (query.text.trim()) {
      const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        const likeClauses = words.map(() => 'LOWER(content) LIKE ?');
        sql += ` AND (${likeClauses.join(' OR ')})`;
        params.push(...words.map(w => `%${w}%`));
      }
    }

    const rows = this.db.raw.prepare(sql).all(...params) as any[];
    return Promise.resolve(this.sortAndLimit(this.filterByTags(rows.map(r => this.rowToEntry(r)), query), query));
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

  async get(id: string): Promise<MemoryEntry | null> {
    const row = this.db.raw.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    return row ? this.rowToEntry(row) : null;
  }

  async update(id: string, patch: Partial<MemoryEntry>): Promise<void> {
    const fields: string[] = [];
    const params: any[] = [];

    if (patch.type !== undefined) { fields.push('type = ?'); params.push(patch.type); }
    if (patch.content !== undefined) { fields.push('content = ?'); params.push(patch.content); }
    if (patch.confidence !== undefined) { fields.push('confidence = ?'); params.push(patch.confidence); }
    if (patch.importance !== undefined) { fields.push('importance = ?'); params.push(patch.importance); }
    if (patch.tags !== undefined) { fields.push('tags = ?'); params.push(JSON.stringify(patch.tags)); }
    if (patch.decayFactor !== undefined) { fields.push('decay_factor = ?'); params.push(patch.decayFactor); }
    if (patch.status !== undefined) { fields.push('status = ?'); params.push(patch.status); }
    if (patch.channel !== undefined) { fields.push('channel = ?'); params.push(patch.channel); }
    if (patch.futureUse !== undefined) { fields.push('future_use = ?'); params.push(patch.futureUse); }
    if (patch.reinforcedAt !== undefined) { fields.push('reinforced_at = ?'); params.push(patch.reinforcedAt); }

    if (fields.length === 0) return;

    params.push(id);
    this.db.raw.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  async delete(id: string): Promise<void> {
    this.db.raw.prepare('DELETE FROM memories WHERE id = ?').run(id);
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

  async decay(): Promise<number> {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const result = this.db.raw.prepare(`
      UPDATE memories
      SET decay_factor = MAX(0.1, decay_factor * 0.95)
      WHERE last_accessed_at < ? AND decay_factor > 0.1 AND deleted = 0
    `).run(thirtyDaysAgo);

    return result.changes;
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
