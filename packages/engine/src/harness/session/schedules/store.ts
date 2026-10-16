/**
 * SessionScheduleStore — schedules.db 持久化
 *
 * 真源：~/.octopi/schedules.db（node:sqlite）。唯一写者是 SessionScheduleService。
 * 建库：Service open() 时 CREATE TABLE IF NOT EXISTS + 幂等 migrate（对齐 credentials.db）。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  SessionSchedule,
  SessionScheduleStatus,
  SessionScheduleCreateInput,
  SessionSchedulePayload,
} from './types.js';

export interface SessionScheduleStoreOptions {
  /** 默认 `:memory:`；生产传 OCTOPI_HOME/schedules.db */
  dbPath?: string;
  wal?: boolean;
  busyTimeoutMs?: number;
}

export interface SessionScheduleRow {
  id: string;
  session_id: string;
  agent_id: string;
  kind: string;
  fire_at: number | null;
  interval_ms: number | null;
  cron_expr: string | null;
  next_fire_at: number;
  max_runs: number | null;
  run_count: number;
  payload_json: string;
  coalesce_key: string | null;
  catch_up: string;
  status: string;
  created_at: number;
  created_by_run_id: string | null;
  last_fire_at: number | null;
  last_fire_id: string | null;
  last_error: string | null;
  updated_at: number;
}

function rowToSchedule(row: SessionScheduleRow): SessionSchedule {
  const payload = JSON.parse(row.payload_json) as SessionSchedulePayload;
  const schedule: SessionSchedule = {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    kind: row.kind as SessionSchedule['kind'],
    nextFireAt: row.next_fire_at,
    runCount: row.run_count,
    payload,
    catchUp: row.catch_up as SessionSchedule['catchUp'],
    status: row.status as SessionScheduleStatus,
    createdBy: {
      at: row.created_at,
      ...(row.created_by_run_id ? { runId: row.created_by_run_id } : {}),
    },
    updatedAt: row.updated_at,
  };
  if (row.fire_at != null) schedule.fireAt = row.fire_at;
  if (row.interval_ms != null) schedule.intervalMs = row.interval_ms;
  if (row.cron_expr != null) schedule.cron = row.cron_expr;
  if (row.max_runs != null) schedule.maxRuns = row.max_runs;
  if (row.coalesce_key != null) schedule.coalesceKey = row.coalesce_key;
  if (row.last_fire_at != null) schedule.lastFireAt = row.last_fire_at;
  if (row.last_fire_id != null) schedule.lastFireId = row.last_fire_id;
  if (row.last_error != null) schedule.lastError = row.last_error;
  return schedule;
}

/**
 * schedules.db 存取
 */
export class SessionScheduleStore {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * 打开/创建 schedules.db（Node >= 24 node:sqlite）
   *
   * @param options - 路径与 PRAGMA
   */
  static async create(
    options?: SessionScheduleStoreOptions,
  ): Promise<SessionScheduleStore> {
    let DatabaseSyncCtor: typeof DatabaseSync;
    try {
      const mod = await import('node:sqlite');
      DatabaseSyncCtor = mod.DatabaseSync;
    } catch {
      throw new Error(
        `SessionScheduleStore requires Node.js >= 24 built-in "node:sqlite". process.version=${process.version}`,
      );
    }

    const dbPath = options?.dbPath ?? ':memory:';
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    const db = new DatabaseSyncCtor(dbPath, {
      timeout: options?.busyTimeoutMs ?? 5000,
      enableForeignKeyConstraints: false,
    });
    if (options?.wal !== false && dbPath !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL');
    }

    const store = new SessionScheduleStore(db);
    store.createTables();
    return store;
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id                 TEXT PRIMARY KEY,
        session_id         TEXT NOT NULL,
        agent_id           TEXT NOT NULL,
        kind               TEXT NOT NULL,
        fire_at            INTEGER,
        interval_ms        INTEGER,
        cron_expr          TEXT,
        next_fire_at       INTEGER NOT NULL,
        max_runs           INTEGER,
        run_count          INTEGER NOT NULL DEFAULT 0,
        payload_json       TEXT NOT NULL,
        coalesce_key       TEXT,
        catch_up           TEXT NOT NULL DEFAULT 'skip',
        status             TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        created_by_run_id  TEXT,
        last_fire_at       INTEGER,
        last_fire_id       TEXT,
        last_error         TEXT,
        updated_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_due
        ON schedules(status, next_fire_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_session
        ON schedules(session_id, status);
    `);
  }

  get raw(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  /**
   * 插入作业
   *
   * @param schedule - 完整记录
   */
  insert(schedule: SessionSchedule): void {
    const stmt = this.db.prepare(`
      INSERT INTO schedules (
        id, session_id, agent_id, kind, fire_at, interval_ms, cron_expr,
        next_fire_at, max_runs, run_count, payload_json, coalesce_key, catch_up,
        status, created_at, created_by_run_id, last_fire_at, last_fire_id,
        last_error, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    stmt.run(
      schedule.id,
      schedule.sessionId,
      schedule.agentId,
      schedule.kind,
      schedule.fireAt ?? null,
      schedule.intervalMs ?? null,
      schedule.cron ?? null,
      schedule.nextFireAt,
      schedule.maxRuns ?? null,
      schedule.runCount,
      JSON.stringify(schedule.payload),
      schedule.coalesceKey ?? null,
      schedule.catchUp,
      schedule.status,
      schedule.createdBy.at,
      schedule.createdBy.runId ?? null,
      schedule.lastFireAt ?? null,
      schedule.lastFireId ?? null,
      schedule.lastError ?? null,
      schedule.updatedAt,
    );
  }

  /**
   * 按 id 取作业
   *
   * @param id - ScheduleId
   */
  get(id: string): SessionSchedule | null {
    const row = this.db
      .prepare('SELECT * FROM schedules WHERE id = ?')
      .get(id) as unknown as SessionScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  /**
   * 列出作业
   *
   * @param filter - sessionId / status 集合
   */
  list(filter?: {
    sessionId?: string;
    statuses?: SessionScheduleStatus[];
  }): SessionSchedule[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.sessionId) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter?.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    const sql =
      'SELECT * FROM schedules' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY next_fire_at ASC, created_at ASC';
    const rows = this.db.prepare(sql).all(...params) as unknown as SessionScheduleRow[];
    return rows.map(rowToSchedule);
  }

  /**
   * 启动重臂查询
   */
  listActiveDue(): SessionSchedule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM schedules WHERE status = 'active' ORDER BY next_fire_at ASC`,
      )
      .all() as unknown as SessionScheduleRow[];
    return rows.map(rowToSchedule);
  }

  /**
   * 统计未闭合作业数
   *
   * @param sessionId - 会话 id
   */
  countOpen(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM schedules
         WHERE session_id = ? AND status IN ('active', 'paused')`,
      )
      .get(sessionId) as unknown as { n: number };
    return Number(row?.n ?? 0);
  }

  /**
   * 局部更新（按 id）
   *
   * @param id - ScheduleId
   * @param patch - 要写入的列
   */
  update(
    id: string,
    patch: Partial<{
      status: SessionScheduleStatus;
      kind: SessionSchedule['kind'];
      fireAt: number | null;
      intervalMs: number | null;
      cron: string | null;
      nextFireAt: number;
      runCount: number;
      lastFireAt: number;
      lastFireId: string;
      lastError: string | null;
      updatedAt: number;
      maxRuns: number | null;
      catchUp: SessionSchedule['catchUp'];
      payload: SessionSchedulePayload;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.kind !== undefined) {
      sets.push('kind = ?');
      params.push(patch.kind);
    }
    if (patch.fireAt !== undefined) {
      sets.push('fire_at = ?');
      params.push(patch.fireAt);
    }
    if (patch.intervalMs !== undefined) {
      sets.push('interval_ms = ?');
      params.push(patch.intervalMs);
    }
    if (patch.cron !== undefined) {
      sets.push('cron_expr = ?');
      params.push(patch.cron);
    }
    if (patch.nextFireAt !== undefined) {
      sets.push('next_fire_at = ?');
      params.push(patch.nextFireAt);
    }
    if (patch.runCount !== undefined) {
      sets.push('run_count = ?');
      params.push(patch.runCount);
    }
    if (patch.lastFireAt !== undefined) {
      sets.push('last_fire_at = ?');
      params.push(patch.lastFireAt);
    }
    if (patch.lastFireId !== undefined) {
      sets.push('last_fire_id = ?');
      params.push(patch.lastFireId);
    }
    if (patch.lastError !== undefined) {
      sets.push('last_error = ?');
      params.push(patch.lastError);
    }
    if (patch.updatedAt !== undefined) {
      sets.push('updated_at = ?');
      params.push(patch.updatedAt);
    }
    if (patch.maxRuns !== undefined) {
      sets.push('max_runs = ?');
      params.push(patch.maxRuns);
    }
    if (patch.catchUp !== undefined) {
      sets.push('catch_up = ?');
      params.push(patch.catchUp);
    }
    if (patch.payload !== undefined) {
      sets.push('payload_json = ?');
      params.push(JSON.stringify(patch.payload));
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params as never[]);
  }

  /**
   * 会话删除清理
   *
   * @param sessionId - 会话 id
   */
  deleteBySession(sessionId: string): number {
    const result = this.db
      .prepare('DELETE FROM schedules WHERE session_id = ?')
      .run(sessionId);
    return Number(result.changes ?? 0);
  }

  /**
   * 事务内执行（点火记账用）
   *
   * @param fn - 同步事务体
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // rollback 失败仅出现在事务已结束时；吞掉以免掩盖原始错误
      }
      throw err;
    }
  }
}

/** 创建入参 → 领域对象（id 由调用方生成） */
export function buildScheduleRecord(
  id: string,
  input: SessionScheduleCreateInput,
  nextFireAt: number,
  now: number,
): SessionSchedule {
  const schedule: SessionSchedule = {
    id,
    sessionId: input.sessionId,
    agentId: input.agentId,
    kind: input.kind,
    nextFireAt,
    runCount: 0,
    payload: input.payload,
    catchUp: input.catchUp ?? 'skip',
    status: 'active',
    createdBy: {
      at: now,
      ...(input.createdByRunId ? { runId: input.createdByRunId } : {}),
    },
    updatedAt: now,
  };
  if (input.fireAt !== undefined) schedule.fireAt = input.fireAt;
  if (input.intervalMs !== undefined) schedule.intervalMs = input.intervalMs;
  if (input.cron !== undefined) schedule.cron = input.cron;
  if (input.maxRuns !== undefined) schedule.maxRuns = input.maxRuns;
  if (input.coalesceKey !== undefined) schedule.coalesceKey = input.coalesceKey;
  return schedule;
}
