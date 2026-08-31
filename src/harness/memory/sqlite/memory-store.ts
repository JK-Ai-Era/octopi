/**
 * SqliteMemoryStore — SQLite 记忆存储
 *
 * 基于 AgentDatabase 的记忆存储实现。
 * 支持混合检索：向量检索（可选）+ 关键词检索（降级方案）。
 *
 * @module
 */

import type {
  MemoryStore,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryType,
} from '../types.js';
import { AgentDatabase } from './agent-db.js';
import type { EmbeddingProvider } from './embedding.js';
import { searchTopK, parseEmbedding, serializeEmbedding } from './vector-search.js';

export interface SqliteMemoryStoreOptions {
  /** Embedding 提供者（可选，未配置则退化为关键词检索） */
  embeddingProvider?: EmbeddingProvider | null;
}

export class SqliteMemoryStore implements MemoryStore {
  readonly name = 'sqlite';

  private db: AgentDatabase;
  private embedding: EmbeddingProvider | null;

  constructor(db: AgentDatabase, options?: SqliteMemoryStoreOptions) {
    this.db = db;
    this.embedding = options?.embeddingProvider ?? null;
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
      INSERT INTO memories (id, type, content, source, confidence, importance, access_count, last_accessed_at, created_at, decay_factor, tags, embedding)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1.0, ?, ?)
    `).run(
      id,
      entry.type,
      entry.content,
      entry.source,
      entry.confidence,
      entry.importance,
      now,
      now,
      JSON.stringify(entry.tags),
      embeddingStr,
    );

    return id;
  }

  async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    // 策略一：有 embedding 且有文本查询 → 混合检索
    if (this.embedding && query.text.trim()) {
      return this.hybridRetrieve(query);
    }

    // 策略二：无 embedding 或无文本 → 纯结构化查询
    return this.structuredRetrieve(query);
  }

  /**
   * 混合检索：向量召回 + 结构化过滤 + 降级
   */
  private async hybridRetrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    const queryVec = await this.embedding!.embed(query.text);

    // 从数据库加载所有记忆的 embedding
    const rows = this.db.raw.prepare(
      'SELECT id, type, content, source, confidence, importance, access_count, last_accessed_at, created_at, decay_factor, tags, embedding FROM memories WHERE embedding IS NOT NULL'
    ).all() as any[];

    const candidates = rows
      .map(r => {
        const emb = parseEmbedding(r.embedding);
        if (!emb) return null;
        return { embedding: emb, item: this.rowToEntry(r) };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    // 向量召回
    let vectorResults = searchTopK(queryVec, candidates, 50);

    // 结构化过滤
    let filtered = this.applyFilters(
      vectorResults.map(r => r.item),
      query,
    );

    // 降级：结果不足时扩大召回
    if (filtered.length < (query.limit ?? 10)) {
      vectorResults = searchTopK(queryVec, candidates, 200);
      filtered = this.applyFilters(
        vectorResults.map(r => r.item),
        query,
      );
    }

    // 仍不足：退化为结构化查询
    if (filtered.length === 0) {
      return this.structuredRetrieve(query);
    }

    // 排序 + 限制
    return this.sortAndLimit(filtered, query);
  }

  /**
   * 纯结构化查询
   */
  private async structuredRetrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    let sql = 'SELECT * FROM memories WHERE 1=1';
    const params: any[] = [];

    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }

    if (query.minConfidence !== undefined) {
      sql += ' AND confidence >= ?';
      params.push(query.minConfidence);
    }

    if (query.minImportance !== undefined) {
      sql += ' AND importance >= ?';
      params.push(query.minImportance);
    }

    // 关键词匹配
    if (query.text.trim()) {
      const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        const likeClauses = words.map(() => 'LOWER(content) LIKE ?');
        sql += ` AND (${likeClauses.join(' OR ')})`;
        params.push(...words.map(w => `%${w}%`));
      }
    }

    const rows = this.db.raw.prepare(sql).all(...params) as any[];
    let results = rows.map(r => this.rowToEntry(r));

    return this.sortAndLimit(results, query);
  }

  /**
   * 应用结构化过滤条件
   */
  private applyFilters(entries: MemoryEntry[], query: MemoryQuery): MemoryEntry[] {
    let results = entries;

    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      results = results.filter(e => types.includes(e.type));
    }

    if (query.minConfidence !== undefined) {
      results = results.filter(e => e.confidence >= query.minConfidence!);
    }

    if (query.minImportance !== undefined) {
      results = results.filter(e => e.importance >= query.minImportance!);
    }

    return results;
  }

  /**
   * 排序 + 限制数量
   */
  private sortAndLimit(entries: MemoryEntry[], query: MemoryQuery): MemoryEntry[] {
    entries.sort((a, b) => {
      const scoreA = a.importance * a.confidence * a.decayFactor;
      const scoreB = b.importance * b.confidence * b.decayFactor;
      return scoreB - scoreA;
    });

    const limit = query.limit ?? 10;
    const results = entries.slice(0, limit);

    // 更新访问计数
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

    if (fields.length === 0) return;

    params.push(id);
    this.db.raw.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  async delete(id: string): Promise<void> {
    this.db.raw.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  async decay(): Promise<number> {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const result = this.db.raw.prepare(`
      UPDATE memories
      SET decay_factor = MAX(0.1, decay_factor * 0.95)
      WHERE last_accessed_at < ? AND decay_factor > 0.1
    `).run(thirtyDaysAgo);

    return result.changes;
  }

  async stats(): Promise<MemoryStats> {
    const total = (this.db.raw.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;

    const typeRows = this.db.raw.prepare(
      'SELECT type, COUNT(*) as count FROM memories GROUP BY type'
    ).all() as Array<{ type: string; count: number }>;

    const byType: Record<MemoryType, number> = {
      preference: 0, decision: 0, lesson: 0, discovery: 0, context: 0, relationship: 0,
    };
    for (const row of typeRows) {
      if (row.type in byType) {
        byType[row.type as MemoryType] = row.count;
      }
    }

    const avgRow = this.db.raw.prepare(
      'SELECT AVG(confidence) as avgConf, AVG(importance) as avgImp FROM memories'
    ).get() as { avgConf: number | null; avgImp: number | null };

    return {
      totalEntries: total,
      byType,
      avgConfidence: avgRow.avgConf ?? 0,
      avgImportance: avgRow.avgImp ?? 0,
    };
  }

  /**
   * 数据库行 → MemoryEntry
   */
  private rowToEntry(row: any): MemoryEntry {
    return {
      id: row.id,
      type: row.type as MemoryType,
      content: row.content,
      source: row.source,
      confidence: row.confidence,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
      createdAt: row.created_at,
      decayFactor: row.decay_factor,
      tags: JSON.parse(row.tags),
    };
  }
}
