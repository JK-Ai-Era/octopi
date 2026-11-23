/**
 * 归档注册表（archives.db）—— 封存包的权威清单
 *
 * 单写者纪律（arch/session-archive-recycle.md §3.2）：仅组合侧（gateway 门面 /
 * retention job）经本类写入；sqlite 单文件随 `archives/` 目录落盘。搜索投影
 * （sessions.index.db）可重建、不作权威。
 *
 * @module
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 注册表行（对应 archives 表） */
export interface ArchiveRecord {
  sessionId: string;
  /** 级联组 id（组内共进退；单会话 = 自身 id） */
  groupSealId: string;
  parentSessionId?: string | null;
  tenantId: string;
  agentId: string;
  title: string;
  state: 'archived' | 'trashed';
  /**
   * 事务阶段（崩溃 reconcile 依据）：
   * sealing = 封存进行中；ready = 就绪；restoring = 恢复进行中
   */
  phase: 'sealing' | 'ready' | 'restoring';
  sealedBy: 'manual' | 'trash' | 'auto';
  createdAt?: number | null;
  endedAt?: number | null;
  sealedAt: number;
  /** 到期销毁时间；null = 永久 */
  purgeAt?: number | null;
  /** 封存包相对 archives/ 的路径 */
  bundle: string;
  bytes: number;
  messageCount: number;
  /** manifest JSON 文本（列表不拆包） */
  manifestJson: string;
}

/** 归档注册表（DatabaseSync 同步驱动；网关单实例单写者） */
export class ArchiveRegistry {
  private readonly db: DatabaseSync;

  /**
   * @param dbPath - archives.db 路径（不存在则建库建表）
   */
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archives (
        session_id TEXT PRIMARY KEY,
        group_seal_id TEXT NOT NULL,
        parent_session_id TEXT,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        sealed_by TEXT NOT NULL,
        created_at INTEGER,
        ended_at INTEGER,
        sealed_at INTEGER NOT NULL,
        purge_at INTEGER,
        bundle TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        manifest_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_archives_purge ON archives(state, purge_at);
      CREATE INDEX IF NOT EXISTS idx_archives_group ON archives(group_seal_id);
    `);
  }

  /**
   * 写入/覆盖一行（seal 入账；同 sessionId 重封存覆盖旧行）
   *
   * @param rec - 注册表行
   */
  upsert(rec: ArchiveRecord): void {
    this.db
      .prepare(
        `INSERT INTO archives (
           session_id, group_seal_id, parent_session_id, tenant_id, agent_id, title,
           state, phase, sealed_by, created_at, ended_at, sealed_at, purge_at,
           bundle, bytes, message_count, manifest_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           group_seal_id=excluded.group_seal_id,
           parent_session_id=excluded.parent_session_id,
           tenant_id=excluded.tenant_id,
           agent_id=excluded.agent_id,
           title=excluded.title,
           state=excluded.state,
           phase=excluded.phase,
           sealed_by=excluded.sealed_by,
           created_at=excluded.created_at,
           ended_at=excluded.ended_at,
           sealed_at=excluded.sealed_at,
           purge_at=excluded.purge_at,
           bundle=excluded.bundle,
           bytes=excluded.bytes,
           message_count=excluded.message_count,
           manifest_json=excluded.manifest_json`,
      )
      .run(
        rec.sessionId,
        rec.groupSealId,
        rec.parentSessionId ?? null,
        rec.tenantId,
        rec.agentId,
        rec.title,
        rec.state,
        rec.phase,
        rec.sealedBy,
        rec.createdAt ?? null,
        rec.endedAt ?? null,
        rec.sealedAt,
        rec.purgeAt ?? null,
        rec.bundle,
        rec.bytes,
        rec.messageCount,
        rec.manifestJson,
      );
  }

  /**
   * 更新事务阶段
   *
   * @param sessionId - 会话 id
   * @param phase - 目标阶段
   */
  setPhase(sessionId: string, phase: ArchiveRecord['phase']): void {
    this.db.prepare('UPDATE archives SET phase = ? WHERE session_id = ?').run(phase, sessionId);
  }

  /**
   * 更新状态与到期时间
   *
   * @param sessionId - 会话 id
   * @param state - 目标状态
   * @param purgeAt - 到期时间（null=永久）
   */
  setState(sessionId: string, state: ArchiveRecord['state'], purgeAt: number | null): void {
    this.db
      .prepare('UPDATE archives SET state = ?, purge_at = ? WHERE session_id = ?')
      .run(state, purgeAt, sessionId);
  }

  /**
   * 读单行
   *
   * @param sessionId - 会话 id
   * @returns 行；不存在返回 null
   */
  get(sessionId: string): ArchiveRecord | null {
    const row = this.db.prepare('SELECT * FROM archives WHERE session_id = ?').get(sessionId);
    return row ? toRecord(row) : null;
  }

  /**
   * 按状态列行（缺省全部）；倒序按 sealed_at
   *
   * @param state - 状态过滤（undefined=全部）
   * @returns 行列表
   */
  list(state?: ArchiveRecord['state']): ArchiveRecord[] {
    const rows = (
      state
        ? this.db.prepare('SELECT * FROM archives WHERE state = ? ORDER BY sealed_at DESC').all(state)
        : this.db.prepare('SELECT * FROM archives ORDER BY sealed_at DESC').all()
    ) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  /**
   * 按级联组列行
   *
   * @param groupSealId - 组 id
   * @returns 组内全部行
   */
  listByGroup(groupSealId: string): ArchiveRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM archives WHERE group_seal_id = ? ORDER BY sealed_at DESC')
      .all(groupSealId) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  /**
   * 到期待清除行（trashed、ready、且 purge_at <= now）。
   * 只列 ready：sealing/restoring 行的唯一副本可能还在 staging，销毁前必须先 settle
   * （评审 blocker-2：TTL 自动销毁不得命中未就绪行）
   *
   * @param now - 当前时间戳
   * @returns 到期行
   */
  listExpiredTrashed(now: number): ArchiveRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM archives WHERE state = 'trashed' AND phase = 'ready' AND purge_at IS NOT NULL AND purge_at <= ? ORDER BY purge_at ASC",
      )
      .all(now) as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  /**
   * 非 ready 行（崩溃 reconcile 入口）
   *
   * @returns phase != ready 的行
   */
  listUnsettled(): ArchiveRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM archives WHERE phase != 'ready' ORDER BY sealed_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  /**
   * 自动归档候选查询所需：全部 ready 行（去重用）
   *
   * @returns ready 行
   */
  listReady(): ArchiveRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM archives WHERE phase = 'ready'")
      .all() as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  /**
   * 删除行
   *
   * @param sessionId - 会话 id
   */
  remove(sessionId: string): void {
    this.db.prepare('DELETE FROM archives WHERE session_id = ?').run(sessionId);
  }

  /** 关闭数据库句柄 */
  close(): void {
    this.db.close();
  }
}

/** 行映射（snake_case → ArchiveRecord） */
function toRecord(row: Record<string, unknown>): ArchiveRecord {
  return {
    sessionId: String(row.session_id),
    groupSealId: String(row.group_seal_id),
    parentSessionId: row.parent_session_id == null ? null : String(row.parent_session_id),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    title: String(row.title),
    state: row.state as ArchiveRecord['state'],
    phase: row.phase as ArchiveRecord['phase'],
    sealedBy: row.sealed_by as ArchiveRecord['sealedBy'],
    createdAt: row.created_at == null ? null : Number(row.created_at),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    sealedAt: Number(row.sealed_at),
    purgeAt: row.purge_at == null ? null : Number(row.purge_at),
    bundle: String(row.bundle),
    bytes: Number(row.bytes),
    messageCount: Number(row.message_count),
    manifestJson: String(row.manifest_json),
  };
}
