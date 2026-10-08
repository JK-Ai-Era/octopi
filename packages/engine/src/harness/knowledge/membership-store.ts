/**
 * MembershipStore — Source↔File 认领 + 零认领 purge（契约 §3.5 / §6.2）
 */

import type { KnowledgeDatabase } from './db.js';
import type { FileIdentity } from './file-identity.js';

export interface MembershipRow {
  sourceId: string;
  fileId: string;
  logicalPath: string;
  createdAt: number;
}

export interface FileRow {
  id: string;
  identityKey: string;
  size: number;
  mtime: number;
  contentHash: string | null;
  status: string;
  chunkCount: number;
}

export interface ReconcileResult {
  added: number;
  removed: number;
  purgedFiles: number;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class MembershipStore {
  constructor(private readonly db: KnowledgeDatabase) {}

  /**
   * 解析/登记物理 File；版本变化时更新 version 并标记 needsParse。
   */
  upsertByIdentity(
    identity: FileIdentity,
    opts?: { tenantId?: string },
  ): { fileId: string; created: boolean; versionChanged: boolean } {
    const tenant = opts?.tenantId ?? 'default';
    const now = Date.now();
    const row = this.db.raw
      .prepare(
        `SELECT id, size, mtime FROM knowledge_files
         WHERE tenant_id = ? AND identity_key = ?`,
      )
      .get(tenant, identity.key) as
      | { id: string; size: number; mtime: number }
      | undefined;

    if (row) {
      const versionChanged = row.size !== identity.size || row.mtime !== identity.mtime;
      if (versionChanged) {
        this.db.raw
          .prepare(
            `UPDATE knowledge_files SET size = ?, mtime = ?, indexed_at = ? WHERE id = ?`,
          )
          .run(identity.size, identity.mtime, now, row.id);
      }
      return { fileId: row.id, created: false, versionChanged };
    }

    const fileId = newId('file');
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_files
           (id, tenant_id, identity_key, size, mtime, content_hash, status, chunk_count, indexed_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'pending', 0, ?)`,
      )
      .run(fileId, tenant, identity.key, identity.size, identity.mtime, now);
    return { fileId, created: true, versionChanged: true };
  }

  claim(sourceId: string, fileId: string, logicalPath: string): void {
    const prev = this.db.raw
      .prepare(
        `SELECT file_id FROM knowledge_memberships
         WHERE source_id = ? AND logical_path = ?`,
      )
      .get(sourceId, logicalPath) as { file_id: string } | undefined;
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_memberships (source_id, file_id, logical_path, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_id, logical_path) DO UPDATE SET file_id = excluded.file_id`,
      )
      .run(sourceId, fileId, logicalPath, Date.now());
    // 换绑后旧 File 若零认领，由调用方 purge（此处只记孤儿风险）
    if (prev && prev.file_id !== fileId && this.claimCount(prev.file_id) === 0) {
      // 留给 reconcile 补 purge；避免 claim 路径上嵌套删除事务
    }
  }

  unclaim(sourceId: string, logicalPath: string): string | null {
    const row = this.db.raw
      .prepare(
        `SELECT file_id FROM knowledge_memberships
         WHERE source_id = ? AND logical_path = ?`,
      )
      .get(sourceId, logicalPath) as { file_id: string } | undefined;
    this.db.raw
      .prepare(`DELETE FROM knowledge_memberships WHERE source_id = ? AND logical_path = ?`)
      .run(sourceId, logicalPath);
    return row?.file_id ?? null;
  }

  claimCount(fileId: string): number {
    const r = this.db.raw
      .prepare(`SELECT COUNT(*) AS n FROM knowledge_memberships WHERE file_id = ?`)
      .get(fileId) as { n: number };
    return r.n;
  }

  listBySource(sourceId: string): MembershipRow[] {
    const rows = this.db.raw
      .prepare(
        `SELECT source_id, file_id, logical_path, created_at
         FROM knowledge_memberships WHERE source_id = ? ORDER BY logical_path`,
      )
      .all(sourceId) as Array<{
      source_id: string;
      file_id: string;
      logical_path: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      sourceId: r.source_id,
      fileId: r.file_id,
      logicalPath: r.logical_path,
      createdAt: r.created_at,
    }));
  }

  listByFile(fileId: string): MembershipRow[] {
    const rows = this.db.raw
      .prepare(
        `SELECT source_id, file_id, logical_path, created_at
         FROM knowledge_memberships WHERE file_id = ?`,
      )
      .all(fileId) as Array<{
      source_id: string;
      file_id: string;
      logical_path: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      sourceId: r.source_id,
      fileId: r.file_id,
      logicalPath: r.logical_path,
      createdAt: r.created_at,
    }));
  }

  /**
   * 解绑 Source：删其全部 Membership，并对失去认领的 File 做 purge。
   * 大源删除分批让出，避免同步连环 purge 堵死 Engine。
   *
   * @returns purge 的 fileId 列表
   */
  async unclaimAllForSourceAsync(
    sourceId: string,
    purge: (fileId: string) => void | Promise<void>,
    opts?: { yieldEvery?: number },
  ): Promise<string[]> {
    const yieldEvery = Math.max(1, opts?.yieldEvery ?? 5);
    const files = this.db.raw
      .prepare(`SELECT DISTINCT file_id FROM knowledge_memberships WHERE source_id = ?`)
      .all(sourceId) as Array<{ file_id: string }>;
    this.db.raw.prepare(`DELETE FROM knowledge_memberships WHERE source_id = ?`).run(sourceId);
    const purged: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      if (this.claimCount(f.file_id) === 0) {
        await purge(f.file_id);
        purged.push(f.file_id);
      }
      if ((i + 1) % yieldEvery === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    return purged;
  }

  /**
   * 解绑 Source：删其全部 Membership，并对失去认领的 File 做 purge。
   * 返回 purge 的 fileId 列表。
   */
  unclaimAllForSource(sourceId: string, purge: (fileId: string) => void): string[] {
    const files = this.db.raw
      .prepare(`SELECT DISTINCT file_id FROM knowledge_memberships WHERE source_id = ?`)
      .all(sourceId) as Array<{ file_id: string }>;
    this.db.raw.prepare(`DELETE FROM knowledge_memberships WHERE source_id = ?`).run(sourceId);
    const purged: string[] = [];
    for (const f of files) {
      if (this.claimCount(f.file_id) === 0) {
        purge(f.file_id);
        purged.push(f.file_id);
      }
    }
    return purged;
  }

  /**
   * Walk 对账（§6.2）：discovered 为 logical_path → fileId。
   * 删掉本 Source 不在 discovered 中的 Membership；零认领则 purge。
   */
  reconcileSource(
    sourceId: string,
    discovered: Map<string, string>,
    purge: (fileId: string) => void,
  ): ReconcileResult {
    const now = Date.now();
    let added = 0;
    for (const [logicalPath, fileId] of discovered) {
      this.claim(sourceId, fileId, logicalPath);
      added += 1;
    }
    const existing = this.listBySource(sourceId);
    let removed = 0;
    let purgedFiles = 0;
    for (const m of existing) {
      if (discovered.has(m.logicalPath)) continue;
      this.unclaim(sourceId, m.logicalPath);
      removed += 1;
      if (this.claimCount(m.fileId) === 0) {
        purge(m.fileId);
        purgedFiles += 1;
      }
    }
    void now;
    return { added, removed, purgedFiles };
  }

  getFile(fileId: string): FileRow | null {
    const r = this.db.raw
      .prepare(
        `SELECT id, identity_key, size, mtime, content_hash, status, chunk_count
         FROM knowledge_files WHERE id = ?`,
      )
      .get(fileId) as
      | {
          id: string;
          identity_key: string;
          size: number;
          mtime: number;
          content_hash: string | null;
          status: string;
          chunk_count: number;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      identityKey: r.identity_key,
      size: r.size,
      mtime: r.mtime,
      contentHash: r.content_hash,
      status: r.status,
      chunkCount: r.chunk_count,
    };
  }

  findFileByIdentity(
    identityKey: string,
    tenantId = 'default',
  ): FileRow | null {
    const r = this.db.raw
      .prepare(
        `SELECT id, identity_key, size, mtime, content_hash, status, chunk_count
         FROM knowledge_files WHERE tenant_id = ? AND identity_key = ?`,
      )
      .get(tenantId, identityKey) as
      | {
          id: string;
          identity_key: string;
          size: number;
          mtime: number;
          content_hash: string | null;
          status: string;
          chunk_count: number;
        }
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      identityKey: r.identity_key,
      size: r.size,
      mtime: r.mtime,
      contentHash: r.content_hash,
      status: r.status,
      chunkCount: r.chunk_count,
    };
  }
}
