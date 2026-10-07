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
   *
   * `toks` 已预计算时直接写入，避免在写事务里跑 CJK 滑窗。
   */
  upsertMany(rows: Array<{ id: string; text: string; path?: string; toks?: string }>): void {
    if (!this.enabled || rows.length === 0) return;
    const del = this.db.raw.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?');
    const ins = this.db.raw.prepare(
      'INSERT INTO knowledge_chunks_fts (chunk_id, toks) VALUES (?, ?)',
    );
    for (const r of rows) {
      del.run(r.id);
      ins.run(r.id, r.toks ?? buildFtsTokens(r.text, r.path));
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
    // 批量 IN 删除：单条 DELETE 循环在数千 chunk 时会把事件循环堵成秒级
    const del = this.db.raw.prepare(
      `DELETE FROM knowledge_chunks_fts WHERE chunk_id IN (${chunkIds.map(() => '?').join(',')})`,
    );
    for (let i = 0; i < chunkIds.length; i += 400) {
      del.run(...chunkIds.slice(i, i + 400));
    }
  }

  /** 源级清空（卸载 / rebuild）— 经 Membership */
  clearSource(sourceId: string): void {
    if (!this.enabled) return;
    this.db.raw
      .prepare(
        `DELETE FROM knowledge_chunks_fts
         WHERE chunk_id IN (
           SELECT c.id FROM knowledge_chunks c
           JOIN knowledge_memberships m ON m.file_id = c.file_id
           WHERE m.source_id = ?
         )`,
      )
      .run(sourceId);
  }

  /**
   * MATCH 检索，返回 chunkId（已按可见 Membership 过滤）
   *
   * @returns 命中 chunk id 列表；FTS 不可用或 query 空时返回 null（调用方退 LIKE）
   */
  search(query: string, sourceIds: string[], limit: number): string[] | null {
    if (!this.enabled) return null;
    const match = buildFtsQuery(query);
    if (!match || sourceIds.length === 0) return null;
    const placeholders = sourceIds.map(() => '?').join(',');
    try {
      const rows = this.db.raw
        .prepare(
          `SELECT f.chunk_id AS id
           FROM knowledge_chunks_fts f
           JOIN knowledge_chunks c ON c.id = f.chunk_id
           JOIN knowledge_memberships m ON m.file_id = c.file_id
           WHERE knowledge_chunks_fts MATCH ?
             AND m.source_id IN (${placeholders})
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
          `SELECT id, text FROM knowledge_chunks
           WHERE id > ? ORDER BY id LIMIT ?`,
        )
        .all(cursor, batch) as Array<{ id: string; text: string }>;
      if (rows.length === 0) break;
      this.upsertMany(rows.map((r) => ({ id: r.id, text: r.text })));
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
    // 小批量 + 频繁让出：CJK 滑窗分词是主线程 CPU，批太大仍会饿死 /health
    const batch = Math.max(20, opts?.batch ?? 50);
    this.db.raw.exec('DELETE FROM knowledge_chunks_fts');
    let cursor = '';
    let n = 0;
    for (;;) {
      const rows = this.db.raw
        .prepare(
          `SELECT id, text FROM knowledge_chunks
           WHERE id > ? ORDER BY id LIMIT ?`,
        )
        .all(cursor, batch) as Array<{ id: string; text: string }>;
      if (rows.length === 0) break;
      this.upsertMany(rows.map((r) => ({ id: r.id, text: r.text })));
      n += rows.length;
      cursor = rows[rows.length - 1].id;
      opts?.onProgress?.(n);
      await new Promise<void>((r) => setImmediate(r));
    }
    return n;
  }
}
