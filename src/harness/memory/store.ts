/**
 * InMemoryMemoryStore — 内存记忆存储
 *
 * 基于内存的记忆存储，支持关键词匹配检索。
 * 生产环境可替换为向量数据库后端。
 */

import { randomUUID } from 'node:crypto';
import type {
  MemoryStore,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryType,
} from './types.js';

export class InMemoryMemoryStore implements MemoryStore {
  readonly name = 'memory';
  private entries = new Map<string, MemoryEntry>();

  async store(entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>): Promise<string> {
    const id = randomUUID().slice(0, 12);
    const full: MemoryEntry = {
      ...entry,
      id,
      accessCount: 0,
      lastAccessedAt: Date.now(),
      createdAt: Date.now(),
      decayFactor: 1.0,
    };
    this.entries.set(id, full);
    return id;
  }

  async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    let results = Array.from(this.entries.values());

    // 类型过滤
    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      results = results.filter(e => types.includes(e.type));
    }

    // 标签过滤
    if (query.tags && query.tags.length > 0) {
      results = results.filter(e => query.tags!.some(t => e.tags.includes(t)));
    }

    // 置信度过滤
    if (query.minConfidence !== undefined) {
      results = results.filter(e => e.confidence >= query.minConfidence!);
    }

    // 重要性过滤
    if (query.minImportance !== undefined) {
      results = results.filter(e => e.importance >= query.minImportance!);
    }

    // 关键词匹配（简单实现：检查内容是否包含查询词）
    const queryLower = query.text.toLowerCase();
    results = results.filter(e => {
      const contentLower = e.content.toLowerCase();
      return queryLower.split(/\s+/).some(word => contentLower.includes(word));
    });

    // 按综合分数排序（重要性 × 置信度 × 衰减因子）
    results.sort((a, b) => {
      const scoreA = a.importance * a.confidence * a.decayFactor;
      const scoreB = b.importance * b.confidence * b.decayFactor;
      return scoreB - scoreA;
    });

    // 限制数量
    const limit = query.limit ?? 10;
    results = results.slice(0, limit);

    // 更新访问计数
    if (query.updateAccess !== false) {
      for (const entry of results) {
        entry.accessCount++;
        entry.lastAccessedAt = Date.now();
      }
    }

    return results;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async update(id: string, patch: Partial<MemoryEntry>): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      Object.assign(entry, patch);
    }
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async decay(): Promise<number> {
    const now = Date.now();
    let decayed = 0;
    for (const entry of this.entries.values()) {
      const daysSinceAccess = (now - entry.lastAccessedAt) / (24 * 60 * 60 * 1000);
      if (daysSinceAccess > 30) {
        entry.decayFactor = Math.max(0.1, entry.decayFactor * 0.95);
        decayed++;
      }
    }
    return decayed;
  }

  async stats(): Promise<MemoryStats> {
    const entries = Array.from(this.entries.values());
    const byType: Record<MemoryType, number> = {
      preference: 0, decision: 0, lesson: 0, discovery: 0, context: 0, relationship: 0,
    };
    for (const e of entries) {
      byType[e.type]++;
    }
    return {
      totalEntries: entries.length,
      byType,
      avgConfidence: entries.length > 0 ? entries.reduce((s, e) => s + e.confidence, 0) / entries.length : 0,
      avgImportance: entries.length > 0 ? entries.reduce((s, e) => s + e.importance, 0) / entries.length : 0,
    };
  }
}
