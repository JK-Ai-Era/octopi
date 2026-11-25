/**
 * SkillStateDatabase — 技能注册表数据面（arch/skill-creation-design.md §6）
 *
 * 启用状态唯一权威（one source of truth）：技能进 discover 索引的判定
 * 只看本注册表（发现层经 SkillAdmissionGate 查询），不看目录里「有什么」。
 *
 * 存储形态：OCTOPI_HOME/skill-state/skills.db（node:sqlite，Node >= 24）。
 * 选 sqlite 而非 per-agent JSON：审查（CLI/REST）与 discover 自动登记是
 * 真实并发写方（wisdom 并发写纪律）——事务原子性消除读-改-写竞态，
 * 同 credentials.db / registry.db 先例。
 *
 * 两个正交维度（设计 §6.2）：
 * - reviewStatus（审查结论）：pending → approved | rejected
 * - enabled（运维开关）：true ⇄ false（approved 后可先不启用；出事一键下线）
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { restrictToOwner } from '../../../../file-mode.js';

// ── 类型 ──

/** 技能来源（批准语义不同，见设计 §6.1） */
export type SkillSourceKind = 'submitted' | 'dropped-in' | 'shared';

/** 审查结论维度（`pending` 与审查单的 `pending_review` 是同一状态的两处命名——设计 §6.2 用 pending_review；本类型取短名用于登记行，勿混用） */
export type SkillReviewStatus = 'pending' | 'approved' | 'rejected';

/** 审查记录（人工或 LLM；绑定当时内容哈希） */
export interface SkillReviewRecord {
  by: string;
  verdict: 'approved' | 'rejected';
  findings?: string;
  at: number;
  /** 审查时的内容哈希（防审查后偷改的可追溯锚点） */
  contentHash: string;
}

/** 技能注册表条目 */
export interface SkillRecord {
  agentId: string;
  skillId: string;
  source: SkillSourceKind;
  reviewStatus: SkillReviewStatus;
  enabled: boolean;
  contentHash: string;
  /** 放盘即信任来源的「未经审查」标注（审计面可见；设计 §6.1） */
  unreviewed: boolean;
  submissionId?: string;
  review?: SkillReviewRecord;
  createdAt: number;
  updatedAt: number;
}

/** 审查单状态 */
export type SkillSubmissionStatus = 'pending_review' | 'approved' | 'rejected';

/** 审查单（skill_submit 产生；staging 副本是审查对象本体） */
export interface SkillSubmission {
  submissionId: string;
  agentId: string;
  skillId: string;
  /** staging 副本路径（引擎区，agent 不可写） */
  stagingPath: string;
  summary?: string;
  status: SkillSubmissionStatus;
  /** 静态校验 issues（JSON 序列化 SkillIssue[]） */
  issues: unknown[];
  createdAt: number;
  updatedAt: number;
}

export interface SkillStateDatabaseOptions {
  /** 数据库文件路径（缺省 :memory:；生产 = OCTOPI_HOME/skill-state/skills.db） */
  dbPath?: string;
  wal?: boolean;
  busyTimeoutMs?: number;
}

// ── 实现 ──

export class SkillStateDatabase {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * 打开/创建 skills.db（Node >= 24 node:sqlite）
   *
   * @param options - dbPath / wal / busyTimeoutMs
   * @returns 数据库实例
   */
  static async create(options?: SkillStateDatabaseOptions): Promise<SkillStateDatabase> {
    let DatabaseSyncCtor: typeof DatabaseSync;
    try {
      const mod = await import('node:sqlite');
      DatabaseSyncCtor = mod.DatabaseSync;
    } catch {
      throw new Error(
        `SkillStateDatabase requires Node.js >= 24 built-in "node:sqlite". process.version=${process.version}`,
      );
    }

    const dbPath = options?.dbPath ?? ':memory:';
    if (dbPath !== ':memory:') {
      await mkdir(dirname(dbPath), { recursive: true });
      // skill-state 存未审查提交（会物化进 agent 目录）——owner-only（0700），
      // 对齐 credentials.db 的 harden 语义（restrictToOwner 失败即抛，不静默）
      restrictToOwner(dirname(dbPath), 'dir');
    }

    const db = new DatabaseSyncCtor(dbPath, {
      timeout: options?.busyTimeoutMs ?? 5000,
      enableForeignKeyConstraints: false,
    });
    if (options?.wal !== false) {
      db.exec('PRAGMA journal_mode = WAL');
    }

    const sdb = new SkillStateDatabase(db);
    sdb.createTables();
    if (dbPath !== ':memory:') {
      restrictToOwner(dbPath, 'file');
    }
    return sdb;
  }

  /**
   * skill-state 数据面路径（OCTOPI_HOME/skill-state/skills.db）
   *
   * @param octopiHome - OCTOPI_HOME 绝对路径
   * @returns 数据库文件路径
   */
  static resolveDbPath(octopiHome: string): string {
    return join(octopiHome, 'skill-state', 'skills.db');
  }

  /**
   * skill-state staging 根（审查单副本区；agent 不可写）
   *
   * @param octopiHome - OCTOPI_HOME 绝对路径
   * @returns staging 根目录
   */
  static resolveStagingRoot(octopiHome: string): string {
    return join(octopiHome, 'skill-state', 'inbox');
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        agent_id       TEXT NOT NULL,
        skill_id       TEXT NOT NULL,
        source         TEXT NOT NULL,
        review_status  TEXT NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        content_hash   TEXT NOT NULL,
        unreviewed     INTEGER NOT NULL DEFAULT 0,
        submission_id  TEXT,
        review_json    TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (agent_id, skill_id)
      );

      CREATE TABLE IF NOT EXISTS skill_submissions (
        submission_id TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        skill_id      TEXT NOT NULL,
        staging_path  TEXT NOT NULL,
        summary       TEXT,
        status        TEXT NOT NULL,
        issues_json   TEXT NOT NULL DEFAULT '[]',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
    `);
  }

  private rowToSkill(row: Record<string, unknown>): SkillRecord {
    let review: SkillReviewRecord | undefined;
    if (typeof row.review_json === 'string' && row.review_json) {
      try {
        review = JSON.parse(row.review_json) as SkillReviewRecord;
      } catch {
        // 审查记录损坏不拖垮读取；状态字段仍权威（fail-loud 由上层诊断补）
        review = undefined;
      }
    }
    return {
      agentId: row.agent_id as string,
      skillId: row.skill_id as string,
      source: row.source as SkillSourceKind,
      reviewStatus: row.review_status as SkillReviewStatus,
      enabled: row.enabled === 1,
      contentHash: row.content_hash as string,
      unreviewed: row.unreviewed === 1,
      submissionId: (row.submission_id as string | null) ?? undefined,
      review,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * 读取单个技能登记
   *
   * @param agentId - agent id
   * @param skillId - skill id（= SKILL.md 目录名）
   * @returns 登记条目；未登记返回 null
   */
  getSkill(agentId: string, skillId: string): SkillRecord | null {
    const row = this.db
      .prepare('SELECT * FROM skills WHERE agent_id = ? AND skill_id = ?')
      .get(agentId, skillId) as Record<string, unknown> | undefined;
    return row ? this.rowToSkill(row) : null;
  }

  /**
   * 登记状态戳（manager 脏检用）：该 agent 全部登记行的最大 updated_at。
   *
   * 停用/批准/回 pending 等登记态变化没有文件面痕迹，仅靠目录 mtime 探不到；
   * 此戳让消费侧 ensureFresh 能发现「无文件变化的状态迁移」。
   *
   * @param agentId - agent id
   * @returns 最大 updated_at（epoch ms）；无登记行时 null
   */
  maxUpdatedAt(agentId: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(updated_at) AS m FROM skills WHERE agent_id = ?')
      .get(agentId) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  /**
   * 列出 agent 的全部技能登记
   *
   * @param agentId - agent id
   * @returns 登记条目（按 skillId 排序）
   */
  listSkills(agentId: string): SkillRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM skills WHERE agent_id = ? ORDER BY skill_id')
      .all(agentId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSkill(r));
  }

  /**
   * 写入/更新技能登记（整体覆盖字段）
   *
   * @param record - 登记条目（updatedAt 由本方法刷新）
   */
  upsertSkill(record: Omit<SkillRecord, 'createdAt' | 'updatedAt'> & Partial<Pick<SkillRecord, 'createdAt'>>): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO skills (agent_id, skill_id, source, review_status, enabled, content_hash,
                             unreviewed, submission_id, review_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, skill_id) DO UPDATE SET
           source = excluded.source,
           review_status = excluded.review_status,
           enabled = excluded.enabled,
           content_hash = excluded.content_hash,
           unreviewed = excluded.unreviewed,
           submission_id = excluded.submission_id,
           review_json = excluded.review_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.agentId,
        record.skillId,
        record.source,
        record.reviewStatus,
        record.enabled ? 1 : 0,
        record.contentHash,
        record.unreviewed ? 1 : 0,
        record.submissionId ?? null,
        record.review ? JSON.stringify(record.review) : null,
        record.createdAt ?? now,
        now,
      );
  }

  /**
   * 创建审查单
   *
   * @param input - submissionId / agentId / skillId / stagingPath / summary / issues
   * @returns 创建后的审查单
   */
  createSubmission(input: {
    submissionId: string;
    agentId: string;
    skillId: string;
    stagingPath: string;
    summary?: string;
    issues?: unknown[];
  }): SkillSubmission {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO skill_submissions (submission_id, agent_id, skill_id, staging_path, summary, status, issues_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending_review', ?, ?, ?)`,
      )
      .run(
        input.submissionId,
        input.agentId,
        input.skillId,
        input.stagingPath,
        input.summary ?? null,
        JSON.stringify(input.issues ?? []),
        now,
        now,
      );
    return {
      submissionId: input.submissionId,
      agentId: input.agentId,
      skillId: input.skillId,
      stagingPath: input.stagingPath,
      summary: input.summary,
      status: 'pending_review',
      issues: input.issues ?? [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 读取审查单
   *
   * @param submissionId - 审查单 id
   * @returns 审查单；不存在返回 null
   */
  getSubmission(submissionId: string): SkillSubmission | null {
    const row = this.db
      .prepare('SELECT * FROM skill_submissions WHERE submission_id = ?')
      .get(submissionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      submissionId: row.submission_id as string,
      agentId: row.agent_id as string,
      skillId: row.skill_id as string,
      stagingPath: row.staging_path as string,
      summary: (row.summary as string | null) ?? undefined,
      status: row.status as SkillSubmissionStatus,
      issues: JSON.parse((row.issues_json as string) || '[]') as unknown[],
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * 列出 agent 的审查单（按创建时间倒序）
   *
   * @param agentId - agent id
   * @param status - 可选状态过滤
   * @returns 审查单列表
   */
  listSubmissions(agentId: string, status?: SkillSubmissionStatus): SkillSubmission[] {
    const rows = (
      status
        ? this.db
            .prepare(
              'SELECT * FROM skill_submissions WHERE agent_id = ? AND status = ? ORDER BY created_at DESC',
            )
            .all(agentId, status)
        : this.db
            .prepare('SELECT * FROM skill_submissions WHERE agent_id = ? ORDER BY created_at DESC')
            .all(agentId)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      submissionId: row.submission_id as string,
      agentId: row.agent_id as string,
      skillId: row.skill_id as string,
      stagingPath: row.staging_path as string,
      summary: (row.summary as string | null) ?? undefined,
      status: row.status as SkillSubmissionStatus,
      issues: JSON.parse((row.issues_json as string) || '[]') as unknown[],
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  /**
   * 更新审查单状态
   *
   * @param submissionId - 审查单 id
   * @param status - 新状态
   * @returns 更新是否发生（false = 审查单不存在）
   */
  updateSubmissionStatus(submissionId: string, status: SkillSubmissionStatus): boolean {
    const res = this.db
      .prepare('UPDATE skill_submissions SET status = ?, updated_at = ? WHERE submission_id = ?')
      .run(status, Date.now(), submissionId);
    return res.changes > 0;
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }
}
