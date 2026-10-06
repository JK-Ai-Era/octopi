/**
 * JobQueue — knowledge_jobs 表原语（enqueue / claim / 计数 / 回收 / 清理）
 *
 * 从 KnowledgeIngest 拆出；调度编排（drain/runJob）仍在 ingest。
 */

import { randomUUID } from 'node:crypto';
import type { KnowledgeDatabase } from './db.js';

export type IngestJobKind = 'parse_file' | 'walk_source' | 'drop_file' | 'embed_source' | 'fetch_doc';

export interface JobRow {
  id: string;
  source_id: string;
  kind: string;
  path: string | null;
  priority: number;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface JobQueueDeps {
  db: KnowledgeDatabase;
  maxQueueDepth: number;
  isAborted: (sourceId: string) => boolean;
  onBackpressure?: (sourceId: string, queued: number) => void;
}

export class JobQueue {
  constructor(private readonly deps: JobQueueDeps) {}

  hasQueuedJobs(): boolean {
    const row = this.deps.db.raw
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_jobs WHERE status = 'queued'`)
      .get() as { n: number };
    return (row?.n ?? 0) > 0;
  }

  countQueuedKinds(kinds: IngestJobKind[], sourceId?: string): number {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => '?').join(',');
    const sql = sourceId
      ? `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE status = 'queued' AND source_id = ? AND kind IN (${placeholders})`
      : `SELECT COUNT(*) AS n FROM knowledge_jobs WHERE status = 'queued' AND kind IN (${placeholders})`;
    const row = this.deps.db.raw
      .prepare(sql)
      .get(...(sourceId ? [sourceId, ...kinds] : kinds)) as { n: number };
    return row?.n ?? 0;
  }

  countActiveJobs(sourceId: string): { total: number; embed: number } {
    const row = this.deps.db.raw
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN kind = 'embed_source' THEN 1 ELSE 0 END) AS embed
         FROM knowledge_jobs
         WHERE source_id = ? AND status IN ('queued', 'running')`,
      )
      .get(sourceId) as { total: number; embed: number | null };
    return { total: row?.total ?? 0, embed: row?.embed ?? 0 };
  }

  hasActivePathJob(sourceId: string, path: string): boolean {
    const row = this.deps.db.raw
      .prepare(
        `SELECT id FROM knowledge_jobs
         WHERE source_id = ? AND path = ? AND kind IN ('parse_file', 'fetch_doc') AND status IN ('queued','running')
         LIMIT 1`,
      )
      .get(sourceId, path) as { id?: string } | undefined;
    return Boolean(row?.id);
  }

  /**
   * 入队（同 source+kind+path 去重；有 file_id 时按 (file_id,kind) 去重；中止源拒绝）
   *
   * @returns 是否真正插入
   */
  enqueue(
    sourceId: string,
    kind: IngestJobKind,
    path: string | null,
    priority: number,
    fileId?: string | null,
  ): boolean {
    if (this.deps.isAborted(sourceId)) return false;
    const activeStatuses = ['queued', 'running'];
    const placeholders = activeStatuses.map(() => '?').join(',');
    // 优先 (file_id, kind)：共享 File 不双 parse
    if (fileId) {
      const byFile = this.deps.db.raw
        .prepare(
          `SELECT id FROM knowledge_jobs
           WHERE file_id = ? AND kind = ? AND status IN (${placeholders}) LIMIT 1`,
        )
        .get(fileId, kind, ...activeStatuses) as { id?: string } | undefined;
      if (byFile?.id) return false;
    }
    const dup = (
      path != null
        ? this.deps.db.raw
            .prepare(
              `SELECT id FROM knowledge_jobs
               WHERE source_id = ? AND kind = ? AND path = ? AND status IN (${placeholders})`,
            )
            .get(sourceId, kind, path, ...activeStatuses)
        : this.deps.db.raw
            .prepare(
              `SELECT id FROM knowledge_jobs
               WHERE source_id = ? AND kind = ? AND path IS NULL AND status IN (${placeholders})`,
            )
            .get(sourceId, kind, ...activeStatuses)
    ) as { id?: string } | undefined;
    if (dup?.id) return false;

    const now = Date.now();
    const depth = this.deps.db.raw
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_jobs WHERE status = 'queued'`)
      .get() as { n: number };
    if ((depth?.n ?? 0) >= this.deps.maxQueueDepth) {
      this.deps.onBackpressure?.(sourceId, depth.n);
    }

    this.deps.db.raw
      .prepare(
        `INSERT INTO knowledge_jobs (id, source_id, file_id, kind, path, priority, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      )
      .run(
        `kj_${randomUUID().slice(0, 12)}`,
        sourceId,
        fileId ?? null,
        kind,
        path,
        priority,
        now,
        now,
      );
    return true;
  }

  /** 原子认领：queued → running；中止源不派发 */
  claimJob(kinds: IngestJobKind[]): JobRow | null {
    if (kinds.length === 0) return null;
    const placeholders = kinds.map(() => '?').join(',');
    const row = this.deps.db.raw
      .prepare(
        `SELECT * FROM knowledge_jobs
         WHERE status = 'queued' AND kind IN (${placeholders})
           AND source_id NOT IN (SELECT source_id FROM knowledge_source_control WHERE aborted = 1)
         ORDER BY priority ASC, created_at ASC
         LIMIT 1`,
      )
      .get(...kinds) as JobRow | undefined;
    if (!row) return null;
    const res = this.deps.db.raw
      .prepare(
        `UPDATE knowledge_jobs SET status = 'running', updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(Date.now(), row.id);
    if (Number(res.changes ?? 0) === 0) return null;
    return row;
  }

  heartbeat(jobId: string): void {
    this.deps.db.raw
      .prepare(`UPDATE knowledge_jobs SET updated_at = ? WHERE id = ? AND status = 'running'`)
      .run(Date.now(), jobId);
  }

  markDone(jobId: string): void {
    this.deps.db.raw
      .prepare(`UPDATE knowledge_jobs SET status = 'done', updated_at = ? WHERE id = ?`)
      .run(Date.now(), jobId);
  }

  markFailedOrCancelled(jobId: string, aborted: boolean, message: string): void {
    this.deps.db.raw
      .prepare(
        `UPDATE knowledge_jobs
         SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(aborted ? 'cancelled' : 'failed', aborted ? 'aborted' : message, Date.now(), jobId);
  }

  /** 启动回收孤儿 running → queued */
  reclaimOrphanRunning(): void {
    this.deps.db.raw
      .prepare(
        `UPDATE knowledge_jobs SET status = 'queued', updated_at = ?
         WHERE status = 'running'`,
      )
      .run(Date.now());
  }

  /** running 超时（无 heartbeat）→ 收回 queued；多次失败的直接标 failed */
  reclaimStaleRunning(staleMs: number): void {
    const cutoff = Date.now() - staleMs;
    this.deps.db.raw
      .prepare(
        `UPDATE knowledge_jobs SET status = 'failed', last_error = COALESCE(last_error, 'stale_give_up'), updated_at = ?
         WHERE status = 'running' AND updated_at < ? AND attempts >= 2`,
      )
      .run(Date.now(), cutoff);
    this.deps.db.raw
      .prepare(
        `UPDATE knowledge_jobs SET status = 'queued', attempts = attempts + 1, updated_at = ?
         WHERE status = 'running' AND updated_at < ? AND attempts < 2`,
      )
      .run(Date.now(), cutoff);
  }

  cleanupTerminal(retainMs = 24 * 60 * 60_000): void {
    const cutoff = Date.now() - retainMs;
    this.deps.db.raw
      .prepare(
        `DELETE FROM knowledge_jobs
         WHERE status IN ('done', 'failed', 'cancelled') AND updated_at < ?`,
      )
      .run(cutoff);
  }
}
