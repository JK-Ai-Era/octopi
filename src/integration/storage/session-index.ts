/**
 * SessionIndex — 会话可搜字段投影（I2：可重建，非权威）。
 *
 * 权威仍是 JsonlSessionStore；本库只存 search 预筛所需列。
 * 失效可全量 rebuild；禁止当作备份或 Discourse 真相源。
 *
 * P2.d：可选 FTS5（trigram）。短词（<3 码点，常见二字中文）trigram 命不中，
 * 自动回落 LIKE；FTS 不可用时整库 LIKE。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { SessionData } from '../../harness/session-types.js';
import { extractSearchableFields } from '../../harness/session-history/score.js';

/** 与 Jsonl 旁路钩子对齐 */
export interface SessionIndexSink {
  upsertFromSession(sessionId: string, data: SessionData): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

export interface SessionIndexPrefilterQuery {
  /** 关键词（keyword AND，子串）或 phrase 整串 */
  terms: string[];
  mode: 'keyword' | 'phrase' | 'regex';
  roles?: string[];
  agentId?: string;
  sessionIds?: string[];
  since?: number;
  until?: number;
  includeArchived?: boolean;
  includeToolIo?: boolean;
  limitSessions?: number;
}

export interface SessionIndexCandidate {
  sessionId: string;
  msgIndexes: number[];
}

export interface SessionIndexBackend extends SessionIndexSink {
  ensureSchema(): Promise<void>;
  /**
   * SQL 缩候选 session（及命中行）；具体打分/ACL 仍由 Port 完成。
   * 返回 `null` 表示索引不可用/陈旧/可能截断漏检 —— 调用方应回退全量扫描。
   * 返回 `[]` 表示索引确信无命中。
   */
  prefilter(query: SessionIndexPrefilterQuery): Promise<SessionIndexCandidate[] | null>;
  /** 全量重建（扫权威 store） */
  rebuildFrom(loadAll: () => AsyncIterable<SessionData>): Promise<{ sessions: number; messages: number }>;
  /** 权威侧 session 数（用于新鲜度校验） */
  countSessions(): Promise<number>;
  /** 是否启用 FTS5 */
  readonly ftsEnabled: boolean;
  close(): void;
}

/** 单字段入库切片；更长文本可能在预筛中漏检 → prefilter 返回 null 回退扫描 */
const INDEX_TEXT_SLICE = 2000;
const SCHEMA_VERSION = 2;
/** trigram 最少 3 码点；更短走 LIKE */
const TRIGRAM_MIN_CHARS = 3;

/**
 * 创建 SQLite 会话投影索引（node:sqlite，Node >= 24）。
 *
 * @param options - dbPath；fts=false 可强制纯 LIKE
 * @returns SessionIndexBackend
 */
export async function createSqliteSessionIndex(options: {
  dbPath: string;
  wal?: boolean;
  /** 默认自动探测 FTS5；false 则只用 LIKE */
  fts?: boolean;
}): Promise<SessionIndexBackend> {
  let DatabaseSyncCtor: typeof DatabaseSync;
  try {
    const mod = await import('node:sqlite');
    DatabaseSyncCtor = mod.DatabaseSync;
  } catch {
    throw new Error(
      `SqliteSessionIndex requires Node.js >= 24 built-in "node:sqlite". Current process.version=${process.version}`,
    );
  }
  const index = new SqliteSessionIndex(
    DatabaseSyncCtor,
    options.dbPath,
    options.wal !== false,
    options.fts !== false,
  );
  await index.ensureSchema();
  return index;
}

/** FTS5 字面量：双引号包裹，内部引号翻倍 */
function ftsQuote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function codePointLength(s: string): number {
  return [...s].length;
}

class SqliteSessionIndex implements SessionIndexBackend {
  private db: DatabaseSync;
  private wantFts: boolean;
  private fts = false;

  constructor(Ctor: typeof DatabaseSync, dbPath: string, wal: boolean, wantFts: boolean) {
    this.db = new Ctor(dbPath, { timeout: 5000, enableForeignKeyConstraints: false });
    if (wal) this.db.exec('PRAGMA journal_mode = WAL');
    this.wantFts = wantFts;
  }

  get ftsEnabled(): boolean {
    return this.fts;
  }

  async ensureSchema(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT,
        primary_agent_id TEXT,
        preferred_agent_id TEXT,
        participant_ids TEXT,
        lifecycle TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        ended_at INTEGER,
        archived_at INTEGER,
        message_count INTEGER,
        source TEXT NOT NULL DEFAULT 'hot'
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL,
        msg_index INTEGER NOT NULL,
        role TEXT,
        agent_id TEXT,
        timestamp INTEGER,
        field TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (session_id, msg_index, field)
      );
      CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_msg_role ON messages(role);
      CREATE INDEX IF NOT EXISTS idx_sess_updated ON sessions(updated_at);
      CREATE INDEX IF NOT EXISTS idx_sess_lifecycle ON sessions(lifecycle);
      CREATE INDEX IF NOT EXISTS idx_sess_source ON sessions(source);
    `);

    if (this.wantFts) {
      this.fts = this.tryEnableFts();
    }

    const row = this.db.prepare(`SELECT value FROM index_meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    if (!row) {
      this.db
        .prepare(`INSERT INTO index_meta (key, value) VALUES ('schema_version', ?)`)
        .run(String(SCHEMA_VERSION));
    }
  }

  private tryEnableFts(): boolean {
    try {
      // trigram：混合 CJK/ASCII；UNINDEXED 保留定位列
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          text,
          session_id UNINDEXED,
          msg_index UNINDEXED,
          field UNINDEXED,
          tokenize='trigram'
        );
      `);
      return true;
    } catch {
      // 无 FTS5 时保持 LIKE-only
      return false;
    }
  }

  async upsertFromSession(sessionId: string, data: SessionData): Promise<void> {
    await this.ensureSchema();
    const meta = data.meta ?? ({ id: sessionId, updatedAt: Date.now() } as SessionData['meta']);
    const participantIds =
      meta.participantAgentIds ?? (data.participants ?? []).map((p) => p.agentId);
    const lifecycle = data.lifecycle?.lifecycle ?? meta.lifecycle ?? 'active';
    const source = lifecycle === 'archived' ? 'archive' : 'hot';
    const messages = data.messages ?? [];

    // 事务：会话行 + 消息行 + FTS 全成或全不成，避免半残投影
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO sessions (
            session_id, agent_id, primary_agent_id, preferred_agent_id, participant_ids,
            lifecycle, created_at, updated_at, ended_at, archived_at, message_count, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            agent_id = excluded.agent_id,
            primary_agent_id = excluded.primary_agent_id,
            preferred_agent_id = excluded.preferred_agent_id,
            participant_ids = excluded.participant_ids,
            lifecycle = excluded.lifecycle,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            ended_at = excluded.ended_at,
            archived_at = excluded.archived_at,
            message_count = excluded.message_count,
            source = excluded.source`,
        )
        .run(
          sessionId,
          data.agentId ?? meta.agentId ?? 'default',
          data.primaryAgentId ?? meta.primaryAgentId ?? null,
          data.preferredAgentId ?? meta.preferredAgentId ?? null,
          JSON.stringify(participantIds ?? []),
          lifecycle,
          meta.createdAt ?? null,
          meta.updatedAt ?? Date.now(),
          data.lifecycle?.endedAt ?? meta.endedAt ?? null,
          data.lifecycle?.archivedAt ?? meta.archivedAt ?? null,
          messages.length,
          source,
        );

      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
      if (this.fts) {
        this.db.prepare(`DELETE FROM messages_fts WHERE session_id = ?`).run(sessionId);
      }

      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO messages (session_id, msg_index, role, agent_id, timestamp, field, text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.fts
        ? this.db.prepare(
            `INSERT INTO messages_fts (text, session_id, msg_index, field) VALUES (?, ?, ?, ?)`,
          )
        : null;

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        for (const f of extractSearchableFields(msg, true)) {
          const text = f.text.slice(0, INDEX_TEXT_SLICE);
          insert.run(sessionId, i, msg.role, msg.agentId ?? null, msg.timestamp ?? null, f.field, text);
          insertFts?.run(text, sessionId, i, f.field);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async remove(sessionId: string): Promise<void> {
    await this.ensureSchema();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
      if (this.fts) {
        this.db.prepare(`DELETE FROM messages_fts WHERE session_id = ?`).run(sessionId);
      }
      this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async countSessions(): Promise<number> {
    await this.ensureSchema();
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number };
    return row.c;
  }

  async prefilter(query: SessionIndexPrefilterQuery): Promise<SessionIndexCandidate[] | null> {
    await this.ensureSchema();
    const limit = query.limitSessions ?? 50;

    // 截断漏检：词条落在 slice 之外时预筛会假阴性 → 交回扫描
    if (query.mode !== 'regex') {
      for (const t of query.terms) {
        if (t.length > INDEX_TEXT_SLICE) return null;
      }
    }

    const textClauses: string[] = [];
    const where: string[] = [];
    const params: unknown[] = [];

    // 词条拆分：长词可进 FTS（trigram ≥3）；短词（二字中文等）LIKE
    if (query.mode === 'phrase' && query.terms.length) {
      const phrase = query.terms.join(' ');
      if (this.fts && codePointLength(phrase) >= TRIGRAM_MIN_CHARS) {
        textClauses.push(`messages_fts MATCH ?`);
        params.push(ftsQuote(phrase));
      } else {
        textClauses.push(`m.text LIKE ?`);
        params.push(`%${phrase}%`);
      }
    } else if (query.mode !== 'regex') {
      const terms = query.terms;
      if (!terms.length) {
        textClauses.push(`1=1`);
      } else if (this.fts) {
        const longTerms = terms.filter((t) => codePointLength(t) >= TRIGRAM_MIN_CHARS);
        const shortTerms = terms.filter((t) => codePointLength(t) < TRIGRAM_MIN_CHARS);
        if (longTerms.length) {
          textClauses.push(`messages_fts MATCH ?`);
          params.push(longTerms.map(ftsQuote).join(' AND '));
        }
        for (const t of shortTerms) {
          textClauses.push(`m.text LIKE ?`);
          params.push(`%${t}%`);
        }
        if (!textClauses.length) textClauses.push(`1=1`);
      } else {
        for (const t of terms) {
          textClauses.push(`m.text LIKE ?`);
          params.push(`%${t}%`);
        }
      }
    } else {
      textClauses.push(`1=1`);
    }

    if (query.includeArchived !== true) {
      where.push(`s.source = 'hot'`);
    }
    if (query.roles?.length) {
      where.push(`m.role IN (${query.roles.map(() => '?').join(',')})`);
      params.push(...query.roles);
    }
    if (query.since != null) {
      where.push(`s.updated_at >= ?`);
      params.push(query.since);
    }
    if (query.until != null) {
      where.push(`s.updated_at <= ?`);
      params.push(query.until);
    }
    if (query.sessionIds?.length) {
      where.push(`s.session_id IN (${query.sessionIds.map(() => '?').join(',')})`);
      params.push(...query.sessionIds);
    }
    if (query.agentId) {
      where.push(`(
        s.agent_id = ? OR s.primary_agent_id = ? OR s.preferred_agent_id = ?
        OR s.participant_ids LIKE ?
      )`);
      const aid = query.agentId;
      params.push(aid, aid, aid, `%"${aid}"%`);
    }

    const usesFts = textClauses.some((c) => c.includes('messages_fts MATCH'));
    const from = usesFts
      ? `FROM messages_fts
         JOIN messages m
           ON m.session_id = messages_fts.session_id
          AND m.msg_index = messages_fts.msg_index
          AND m.field = messages_fts.field
         JOIN sessions s ON s.session_id = m.session_id`
      : `FROM messages m
         JOIN sessions s ON s.session_id = m.session_id`;

    // 先按会话新鲜度取足消息行，再在 JS 里按 session 截断（避免热会话消息行挤掉其它会话）
    const sql = `
      SELECT s.session_id AS session_id, m.msg_index AS msg_index
      ${from}
      WHERE (${textClauses.join(' AND ')})
        ${where.length ? `AND ${where.join(' AND ')}` : ''}
      ORDER BY s.updated_at DESC
      LIMIT ?
    `;
    params.push(Math.max(limit * 100, 1000));

    const rows = this.db.prepare(sql).all(...(params as never[])) as Array<{
      session_id: string;
      msg_index: number;
    }>;

    const bySession = new Map<string, Set<number>>();
    for (const r of rows) {
      let set = bySession.get(r.session_id);
      if (!set) {
        // 首次出现序 = updated_at DESC；满 limit 个会话后不再纳入
        if (bySession.size >= limit) continue;
        set = new Set();
        bySession.set(r.session_id, set);
      }
      set.add(r.msg_index);
    }
    return [...bySession.entries()].map(([sessionId, idxs]) => ({
      sessionId,
      msgIndexes: [...idxs].sort((a, b) => a - b),
    }));
  }

  async rebuildFrom(
    loadAll: () => AsyncIterable<SessionData>,
  ): Promise<{ sessions: number; messages: number }> {
    await this.ensureSchema();
    this.db.exec('BEGIN');
    try {
      this.db.exec(`DELETE FROM messages; DELETE FROM sessions;`);
      if (this.fts) {
        this.db.exec(`DELETE FROM messages_fts;`);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    let sessions = 0;
    let messages = 0;
    for await (const data of loadAll()) {
      const id = data.id;
      if (!id) continue;
      await this.upsertFromSession(id, data);
      sessions++;
      messages += data.messages?.length ?? 0;
    }
    this.db
      .prepare(
        `INSERT INTO index_meta (key, value) VALUES ('built_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(Date.now()));
    return { sessions, messages };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 从 JsonlSessionStore 全量重建投影。
 *
 * @param index - 目标索引
 * @param store - 权威 SessionStore
 * @returns 重建统计
 */
export async function rebuildSessionIndexFromStore(
  index: SessionIndexBackend,
  store: {
    list(): Promise<Array<{ id: string }>>;
    load(id: string): Promise<SessionData | null>;
  },
): Promise<{ sessions: number; messages: number }> {
  return index.rebuildFrom(async function* () {
    for (const meta of await store.list()) {
      const data = await store.load(meta.id);
      if (data) yield data;
    }
  });
}

/**
 * 启动对齐：投影 session 数 ≠ 权威 list 时 rebuild。
 * 保证「空 prefilter = 无命中」不会因陈旧/空索引误杀。
 *
 * @param index - 投影索引
 * @param store - 权威 store
 * @returns 是否执行了 rebuild
 */
export async function ensureSessionIndexFresh(
  index: SessionIndexBackend,
  store: {
    list(): Promise<Array<{ id: string }>>;
    load(id: string): Promise<SessionData | null>;
  },
): Promise<{ rebuilt: boolean; sessions: number }> {
  await index.ensureSchema();
  const authoritative = (await store.list()).length;
  const projected = await index.countSessions();
  if (projected !== authoritative) {
    const stats = await rebuildSessionIndexFromStore(index, store);
    return { rebuilt: true, sessions: stats.sessions };
  }
  return { rebuilt: false, sessions: projected };
}
