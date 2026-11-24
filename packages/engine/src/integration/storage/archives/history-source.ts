/**
 * `HistoryArchiveSource` 的 Integration 实现 —— 注册表过滤 + 按需解包
 *
 * includeArchived 检索的冷备数据面（P2 迁移目标形态，arch/session-archive-recycle.md §8）：
 * - `listEntries`：只读注册表 `state='archived'` 行的 meta 投影（manifest 缓存 metaRaw），
 *   不解包任何 bundle——候选过滤是纯元数据操作；
 * - `loadSessionData`：命中候选后按需解包单个 bundle（sha256 校验随解包）。
 * trashed（回收站）= 已删除，不进检索面；恢复后重回。
 * 注册表句柄按调用开关库（只读，不占唯一写者纪律，也无句柄生命周期要管）。
 *
 * @module
 */

import { join } from 'node:path';
import type {
  HistoryArchiveSource,
} from '@octopi-agent/engine/harness/session/history/types.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import type { SessionMeta } from '@octopi-agent/core/types.js';
import { ArchiveRegistry, type ArchiveRecord } from './registry.js';
import { bundlePathFor, readSessionFromBundle } from './read.js';

export interface ArchiveHistorySourceOptions {
  /** OCTOPI_HOME/archives（archives.db + sessions/） */
  archivesDir: string;
}

function metaFromRecord(rec: ArchiveRecord): SessionMeta {
  // manifest 缓存由封存侧写入必为合法 JSON；坏行降级用注册表列（title/agentId/时间仍在）
  let metaRaw: Partial<SessionMeta> | undefined;
  try {
    const parsed = JSON.parse(rec.manifestJson) as { metaRaw?: Partial<SessionMeta> };
    metaRaw = parsed.metaRaw;
  } catch {
    // swallow: 只影响 meta 细节字段（如 participantAgentIds）；行级列兜底见下
  }
  return {
    ...(metaRaw ?? {}),
    id: rec.sessionId,
    agentId: metaRaw?.agentId ?? rec.agentId,
    title: metaRaw?.title ?? rec.title,
    tenantId: metaRaw?.tenantId ?? rec.tenantId,
    createdAt: metaRaw?.createdAt ?? rec.createdAt ?? rec.sealedAt,
    updatedAt: metaRaw?.updatedAt ?? rec.endedAt ?? rec.sealedAt,
    lifecycle: 'archived',
  } as SessionMeta;
}

/**
 * 构造冷备检索数据面
 *
 * @param options - archivesDir
 * @returns HistoryArchiveSource（listEntries / loadSessionData）
 */
export function createArchiveHistorySource(
  options: ArchiveHistorySourceOptions,
): HistoryArchiveSource {
  const dbPath = join(options.archivesDir, 'archives.db');
  return {
    async listEntries(): Promise<Array<{ sessionId: string; meta: SessionMeta }>> {
      const reg = new ArchiveRegistry(dbPath);
      try {
        return reg
          .list('archived')
          .map((rec) => ({ sessionId: rec.sessionId, meta: metaFromRecord(rec) }));
      } finally {
        reg.close();
      }
    },
    async loadSessionData(sessionId: string): Promise<SessionData | null> {
      const reg = new ArchiveRegistry(dbPath);
      try {
        const rec = reg.get(sessionId);
        // trashed 不进检索（已删除）；越权/不存在一律 null，不泄漏存在性
        if (!rec || rec.state !== 'archived') return null;
      } finally {
        reg.close();
      }
      return readSessionFromBundle(bundlePathFor(options.archivesDir, sessionId), sessionId);
    },
  };
}
