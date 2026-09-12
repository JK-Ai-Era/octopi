/**
 * MemoryKnowledgeStore — 内存知识存储
 *
 * 基于内存的知识存储，适用于开发和测试。
 * 支持关键词匹配检索。
 */

import { randomUUID } from 'node:crypto';
import type {
  KnowledgeStore,
  KnowledgeEntry,
  KnowledgeType,
  KnowledgeStats,
  RetrieveOptions,
} from './types.js';

export class MemoryKnowledgeStore implements KnowledgeStore {
  readonly name = 'memory';
  private _entries = new Map<string, KnowledgeEntry>();

  async store(entry: Omit<KnowledgeEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    const full: KnowledgeEntry = {
      ...entry,
      id,
      accessCount: 0,
      lastAccessedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this._entries.set(id, full);
    return id;
  }

  async update(id: string, patch: Partial<KnowledgeEntry>): Promise<void> {
    const existing = this._entries.get(id);
    if (!existing) return;
    this._entries.set(id, { ...existing, ...patch, updatedAt: Date.now() });
  }

  async retrieve(query: string, options?: RetrieveOptions): Promise<KnowledgeEntry[]> {
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    let results = Array.from(this._entries.values());

    // 关键词匹配
    results = results.filter(entry => {
      const text = `${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    });

    // 过滤
    results = this._filter(results, options);

    // 按相关度排序（关键词命中数 × 置信度）
    results.sort((a, b) => {
      const scoreA = this._score(a, keywords) * a.confidence;
      const scoreB = this._score(b, keywords) * b.confidence;
      return scoreB - scoreA;
    });

    // 限制数量
    const limit = options?.limit ?? 10;
    results = results.slice(0, limit);

    // 更新访问计数
    if (options?.updateAccess !== false) {
      const now = Date.now();
      for (const entry of results) {
        entry.accessCount++;
        entry.lastAccessedAt = now;
      }
    }

    return results;
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    return this._entries.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this._entries.delete(id);
  }

  async list(options?: RetrieveOptions): Promise<KnowledgeEntry[]> {
    let results = Array.from(this._entries.values());
    results = this._filter(results, options);
    results.sort((a, b) => b.createdAt - a.createdAt);
    const limit = options?.limit ?? 100;
    return results.slice(0, limit);
  }

  async stats(): Promise<KnowledgeStats> {
    const entries = Array.from(this._entries.values());
    const byType: Record<KnowledgeType, number> = {
      fact: 0, pattern: 0, lesson: 0, preference: 0, skill: 0,
    };
    let totalConfidence = 0;
    let totalAccesses = 0;

    for (const entry of entries) {
      byType[entry.type]++;
      totalConfidence += entry.confidence;
      totalAccesses += entry.accessCount;
    }

    return {
      totalEntries: entries.length,
      byType,
      avgConfidence: entries.length > 0 ? totalConfidence / entries.length : 0,
      totalAccesses,
    };
  }

  // ── 内部方法 ──

  private _filter(entries: KnowledgeEntry[], options?: RetrieveOptions): KnowledgeEntry[] {
    if (!options) return entries;

    let filtered = entries;

    if (options.type) {
      const types = Array.isArray(options.type) ? options.type : [options.type];
      filtered = filtered.filter(e => types.includes(e.type));
    }

    if (options.tags && options.tags.length > 0) {
      filtered = filtered.filter(e => options.tags!.some(t => e.tags.includes(t)));
    }

    if (options.minConfidence !== undefined) {
      filtered = filtered.filter(e => e.confidence >= options.minConfidence!);
    }

    return filtered;
  }

  private _score(entry: KnowledgeEntry, keywords: string[]): number {
    const text = `${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
    return keywords.filter(kw => text.includes(kw)).length;
  }
}
