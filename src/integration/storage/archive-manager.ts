/**
 * SessionArchiveManager — Session 归档管理器
 *
 * 基于 SessionStore（Jsonl / InMemory / 自定义）的冷备生命周期：
 * - 将结束超过保留期的 session 导出到压缩 JSONL
 * - 从热库删除已归档 session（归档文件为冷备权威）
 * - 清理过期归档文件
 * - 强制归档超期未处理 session（兜底；不再依赖 memoryExtraction）
 *
 * Crash 顺序：先追加归档行，再删热库。
 *
 * @module
 */

import { mkdir, readdir, stat, unlink, readFile, writeFile } from 'node:fs/promises';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../../harness/session-types.js';
import type { EventBus } from '../../core/primitives/event-bus.js';
import { sessionMatchesAgent } from './memory.js';

export interface ArchiveManagerOptions {
  /** 归档目录路径 */
  archiveDir: string;
  /** Recent session 保留天数（默认 30；从 endedAt 起算） */
  recentRetentionDays?: number;
  /** 归档文件保留天数（默认 180） */
  archiveRetentionDays?: number;
  /** 强制归档兜底天数（默认 90；不再看 memoryExtraction） */
  forceArchiveDays?: number;
  /** 可选 EventBus：归档成功后 emit session.ended */
  events?: EventBus;
}

interface ArchiveEntry {
  sessionId: string;
  data: SessionData;
  archivedAt: number;
}

export class SessionArchiveManager {
  private store: SessionStore<SessionData>;
  private archiveDir: string;
  private recentRetentionMs: number;
  private archiveRetentionMs: number;
  private forceArchiveMs: number;
  private events?: EventBus;

  /**
   * @param store - SessionStore（契约级；不绑具体后端）
   * @param options - 归档目录与保留策略
   */
  constructor(store: SessionStore<SessionData>, options: ArchiveManagerOptions) {
    this.store = store;
    this.archiveDir = options.archiveDir;
    this.recentRetentionMs = (options.recentRetentionDays ?? 30) * 24 * 60 * 60 * 1000;
    this.archiveRetentionMs = (options.archiveRetentionDays ?? 180) * 24 * 60 * 60 * 1000;
    this.forceArchiveMs = (options.forceArchiveDays ?? 90) * 24 * 60 * 60 * 1000;
    this.events = options.events;
  }

  /**
   * 执行归档流程
   *
   * @returns 归档的 session 数量
   */
  async runArchive(): Promise<number> {
    await mkdir(this.archiveDir, { recursive: true });

    const now = Date.now();
    const cutoff = now - this.recentRetentionMs;
    const forceCutoff = now - this.forceArchiveMs;

    let archived = 0;
    for (const meta of await this.store.list()) {
      const lifecycle = meta.lifecycle ?? 'active';
      if (lifecycle !== 'recent') continue;

      // 缺 endedAt 无法判断保留期 → 跳过（禁止 ??0 立即归档）
      const endedAt = meta.endedAt;
      if (endedAt == null) continue;
      if (endedAt > cutoff && endedAt > forceCutoff) continue;

      const session = await this.store.load(meta.id);
      if (!session) continue;

      await this.archiveSession(session);
      archived++;
    }

    return archived;
  }

  /**
   * 归档单个 session：导出 gz → 标记 archived → 删热库
   */
  private async archiveSession(session: SessionData): Promise<void> {
    const now = Date.now();
    const month = new Date(now).toISOString().slice(0, 7); // YYYY-MM
    const archiveFile = join(this.archiveDir, `${month}.sessions.jsonl.gz`);

    const entry: ArchiveEntry = {
      sessionId: session.id,
      data: {
        ...session,
        lifecycle: {
          lifecycle: 'archived',
          endedAt: session.lifecycle?.endedAt,
          archivedAt: now,
        },
      },
      archivedAt: now,
    };

    // 先追加归档行，再删热库（宁可重复归档行，不可丢正文）
    await this.appendToArchive(archiveFile, entry);
    await this.store.delete(session.id);

    this.events?.emit({
      type: 'session.ended',
      timestamp: Date.now(),
      agentId: session.agentId,
      sessionId: session.id,
      data: { reason: 'archived' },
    });
  }

  /**
   * 追加一条记录到压缩归档文件（temp + rename，避免截断式写坏当月冷备）
   */
  private async appendToArchive(filePath: string, entry: ArchiveEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';

    let existing = '';
    try {
      const compressed = await readFile(filePath);
      const buffer = await this.decompress(compressed);
      existing = buffer.toString('utf-8');
    } catch {
      // 文件不存在，从头开始
    }

    const newContent = existing + line;
    const compressed = await this.compress(Buffer.from(newContent, 'utf-8'));
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, compressed);
    const { rename } = await import('node:fs/promises');
    await rename(tmpPath, filePath);
  }

  /**
   * 查询归档中的 session
   */
  async queryArchive(sessionId: string): Promise<SessionData | null> {
    const files = await this.listArchiveFiles();

    for (const file of files) {
      try {
        const compressed = await readFile(file);
        const buffer = await this.decompress(compressed);
        const lines = buffer.toString('utf-8').split('\n').filter(Boolean);

        for (const line of lines) {
          const entry = JSON.parse(line) as ArchiveEntry;
          if (entry.sessionId === sessionId) {
            return entry.data;
          }
        }
      } catch {
        // 文件损坏或读取失败，跳过
      }
    }

    return null;
  }

  /**
   * 列出归档中的 session 元数据
   */
  async listArchived(agentId?: string): Promise<Array<{ sessionId: string; agentId: string; archivedAt: number }>> {
    const files = await this.listArchiveFiles();
    const results: Array<{ sessionId: string; agentId: string; archivedAt: number }> = [];

    for (const file of files) {
      try {
        const compressed = await readFile(file);
        const buffer = await this.decompress(compressed);
        const lines = buffer.toString('utf-8').split('\n').filter(Boolean);

        for (const line of lines) {
          const entry = JSON.parse(line) as ArchiveEntry;
          const pick = toIndexPick(entry.data);
          if (!agentId || sessionMatchesAgent(pick, agentId)) {
            results.push({
              sessionId: entry.sessionId,
              agentId: entry.data.agentId,
              archivedAt: entry.archivedAt,
            });
          }
        }
      } catch {
        // 跳过损坏的文件
      }
    }

    return results;
  }

  /**
   * 清理过期归档文件
   *
   * @returns 删除的文件数
   */
  async cleanupExpiredArchives(): Promise<number> {
    const now = Date.now();
    const files = await this.listArchiveFiles();
    let deleted = 0;

    for (const file of files) {
      try {
        const fileStat = await stat(file);
        if (now - fileStat.mtimeMs > this.archiveRetentionMs) {
          await unlink(file);
          deleted++;
        }
      } catch {
        // 文件已不存在，忽略
      }
    }

    return deleted;
  }

  /**
   * 列出归档目录下的 .jsonl.gz 文件
   */
  private async listArchiveFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.archiveDir);
      return entries
        .filter(e => e.endsWith('.sessions.jsonl.gz'))
        .map(e => join(this.archiveDir, e))
        .sort();
    } catch {
      return [];
    }
  }

  private async compress(data: Buffer): Promise<Buffer> {
    return promisify(gzip)(data);
  }

  private async decompress(data: Buffer): Promise<Buffer> {
    return promisify(gunzip)(data);
  }
}

function toIndexPick(s: SessionData): Parameters<typeof sessionMatchesAgent>[0] {
  return {
    agentId: s.agentId ?? s.meta?.agentId,
    primaryAgentId: s.primaryAgentId ?? s.meta?.primaryAgentId,
    preferredAgentId: s.preferredAgentId ?? s.meta?.preferredAgentId,
    participantAgentIds:
      s.meta?.participantAgentIds ??
      (s.participants ?? []).map((p) => p.agentId),
  };
}
