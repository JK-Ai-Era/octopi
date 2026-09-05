/**
 * Memory Extraction — 提取素材持久化接口与内存实现
 *
 * 目标：
 * - 让采集过程可回放、可恢复（进程重启不丢失关键素材）
 * - 支持 append events + save/load bundle 两种持久化粒度
 *
 * 说明：
 * - 本接口是 harness 层扩展点，不破坏现有子系统内核
 * - 内置 InMemoryExtractorStore 用于测试；JSONL 实现见 ./jsonl-extractor-store.ts
 *
 * @module harness/memory/extraction/extractor-store
 */

import type { SessionExtractBundle, SessionExtractEvent } from './session-extractor.js';

export interface ExtractorMeta {
  sessionId: string;
  agentId?: string;
  lifecycle?: string;
  extractionStatus?: string;
  updatedAt?: number;
  eventCount?: number;
}

export interface ExtractorStore {
  /** 追加一组事件（可重复调用） */
  appendEvents(agentId: string, sessionId: string, events: SessionExtractEvent[]): Promise<void>;

  /** 加载事件列表（不存在返回空数组） */
  loadEvents(agentId: string, sessionId: string): Promise<SessionExtractEvent[]>;

  /** 保存完整 bundle（覆盖写） */
  saveBundle(agentId: string, sessionId: string, bundle: SessionExtractBundle, meta?: ExtractorMeta): Promise<void>;

  /** 加载完整 bundle（不存在返回 null） */
  loadBundle(agentId: string, sessionId: string): Promise<SessionExtractBundle | null>;

  /** 更新元数据（可用于记录 lifecycle/extraction 状态） */
  updateMeta(agentId: string, sessionId: string, meta: ExtractorMeta): Promise<void>;

  /** 查询可处理的 session（pending） */
  listPending(agentId: string): Promise<ExtractorMeta[]>;
}

// ── 内存实现 ──

interface MemorySessionEntry {
  events: SessionExtractEvent[];
  bundle?: SessionExtractBundle;
  meta?: ExtractorMeta;
}

export class InMemoryExtractorStore implements ExtractorStore {
  private agentSessions = new Map<string, Map<string, MemorySessionEntry>>();

  async appendEvents(agentId: string, sessionId: string, events: SessionExtractEvent[]): Promise<void> {
    const entry = this.ensureEntry(agentId, sessionId);
    entry.events.push(...events);
    entry.meta = {
      ...(entry.meta ?? { sessionId, agentId }),
      eventCount: entry.events.length,
      updatedAt: Date.now(),
    };
  }

  async loadEvents(agentId: string, sessionId: string): Promise<SessionExtractEvent[]> {
    return this.getEntry(agentId, sessionId)?.events ?? [];
  }

  async saveBundle(agentId: string, sessionId: string, bundle: SessionExtractBundle, meta?: ExtractorMeta): Promise<void> {
    const entry = this.ensureEntry(agentId, sessionId);
    entry.bundle = bundle;
    entry.meta = {
      ...(entry.meta ?? { sessionId, agentId }),
      ...meta,
      updatedAt: Date.now(),
    };
  }

  async loadBundle(agentId: string, sessionId: string): Promise<SessionExtractBundle | null> {
    return this.getEntry(agentId, sessionId)?.bundle ?? null;
  }

  async updateMeta(agentId: string, sessionId: string, meta: ExtractorMeta): Promise<void> {
    const entry = this.ensureEntry(agentId, sessionId);
    entry.meta = {
      ...(entry.meta ?? { sessionId, agentId }),
      ...meta,
      updatedAt: Date.now(),
    };
  }

  async listPending(agentId: string): Promise<ExtractorMeta[]> {
    const map = this.agentSessions.get(agentId);
    if (!map) return [];
    const result: ExtractorMeta[] = [];
    for (const [sessionId, entry] of map) {
      const m = entry.meta;
      if (!m) continue;
      if ((m.extractionStatus ?? 'pending') === 'pending') {
        const { sessionId: _ignore, ...rest } = m;
        result.push({ sessionId, ...rest });
      }
    }
    return result;
  }

  private ensureEntry(agentId: string, sessionId: string): MemorySessionEntry {
    let map = this.agentSessions.get(agentId);
    if (!map) {
      map = new Map();
      this.agentSessions.set(agentId, map);
    }
    let entry = map.get(sessionId);
    if (!entry) {
      entry = { events: [] };
      map.set(sessionId, entry);
    }
    return entry;
  }

  private getEntry(agentId: string, sessionId: string): MemorySessionEntry | undefined {
    return this.agentSessions.get(agentId)?.get(sessionId);
  }
}
