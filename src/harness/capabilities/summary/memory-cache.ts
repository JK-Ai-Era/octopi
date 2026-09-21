/**
 * 进程内 LRU Summary 缓存（无 Redis 硬依赖）
 *
 * @module harness/capabilities/summary/memory-cache
 */

import type { SummaryCachePort, SummaryResult } from './types.js';

interface Entry {
  value: SummaryResult;
  expiresAt: number;
}

/**
 * 创建进程内摘要缓存
 *
 * @param options - maxEntries / defaultTtlMs
 * @returns SummaryCachePort
 */
export function createMemorySummaryCache(options?: {
  maxEntries?: number;
  defaultTtlMs?: number;
}): SummaryCachePort {
  const maxEntries = options?.maxEntries ?? 256;
  const defaultTtlMs = options?.defaultTtlMs ?? 600_000;
  const map = new Map<string, Entry>();

  return {
    get(key: string): SummaryResult | undefined {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt < Date.now()) {
        map.delete(key);
        return undefined;
      }
      // LRU: re-insert
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key: string, value: SummaryResult, ttlMs?: number): void {
      if (map.has(key)) map.delete(key);
      map.set(key, { value, expiresAt: Date.now() + (ttlMs ?? defaultTtlMs) });
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
  };
}
