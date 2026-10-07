/**
 * KnowledgeIndexStore — File 本位索引投影
 *
 * chunk/file 挂 file_id；logical path 在 Membership。
 * sourceId+path 的 API 保留为「Membership 视图」，内部按 identity 去重。
 */

import { randomUUID, createHash } from 'node:crypto';
import { tokenizeKeywordQuery, scoreKeywordFields } from '../memory/sqlite/keyword-search.js';
import { cosineSimilarity } from '../memory/sqlite/vector-search.js';
import { KnowledgeDatabase } from './db.js';
import { KnowledgeFts } from './fts.js';
import { queryBuckets, scoreAnnCandidates, vectorBucket, VECTOR_BUCKETS } from './vector-ann.js';
import { toVecBlob } from '../memory/sqlite/sqlite-vec.js';
import { asChunkId, asSourceId } from './types.js';
import type { KnowledgeChunkId, KnowledgeSourceId } from './types.js';
import type { KnowledgeChunkDraft } from './adapters.js';
import { normalizePathLexical } from './file-identity.js';

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
  status: 'indexed' | 'indexing' | 'skipped' | 'error';
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
  /** 共享 File 的全部可见绑定 */
  sourceIds?: string[];
  /** sourceId → logical path */
  logicalPaths?: Record<string, string>;
}

function defaultIdentityKey(path: string): string {
  try {
    return `path:${normalizePathLexical(path)}`;
  } catch {
    return `path:${path.replace(/\\/g, '/')}`;
  }
}

function rowToFile(row: Record<string, unknown>): IndexedFileRecord {
  return {
    id: String(row.id),
    sourceId: asSourceId(String(row.source_id ?? row.membership_source_id ?? '')),
    path: String(row.logical_path ?? row.path ?? ''),
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

export class KnowledgeIndexStore {
  private readonly fts: KnowledgeFts;
  private ftsBackfillPromise: Promise<number> | null = null;
  private vecTableReady = false;

  constructor(private readonly db: KnowledgeDatabase) {
    this.fts = new KnowledgeFts(db);
  }

  get ftsAvailable(): boolean {
    return this.fts.available;
  }

  get ftsBackfillRunning(): boolean {
    return this.ftsBackfillPromise != null;
  }

  ensureFtsBackfill(): Promise<number> {
    if (!this.fts.available) return Promise.resolve(0);
    if (this.ftsBackfillPromise) return this.ftsBackfillPromise;
    const n = (
      this.db.raw.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get() as { n: number }
    ).n;
    const ftsN = (
      this.db.raw.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks_fts').get() as { n: number }
    ).n;
    if (n === 0 || ftsN > 0) return Promise.resolve(0);
    this.ftsBackfillPromise = this.fts
      .rebuildFromChunksAsync()
      .catch(() => 0)
      .finally(() => {
        this.ftsBackfillPromise = null;
      });
    return this.ftsBackfillPromise;
  }

  /** 解析或创建 File（identity 去重）+ Membership */
  private resolveFile(
    sourceId: string,
    path: string,
    meta: { identityKey?: string; size?: number; mtime?: number; tenantId?: string },
  ): string {
    const identityKey = meta.identityKey ?? defaultIdentityKey(path);
    const tenant = meta.tenantId ?? 'default';
    const now = Date.now();
    let row = this.db.raw
      .prepare('SELECT id, size, mtime FROM knowledge_files WHERE tenant_id = ? AND identity_key = ?')
      .get(tenant, identityKey) as { id: string; size: number; mtime: number } | undefined;
    if (!row) {
      const id = `kf_${randomUUID().slice(0, 12)}`;
      this.db.raw
        .prepare(
          `INSERT INTO knowledge_files
             (id, tenant_id, identity_key, size, mtime, content_hash, status, chunk_count, indexed_at)
           VALUES (?, ?, ?, ?, ?, NULL, 'pending', 0, ?)`,
        )
        .run(id, tenant, identityKey, meta.size ?? 0, meta.mtime ?? 0, now);
      row = { id, size: meta.size ?? 0, mtime: meta.mtime ?? 0 };
    } else if (
      (meta.size != null && meta.size !== row.size) ||
      (meta.mtime != null && meta.mtime !== row.mtime)
    ) {
      this.db.raw
        .prepare('UPDATE knowledge_files SET size = ?, mtime = ? WHERE id = ?')
        .run(meta.size ?? row.size, meta.mtime ?? row.mtime, row.id);
    }
    const logical = path.replace(/\\/g, '/');
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_memberships (source_id, file_id, logical_path, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_id, logical_path) DO UPDATE SET file_id = excluded.file_id`,
      )
      .run(sourceId, row.id, logical, now);
    return row.id;
  }

  /**
   * 替换文件索引。chunk/FTS **分批**写入并让出事件循环，
   * 大 xlsx 数千 chunk 不得整文件一个同步事务堵死 Service。
   *
   * 语义：旧 chunk 先清；`status='indexing'` 直到全部批次落库后才 `indexed`。
   * 检索不认 `indexing`（半成品）。批次失败/中止会清掉 partial chunks，
   * 并留在 `indexing`（chunk_count=0）供 gap 扫描重试——不得把半成品标成 `error`
   * 而让 partial 变得可搜。
   */
  async upsertFile(
    input: {
      sourceId: KnowledgeSourceId | string;
      path: string;
      contentHash: string;
      size: number;
      mtime: number;
      adapterId: string;
      chunks: KnowledgeChunkDraft[];
      identityKey?: string;
      externalUrl?: string;
      etag?: string;
      lastModified?: string;
    },
    opts?: { batchSize?: number; signal?: AbortSignal },
  ): Promise<IndexedFileRecord> {
    const now = Date.now();
    const batchSize = Math.max(50, opts?.batchSize ?? 200);
    const signal = opts?.signal;
    const fileId = this.resolveFile(String(input.sourceId), input.path, {
      identityKey: input.identityKey,
      size: input.size,
      mtime: input.mtime,
    });

    if (signal?.aborted) {
      this.markUpsertIncomplete(fileId, 'aborted');
      throw new Error('aborted');
    }

    // 旧索引作废（含 embeddings/FTS/vec）
    this.db.raw.exec('BEGIN');
    try {
      const oldIds = (
        this.db.raw
          .prepare('SELECT id FROM knowledge_chunks WHERE file_id = ?')
          .all(fileId) as Array<{ id: string }>
      ).map((r) => r.id);
      this.dropChunks(oldIds);
      this.db.raw.prepare('DELETE FROM knowledge_chunks WHERE file_id = ?').run(fileId);
      this.db.raw
        .prepare(
          `UPDATE knowledge_files
           SET content_hash = ?, size = ?, mtime = ?, adapter_id = ?,
               status = 'indexing', error = NULL, chunk_count = 0, indexed_at = ?,
               external_url = ?, etag = ?, last_modified = ?
           WHERE id = ?`,
        )
        .run(
          input.contentHash,
          input.size,
          input.mtime,
          input.adapterId,
          now,
          input.externalUrl ?? null,
          input.etag ?? null,
          input.lastModified ?? null,
          fileId,
        );
      this.db.raw.exec('COMMIT');
    } catch (err) {
      try {
        this.db.raw.exec('ROLLBACK');
      } catch {
        // 以原异常为准
      }
      throw err;
    }

    for (let offset = 0; offset < input.chunks.length; offset += batchSize) {
      if (signal?.aborted) {
        this.markUpsertIncomplete(fileId, 'aborted');
        throw new Error('aborted');
      }
      const batch = input.chunks.slice(offset, offset + batchSize);
      this.db.raw.exec('BEGIN');
      try {
        const insertChunk = this.db.raw.prepare(
          `INSERT INTO knowledge_chunks (id, file_id, ordinal, text, start_line, end_line)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const ftsRows: Array<{ id: string; text: string; path?: string; toks?: string }> = [];
        for (const c of batch) {
          const cid = `kc_${randomUUID().slice(0, 12)}`;
          insertChunk.run(cid, fileId, c.ordinal, c.text, c.startLine, c.endLine);
          ftsRows.push({
            id: cid,
            text: c.text,
            path: input.path,
            ...(c.ftsToks != null ? { toks: c.ftsToks } : {}),
          });
        }
        this.fts.upsertMany(ftsRows);
        this.db.raw.exec('COMMIT');
      } catch (err) {
        try {
          this.db.raw.exec('ROLLBACK');
        } catch {
          // 以原异常为准
        }
        const message = err instanceof Error ? err.message : String(err);
        this.markUpsertIncomplete(fileId, message);
        throw err;
      }
      if (offset + batchSize < input.chunks.length) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }

    if (signal?.aborted) {
      this.markUpsertIncomplete(fileId, 'aborted');
      throw new Error('aborted');
    }

    this.db.raw
      .prepare(
        `UPDATE knowledge_files
         SET status = 'indexed', error = NULL, chunk_count = ?, indexed_at = ?
         WHERE id = ?`,
      )
      .run(input.chunks.length, now, fileId);

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
   * 半写入收尾：清掉已落地的 partial chunks，回到可重试的 `indexing`。
   * 不得标成 `error`——error 行上的 partial 会被检索捞出。
   */
  private markUpsertIncomplete(fileId: string, message: string): void {
    try {
      this.db.raw.exec('BEGIN');
      const ids = (
        this.db.raw
          .prepare('SELECT id FROM knowledge_chunks WHERE file_id = ?')
          .all(fileId) as Array<{ id: string }>
      ).map((r) => r.id);
      this.dropChunks(ids);
      this.db.raw.prepare('DELETE FROM knowledge_chunks WHERE file_id = ?').run(fileId);
      this.db.raw
        .prepare(
          `UPDATE knowledge_files
           SET status = 'indexing', chunk_count = 0, error = ?, indexed_at = ?
           WHERE id = ?`,
        )
        .run(message, Date.now(), fileId);
      this.db.raw.exec('COMMIT');
    } catch {
      try {
        this.db.raw.exec('ROLLBACK');
      } catch {
        // 清理失败时至少保证调用方仍看到原异常；半成品由 gap 扫描按 indexing 重做
      }
    }
  }

  markFileSkipped(
    sourceId: KnowledgeSourceId | string,
    path: string,
    reason: string,
    size?: number,
    identityKey?: string,
  ): void {
    this.markFileNonIndexed(sourceId, path, 'skipped', reason, size, identityKey);
  }

  markFileError(
    sourceId: KnowledgeSourceId | string,
    path: string,
    error: string,
    size?: number,
    identityKey?: string,
  ): void {
    this.markFileNonIndexed(sourceId, path, 'error', error, size, identityKey);
  }

  /**
   * 标记 skipped/error — **不删** 已有 chunks。
   * 若已有 membership，只改状态；**不得**用 path-identity 新建 File 顶掉带 chunk 的行。
   */
  private markFileNonIndexed(
    sourceId: KnowledgeSourceId | string,
    path: string,
    status: 'skipped' | 'error',
    detail: string,
    size?: number,
    identityKey?: string,
  ): void {
    const logical = path.replace(/\\/g, '/');
    const existing = this.db.raw
      .prepare(
        `SELECT file_id FROM knowledge_memberships WHERE source_id = ? AND logical_path = ?`,
      )
      .get(String(sourceId), logical) as { file_id: string } | undefined;
    if (existing?.file_id) {
      this.db.raw
        .prepare('UPDATE knowledge_files SET status = ?, error = ?, indexed_at = ? WHERE id = ?')
        .run(status, detail, Date.now(), existing.file_id);
      return;
    }
    // 优先真实 identity（win:/unix:），避免 path: 与成功路径分裂出零认领行
    const fileId = this.resolveFile(String(sourceId), path, { size, identityKey });
    this.db.raw
      .prepare('UPDATE knowledge_files SET status = ?, error = ?, indexed_at = ? WHERE id = ?')
      .run(status, detail, Date.now(), fileId);
  }

  /**
   * 清零认领的 path: 降级 File（错误路径与成功路径 identity 分裂残留）。
   *
   * @returns 删除的 File 行数
   */
  purgeOrphanPathIdentityFiles(): number {
    const res = this.db.raw
      .prepare(
        `DELETE FROM knowledge_files
         WHERE identity_key LIKE 'path:%'
           AND NOT EXISTS (
             SELECT 1 FROM knowledge_memberships m WHERE m.file_id = knowledge_files.id
           )`,
      )
      .run();
    return Number(res.changes ?? 0);
  }

  isFresh(sourceId: KnowledgeSourceId | string, path: string, contentHash: string): boolean {
    const logical = path.replace(/\\/g, '/');
    const row = this.db.raw
      .prepare(
        `SELECT f.content_hash AS content_hash, f.chunk_count AS chunk_count
         FROM knowledge_memberships m
         JOIN knowledge_files f ON f.id = m.file_id
         WHERE m.source_id = ? AND m.logical_path = ? AND f.status <> 'indexing'`,
      )
      .get(String(sourceId), logical) as
      | { content_hash?: string; chunk_count?: number }
      | undefined;
    return row?.content_hash === contentHash && (row?.chunk_count ?? 0) > 0;
  }

  invalidateFileForReparse(
    sourceId: KnowledgeSourceId | string,
    path: string,
  ): void {
    const logical = path.replace(/\\/g, '/');
    const row = this.db.raw
      .prepare(
        `SELECT file_id FROM knowledge_memberships WHERE source_id = ? AND logical_path = ?`,
      )
      .get(String(sourceId), logical) as { file_id: string } | undefined;
    if (!row) return;
    this.db.raw
      .prepare(`UPDATE knowledge_files SET content_hash = '' WHERE id = ?`)
      .run(row.file_id);
  }

  getFile(sourceId: KnowledgeSourceId | string, path: string): IndexedFileRecord | null {
    const logical = path.replace(/\\/g, '/');
    const row = this.db.raw
      .prepare(
        `SELECT f.*, m.source_id AS membership_source_id, m.logical_path AS logical_path
         FROM knowledge_memberships m
         JOIN knowledge_files f ON f.id = m.file_id
         WHERE m.source_id = ? AND m.logical_path = ?`,
      )
      .get(String(sourceId), logical) as Record<string, unknown> | undefined;
    return row ? rowToFile(row) : null;
  }

  listFiles(sourceId: KnowledgeSourceId | string): IndexedFileRecord[] {
    const rows = this.db.raw
      .prepare(
        `SELECT f.*, m.source_id AS membership_source_id, m.logical_path AS logical_path
         FROM knowledge_memberships m
         JOIN knowledge_files f ON f.id = m.file_id
         WHERE m.source_id = ? ORDER BY m.logical_path`,
      )
      .all(String(sourceId)) as Array<Record<string, unknown>>;
    return rows.map(rowToFile);
  }

  listFilesPaged(
    sourceId: KnowledgeSourceId | string,
    opts?: {
      status?: 'indexed' | 'skipped' | 'error' | 'all';
      ext?: string;
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
    const all = this.listFiles(sourceId);
    let items = all;
    if (opts?.status && opts.status !== 'all') {
      items = items.filter((f) => f.status === opts.status);
    }
    if (opts?.ext && opts.ext !== 'all') {
      const ext = opts.ext.replace(/^\./, '').toLowerCase();
      items = items.filter((f) => f.path.toLowerCase().endsWith(`.${ext}`));
    }
    if (opts?.q) {
      const q = opts.q.toLowerCase();
      items = items.filter((f) => f.path.toLowerCase().includes(q));
    }
    const statusCounts = { indexed: 0, skipped: 0, error: 0 };
    const extMap = new Map<string, number>();
    for (const f of all) {
      if (f.status === 'indexed' || f.status === 'skipped' || f.status === 'error') {
        statusCounts[f.status] += 1;
      }
      const ext = f.path.includes('.') ? (f.path.split('.').pop() ?? '').toLowerCase() : '';
      if (ext) extMap.set(ext, (extMap.get(ext) ?? 0) + 1);
    }
    const pageSize = opts?.pageSize ?? 50;
    const page = Math.max(1, opts?.page ?? 1);
    const start = (page - 1) * pageSize;
    const slice = items.slice(start, start + pageSize).map((f) => ({
      ...f,
      ext: f.path.includes('.') ? (f.path.split('.').pop() ?? '').toLowerCase() : '',
    }));
    return {
      items: slice,
      total: items.length,
      page,
      pageSize,
      statusCounts,
      extCounts: [...extMap.entries()].map(([ext, n]) => ({ ext, n })),
    };
  }

  listFilePathsFiltered(
    sourceId: KnowledgeSourceId | string,
    filter?: { status?: string; ext?: string; max?: number },
  ): string[] {
    const rows = this.db.raw
      .prepare(
        `SELECT m.logical_path AS path, f.status AS status
         FROM knowledge_memberships m
         JOIN knowledge_files f ON f.id = m.file_id
         WHERE m.source_id = ? ORDER BY m.logical_path`,
      )
      .all(String(sourceId)) as Array<{ path: string; status: string }>;
    let out = rows.map((r) => r.path);
    if (filter?.status) {
      out = rows.filter((r) => r.status === filter.status).map((r) => r.path);
    }
    if (filter?.ext && filter.ext !== 'all') {
      const ext = filter.ext.replace(/^\./, '').toLowerCase();
      out = out.filter((p) => p.toLowerCase().endsWith(`.${ext}`));
    }
    if (filter?.max != null) out = out.slice(0, filter.max);
    return out;
  }

  /** 解绑 path；File 仅在零认领时 purge */
  removeFile(sourceId: KnowledgeSourceId | string, path: string): void {
    const logical = path.replace(/\\/g, '/');
    const row = this.db.raw
      .prepare(
        `SELECT file_id FROM knowledge_memberships WHERE source_id = ? AND logical_path = ?`,
      )
      .get(String(sourceId), logical) as { file_id: string } | undefined;
    this.db.raw
      .prepare('DELETE FROM knowledge_memberships WHERE source_id = ? AND logical_path = ?')
      .run(String(sourceId), logical);
    if (!row) return;
    const n = (
      this.db.raw
        .prepare('SELECT COUNT(*) AS n FROM knowledge_memberships WHERE file_id = ?')
        .get(row.file_id) as { n: number }
    ).n;
    if (n === 0) this.purgeFileRow(row.file_id);
  }

  removeFiles(sourceId: KnowledgeSourceId | string, paths: string[]): void {
    for (const p of paths) this.removeFile(sourceId, p);
  }

  removePathTree(sourceId: KnowledgeSourceId | string, path: string): void {
    const prefix = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const rows = this.db.raw
      .prepare(
        `SELECT logical_path FROM knowledge_memberships
         WHERE source_id = ? AND (logical_path = ? OR logical_path LIKE ? ESCAPE '\\')`,
      )
      .all(String(sourceId), prefix, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`) as Array<{
      logical_path: string;
    }>;
    for (const r of rows) this.removeFile(sourceId, r.logical_path);
  }

  clearSource(sourceId: KnowledgeSourceId | string): void {
    const rows = this.db.raw
      .prepare('SELECT file_id FROM knowledge_memberships WHERE source_id = ?')
      .all(String(sourceId)) as Array<{ file_id: string }>;
    this.db.raw
      .prepare('DELETE FROM knowledge_memberships WHERE source_id = ?')
      .run(String(sourceId));
    for (const r of rows) {
      const n = (
        this.db.raw
          .prepare('SELECT COUNT(*) AS n FROM knowledge_memberships WHERE file_id = ?')
          .get(r.file_id) as { n: number }
      ).n;
      if (n === 0) this.purgeFileRow(r.file_id);
    }
  }

  purgePath(sourceId: KnowledgeSourceId | string, path: string): void {
    this.removeFile(sourceId, path);
  }

  /** 按 fileId 物理删除（membership 已清） */
  purgeFile(fileId: string): void {
    this.purgeFileRow(fileId);
  }

  purgeSource(sourceId: KnowledgeSourceId | string): void {
    this.clearSource(sourceId);
  }

  private purgeFileRow(fileId: string): void {
    const oldIds = (
      this.db.raw
        .prepare('SELECT id FROM knowledge_chunks WHERE file_id = ?')
        .all(fileId) as Array<{ id: string }>
    ).map((r) => r.id);
    this.dropChunks(oldIds);
    this.db.raw.prepare('DELETE FROM knowledge_chunks WHERE file_id = ?').run(fileId);
    this.db.raw.prepare('DELETE FROM knowledge_jobs WHERE file_id = ?').run(fileId);
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
      const del = this.db.raw.prepare(
        `DELETE FROM knowledge_vec WHERE chunk_id IN (${chunkIds.map(() => '?').join(',')})`,
      );
      for (let i = 0; i < chunkIds.length; i += 400) {
        del.run(...chunkIds.slice(i, i + 400));
      }
    } catch {
      // 无 vec 表时忽略
    }
  }

  pruneMissing(
    sourceId: KnowledgeSourceId | string,
    keepPaths: ReadonlySet<string> | Iterable<string>,
    opts?: { allowEmptyKeep?: boolean },
  ): number {
    // keep 可能来自 discover（Windows 反斜杠）；logical_path 存的是正斜杠。两边都归一再比。
    const normalize = (p: string): string => p.replace(/\\/g, '/');
    const keep = new Set(
      Array.from(keepPaths instanceof Set ? keepPaths : new Set(keepPaths), normalize),
    );
    // discover 成功且目录为空时允许清空（契约 §6.2）；空 keep 默认 no-op 防误清
    if (keep.size === 0 && !opts?.allowEmptyKeep) return 0;
    const files = this.listFiles(sourceId);
    const gone = files.filter((f) => !keep.has(normalize(f.path))).map((f) => f.path);
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
           SUM(CASE WHEN f.status = 'error' THEN 1 ELSE 0 END) AS errors,
           SUM(CASE WHEN f.status = 'skipped' THEN 1 ELSE 0 END) AS skipped
         FROM knowledge_memberships m
         JOIN knowledge_files f ON f.id = m.file_id
         WHERE m.source_id = ?`,
      )
      .get(String(sourceId)) as { total: number; errors: number | null; skipped: number | null };
    const c = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_chunks c
         JOIN knowledge_memberships m ON m.file_id = c.file_id
         WHERE m.source_id = ?`,
      )
      .get(String(sourceId)) as { n: number };
    const ec = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_chunks c
         JOIN knowledge_files f ON f.id = c.file_id
         JOIN knowledge_memberships m ON m.file_id = c.file_id
         WHERE m.source_id = ? AND ${EMBEDDABLE_WHERE}`,
      )
      .get(String(sourceId)) as { n: number };
    const e = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_chunk_embeddings e
         JOIN knowledge_chunks c ON c.id = e.chunk_id
         JOIN knowledge_memberships m ON m.file_id = c.file_id
         WHERE m.source_id = ?`,
      )
      .get(String(sourceId)) as { n: number };
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
   * 关键词检索。sourceIds = 可见 Membership；chunk 按 file 去重。
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

    type Row = {
      id: string;
      file_id: string;
      ordinal: number;
      text: string;
      start_line: number;
      end_line: number;
      source_id: string;
      logical_path: string;
    };

    let rows: Row[] | null = null;
    const ftsIds = this.fts.search(query, opts.sourceIds as string[], Math.max(limit * 4, 32));
    if (ftsIds && ftsIds.length > 0) {
      const idPh = ftsIds.map(() => '?').join(',');
      rows = this.db.raw
        .prepare(
          `SELECT c.id, c.file_id, c.ordinal, c.text, c.start_line, c.end_line,
                  m.source_id, m.logical_path
           FROM knowledge_chunks c
           JOIN knowledge_files f ON f.id = c.file_id AND f.status <> 'indexing'
           JOIN knowledge_memberships m ON m.file_id = c.file_id
           WHERE c.id IN (${idPh}) AND m.source_id IN (${placeholders})`,
        )
        .all(...ftsIds, ...opts.sourceIds) as Row[];
    }

    if (!rows || rows.length === 0) {
      const likeClauses: string[] = [];
      const likeParams: string[] = [];
      for (const token of tokens) {
        const like = `%${token.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        likeClauses.push(`LOWER(c.text) LIKE ? ESCAPE '\\'`);
        likeParams.push(like);
        likeClauses.push(`LOWER(m.logical_path) LIKE ? ESCAPE '\\'`);
        likeParams.push(like);
      }
      rows = this.db.raw
        .prepare(
          `SELECT c.id, c.file_id, c.ordinal, c.text, c.start_line, c.end_line,
                  m.source_id, m.logical_path
           FROM knowledge_chunks c
           JOIN knowledge_files f ON f.id = c.file_id AND f.status <> 'indexing'
           JOIN knowledge_memberships m ON m.file_id = c.file_id
           WHERE m.source_id IN (${placeholders})
             AND (${likeClauses.join(' OR ')})
           LIMIT ?`,
        )
        .all(...opts.sourceIds, ...likeParams, Math.max(limit * 8, 64)) as Row[];
    }

    const byChunk = new Map<
      string,
      {
        chunkId: string;
        fileId: string;
        sourceIds: string[];
        logicalPaths: Record<string, string>;
        path: string;
        ordinal: number;
        text: string;
        startLine: number;
        endLine: number;
        score: number;
      }
    >();
    for (const r of rows) {
      let h = byChunk.get(r.id);
      if (!h) {
        if (byChunk.size >= limit * 3) continue;
        const score = scoreKeywordFields({ content: r.text, tags: r.logical_path }, tokens);
        h = {
          chunkId: r.id,
          fileId: r.file_id,
          sourceIds: [],
          logicalPaths: {},
          path: r.logical_path,
          ordinal: r.ordinal,
          text: r.text,
          startLine: r.start_line,
          endLine: r.end_line,
          score: score ?? 0,
        };
        byChunk.set(r.id, h);
      }
      if (!h.sourceIds.includes(r.source_id)) h.sourceIds.push(r.source_id);
      h.logicalPaths[r.source_id] = r.logical_path;
    }

    return [...byChunk.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((h) => ({
        chunkId: asChunkId(h.chunkId),
        sourceId: asSourceId(h.sourceIds[0] ?? ''),
        path: h.path,
        ordinal: h.ordinal,
        text: h.text,
        startLine: h.startLine,
        endLine: h.endLine,
        score: h.score,
        // 契约 §8.4：共享 File 多绑定溯源
        sourceIds: h.sourceIds,
        logicalPaths: h.logicalPaths,
      }));
  }

  vectorBackend(): 'sqlite-vec' | 'js-bucket' | 'disabled' {
    if (this.countEmbeddings() === 0) return 'disabled';
    return this.db.sqliteVecEnabled ? 'sqlite-vec' : 'js-bucket';
  }

  vectorSearch(
    embedding: Float32Array | number[],
    opts: { sourceIds: KnowledgeSourceId[]; limit?: number; buckets?: number[] },
  ): ChunkHit[] {
    const sourceIds = opts.sourceIds.map((s) => String(s));
    if (sourceIds.length === 0) return [];
    const limit = opts.limit ?? 8;
    const emb = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
    const placeholders = sourceIds.map(() => '?').join(',');
    const joinChunks = `JOIN knowledge_chunks c ON c.id = %s
                  JOIN knowledge_files f ON f.id = c.file_id AND f.status <> 'indexing'
                  JOIN knowledge_memberships m ON m.file_id = c.file_id`;
    const where = `WHERE m.source_id IN (${placeholders})`;

    const load = (ids: string[], scores?: Map<string, number>): ChunkHit[] => {
      if (ids.length === 0) return [];
      const idPh = ids.map(() => '?').join(',');
      const rows = this.db.raw
        .prepare(
          `SELECT c.id, c.ordinal, c.text, c.start_line, c.end_line,
                  m.source_id, m.logical_path
           FROM knowledge_chunks c
           JOIN knowledge_memberships m ON m.file_id = c.file_id
           WHERE c.id IN (${idPh})`,
        )
        .all(...ids) as Array<{
        id: string;
        ordinal: number;
        text: string;
        start_line: number;
        end_line: number;
        source_id: string;
        logical_path: string;
      }>;
      // 保持 scores 顺序（SQL IN 不保证序）
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = (scores ? ids : ids).map((id) => byId.get(id)).filter(Boolean) as typeof rows;
      return ordered.map((r) => ({
        chunkId: asChunkId(r.id),
        sourceId: asSourceId(r.source_id),
        path: r.logical_path,
        ordinal: r.ordinal,
        text: r.text,
        startLine: r.start_line,
        endLine: r.end_line,
        score: scores?.get(r.id) ?? 0,
      }));
    };

    if (this.db.sqliteVecEnabled) {
      try {
        const ph = Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
        const knn = this.db.raw
          .prepare(
            `SELECT c.id AS id, vec_distance_cosine(v.embedding, ?) AS dist FROM knowledge_vec v
             ${joinChunks.replace('%s', 'v.chunk_id')} ${where}
             ORDER BY dist LIMIT ?`,
          )
          .all(ph, ...sourceIds, limit) as Array<{ id: string; dist: number }>;
        if (knn.length > 0) {
          const scores = new Map(knn.map((r) => [r.id, 1 - Number(r.dist ?? 1)]));
          return load(knn.map((r) => r.id), scores);
        }
      } catch {
        // 退 JS
      }
    }

    const rows = this.db.raw
      .prepare(
        `SELECT e.chunk_id AS chunk_id, e.embedding AS embedding, e.bucket AS bucket,
                c.id AS id, c.ordinal AS ordinal, c.text AS text,
                c.start_line AS start_line, c.end_line AS end_line,
                m.source_id AS source_id, m.logical_path AS logical_path
         FROM knowledge_chunk_embeddings e
         ${joinChunks.replace('%s', 'e.chunk_id')} ${where}
         LIMIT 50000`,
      )
      .all(...sourceIds) as Array<{
      chunk_id: string;
      embedding: ArrayBuffer | Uint8Array;
      bucket: number;
      id: string;
      ordinal: number;
      text: string;
      start_line: number;
      end_line: number;
      source_id: string;
      logical_path: string;
    }>;
    if (rows.length > 50_000) {
      // 闸门：禁止 JS 全扫
      return [];
    }
    const candidates = rows.map((r) => {
      const buf =
        r.embedding instanceof Uint8Array
          ? r.embedding
          : new Uint8Array(r.embedding as ArrayBuffer);
      const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      return { ...r, score: cosineSimilarity(Array.from(emb), Array.from(vec)) };
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit).map((r) => ({
      chunkId: asChunkId(r.id),
      sourceId: asSourceId(r.source_id),
      path: r.logical_path,
      ordinal: r.ordinal,
      text: r.text,
      startLine: r.start_line,
      endLine: r.end_line,
      score: r.score,
    }));
  }

  listChunksMissingEmbedding(
    sourceId: KnowledgeSourceId | string,
    limit = 50,
  ): Array<{ chunkId: string; text: string }> {
    const rows = this.db.raw
      .prepare(
        `SELECT c.id AS id, c.text AS text
         FROM knowledge_chunks c
         JOIN knowledge_files f ON f.id = c.file_id
         JOIN knowledge_memberships m ON m.file_id = c.file_id
         LEFT JOIN knowledge_chunk_embeddings e ON e.chunk_id = c.id
         WHERE m.source_id = ? AND e.chunk_id IS NULL AND ${EMBEDDABLE_WHERE}
         LIMIT ?`,
      )
      .all(String(sourceId), limit) as Array<{ id: string; text: string }>;
    return rows.map((r) => ({ chunkId: r.id, text: r.text }));
  }

  /** 是否仍有缺向量 chunk（EXISTS，不拉正文） */
  hasChunksMissingEmbedding(sourceId: KnowledgeSourceId | string): boolean {
    const row = this.db.raw
      .prepare(
        `SELECT 1 AS ok
         FROM knowledge_chunks c
         JOIN knowledge_files f ON f.id = c.file_id
         JOIN knowledge_memberships m ON m.file_id = c.file_id
         LEFT JOIN knowledge_chunk_embeddings e ON e.chunk_id = c.id
         WHERE m.source_id = ? AND e.chunk_id IS NULL AND ${EMBEDDABLE_WHERE}
         LIMIT 1`,
      )
      .get(String(sourceId)) as { ok?: number } | undefined;
    return Boolean(row);
  }

  /**
   * 批量写入嵌入。pairs: `[chunkId, number[]]`；空向量 = secret-skip 墓碑。
   */
  setChunkEmbeddings(pairs: Array<[string, number[]]>): void {
    if (!pairs || pairs.length === 0) return;
    this.db.ensureEmbeddingSchema();
    const now = Date.now();
    const insert = this.db.raw.prepare(
      `INSERT INTO knowledge_chunk_embeddings (chunk_id, dimensions, embedding, bucket, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         dimensions = excluded.dimensions,
         embedding = excluded.embedding,
         bucket = excluded.bucket`,
    );
    this.db.raw.exec('BEGIN');
    try {
      for (const [chunkId, embedding] of pairs) {
        const vec = Float32Array.from(embedding ?? []);
        const dims = vec.length;
        const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
        insert.run(chunkId, dims, buf, dims > 0 ? vectorBucket(Array.from(vec)) : -1, now);
        this.writeKnowledgeVec(chunkId, embedding ?? []);
      }
      this.db.raw.exec('COMMIT');
    } catch (err) {
      try {
        this.db.raw.exec('ROLLBACK');
      } catch {
        // 以原异常为准
      }
      throw err;
    }
  }

  setChunkEmbedding(chunkId: string, embedding: number[]): void {
    this.setChunkEmbeddings([[chunkId, embedding]]);
  }

  private writeKnowledgeVec(chunkId: string, embedding: number[]): void {
    if (!this.db.sqliteVecEnabled || !embedding?.length) return;
    try {
      const dims = embedding.length;
      if (!this.vecTableReady) {
        this.db.raw.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(
            chunk_id TEXT PRIMARY KEY,
            embedding float[${dims}] distance_metric=cosine
          );
        `);
        this.vecTableReady = true;
      }
      this.db.raw.prepare('DELETE FROM knowledge_vec WHERE chunk_id = ?').run(chunkId);
      this.db.raw
        .prepare('INSERT INTO knowledge_vec (chunk_id, embedding) VALUES (?, ?)')
        .run(chunkId, toVecBlob(embedding));
    } catch {
      // 无 sqlite-vec 时忽略
    }
  }

  embeddingCoverage(sourceId?: KnowledgeSourceId | string): number {
    if (sourceId) {
      const t = (
        this.db.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM knowledge_chunks c
             JOIN knowledge_files f ON f.id = c.file_id
             JOIN knowledge_memberships m ON m.file_id = c.file_id
             WHERE m.source_id = ? AND ${EMBEDDABLE_WHERE}`,
          )
          .get(String(sourceId)) as { n: number }
      ).n;
      if (t === 0) return 1;
      const e = (
        this.db.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM knowledge_chunk_embeddings e
             JOIN knowledge_chunks c ON c.id = e.chunk_id
             JOIN knowledge_memberships m ON m.file_id = c.file_id
             WHERE m.source_id = ?`,
          )
          .get(String(sourceId)) as { n: number }
      ).n;
      return Math.min(1, e / t);
    }
    const t = (
      this.db.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_chunks c
           JOIN knowledge_files f ON f.id = c.file_id WHERE ${EMBEDDABLE_WHERE}`,
        )
        .get() as { n: number }
    ).n;
    if (t === 0) return 1;
    const e = (
      this.db.raw
        .prepare('SELECT COUNT(*) AS n FROM knowledge_chunk_embeddings')
        .get() as { n: number }
    ).n;
    return Math.min(1, e / t);
  }

  backfillVecFromEmbeddings(batch = 100): number {
    if (!this.db.sqliteVecEnabled) return 0;
    const rows = this.db.raw
      .prepare(
        `SELECT chunk_id, embedding, dimensions FROM knowledge_chunk_embeddings
         WHERE dimensions > 0 LIMIT ?`,
      )
      .all(batch) as Array<{
      chunk_id: string;
      embedding: ArrayBuffer | Uint8Array;
      dimensions: number;
    }>;
    let n = 0;
    for (const r of rows) {
      const buf =
        r.embedding instanceof Uint8Array
          ? r.embedding
          : new Uint8Array(r.embedding as ArrayBuffer);
      const vec = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
      this.writeKnowledgeVec(r.chunk_id, vec);
      n += 1;
    }
    return n;
  }

  getChunk(chunkId: string): {
    id: string;
    sourceId: string;
    path: string;
    text: string;
    startLine: number;
    endLine: number;
  } | null {
    const r = this.db.raw
      .prepare(
        `SELECT c.id, c.text, c.start_line, c.end_line, m.source_id, m.logical_path
         FROM knowledge_chunks c
         LEFT JOIN knowledge_memberships m ON m.file_id = c.file_id
         WHERE c.id = ? LIMIT 1`,
      )
      .get(chunkId) as
      | {
          id: string;
          text: string;
          start_line: number;
          end_line: number;
          source_id: string | null;
          logical_path: string | null;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      sourceId: r.source_id ?? '',
      path: r.logical_path ?? '',
      text: r.text,
      startLine: r.start_line,
      endLine: r.end_line,
    };
  }

  listChunksByPath(
    sourceId: KnowledgeSourceId | string,
    path: string,
  ): Array<{ id: string; text: string; startLine: number; endLine: number; ordinal: number; path: string }> {
    const logical = path.replace(/\\/g, '/');
    const rows = this.db.raw
      .prepare(
        `SELECT c.id, c.text, c.start_line, c.end_line, c.ordinal
         FROM knowledge_chunks c
         JOIN knowledge_memberships m ON m.file_id = c.file_id
         WHERE m.source_id = ? AND m.logical_path = ?
         ORDER BY c.ordinal`,
      )
      .all(String(sourceId), logical) as Array<{
      id: string;
      text: string;
      start_line: number;
      end_line: number;
      ordinal: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      startLine: r.start_line,
      endLine: r.end_line,
      ordinal: r.ordinal,
      path: logical,
    }));
  }

  countEmbeddings(): number {
    return (
      this.db.raw
        .prepare('SELECT COUNT(*) AS n FROM knowledge_chunk_embeddings')
        .get() as { n: number }
    ).n;
  }
}

export function hashContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
