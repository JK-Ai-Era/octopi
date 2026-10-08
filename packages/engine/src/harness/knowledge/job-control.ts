/**
 * KnowledgeJobControl — 源级中止/继续纪元
 *
 * 中止态必须跨进程存活：DB 是权威，内存 AbortController 只是本进程信号。
 * 调度前读库；`aborted` 则不派发新任务。
 */

import type { KnowledgeDatabase } from './db.js';

export interface AbortResumeStats {
  cancelledQueued: number;
  abortedRunning: number;
  runningJobs: number;
  restoredCancelled: number;
  embedQueued: number;
}

export class KnowledgeJobControl {
  /** 本进程信号：abort 后 worker/embed 循环应立刻退出 */
  private abortBySource = new Map<string, AbortController>();

  constructor(private readonly db: KnowledgeDatabase) {
    this.db.raw.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_source_control (
        source_id   TEXT PRIMARY KEY,
        aborted     INTEGER NOT NULL DEFAULT 0,
        aborted_at  INTEGER,
        updated_at  INTEGER NOT NULL
      );
    `);
  }

  /** 是否处于中止态（DB 权威；进程重启后仍生效）。连接已关时视为停止调度 */
  isAborted(sourceId: string): boolean {
    try {
      const row = this.db.raw
        .prepare('SELECT aborted FROM knowledge_source_control WHERE source_id = ?')
        .get(sourceId) as { aborted?: number } | undefined;
      return Number(row?.aborted ?? 0) === 1;
    } catch {
      return true;
    }
  }

  /** 本进程 AbortSignal（无记录时惰性创建未中止的纪元） */
  signalFor(sourceId: string): AbortSignal {
    let ac = this.abortBySource.get(sourceId);
    if (!ac) {
      ac = new AbortController();
      this.abortBySource.set(sourceId, ac);
      // 库里是 aborted 而内存还没有 → 补上信号，保证在跑任务能被打断
      if (this.isAborted(sourceId) && !ac.signal.aborted) ac.abort();
    }
    return ac.signal;
  }

  /** 开启新的未中止纪元（resume / supersede 后用） */
  beginEpoch(sourceId: string): void {
    this.abortBySource.set(sourceId, new AbortController());
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_source_control (source_id, aborted, aborted_at, updated_at)
         VALUES (?, 0, NULL, ?)
         ON CONFLICT(source_id) DO UPDATE SET aborted = 0, aborted_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(sourceId, Date.now());
  }

  /**
   * 中止：DB 落 aborted + 打断本进程信号。
   * 不在此清 jobs（调用方负责 queued/running 收尾）。
   */
  markAborted(sourceId: string): boolean {
    const already = this.isAborted(sourceId);
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_source_control (source_id, aborted, aborted_at, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET aborted = 1, aborted_at = excluded.aborted_at, updated_at = excluded.updated_at`,
      )
      .run(sourceId, Date.now(), Date.now());
    let ctrl = this.abortBySource.get(sourceId);
    if (!ctrl) {
      ctrl = new AbortController();
      this.abortBySource.set(sourceId, ctrl);
    }
    if (!ctrl.signal.aborted) ctrl.abort();
    return !already;
  }

  /** 列出全部处于中止态的源（启动恢复 / 全局 abort 用） */
  listAbortedSourceIds(): string[] {
    const rows = this.db.raw
      .prepare('SELECT source_id FROM knowledge_source_control WHERE aborted = 1')
      .all() as Array<{ source_id: string }>;
    return rows.map((r) => r.source_id);
  }

  /** 调度闸门：中止源不得 claim 新任务 */
  allowsDispatch(sourceId: string): boolean {
    return !this.isAborted(sourceId);
  }
}
