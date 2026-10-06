/**
 * FileIndexStore — File 本位索引投影（chunks 挂 file_id；path 在 Membership）
 */

import { randomUUID } from 'node:crypto';
import type { KnowledgeDatabase } from './db.js';
import { KnowledgeFts } from './fts.js';

export interface ChunkDraft {
  ordinal: number;
  text: string;
  startLine: number;
  endLine: number;
}

export interface UpsertFileResult {
  fileId: string;
  chunkCount: number;
  indexedAt: number;
}

export class FileIndexStore {
  private readonly fts: KnowledgeFts;

  constructor(private readonly db: KnowledgeDatabase) {
    this.fts = new KnowledgeFts(db);
  }

  /**
   * 覆盖写入该 File 的全部 chunk（原地更新 / 首次解析）。
   * 不触碰 memberships。
   */
  upsertFileContent(input: {
    fileId: string;
    adapterId?: string | null;
    contentHash?: string | null;
    size: number;
    mtime: number;
    chunks: ChunkDraft[];
  }): UpsertFileResult {
    const now = Date.now();
    this.db.raw.exec('BEGIN');
    try {
      const oldIds = (
        this.db.raw
          .prepare('SELECT id FROM knowledge_chunks WHERE file_id = ?')
          .all(input.fileId) as Array<{ id: string }>
      ).map((r) => r.id);
      this.dropChunks(oldIds);
      this.db.raw.prepare('DELETE FROM knowledge_chunks WHERE file_id = ?').run(input.fileId);

      this.db.raw
        .prepare(
          `UPDATE knowledge_files
           SET content_hash = ?, size = ?, mtime = ?, adapter_id = ?,
               status = 'indexed', error = NULL, chunk_count = ?, indexed_at = ?
           WHERE id = ?`,
        )
        .run(
          input.contentHash ?? null,
          input.size,
          input.mtime,
          input.adapterId ?? null,
          input.chunks.length,
          now,
          input.fileId,
        );

      const insertChunk = this.db.raw.prepare(
        `INSERT INTO knowledge_chunks (id, file_id, ordinal, text, start_line, end_line)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const ftsRows: Array<{ id: string; text: string; path: string }> = [];
      for (const c of input.chunks) {
        const cid = `kc_${randomUUID().slice(0, 12)}`;
        insertChunk.run(cid, input.fileId, c.ordinal, c.text, c.startLine, c.endLine);
        ftsRows.push({ id: cid, text: c.text, path: '' });
      }
      this.fts.upsertMany(ftsRows);
      this.db.raw.exec('COMMIT');
      return { fileId: input.fileId, chunkCount: input.chunks.length, indexedAt: now };
    } catch (err) {
      try {
        this.db.raw.exec('ROLLBACK');
      } catch {
        // 以原异常为准
      }
      throw err;
    }
  }

  markFileStatus(
    fileId: string,
    status: 'skipped' | 'error' | 'pending' | 'indexed',
    detail?: string,
  ): void {
    this.db.raw
      .prepare(
        `UPDATE knowledge_files SET status = ?, error = ?, indexed_at = ? WHERE id = ?`,
      )
      .run(status, detail ?? null, Date.now(), fileId);
  }

  /** purge File + chunks + embeddings + FTS（membership 已清） */
  purgeFile(fileId: string): void {
    const oldIds = (
      this.db.raw
        .prepare('SELECT id FROM knowledge_chunks WHERE file_id = ?')
        .all(fileId) as Array<{ id: string }>
    ).map((r) => r.id);
    this.dropChunks(oldIds);
    this.db.raw.prepare('DELETE FROM knowledge_chunks WHERE file_id = ?').run(fileId);
    this.db.raw.prepare('DELETE FROM knowledge_files WHERE id = ?').run(fileId);
  }

  private dropChunks(chunkIds: string[]): void {
    if (chunkIds.length === 0) return;
    const ph = chunkIds.map(() => '?').join(',');
    this.db.raw
      .prepare(`DELETE FROM knowledge_chunk_embeddings WHERE chunk_id IN (${ph})`)
      .run(...chunkIds);
    this.deleteKnowledgeVec(chunkIds);
    this.fts.removeMany(chunkIds);
  }

  private deleteKnowledgeVec(chunkIds: string[]): void {
    if (!this.db.sqliteVecEnabled || chunkIds.length === 0) return;
    try {
      this.db.raw
        .prepare(
          `DELETE FROM knowledge_vec_chunks WHERE rowid IN
             (SELECT rowid FROM knowledge_chunks WHERE id IN (${chunkIds.map(() => '?').join(',')}))`,
        )
        .run(...chunkIds);
    } catch {
      // 无 vec 表时忽略
    }
  }

  /**
   * 按可见 source 集合做关键词候选（chunk 去重；path 取 membership）。
   */
  searchKeywordVisible(
    query: string,
    visibleSourceIds: string[],
    limit: number,
  ): Array<{
    chunkId: string;
    fileId: string;
    sourceIds: string[];
    path: string;
    ordinal: number;
    text: string;
    startLine: number;
    endLine: number;
  }> {
    if (visibleSourceIds.length === 0 || limit <= 0) return [];
    const srcPh = visibleSourceIds.map(() => '?').join(',');
    // LIKE 预筛 + FTS 可选；此处先 LIKE（FTS 路径可后接）
    const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = this.db.raw
      .prepare(
        `SELECT c.id AS chunk_id, c.file_id, c.ordinal, c.text, c.start_line, c.end_line,
                m.source_id AS source_id, m.logical_path AS logical_path
         FROM knowledge_chunks c
         JOIN knowledge_memberships m ON m.file_id = c.file_id
         WHERE m.source_id IN (${srcPh})
           AND c.text LIKE ? ESCAPE '\\'
         LIMIT ?`,
      )
      .all(...visibleSourceIds, like, limit * 4) as Array<{
      chunk_id: string;
      file_id: string;
      ordinal: number;
      text: string;
      start_line: number;
      end_line: number;
      source_id: string;
      logical_path: string;
    }>;

    const byChunk = new Map<
      string,
      {
        chunkId: string;
        fileId: string;
        sourceIds: string[];
        path: string;
        ordinal: number;
        text: string;
        startLine: number;
        endLine: number;
      }
    >();
    for (const r of rows) {
      let hit = byChunk.get(r.chunk_id);
      if (!hit) {
        if (byChunk.size >= limit) continue;
        hit = {
          chunkId: r.chunk_id,
          fileId: r.file_id,
          sourceIds: [],
          path: r.logical_path,
          ordinal: r.ordinal,
          text: r.text,
          startLine: r.start_line,
          endLine: r.end_line,
        };
        byChunk.set(r.chunk_id, hit);
      }
      if (!hit.sourceIds.includes(r.source_id)) hit.sourceIds.push(r.source_id);
    }
    return [...byChunk.values()];
  }
}
