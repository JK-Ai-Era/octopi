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

/** 可嵌入向量的 chunk 条件：非 code-tree（代码走 file_search / 原文） */
const EMBEDDABLE_WHERE =
  "(f.adapter_id IS NULL OR f.adapter_id NOT IN ('code-tree'))";

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
      const oldIds = (
        this.db.raw
          .prepare('SELECT id FROM knowledge_chunks WHERE file_id = ?')
          .all(fileId) as Array<{ id: string }>
      ).map((r) => r.id);
      this.deleteKnowledgeVec(oldIds);
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
   *
   * @param reason - 跳过原因（oversize / no_adapter / …）
   * @param size - 文件字节数（可选；便于 UI 展示真实体积）
   */
  markFileSkipped(
    sourceId: KnowledgeSourceId | string,
    path: string,
    reason: string,
    size?: number,
  ): void {
    this.markFileNonIndexed(sourceId, path, 'skipped', reason, size);
  }

  /**
   * 标记 error — **不删** 已有 chunks（网络抖动不得清库）；仅元数据。
   * 成功 `upsertFile` 才替换 chunks。
   */
  markFileError(
    sourceId: KnowledgeSourceId | string,
    path: string,
    error: string,
    size?: number,
  ): void {
    this.markFileNonIndexed(sourceId, path, 'error', error, size);
  }

  private markFileNonIndexed(
    sourceId: KnowledgeSourceId | string,
    path: string,
    status: 'skipped' | 'error',
    detail: string,
    size?: number,
  ): void {
    const now = Date.now();
    const existing = this.db.raw
      .prepare('SELECT id, chunk_count, size FROM knowledge_files WHERE source_id = ? AND path = ?')
      .get(sourceId, path) as { id?: string; chunk_count?: number; size?: number } | undefined;
    const fileId = existing?.id ?? `kf_${randomUUID().slice(0, 12)}`;
    const chunkCount = existing?.chunk_count ?? 0;
    const fileSize = size ?? existing?.size ?? 0;
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_files (
          id, source_id, path, content_hash, size, mtime, adapter_id, status, error, chunk_count, indexed_at
        ) VALUES (?, ?, ?, '', ?, 0, NULL, ?, ?, ?, ?)
        ON CONFLICT(source_id, path) DO UPDATE SET
          status=excluded.status,
          error=excluded.error,
          size=excluded.size,
          indexed_at=excluded.indexed_at`,
      )
      .run(fileId, sourceId, path, fileSize, status, detail, chunkCount, now);
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
   * 源文件分页 + 状态/扩展名筛选（管理面列表）
   *
   * @param sourceId - 源 id
   * @param opts - status / ext / q / page / pageSize
   * @returns 当前页 + 总数 + 状态/扩展名聚合（供筛选芯片）
   */
  listFilesPaged(
    sourceId: KnowledgeSourceId | string,
    opts?: {
      status?: 'indexed' | 'skipped' | 'error' | 'all';
      /** 扩展名（不含点；`all`/空 = 不限） */
      ext?: string;
      /** path 子串（大小写不敏感） */
      q?: string;
      page?: number;
      pageSize?: number;
    },
  ): {
    items: Array<IndexedFileRecord & { ext: string }>;
    total: number;
    page: number;
    pageSize: number;
    statusCounts: { indexed: number; skipped: number; error: number };
    extCounts: Array<{ ext: string; n: number }>;
  } {
    const page = Math.max(1, Math.floor(opts?.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(opts?.pageSize ?? 50)));
    const status = opts?.status && opts.status !== 'all' ? opts.status : null;
    const ext = opts?.ext?.trim().replace(/^\./, '').toLowerCase() || null;
    const q = opts?.q?.trim() || null;

    const where: string[] = ['source_id = ?'];
    const params: Array<string | number> = [String(sourceId)];
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (ext) {
      // 后缀精确（忽略大小写）
      where.push(`LOWER(path) LIKE ?`);
      params.push(`%.${ext}`);
    }
    if (q) {
      where.push(`LOWER(path) LIKE ?`);
      params.push(`%${q.toLowerCase()}%`);
    }
    const whereSql = where.join(' AND ');

    const totalRow = this.db.raw
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_files WHERE ${whereSql}`)
      .get(...params) as { n: number };
    const total = Number(totalRow?.n ?? 0);

    const rows = this.db.raw
      .prepare(
        `SELECT * FROM knowledge_files WHERE ${whereSql}
         ORDER BY path LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;

    const statusRows = this.db.raw
      .prepare(
        `SELECT status, COUNT(*) AS n FROM knowledge_files
         WHERE source_id = ? GROUP BY status`,
      )
      .all(sourceId) as Array<{ status: string; n: number }>;
    const statusCounts = { indexed: 0, skipped: 0, error: 0 };
    for (const r of statusRows) {
      if (r.status === 'indexed' || r.status === 'skipped' || r.status === 'error') {
        statusCounts[r.status] = Number(r.n);
      }
    }

    // 扩展名聚合：忽略当前 ext 筛选，便于切换类型（path 行数可控；admin 面偶发）
    const facetRows = this.db.raw
      .prepare(
        `SELECT path FROM knowledge_files WHERE source_id = ? AND status = COALESCE(?, status)`,
      )
      .all(sourceId, status) as Array<{ path: string }>;
    const extMap = new Map<string, number>();
    for (const r of facetRows) {
      const p = r.path;
      const dot = p.lastIndexOf('.');
      const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      const e = dot > slash && dot >= 0 ? p.slice(dot + 1).toLowerCase() : '';
      if (!e) continue;
      extMap.set(e, (extMap.get(e) ?? 0) + 1);
    }

    const items = rows.map((row) => {
      const rec = rowToFile(row);
      const path = rec.path;
      const dot = path.lastIndexOf('.');
      const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
      const e = dot > slash && dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
      return { ...rec, ext: e };
    });

    return {
      items,
      total,
      page,
      pageSize,
      statusCounts,
      extCounts: [...extMap.entries()]
        .map(([ext, n]) => ({ ext, n }))
        .sort((a, b) => b.n - a.n || a.ext.localeCompare(b.ext))
        .slice(0, 30),
    };
  }

  /**
   * 重做前失效 contentHash，强制下次 parse 跳过 isFresh。
   * **不删** chunks/embeddings：成功 upsert 才替换，失败不丢旧索引。
   *
   * @param sourceId - 源 id
   * @param path - 文件路径
   */
  invalidateFileForReparse(sourceId: KnowledgeSourceId | string, path: string): void {
    this.db.raw
      .prepare(
        `UPDATE knowledge_files SET content_hash = '' WHERE source_id = ? AND path = ?`,
      )
      .run(String(sourceId), path);
  }

  /**
   * 按筛选列出 path（批量重做用；不分页）
   *
   * @param sourceId - 源 id
   * @param opts - 与 listFilesPaged 相同筛选语义
   */
  listFilePathsFiltered(
    sourceId: KnowledgeSourceId | string,
    opts?: { status?: 'indexed' | 'skipped' | 'error' | 'all'; ext?: string; q?: string },
  ): string[] {
    const where: string[] = ['source_id = ?'];
    const params: Array<string | number> = [String(sourceId)];
    const status = opts?.status && opts.status !== 'all' ? opts.status : null;
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const ext = opts?.ext?.trim().replace(/^\./, '').toLowerCase();
    if (ext && ext !== 'all') {
      where.push('LOWER(path) LIKE ?');
      params.push(`%.${ext}`);
    }
    const q = opts?.q?.trim();
    if (q) {
      where.push('LOWER(path) LIKE ?');
      params.push(`%${q.toLowerCase()}%`);
    }
    const rows = this.db.raw
      .prepare(`SELECT path FROM knowledge_files WHERE ${where.join(' AND ')} ORDER BY path`)
      .all(...params) as Array<{ path: string }>;
    return rows.map((r) => r.path);
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
    const ids = (
      this.db.raw
        .prepare('SELECT id FROM knowledge_chunks WHERE source_id = ?')
        .all(sourceId) as Array<{ id: string }>
    ).map((r) => r.id);
    this.deleteKnowledgeVec(ids);
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
    const oldIds = (
      this.db.raw
        .prepare('SELECT id FROM knowledge_chunks WHERE source_id = ? AND path = ?')
        .all(sourceId, path) as Array<{ id: string }>
    ).map((r) => r.id);
    this.deleteKnowledgeVec(oldIds);
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
   * 批量删除 path（同一事务，减少 sync 往返）
   *
   * @param sourceId - 知识源 id
   * @param paths - 精确 path 列表
   */
  removeFiles(sourceId: KnowledgeSourceId | string, paths: string[]): void {
    if (paths.length === 0) return;
    const chunkIds: string[] = [];
    const select = this.db.raw.prepare(
      `SELECT id FROM knowledge_chunks WHERE source_id = ? AND path = ?`,
    );
    for (const p of paths) {
      const rows = select.all(sourceId, p) as Array<{ id: string }>;
      for (const r of rows) chunkIds.push(r.id);
    }
    this.db.raw.exec('BEGIN');
    try {
      if (chunkIds.length > 0) {
        this.deleteKnowledgeVec(chunkIds);
        const delEmb = this.db.raw.prepare('DELETE FROM knowledge_chunk_embeddings WHERE chunk_id = ?');
        for (const id of chunkIds) delEmb.run(id);
      }
      const delChunks = this.db.raw.prepare(
        'DELETE FROM knowledge_chunks WHERE source_id = ? AND path = ?',
      );
      const delFiles = this.db.raw.prepare(
        'DELETE FROM knowledge_files WHERE source_id = ? AND path = ?',
      );
      for (const p of paths) {
        delChunks.run(sourceId, p);
        delFiles.run(sourceId, p);
      }
      this.db.raw.exec('COMMIT');
    } catch (e) {
      this.db.raw.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * 删除路径及子树（目录被移出 / 删除）
   *
   * @param sourceId - 知识源 id
   * @param path - 文件或目录绝对路径
   */
  removePathTree(sourceId: KnowledgeSourceId | string, path: string): void {
    this.db.raw.exec('BEGIN');
    try {
      this.removeFile(sourceId, path);
      const likeSlash = `${path}/%`;
      const likeBack = `${path}\\%`;
      this.db.raw
        .prepare(
          `DELETE FROM knowledge_chunk_embeddings
           WHERE chunk_id IN (
             SELECT id FROM knowledge_chunks
             WHERE source_id = ? AND (path LIKE ? OR path LIKE ?)
           )`,
        )
        .run(sourceId, likeSlash, likeBack);
      this.db.raw
        .prepare(
          `DELETE FROM knowledge_chunks WHERE source_id = ? AND (path LIKE ? OR path LIKE ?)`,
        )
        .run(sourceId, likeSlash, likeBack);
      this.db.raw
        .prepare(
          `DELETE FROM knowledge_files WHERE source_id = ? AND (path LIKE ? OR path LIKE ?)`,
        )
        .run(sourceId, likeSlash, likeBack);
      this.db.raw.exec('COMMIT');
    } catch (e) {
      this.db.raw.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * 差量 prune：删除本轮 discover **未出现** 的 path（含 chunks）。
   * 仅在 discover 成功后调用；keepPaths 为空集时 no-op（防误清全库）。
   *
   * @param keepPaths - 应保留的 path 集
   * @param opts.allowEmptyKeep - walk 成功且目录为空时允许清空（默认 false）
   * @returns 删除的文件数
   */
  pruneMissing(
    sourceId: KnowledgeSourceId | string,
    keepPaths: ReadonlySet<string> | Iterable<string>,
    opts?: { allowEmptyKeep?: boolean },
  ): number {
    const keep = keepPaths instanceof Set ? keepPaths : new Set(keepPaths);
    if (keep.size === 0 && !opts?.allowEmptyKeep) return 0;
    const files = this.listFiles(sourceId);
    const gone = files.filter((f) => !keep.has(f.path)).map((f) => f.path);
    if (gone.length === 0) return 0;
    this.removeFiles(sourceId, gone);
    return gone.length;
  }

  sourceStats(sourceId: KnowledgeSourceId | string): {
    files: number;
    chunks: number;
    embeddableChunks: number;
    embeddings: number;
    errors: number;
    skipped: number;
  } {
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
    const ec = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_chunks c
         LEFT JOIN knowledge_files f ON f.source_id = c.source_id AND f.path = c.path
         WHERE c.source_id = ? AND ${EMBEDDABLE_WHERE}`,
      )
      .get(sourceId) as { n: number };
    const e = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_chunk_embeddings e
         JOIN knowledge_chunks c ON c.id = e.chunk_id
         WHERE c.source_id = ?`,
      )
      .get(sourceId) as { n: number };
    return {
      files: f?.total ?? 0,
      chunks: c?.n ?? 0,
      embeddableChunks: ec?.n ?? 0,
      embeddings: e?.n ?? 0,
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
   * 写入 chunk 向量（Float32 BLOB；sqlite-vec 可用时同步进 vec 表）
   */
  setChunkEmbedding(chunkId: KnowledgeChunkId | string, embedding: number[]): void {
    this.setChunkEmbeddings([[chunkId, embedding]]);
  }

  /**
   * 批量写向量（单事务，减少与 parse 写路径的锁竞争）
   *
   * @param rows - [chunkId, embedding] 列表
   */
  setChunkEmbeddings(rows: Array<[string, number[]]>): void {
    if (rows.length === 0) return;
    const upsert = this.db.raw.prepare(
      `INSERT INTO knowledge_chunk_embeddings (chunk_id, dimensions, embedding, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         dimensions=excluded.dimensions,
         embedding=excluded.embedding,
         created_at=excluded.created_at`,
    );
    this.db.raw.exec('BEGIN');
    try {
      const now = Date.now();
      for (const [chunkId, embedding] of rows) {
        upsert.run(chunkId, embedding.length, toF32Blob(embedding), now);
        this.upsertKnowledgeVec(chunkId, embedding);
      }
      this.db.raw.exec('COMMIT');
    } catch (e) {
      this.db.raw.exec('ROLLBACK');
      throw e;
    }
  }

  /** sqlite-vec 表名 */
  private static readonly VEC_TABLE = 'knowledge_vec';

  /** 确保 vec0 虚拟表（维度首次写入时确定） */
  private ensureVecTable(dimensions: number): boolean {
    if (!this.db.sqliteVecEnabled) return false;
    try {
      const row = this.db.raw
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
        )
        .get(KnowledgeIndexStore.VEC_TABLE) as { sql?: string } | undefined;
      if (row?.sql) {
        const m = /float\[(\d+)\]/i.exec(row.sql);
        return !m || Number(m[1]) === dimensions;
      }
      this.db.raw.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${KnowledgeIndexStore.VEC_TABLE} USING vec0(
          chunk_id TEXT PRIMARY KEY,
          embedding float[${dimensions}] distance_metric=cosine
        );
      `);
      return true;
    } catch {
      return false;
    }
  }

  private upsertKnowledgeVec(chunkId: KnowledgeSourceId | string | KnowledgeChunkId, embedding: number[]): void {
    if (!this.ensureVecTable(embedding.length)) return;
    try {
      // vec0 虚拟表不支持 INSERT … ON CONFLICT UPSERT → 必须 DELETE + INSERT
      this.db.raw
        .prepare(`DELETE FROM ${KnowledgeIndexStore.VEC_TABLE} WHERE chunk_id = ?`)
        .run(String(chunkId));
      this.db.raw
        .prepare(
          `INSERT INTO ${KnowledgeIndexStore.VEC_TABLE} (chunk_id, embedding)
           VALUES (?, ?)`,
        )
        .run(String(chunkId), toF32Blob(embedding));
    } catch {
      // vec 表不可用时忽略，检索走 JS 路径
    }
  }

  /** 删除 sqlite-vec 行（chunk 级清理；扩展未加载时 no-op） */
  private deleteKnowledgeVec(chunkIds: string[]): void {
    if (chunkIds.length === 0 || !this.db.sqliteVecEnabled) return;
    try {
      const del = this.db.raw.prepare(
        `DELETE FROM ${KnowledgeIndexStore.VEC_TABLE} WHERE chunk_id = ?`,
      );
      for (const id of chunkIds) del.run(String(id));
    } catch {
      // 扩展不可用 / 表不存在
    }
  }

  /**
   * 把已有 BLOB 向量回填进 sqlite-vec。
   *
   * **必须小批量 + 让出事件循环**：node:sqlite 同步，大循环会堵死 HTTP（中止按钮假死）。
   * 按 chunk_id 游标推进，避免每次从头 JOIN 大表。
   *
   * @param limit - 本轮最多回填条数（建议 ≤50）
   * @returns 本轮写入条数；扩展未启用时 0
   */
  async backfillVecFromEmbeddings(limit = 25): Promise<number> {
    if (!this.db.sqliteVecEnabled) return 0;
    if (this._vecBackfillBusy) return 0;
    this._vecBackfillBusy = true;
    try {
      const dimRow = this.db.raw
        .prepare(
          `SELECT dimensions FROM knowledge_chunk_embeddings
           WHERE dimensions > 0 ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { dimensions?: number } | undefined;
      const dims = Number(dimRow?.dimensions ?? 0);
      if (!dims || !this.ensureVecTable(dims)) return 0;

      const rows = this.db.raw
        .prepare(
          `SELECT chunk_id, embedding FROM knowledge_chunk_embeddings
           WHERE dimensions = ? AND chunk_id > ?
           ORDER BY chunk_id
           LIMIT ?`,
        )
        .all(dims, this._vecBackfillCursor, Math.min(50, Math.max(1, limit))) as Array<{
        chunk_id: string;
        embedding: Uint8Array | Buffer;
      }>;
      if (rows.length === 0) {
        // 游标到尾：重置，便于后续新向量（幂等重写也无害）
        this._vecBackfillCursor = '';
        return 0;
      }
      let n = 0;
      for (const r of rows) {
        try {
          this.db.raw
            .prepare(`DELETE FROM ${KnowledgeIndexStore.VEC_TABLE} WHERE chunk_id = ?`)
            .run(String(r.chunk_id));
          this.db.raw
            .prepare(
              `INSERT INTO ${KnowledgeIndexStore.VEC_TABLE} (chunk_id, embedding) VALUES (?, ?)`,
            )
            .run(String(r.chunk_id), r.embedding);
          n += 1;
          this._vecBackfillCursor = String(r.chunk_id);
        } catch {
          // 单条失败跳过
        }
        // 每条让出一次，保证 abort/HTTP 可调度
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return n;
    } finally {
      this._vecBackfillBusy = false;
    }
  }

  private _vecBackfillBusy = false;
  private _vecBackfillCursor = '';

  /**
   * 列出待嵌入 chunk（无向量行）
   *
   * **代码不进向量**：原文件已可 file_search；片段易失真。
   * 仅文档/正文类（text / markdown / document:* 等）参与 embedding。
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
         LEFT JOIN knowledge_files f ON f.source_id = c.source_id AND f.path = c.path
         WHERE c.source_id = ? AND e.chunk_id IS NULL
           AND ${EMBEDDABLE_WHERE}
         ORDER BY c.path, c.ordinal
         LIMIT ?`,
      )
      .all(sourceId, limit) as Array<{ id: string; text: string; path: string }>;
    return rows.map((r) => ({ id: asChunkId(r.id), text: r.text, path: r.path }));
  }

  /**
   * 向量覆盖度（0–1；无可嵌入 chunk 时为 1）
   */
  embeddingCoverage(sourceId: KnowledgeSourceId | string): number {
    const total = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_chunks c
         LEFT JOIN knowledge_files f ON f.source_id = c.source_id AND f.path = c.path
         WHERE c.source_id = ? AND ${EMBEDDABLE_WHERE}`,
      )
      .get(sourceId) as { n: number };
    if (!total?.n) return 1;
    const embedded = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_chunk_embeddings e
         JOIN knowledge_chunks c ON c.id = e.chunk_id
         LEFT JOIN knowledge_files f ON f.source_id = c.source_id AND f.path = c.path
         WHERE c.source_id = ? AND ${EMBEDDABLE_WHERE}`,
      )
      .get(sourceId) as { n: number };
    return Math.min(1, (embedded?.n ?? 0) / total.n);
  }

  /**
   * 向量检索：优先 sqlite-vec KNN；否则 JS cosine（BLOB）
   */
  vectorSearch(
    queryEmbedding: number[],
    opts: { sourceIds: KnowledgeSourceId[]; limit?: number },
  ): ChunkHit[] {
    if (opts.sourceIds.length === 0 || !queryEmbedding?.length) return [];
    const limit = opts.limit ?? 8;

    // vec 表可能尚未回填；0 命中时退 JS，避免空结果短路
    const viaVec = this.vectorSearchVec(queryEmbedding, opts, limit);
    if (viaVec && viaVec.length > 0) return viaVec;

    return this.vectorSearchJs(queryEmbedding, opts, limit);
  }

  /** sqlite-vec KNN（不可用时返回 null） */
  private vectorSearchVec(
    queryEmbedding: number[],
    opts: { sourceIds: KnowledgeSourceId[] },
    limit: number,
  ): ChunkHit[] | null {
    if (!this.db.sqliteVecEnabled) return null;
    if (!this.ensureVecTable(queryEmbedding.length)) return null;
    const placeholders = opts.sourceIds.map(() => '?').join(',');
    try {
      const rows = this.db.raw
        .prepare(
          `SELECT c.id, c.source_id, c.path, c.ordinal, c.text, c.start_line, c.end_line, v.distance AS distance
           FROM (
             SELECT chunk_id, distance
             FROM ${KnowledgeIndexStore.VEC_TABLE}
             WHERE embedding MATCH ?
               AND k = ?
           ) v
           JOIN knowledge_chunks c ON c.id = v.chunk_id
           WHERE c.source_id IN (${placeholders})
           ORDER BY v.distance ASC`,
        )
        .all(toF32Blob(queryEmbedding), Math.max(limit * 2, 16), ...opts.sourceIds) as Array<{
        id: string;
        source_id: string;
        path: string;
        ordinal: number;
        text: string;
        start_line: number;
        end_line: number;
        distance: number;
      }>;
      return rows.slice(0, limit).map((row) => ({
        chunkId: asChunkId(row.id),
        sourceId: asSourceId(row.source_id),
        path: row.path,
        ordinal: row.ordinal,
        text: row.text,
        startLine: row.start_line,
        endLine: row.end_line,
        score: 1 - Number(row.distance),
      }));
    } catch {
      return null;
    }
  }

  /** JS 余弦（Float32 BLOB；无 JSON.parse） */
  private vectorSearchJs(
    queryEmbedding: number[],
    opts: { sourceIds: KnowledgeSourceId[] },
    limit: number,
  ): ChunkHit[] {
    const placeholders = opts.sourceIds.map(() => '?').join(',');
    const rows = this.db.raw
      .prepare(
        `SELECT c.id, c.source_id, c.path, c.ordinal, c.text, c.start_line, c.end_line, e.embedding
         FROM knowledge_chunks c
         JOIN knowledge_chunk_embeddings e ON e.chunk_id = c.id
         WHERE c.source_id IN (${placeholders})
         LIMIT 200000`,
      )
      .all(...opts.sourceIds) as Array<{
      id: string;
      source_id: string;
      path: string;
      ordinal: number;
      text: string;
      start_line: number;
      end_line: number;
      embedding: Uint8Array | Buffer;
    }>;

    const hits: ChunkHit[] = [];
    for (const row of rows) {
      const emb = fromF32Blob(row.embedding);
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

/** number[] → float32 blob */
function toF32Blob(embedding: number[]): Buffer {
  const f32 = Float32Array.from(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** float32 blob → number[] */
function fromF32Blob(buf: Uint8Array | Buffer | null | undefined): number[] | null {
  if (!buf || buf.byteLength === 0) return null;
  if (buf.byteLength % 4 !== 0) return null;
  const u8 = buf instanceof Buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
  const f32 = new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
  return Array.from(f32);
}

/**
 * 内容指纹（新鲜度判断）
 *
 * @param content - UTF-8 文本或原始字节（二进制文档用 bytes）
 * @returns sha256 hex
 */
export function hashContent(content: string | Uint8Array): string {
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
