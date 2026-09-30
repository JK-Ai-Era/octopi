/**
 * InMemoryMemoryStore — 内存记忆存储
 *
 * 支持关键词匹配、shadow/软删过滤。生产环境可替换为 SQLite 后端。
 */

import { randomUUID } from 'node:crypto';
import type {
  MemoryChannel,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryStatus,
  MemoryStore,
  MemoryType,
  SoftDeleteReason,
} from './types.js';
import { MEMORY_TYPES } from './types.js';
import { mapLegacyType } from './gates.js';
import {
  scoreKeywordFields,
  tokenizeKeywordQuery,
} from './sqlite/keyword-search.js';

function emptyTypes(): Record<MemoryType, number> {
  return { fact: 0, method: 0, norm: 0 };
}

function normalizeStatus(entry: MemoryEntry): MemoryStatus {
  return entry.status ?? 'active';
}

function passesVisibility(entry: MemoryEntry, query: MemoryQuery): boolean {
  if (entry.deleted && !query.includeDeleted) return false;
  const status = normalizeStatus(entry);
  // shadow 与 deleted 独立：未显式 includeShadow 时一律不可见
  if (status === 'shadow' && !query.includeShadow) return false;
  if (query.status) {
    const list = Array.isArray(query.status) ? query.status : [query.status];
    if (!list.includes(status)) return false;
  }
  return true;
}

export class InMemoryMemoryStore implements MemoryStore {
  readonly name = 'memory';
  private entries = new Map<string, MemoryEntry>();

  async store(
    entry: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'decayFactor'>,
  ): Promise<string> {
    const id = randomUUID().slice(0, 12);
    const full: MemoryEntry = {
      ...entry,
      type: mapLegacyType(entry.type),
      id,
      accessCount: 0,
      lastAccessedAt: Date.now(),
      createdAt: Date.now(),
      decayFactor: 1.0,
      status: entry.status ?? 'active',
      channel: entry.channel ?? 'model_inference',
      deleted: entry.deleted ?? false,
    };
    this.entries.set(id, full);
    return id;
  }

  async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    let results = Array.from(this.entries.values()).filter((e) => passesVisibility(e, query));

    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      results = results.filter((e) => types.includes(e.type));
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter((e) => query.tags!.some((t) => e.tags.includes(t)));
    }

    if (query.channel) {
      const ch = Array.isArray(query.channel) ? query.channel : [query.channel];
      results = results.filter((e) => (e.channel ? ch.includes(e.channel) : false));
    }

    if (query.minConfidence !== undefined) {
      results = results.filter((e) => e.confidence >= query.minConfidence!);
    }

    if (query.minImportance !== undefined) {
      results = results.filter((e) => e.importance >= query.minImportance!);
    }

    const tokens = tokenizeKeywordQuery(query.text ?? '');
    let scored: Array<{ e: MemoryEntry; score: number }>;
    if (tokens.length > 0) {
      scored = results
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
    } else {
      scored = results.map((e) => ({ e, score: 0 }));
    }

    scored.sort((a, b) => {
      const rankA = a.score * 10 + a.e.importance * a.e.confidence * a.e.decayFactor;
      const rankB = b.score * 10 + b.e.importance * b.e.confidence * b.e.decayFactor;
      return rankB - rankA;
    });

    const limit = query.limit ?? 10;
    results = scored.map((s) => s.e).slice(0, limit);

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

  async softDelete(
    id: string,
    meta: { by: string; reason: SoftDeleteReason | string; winnerId?: string },
  ): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.deleted = true;
    entry.deletedAt = Date.now();
    entry.deletedBy = meta.by;
    entry.deletedReason = meta.reason;
    entry.deletedMeta = meta.winnerId ? { winnerId: meta.winnerId } : {};
  }

  async undelete(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.deleted = false;
    entry.deletedAt = undefined;
    entry.deletedBy = undefined;
    entry.deletedReason = undefined;
    entry.deletedMeta = undefined;
  }

  async listForGovern(filter?: { includeDeleted?: boolean }): Promise<MemoryEntry[]> {
    return Array.from(this.entries.values()).filter(
      (e) => filter?.includeDeleted || !e.deleted,
    );
  }

  async decay(options?: {
    typeParams?: Partial<Record<import('./types.js').MemoryType, { idleDays?: number; factor?: number; min?: number }>>;
  }): Promise<number> {
    const { isDecayDue, nextDecayFactor, resolveDecayParams } = await import('./decay-policy.js');
    const params = resolveDecayParams(options?.typeParams);
    const now = Date.now();
    let decayed = 0;
    for (const entry of this.entries.values()) {
      if (entry.deleted) continue;
      if (!isDecayDue(entry.lastAccessedAt, entry.type, params, now)) continue;
      const next = nextDecayFactor(entry.decayFactor, entry.type, params);
      if (next < entry.decayFactor) {
        entry.decayFactor = next;
        decayed++;
      }
    }
    return decayed;
  }

  async stats(): Promise<MemoryStats> {
    const all = Array.from(this.entries.values());
    const active = all.filter((e) => !e.deleted);
    const byType = emptyTypes();
    for (const e of active) {
      if (MEMORY_TYPES.includes(e.type)) byType[e.type]++;
    }
    return {
      totalEntries: active.length,
      byType,
      avgConfidence:
        active.length > 0 ? active.reduce((s, e) => s + e.confidence, 0) / active.length : 0,
      avgImportance:
        active.length > 0 ? active.reduce((s, e) => s + e.importance, 0) / active.length : 0,
      deletedEntries: all.filter((e) => e.deleted).length,
      shadowEntries: active.filter((e) => normalizeStatus(e) === 'shadow').length,
    };
  }
}

export type { MemoryChannel };
