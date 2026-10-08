/**
 * 源级 job 控制状态 — 纯 SQL，只读连接可跑。
 *
 * 与 KnowledgeIngest.jobControlState 同口径；禁止依赖 ingest 内存态
 * （中止纪元以 knowledge_source_control 为权威）。
 */

import type { KnowledgeDatabase } from './db.js';
import type { KnowledgeIndexStore } from './index-store.js';

export interface KnowledgeJobControlState {
  aborted: boolean;
  jobsQueued: number;
  jobsRunning: number;
  jobsCancelled: number;
  embedMissing: boolean;
  canAbort: boolean;
  canResume: boolean;
}

/**
 * 计算源的中止/继续控制面。
 *
 * @param db - knowledge 连接（只读亦可）
 * @param index - 缺向量探测
 * @param sourceId - 源 id
 * @param opts.embeddingEnabled - 是否配置了 embedding（未配置则 embedMissing=false）
 * @returns 控制按钮状态
 */
export function readJobControlState(
  db: KnowledgeDatabase,
  index: KnowledgeIndexStore,
  sourceId: string,
  opts?: { embeddingEnabled?: boolean },
): KnowledgeJobControlState {
  const row = db.raw
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS q,
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS r,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS c
       FROM knowledge_jobs WHERE source_id = ?`,
    )
    .get(sourceId) as { q: number | null; r: number | null; c: number | null };
  const jobsQueued = Number(row?.q ?? 0);
  const jobsRunning = Number(row?.r ?? 0);
  const jobsCancelled = Number(row?.c ?? 0);
  const abortedRow = db.raw
    .prepare('SELECT aborted FROM knowledge_source_control WHERE source_id = ?')
    .get(sourceId) as { aborted?: number } | undefined;
  const aborted = Number(abortedRow?.aborted ?? 0) === 1;
  const embedMissing = opts?.embeddingEnabled
    ? index.hasChunksMissingEmbedding(sourceId)
    : false;
  const active = jobsQueued + jobsRunning > 0;
  return {
    aborted,
    jobsQueued,
    jobsRunning,
    jobsCancelled,
    embedMissing,
    canAbort: active && !aborted,
    canResume: aborted || jobsCancelled > 0 || (embedMissing && !active),
  };
}
