/**
 * Hit log + 提升候选（P5）— 使用证据，不直接写 Cognition/Memory
 *
 * 提升主通道仍是显式 memory_store(+anchors)；此处只产计量与候选信号。
 */

import { randomUUID } from 'node:crypto';
import type { KnowledgeDatabase } from './db.js';
import { asSourceId } from './types.js';
import type { KnowledgeChunkId, KnowledgeSourceId } from './types.js';

export interface KnowledgeHitRecord {
  sourceId: KnowledgeSourceId | string;
  chunkId?: KnowledgeChunkId | string;
  path: string;
  agentId?: string;
  sessionId?: string;
  query: string;
  mode?: 'inject' | 'hint' | 'read' | 'search';
}

export interface KnowledgeHitStats {
  total: number;
  byPath: Array<{ path: string; sourceId: KnowledgeSourceId; hits: number; sessions: number }>;
}

export interface PromotionCandidate {
  path: string;
  sourceId: KnowledgeSourceId;
  hitCount: number;
  sessionCount: number;
  /** 是否达到默认计量阈值 */
  meetsThreshold: boolean;
}

export class KnowledgeHitLog {
  /** 收敛时是否产出 promotion 候选（knowledge.promotion.stewardOnConverge） */
  constructor(
    private readonly db: KnowledgeDatabase,
    private readonly opts?: { stewardOnConverge?: boolean },
  ) {}

  /**
   * 会话收敛钩子：stewardOnConverge=false 时不产出，避免假配置
   */
  collectOnConverge(opts?: {
    minSessions?: number;
    minHits?: number;
  }): PromotionCandidate[] {
    if (this.opts?.stewardOnConverge === false) return [];
    return this.promotionCandidates(opts);
  }

  /**
   * 记录一次命中/使用
   */
  record(hit: KnowledgeHitRecord): void {
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_hits (id, source_id, chunk_id, path, agent_id, session_id, query, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `kh_${randomUUID().slice(0, 12)}`,
        hit.sourceId,
        hit.chunkId ?? null,
        hit.path,
        hit.agentId ?? null,
        hit.sessionId ?? null,
        hit.query.slice(0, 500),
        hit.mode ?? 'inject',
        Date.now(),
      );
  }

  /**
   * 批量记录（auto-ground inject）
   */
  recordMany(hits: KnowledgeHitRecord[]): void {
    for (const h of hits) this.record(h);
  }

  stats(opts?: { sinceMs?: number }): KnowledgeHitStats {
    const since = opts?.sinceMs ?? 0;
    const total = (
      this.db.raw
        .prepare('SELECT COUNT(*) AS n FROM knowledge_hits WHERE created_at >= ?')
        .get(since) as { n: number }
    ).n;
    const rows = this.db.raw
      .prepare(
        `SELECT path, source_id, COUNT(*) AS hits, COUNT(DISTINCT session_id) AS sessions
         FROM knowledge_hits
         WHERE created_at >= ?
         GROUP BY source_id, path
         ORDER BY hits DESC
         LIMIT 50`,
      )
      .all(since) as Array<{
      path: string;
      source_id: string;
      hits: number;
      sessions: number;
    }>;
    return {
      total,
      byPath: rows.map((r) => ({
        path: r.path,
        sourceId: asSourceId(r.source_id),
        hits: r.hits,
        sessions: r.sessions,
      })),
    };
  }

  /**
   * 跨会话计量候选：session 数 **或** hit 数达标即入选；
   * `meetsThreshold` = 两者同时达标（严格门槛）。
   *
   * 只产信号；写入 Memory/Cognition 走 memory_store / 后续 steward 确认。
   */
  promotionCandidates(opts?: {
    minSessions?: number;
    minHits?: number;
  }): PromotionCandidate[] {
    const minSessions = opts?.minSessions ?? 3;
    const minHits = opts?.minHits ?? 10;
    const rows = this.db.raw
      .prepare(
        `SELECT path, source_id, COUNT(*) AS hits, COUNT(DISTINCT session_id) AS sessions
         FROM knowledge_hits
         GROUP BY source_id, path
         HAVING sessions >= ? OR hits >= ?
         ORDER BY hits DESC
         LIMIT 100`,
      )
      .all(minSessions, minHits) as Array<{
      path: string;
      source_id: string;
      hits: number;
      sessions: number;
    }>;
    return rows.map((r) => ({
      path: r.path,
      sourceId: asSourceId(r.source_id),
      hitCount: r.hits,
      sessionCount: r.sessions,
      meetsThreshold: r.sessions >= minSessions && r.hits >= minHits,
    }));
  }

  /**
   * purge 后清痕（合规：不可再据 hit 引用已删内容）
   */
  clearForPath(sourceId: KnowledgeSourceId | string, path: string): void {
    this.db.raw
      .prepare('DELETE FROM knowledge_hits WHERE source_id = ? AND path = ?')
      .run(sourceId, path);
  }

  clearForSource(sourceId: KnowledgeSourceId | string): void {
    this.db.raw.prepare('DELETE FROM knowledge_hits WHERE source_id = ?').run(sourceId);
  }
}
