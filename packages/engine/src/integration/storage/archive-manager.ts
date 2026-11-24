/**
 * SessionArchiveManager — 冷备读取门面（queryArchive / listArchived）
 *
 * P2 起冷备权威 = `archives.db` 注册表 + `sessions/<base>.tar.gz` bundle
 * （arch/session-archive-recycle.md §8）。旧月度 `*.sessions.jsonl.gz` 追加写入
 * 机制已整体删除（含 OP-ARCH-1 的读改写并发丢行缺陷）；存量旧文件由一次性迁移
 * 转成 bundle 后删除，不留双读路径。
 *
 * 本类只读：唯一写者仍是 gateway 门面（`SessionArchiveService`），不开第二写路径。
 * `trashed`（回收站）= 已删除，不在本读取面（恢复后重回 `archived` 可读）。
 *
 * @module
 */

import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { SessionMeta } from '@octopi-agent/core/types.js';
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';
import { sessionMatchesAgent } from '@octopi-agent/core/types/session.js';
import { ArchiveRegistry, type ArchiveRecord } from './archives/registry.js';
import { bundlePathFor, readSessionFromBundle } from './archives/read.js';
import { join } from 'node:path';

export interface ArchiveManagerOptions {
  /** OCTOPI_HOME/archives（archives.db + sessions/） */
  archivesDir: string;
}

function metaFromRecord(rec: ArchiveRecord): SessionMeta {
  let metaRaw: Partial<SessionMeta> | undefined;
  try {
    const parsed = JSON.parse(rec.manifestJson) as { metaRaw?: Partial<SessionMeta> };
    metaRaw = parsed.metaRaw;
  } catch {
    // swallow: manifest 缓存由封存侧写入必合法；坏行降级用注册表列（行级列兜底见下）
  }
  return {
    ...(metaRaw ?? {}),
    id: rec.sessionId,
    agentId: metaRaw?.agentId ?? rec.agentId,
    tenantId: metaRaw?.tenantId ?? rec.tenantId,
    createdAt: metaRaw?.createdAt ?? rec.createdAt ?? rec.sealedAt,
    updatedAt: metaRaw?.updatedAt ?? rec.endedAt ?? rec.sealedAt,
    lifecycle: 'archived',
  } as SessionMeta;
}

function toIndexPick(meta: SessionMeta): Parameters<typeof sessionMatchesAgent>[0] {
  return {
    agentId: meta.agentId,
    primaryAgentId: meta.primaryAgentId,
    preferredAgentId: meta.preferredAgentId,
    participantAgentIds: meta.participantAgentIds ?? [],
  };
}

export class SessionArchiveManager {
  private archivesDir: string;

  /**
   * @param options - archivesDir（archives.db + sessions/ 所在目录）
   */
  constructor(options: ArchiveManagerOptions) {
    this.archivesDir = options.archivesDir;
  }

  /**
   * 查询冷备中的 session（只读；bundle 解包含 sha256 校验）
   *
   * @param sessionId - 会话 id
   * @param opts - 租户收口（§9.1-2，T4b）：带 tenantId 时越域视为不存在（不泄漏存在性）
   * @returns 会话数据；未归档/已入回收站/越域返回 null
   */
  async queryArchive(sessionId: string, opts?: { tenantId?: string }): Promise<SessionData | null> {
    const reg = new ArchiveRegistry(join(this.archivesDir, 'archives.db'));
    let rec: ArchiveRecord | null;
    try {
      rec = reg.get(sessionId);
    } finally {
      reg.close();
    }
    if (!rec || rec.state !== 'archived') return null;
    const tenant = rec.tenantId ?? DEFAULT_TENANT_ID;
    if (opts?.tenantId !== undefined && tenant !== opts.tenantId) return null;
    try {
      return await readSessionFromBundle(bundlePathFor(this.archivesDir, sessionId), sessionId);
    } catch (err) {
      // swallow: 单包损坏只损失该查询（显式告警，doctor 可扫），沿旧契约返回 null
      console.warn(
        `[SessionArchiveManager] queryArchive(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * 列出冷备中的 session 元数据（不解包；注册表投影）
   *
   * @param filter - agentId / tenantId（§9.1-2，T4b）：带 tenantId 时只列本域；
   *   兼容旧签名（string = agentId）——绝不静默放宽语义（评审 MIN-3）
   * @returns 元数据列表
   */
  async listArchived(
    filter?: string | { agentId?: string; tenantId?: string },
  ): Promise<Array<{ sessionId: string; agentId: string; tenantId?: string; archivedAt: number }>> {
    const normalized: { agentId?: string; tenantId?: string } =
      typeof filter === 'string' ? { agentId: filter } : (filter ?? {});
    const reg = new ArchiveRegistry(join(this.archivesDir, 'archives.db'));
    let rows: ArchiveRecord[];
    try {
      rows = reg.list('archived');
    } finally {
      reg.close();
    }
    const results: Array<{ sessionId: string; agentId: string; tenantId?: string; archivedAt: number }> = [];
    for (const rec of rows) {
      const tenant = rec.tenantId ?? DEFAULT_TENANT_ID;
      if (normalized.tenantId !== undefined && tenant !== normalized.tenantId) continue;
      const meta = metaFromRecord(rec);
      if (normalized.agentId && !sessionMatchesAgent(toIndexPick(meta), normalized.agentId)) continue;
      results.push({
        sessionId: rec.sessionId,
        agentId: rec.agentId,
        tenantId: tenant,
        archivedAt: rec.sealedAt,
      });
    }
    return results;
  }
}
