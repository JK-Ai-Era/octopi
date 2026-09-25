/**
 * 合规 purge — 单文件 / 源级抹除
 *
 * 删 chunks + embeddings + files 行 + hit log；generatedDescription 标脏待重生成。
 */

import type { KnowledgeIndexStore } from './index-store.js';
import type { KnowledgeHitLog } from './hit-log.js';
import type { KnowledgeSourceStore } from './source-store.js';

export interface PurgeResult {
  sourceId: string;
  path?: string;
  purged: true;
  /** description 已标脏（待 auto-describe 重跑） */
  describeStale: boolean;
}

export class KnowledgePurger {
  constructor(
    private readonly sources: KnowledgeSourceStore,
    private readonly index: KnowledgeIndexStore,
    private readonly hits: KnowledgeHitLog,
  ) {}

  /**
   * 单文件 purge（合规 / 用户要求抹掉）
   */
  purgePath(sourceId: string, path: string): PurgeResult {
    this.index.purgePath(sourceId, path);
    this.hits.clearForPath(sourceId, path);
    const describeStale = this.markDescribeStale(sourceId);
    return { sourceId, path, purged: true, describeStale };
  }

  /**
   * 源级 purge
   */
  purgeSource(sourceId: string): PurgeResult {
    this.index.purgeSource(sourceId);
    this.hits.clearForSource(sourceId);
    const describeStale = this.markDescribeStale(sourceId);
    return { sourceId, purged: true, describeStale };
  }

  /**
   * 源级 purge + 注册删除（卸载路径）
   */
  purgeAndRemoveSource(sourceId: string): PurgeResult {
    const result = this.purgeSource(sourceId);
    this.sources.remove(sourceId);
    return result;
  }

  private markDescribeStale(sourceId: string): boolean {
    const source = this.sources.get(sourceId);
    if (!source) return false;
    if (!source.generatedDescription) return false;
    // 人工 description 权威不动；只清自动描述，待重生成
    this.sources.update(sourceId, { generatedDescription: null });
    return true;
  }
}
