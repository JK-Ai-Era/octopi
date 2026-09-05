/**
 * Memory Extraction — 记忆去重与升级策略（规则层，语言无关）
 *
 * 目标：
 * - 避免重复记忆膨胀
 * - 当新证据更强时升级旧条目（置信度/重要性）
 *
 * 策略：
 * - 同源去重：相同 sessionId + source 不重复入库
 * - 类型+标签去重：同 type + tags 超过阈值时跳过
 * - 升级策略：当新 candidate 的 confidence/importance 更高，update 旧条目
 *
 * @module harness/memory/extraction/memory-deduplicator
 */

import type { MemoryStore, MemoryQuery, MemoryEntry, MemoryType } from '../types.js';
import type { MemoryCandidate } from './session-extractor.js';

export interface MemoryDeduplicatorOptions {
  /** 同源去重：是否按 source 精确去重（默认 true） */
  dedupeBySource?: boolean;
  /** 同类型+标签的最大条数（超过则跳过，默认 10） */
  maxPerTypeTagGroup?: number;
  /** 升级阈值：新旧 confidence/importance 差值（默认 0.05） */
  upgradeDelta?: number;
}

export class MemoryDeduplicator {
  private store: MemoryStore;
  private dedupeBySource: boolean;
  private maxPerTypeTagGroup: number;
  private upgradeDelta: number;

  constructor(store: MemoryStore, options?: MemoryDeduplicatorOptions) {
    this.store = store;
    this.dedupeBySource = options?.dedupeBySource ?? true;
    this.maxPerTypeTagGroup = options?.maxPerTypeTagGroup ?? 10;
    this.upgradeDelta = options?.upgradeDelta ?? 0.05;
  }

  /**
   * 过滤与升级候选列表，返回需要入库的新候选
   */
  async filterAndUpgrade(candidates: MemoryCandidate[]): Promise<MemoryCandidate[]> {
    const accepted: MemoryCandidate[] = [];

    for (const c of candidates) {
      // 1) 同源去重（使用 source 标签检索，兼容 InMemoryMemoryStore）
      if (this.dedupeBySource) {
        const existingBySource = await this.store.retrieve({
          text: c.content,
          type: c.type,
          tags: [c.source],
          limit: 1,
          updateAccess: false,
        });

        if (existingBySource.length > 0) {
          // 升级旧条目（若新证据更强）
          await this.tryUpgrade(existingBySource[0], c);
          continue;
        }
      }

      // 2) 类型+标签容量控制
      const tagQuery: MemoryQuery = {
        text: c.content,
        type: c.type,
        tags: c.tags,
        limit: this.maxPerTypeTagGroup,
        updateAccess: false,
      };
      const sameGroup = await this.store.retrieve(tagQuery);

      if (sameGroup.length >= this.maxPerTypeTagGroup) {
        // 组内去重：尝试升级最弱条目
        const weakest = [...sameGroup].sort(
          (a, b) => (a.importance * a.confidence) - (b.importance * b.confidence),
        )[0];

        if (weakest) {
          await this.tryUpgrade(weakest, c);
        }
        continue;
      }

      accepted.push({ ...c, tags: [...new Set([...c.tags, c.source])] });
    }

    return accepted;
  }

  private async tryUpgrade(existing: MemoryEntry, incoming: MemoryCandidate): Promise<void> {
    const confDelta = incoming.confidence - existing.confidence;
    const impDelta = incoming.importance - existing.importance;

    const shouldUpgrade =
      confDelta >= this.upgradeDelta ||
      impDelta >= this.upgradeDelta;

    if (!shouldUpgrade) return;

    await this.store.update(existing.id, {
      confidence: Math.max(existing.confidence, incoming.confidence),
      importance: Math.max(existing.importance, incoming.importance),
      // 合并标签
      tags: [...new Set([...existing.tags, ...incoming.tags])],
      // 保留原 source，但追加新来源信息（放在 content 末尾 or tags）
    });
  }
}
