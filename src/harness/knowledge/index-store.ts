/**
 * KnowledgeIndexStore — files / chunks 投影 + 关键词检索（Phase A）
 *
 * Index 非权威；可整库重跑。检索用 Memory 同款 CJK 二元组分词。
 */

import { randomUUID, createHash } from 'node:crypto';
import { tokenizeKeywordQuery, scoreKeywordFields } from '../memory/sqlite/keyword-search.js';
import { cosineSimilarity } from '../memory/sqlite/vector-search.js';
import { KnowledgeDatabase } from './db.js';
import { asChunkId, asSourceId } from './types.js';
import type { KnowledgeChunkId, KnowledgeSourceId } from './types.js';
import type { KnowledgeChunkDraft } from './adapters.js';

export interface IndexedFileRecord {
  id: string;
  sourceId: KnowledgeSourceId | string;
  path: string;
  contentHash: string;
  size: number;
  mtime: number;
  adapterId: string | null;
  status: 'indexed' | 'skipped' | 'error';
  error?: string;
  chunkCount: number;
  indexedAt: number;
  externalUrl?: string;
  etag?: string;
  lastModified?: string;
}

export interface ChunkHit {
  chunkId: KnowledgeChunkId;
  sourceId: KnowledgeSourceId | string;
  path: string;
  ordinal: number;
  text: string;
  startLine: number;
  endLine: number;
  score: number;
}

export class KnowledgeIndexStore {
  constructor(private readonly db: KnowledgeDatabase) {}

  /**
   * 写入/替换某文件的 chunks（幂等：先删旧 chunk 与向量）
   */
  upsertFile(input: {
    sourceId: KnowledgeSourceId | string;
    path: string;
    contentHash: string;
    size: number;
    mtime: number;
    adapterId: string;
    chunks: KnowledgeChunkDraft[];
    externalUrl?: string;
    etag?: string;
    lastModified?: string;
  }): IndexedFileRecord {
    const now = Date.now();
    const existing = this.db.raw
      .prepare('SELECT id FROM knowledge_files WHERE source_id = ? AND path = ?')
      .get(input.sourceId, input.path) as { id?: string } | undefined;
    const fileId = existing?.id ?? `kf_${randomUUID().slice(0, 12)}`;

    this.db.raw.exec('BEGIN');
    try {
      this.db.raw
        .prepare(
          `DELETE FROM knowledge_chunk_embeddings
           WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE file_id = ?)`,
        )
        .run(fileId);
      this.db.raw.prepare('DELETE FROM knowledge_chunks WHERE file_id = ?').run(fileId);

      this.db.raw
        .prepare(
          `INSERT INTO knowledge_files (
            id, source_id, path, content_hash, size, mtime, adapter_id, status, error, chunk_count, indexed_at,
            external_url, etag, last_modified
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'indexed', NULL, ?, ?, ?, ?, ?)
          ON CONFLICT(source_id, path) DO UPDATE SET
            content_hash=excluded.content_hash,
            size=excluded.size,
            mtime=excluded.mtime,
            adapter_id=excluded.adapter_id,
            status='indexed',
            error=NULL,
            chunk_count=excluded.chunk_count,
            indexed_at=excluded.indexed_at,
            external_url=excluded.external_url,
            etag=excluded.etag,
            last_modified=excluded.last_modified`,
        )
        .run(
          fileId,
          input.sourceId,
          input.path,
          input.contentHash,
          input.size,
          input.mtime,
          input.adapterId,
          input.chunks.length,
          now,
          input.externalUrl ?? null,
          input.etag ?? null,
          input.lastModified ?? null,
        );

      const insertChunk = this.db.raw.prepare(
        `INSERT INTO knowledge_chunks (id, file_id, source_id, path, ordinal, text, start_line, end_line)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of input.chunks) {
        insertChunk.run(
          `kc_${randomUUID().slice(0, 12)}`,
          fileId,
          input.sourceId,
          input.path,
          c.ordinal,
          c.text,
          c.startLine,
          c.endLine,
        );
      }
      this.db.raw.exec('COMMIT');
    } catch (err) {
      try {
        this.db.raw.exec('ROLLBACK');
      } catch {
        // rollback 失败仅吞掉：上层以原异常为准，避免掩盖根因
      }
      throw err;
    }

    return {
      id: fileId,
      sourceId: input.sourceId,
      path: input.path,
      contentHash: input.contentHash,
      size: input.size,
      mtime: input.mtime,
      adapterId: input.adapterId,
      status: 'indexed',
      chunkCount: input.chunks.length,
      indexedAt: now,
      externalUrl: input.externalUrl,
      etag: input.etag,
      lastModified: input.lastModified,
    };
  }

  /**
   * 标记 skipped — **不删** 已有 chunks（瞬时/边界失败保旧索引）；仅元数据。
   */
  markFileSkipped(sourceId: KnowledgeSourceId | string, path: string, reason: string): void {
    this.markFileNonIndexed(sourceId, path, 'skipped', reason);
  }

  /**
   * 标记 error — **不删** 已有 chunks（网络抖动不得清库）；仅元数据。
   * 成功 `upsertFile` 才替换 chunks。
   */
  markFileError(sourceId: KnowledgeSourceId | string, path: string, error: string): void {
    this.markFileNonIndexed(sourceId, path, 'error', error);
  }

  private markFileNonIndexed(
    sourceId: KnowledgeSourceId | string,
    path: string,
    status: 'skipped' | 'error',
    detail: string,
  ): void {
    const now = Date.now();
    const existing = this.db.raw
      .prepare('SELECT id, chunk_count FROM knowledge_files WHERE source_id = ? AND path = ?')
      .get(sourceId, path) as { id?: string; chunk_count?: number } | undefined;
    const fileId = existing?.id ?? `kf_${randomUUID().slice(0, 12)}`;
    const chunkCount = existing?.chunk_count ?? 0;
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_files (
          id, source_id, path, content_hash, size, mtime, adapter_id, status, error, chunk_count, indexed_at
        ) VALUES (?, ?, ?, '', 0, 0, NULL, ?, ?, ?, ?)
        ON CONFLICT(source_id, path) DO UPDATE SET
          status=excluded.status,
          error=excluded.error,
          indexed_at=excluded.indexed_at`,
      )
      .run(fileId, sourceId, path, status, detail, chunkCount, now);
  }

  /**
   * 文件是否已用同一 contentHash 索引（且确有 chunk，防半写入）
   */
  isFresh(sourceId: KnowledgeSourceId | string, path: string, contentHash: string): boolean {
    const row = this.db.raw
      .prepare(
        `SELECT content_hash, chunk_count FROM knowledge_files
         WHERE source_id = ? AND path = ? AND status = 'indexed'`,
      )
      .get(sourceId, path) as { content_hash?: string; chunk_count?: number } | undefined;
    return (
      row?.content_hash === contentHash &&
      (row?.chunk_count ?? 0) > 0
    );
  }

  getFile(sourceId: KnowledgeSourceId | string, path: string): IndexedFileRecord | null {
    const row = this.db.raw
      .prepare('SELECT * FROM knowledge_files WHERE source_id = ? AND path = ?')
      .get(sourceId, path) as Record<string, unknown> | undefined;
    return row ? rowToFile(row) : null;
  }

  listFiles(sourceId: KnowledgeSourceId | string): IndexedFileRecord[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM knowledge_files WHERE source_id = ? ORDER BY path')
      .all(sourceId) as Array<Record<string, unknown>>;
    return rows.map(rowToFile);
  }

  /**
   * 单文件 purge（合规）：chunks + embeddings + files 行
   */
  purgePath(sourceId: KnowledgeSourceId | string, path: string): void {
    this.removeFile(sourceId, path);
  }

  /**
   * 源级 purge
   */
  purgeSource(sourceId: KnowledgeSourceId | string): void {
    this.clearSource(sourceId);
  }

  /**
   * 删除源下全部 index（卸载 / rebuild）
   */
  clearSource(sourceId: KnowledgeSourceId | string): void {
    this.db.raw
      .prepare(
        `DELETE FROM knowledge_chunk_embeddings
         WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE source_id = ?)`,
      )
      .run(sourceId);
    this.db.raw.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(sourceId);
    this.db.raw.prepare('DELETE FROM knowledge_files WHERE source_id = ?').run(sourceId);
  }

  removeFile(sourceId: KnowledgeSourceId | string, path: string): void {
    this.db.raw
      .prepare(
        `DELETE FROM knowledge_chunk_embeddings
         WHERE chunk_id IN (
           SELECT id FROM knowledge_chunks WHERE source_id = ? AND path = ?
         )`,
      )
      .run(sourceId, path);
    this.db.raw
      .prepare('DELETE FROM knowledge_chunks WHERE source_id = ? AND path = ?')
      .run(sourceId, path);
    this.db.raw
      .prepare('DELETE FROM knowledge_files WHERE source_id = ? AND path = ?')
      .run(sourceId, path);
  }

  /**
   * 差量 prune：删除本轮 discover **未出现** 的 path（含 chunks）。
   * 仅在 discover 成功后调用；keepPaths 为空集时 no-op（防误清全库）。
   *
   * @returns 删除的文件数
   */
  pruneMissing(
    sourceId: KnowledgeSourceId | string,
    keepPaths: ReadonlySet<string> | Iterable<string>,
  ): number {
    const keep = keepPaths instanceof Set ? keepPaths : new Set(keepPaths);
    if (keep.size === 0) return 0;
    const files = this.listFiles(sourceId);
    let removed = 0;
    for (const f of files) {
      if (!keep.has(f.path)) {
        this.removeFile(sourceId, f.path);
        removed += 1;
      }
    }
    return removed;
  }

  sourceStats(sourceId: KnowledgeSourceId | string): { files: number; chunks: number; errors: number; skipped: number } {
    const f = this.db.raw
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
           SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
         FROM knowledge_files WHERE source_id = ?`,
      )
      .get(sourceId) as { total: number; errors: number | null; skipped: number | null };
    const c = this.db.raw
      .prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE source_id = ?')
      .get(sourceId) as { n: number };
    return {
      files: f?.total ?? 0,
      chunks: c?.n ?? 0,
      errors: f?.errors ?? 0,
      skipped: f?.skipped ?? 0,
    };
  }

  /**
   * 关键词检索（CJK 二元组 + Latin）；限定 sourceIds（可见集）
   */
  search(
    query: string,
    opts: {
      sourceIds: KnowledgeSourceId[];
      limit?: number;
    },
  ): ChunkHit[] {
    const tokens = tokenizeKeywordQuery(query);
    if (tokens.length === 0 || opts.sourceIds.length === 0) return [];

    const limit = opts.limit ?? 8;
    const placeholders = opts.sourceIds.map(() => '?').join(',');
    const rows = this.db.raw
      .prepare(
        `SELECT id, source_id, path, ordinal, text, start_line, end_line
         FROM knowledge_chunks
         WHERE source_id IN (${placeholders})
         ORDER BY source_id, path, ordinal
         LIMIT 20000`,
      )
      .all(...opts.sourceIds) as Array<{
      id: string;
      source_id: string;
      path: string;
      ordinal: number;
      text: string;
      start_line: number;
      end_line: number;
    }>;

    const hits: ChunkHit[] = [];
    for (const row of rows) {
      const score = scoreKeywordFields(
        { content: row.text, tags: row.path },
        tokens,
      );
      if (score <= 0) continue;
      hits.push({
        chunkId: asChunkId(row.id),
        sourceId: asSourceId(row.source_id),
        path: row.path,
        ordinal: row.ordinal,
        text: row.text,
        startLine: row.start_line,
        endLine: row.end_line,
        score,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  // ── Phase B 向量 ──

  /**
   * 按 chunk id 读取
   */
  getChunkById(
    chunkId: KnowledgeChunkId | string,
  ): {
    id: KnowledgeChunkId;
    sourceId: KnowledgeSourceId | string;
    path: string;
    text: string;
    startLine: number;
    endLine: number;
  } | null {
    const row = this.db.raw
      .prepare(
        'SELECT id, source_id, path, text, start_line, end_line FROM knowledge_chunks WHERE id = ?',
      )
      .get(chunkId) as
      | {
          id: string;
          source_id: string;
          path: string;
          text: string;
          start_line: number;
          end_line: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: asChunkId(row.id),
      sourceId: asSourceId(row.source_id),
      path: row.path,
      text: row.text,
      startLine: row.start_line,
      endLine: row.end_line,
    };
  }

  /**
   * 按路径列出 chunks（可选行窗）
   */
  listChunksByPath(
    sourceId: KnowledgeSourceId | string,
    path: string,
    opts?: { startLine?: number; endLine?: number },
  ): Array<{
    id: KnowledgeChunkId;
    path: string;
    text: string;
    startLine: number;
    endLine: number;
  }> {
    const rows = this.db.raw
      .prepare(
        `SELECT id, path, text, start_line, end_line FROM knowledge_chunks
         WHERE source_id = ? AND path = ?
         ORDER BY ordinal`,
      )
      .all(sourceId, path) as Array<{
      id: string;
      path: string;
      text: string;
      start_line: number;
      end_line: number;
    }>;
    let mapped = rows.map((r) => ({
      id: asChunkId(r.id),
      path: r.path,
      text: r.text,
      startLine: r.start_line,
      endLine: r.end_line,
    }));
    if (opts?.startLine != null) {
      mapped = mapped.filter((c) => c.endLine >= opts.startLine!);
    }
    if (opts?.endLine != null) {
      mapped = mapped.filter((c) => c.startLine <= opts.endLine!);
    }
    return mapped;
  }

  /**
   * 写入 chunk 向量（JSON 冗余；P3 用 JS cosine）
   */
  setChunkEmbedding(chunkId: KnowledgeChunkId | string, embedding: number[]): void {
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_chunk_embeddings (chunk_id, dimensions, embedding_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET
           dimensions=excluded.dimensions,
           embedding_json=excluded.embedding_json,
           created_at=excluded.created_at`,
      )
      .run(chunkId, embedding.length, JSON.stringify(embedding), Date.now());
  }

  /**
   * 列出待嵌入 chunk（无向量行）
   */
  listChunksMissingEmbedding(sourceId: KnowledgeSourceId | string, limit = 100): Array<{
    id: KnowledgeChunkId;
    text: string;
    path: string;
  }> {
    const rows = this.db.raw
      .prepare(
        `SELECT c.id, c.text, c.path
         FROM knowledge_chunks c
         LEFT JOIN knowledge_chunk_embeddings e ON e.chunk_id = c.id
         WHERE c.source_id = ? AND e.chunk_id IS NULL
         ORDER BY c.path, c.ordinal
         LIMIT ?`,
      )
      .all(sourceId, limit) as Array<{ id: string; text: string; path: string }>;
    return rows.map((r) => ({ id: asChunkId(r.id), text: r.text, path: r.path }));
  }

  /**
   * 向量覆盖度（0–1；无 chunk 时为 1）
   */
  embeddingCoverage(sourceId: KnowledgeSourceId | string): number {
    const total = this.db.raw
      .prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE source_id = ?')
      .get(sourceId) as { n: number };
    if (!total?.n) return 1;
    const embedded = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_chunk_embeddings e
         JOIN knowledge_chunks c ON c.id = e.chunk_id
         WHERE c.source_id = ?`,
      )
      .get(sourceId) as { n: number };
    return Math.min(1, (embedded?.n ?? 0) / total.n);
  }

  /**
   * 向量检索（JS cosine）；embeddingJson 不可用的 chunk 跳过
   */
  vectorSearch(
    queryEmbedding: number[],
    opts: { sourceIds: KnowledgeSourceId[]; limit?: number },
  ): ChunkHit[] {
    if (opts.sourceIds.length === 0 || !queryEmbedding?.length) return [];
    const limit = opts.limit ?? 8;
    const placeholders = opts.sourceIds.map(() => '?').join(',');
    const rows = this.db.raw
      .prepare(
        `SELECT c.id, c.source_id, c.path, c.ordinal, c.text, c.start_line, c.end_line, e.embedding_json
         FROM knowledge_chunks c
         JOIN knowledge_chunk_embeddings e ON e.chunk_id = c.id
         WHERE c.source_id IN (${placeholders})
         LIMIT 20000`,
      )
      .all(...opts.sourceIds) as Array<{
      id: string;
      source_id: string;
      path: string;
      ordinal: number;
      text: string;
      start_line: number;
      end_line: number;
      embedding_json: string;
    }>;

    const hits: ChunkHit[] = [];
    for (const row of rows) {
      let emb: number[] | null = null;
      try {
        emb = JSON.parse(row.embedding_json) as number[];
      } catch {
        emb = null;
      }
      if (!emb?.length || emb.length !== queryEmbedding.length) continue;
      const sim = cosineSimilarity(queryEmbedding, emb);
      if (sim <= 0) continue;
      hits.push({
        chunkId: asChunkId(row.id),
        sourceId: asSourceId(row.source_id),
        path: row.path,
        ordinal: row.ordinal,
        text: row.text,
        startLine: row.start_line,
        endLine: row.end_line,
        score: sim,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function rowToFile(row: Record<string, unknown>): IndexedFileRecord {
  return {
    id: String(row.id),
    sourceId: asSourceId(String(row.source_id)),
    path: String(row.path),
    contentHash: String(row.content_hash ?? ''),
    size: Number(row.size ?? 0),
    mtime: Number(row.mtime ?? 0),
    adapterId: row.adapter_id == null ? null : String(row.adapter_id),
    status: String(row.status) as IndexedFileRecord['status'],
    error: row.error == null ? undefined : String(row.error),
    chunkCount: Number(row.chunk_count ?? 0),
    indexedAt: Number(row.indexed_at ?? 0),
    externalUrl: row.external_url == null ? undefined : String(row.external_url),
    etag: row.etag == null ? undefined : String(row.etag),
    lastModified: row.last_modified == null ? undefined : String(row.last_modified),
  };
}
