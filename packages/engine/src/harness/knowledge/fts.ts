/**
 * Knowledge FTS5 — 关键词倒排（可重建投影）
 *
 * 中文不靠默认分词：索引/查询都写入「词 + CJK 二元组」token 流（对齐 Memory）。
 * FTS 表非权威；upsert/remove 同步维护，可整库 rebuild。
 */

import type { KnowledgeDatabase } from './db.js';
import { tokenizeKeywordQuery } from '../memory/sqlite/keyword-search.js';

const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u;
const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;

/** 路径 + 正文 → 空格分隔 token 流（FTS unicode61 再切一次也无害） */
export function buildFtsTokens(text: string, path?: string): string {
  const parts: string[] = [];
  const push = (s: string) => {
    if (!s) return;
    parts.push(s.toLowerCase());
  };
  const add = (raw: string) => {
    for (const p of raw.split(TOKEN_SPLIT)) {
      if (!p) continue;
      push(p);
      if (CJK_RE.test(p[0] ?? '')) {
        // CJK 二元组：两字中文词在 unicode61 下也是单 token，滑窗保证子串可搜
        for (let i = 0; i + 1 < p.length; i++) push(p.slice(i, i + 2));
      }
    }
  };
  add(path ?? '');
  add(text ?? '');
  return parts.join(' ');
}

/** 查询 → FTS MATCH 表达式（OR） */
export function buildFtsQuery(query: string): string {
  const tokens = tokenizeKeywordQuery(query);
  if (tokens.length === 0) return '';
  const quoted = tokens
    .filter((t) => t.length >= 2)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(' OR ');
}

export class KnowledgeFts {
  private enabled = false;

  constructor(private readonly db: KnowledgeDatabase) {
    try {
      this.db.raw.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
          chunk_id UNINDEXED,
          toks,
          tokenize='unicode61'
        );
      `);
      this.enabled = true;
    } catch {
      // FTS5 未编译进 sqlite：退回 LIKE 路径
      this.enabled = false;
    }
  }

  get available(): boolean {
    return this.enabled;
  }

  /** 单条 upsert（先删后插，兼容 contentless 语义） */
  upsert(chunkId: string, text: string, path?: string): void {
    if (!this.enabled) return;
    this.db.raw
      .prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?')
      .run(chunkId);
    this.db.raw
      .prepare('INSERT INTO knowledge_chunks_fts (chunk_id, toks) VALUES (?, ?)')
      .run(chunkId, buildFtsTokens(text, path));
  }

  /**
   * 批量 upsert。**不自开事务**：调用方（upsertFile 等）已在外层事务内，
   * 嵌套 BEGIN 会炸；rebuild 时由调用方包事务。
   */
  upsertMany(rows: Array<{ id: string; text: string; path?: string }>): void {
    if (!this.enabled || rows.length === 0) return;
    const del = this.db.raw.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?');
    const ins = this.db.raw.prepare(
      'INSERT INTO knowledge_chunks_fts (chunk_id, toks) VALUES (?, ?)',
    );
    for (const r of rows) {
      del.run(r.id);
      ins.run(r.id, buildFtsTokens(r.text, r.path));
    }
  }

  remove(chunkId: string): void {
    if (!this.enabled) return;
    this.db.raw
      .prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?')
      .run(chunkId);
  }

  removeMany(chunkIds: string[]): void {
    if (!this.enabled || chunkIds.length === 0) return;
    const del = this.db.raw.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?');
    for (const id of chunkIds) del.run(id);
  }

  /** 源级清空（卸载 / rebuild） */
  clearSource(sourceId: string): void {
    if (!this.enabled) return;
    this.db.raw
      .prepare(
        `DELETE FROM knowledge_chunks_fts
         WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE source_id = ?)`,
      )
      .run(sourceId);
  }

  /**
   * MATCH 检索，返回 chunkId（已按源过滤）
   *
   * @returns 命中 chunk id 列表；FTS 不可用或 query 空时返回 null（调用方退 LIKE）
   */
  search(query: string, sourceIds: string[], limit: number): string[] | null {
    if (!this.enabled) return null;
    const match = buildFtsQuery(query);
    if (!match) return null;
    const placeholders = sourceIds.map(() => '?').join(',');
    try {
      const rows = this.db.raw
        .prepare(
          `SELECT f.chunk_id AS id
           FROM knowledge_chunks_fts f
           JOIN knowledge_chunks c ON c.id = f.chunk_id
           WHERE knowledge_chunks_fts MATCH ?
             AND c.source_id IN (${placeholders})
           LIMIT ?`,
        )
        .all(match, ...sourceIds, limit) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    } catch {
      return null;
    }
  }

  /**
   * 全量重建（Index 非权威；可整库重跑）
   *
   * **同步**版本：仅测试/小库。大库请用 {@link rebuildFromChunksAsync}。
   *
   * @returns 写入条数
   */
  rebuildFromChunks(batch = 500): number {
    if (!this.enabled) return 0;
    this.db.raw.exec('DELETE FROM knowledge_chunks_fts');
    let cursor = '';
    let n = 0;
    for (;;) {
      const rows = this.db.raw
        .prepare(
          `SELECT id, text, path FROM knowledge_chunks
           WHERE id > ? ORDER BY id LIMIT ?`,
        )
        .all(cursor, batch) as Array<{ id: string; text: string; path: string }>;
      if (rows.length === 0) break;
      this.upsertMany(rows);
      n += rows.length;
      cursor = rows[rows.length - 1].id;
    }
    return n;
  }

  /**
   * 分批 + 让出事件循环的重建。禁止在构造/请求同步路径整库跑（会堵死 Gateway）。
   *
   * @param opts.batch - 每批条数
   * @param opts.onProgress - 进度回调
   * @returns 写入条数
   */
  async rebuildFromChunksAsync(
    opts?: { batch?: number; onProgress?: (done: number) => void },
  ): Promise<number> {
    if (!this.enabled) return 0;
    const batch = Math.max(50, opts?.batch ?? 200);
    this.db.raw.exec('DELETE FROM knowledge_chunks_fts');
    let cursor = '';
    let n = 0;
    for (;;) {
      const rows = this.db.raw
        .prepare(
          `SELECT id, text, path FROM knowledge_chunks
           WHERE id > ? ORDER BY id LIMIT ?`,
        )
        .all(cursor, batch) as Array<{ id: string; text: string; path: string }>;
      if (rows.length === 0) break;
      this.upsertMany(rows);
      n += rows.length;
      cursor = rows[rows.length - 1].id;
      opts?.onProgress?.(n);
      // 让出事件循环，保证 /health 与管理 API 可响应
      await new Promise<void>((r) => setImmediate(r));
    }
    return n;
  }
}
