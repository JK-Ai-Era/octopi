/**
 * SessionArchiveManager — Session 归档管理器
 *
 * 负责 session 的归档生命周期：
 * - 检查可归档的 session（结束超过 recentRetentionDays 且 memory 提取已完成）
 * - 导出到压缩 JSONL 文件
 * - 从 sessions.db 删除已归档的 session
 * - 清理过期归档文件
 * - 强制归档超期未提取的 session（兜底策略）
 *
 * @module
 */

import { mkdir, readdir, stat, unlink, readFile, writeFile } from 'node:fs/promises';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { SqliteSessionStore } from '../storage/sqlite.js';
import type { SessionData } from '../../harness/session-types.js';

export interface ArchiveManagerOptions {
  /** 归档目录路径 */
  archiveDir: string;
  /** Recent session 保留天数（默认 30） */
  recentRetentionDays?: number;
  /** 归档文件保留天数（默认 180） */
  archiveRetentionDays?: number;
  /** 强制归档兜底天数（memory 提取超期，默认 90） */
  forceArchiveDays?: number;
}

interface ArchiveEntry {
  sessionId: string;
  data: SessionData;
  archivedAt: number;
}

export class SessionArchiveManager {
  private store: SqliteSessionStore;
  private archiveDir: string;
  private recentRetentionMs: number;
  private archiveRetentionMs: number;
  private forceArchiveMs: number;

  constructor(store: SqliteSessionStore, options: ArchiveManagerOptions) {
    this.store = store;
    this.archiveDir = options.archiveDir;
    this.recentRetentionMs = (options.recentRetentionDays ?? 30) * 24 * 60 * 60 * 1000;
    this.archiveRetentionMs = (options.archiveRetentionDays ?? 180) * 24 * 60 * 60 * 1000;
    this.forceArchiveMs = (options.forceArchiveDays ?? 90) * 24 * 60 * 60 * 1000;
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

    // 获取所有 recent 状态的 session
    const agentIds = this.getAgentIds();
    let archived = 0;

    for (const agentId of agentIds) {
      const recentSessions = await this.store.listByLifecycle(agentId, 'recent');

      for (const session of recentSessions) {
        const endedAt = session.lifecycle?.endedAt ?? 0;
        if (endedAt > cutoff) continue; // 还在保留期内

        const extractionStatus = session.lifecycle?.memoryExtraction ?? 'pending';

        if (extractionStatus === 'completed') {
          // 正常归档
          await this.archiveSession(session);
          archived++;
        } else if (endedAt < forceCutoff) {
          // 兜底策略：超过强制归档天数，即使提取未完成也归档
          await this.archiveSession(session);
          archived++;
        }
        // 其他情况：跳过，等待提取完成
      }
    }

    return archived;
  }

  /**
   * 归档单个 session
   */
  private async archiveSession(session: SessionData): Promise<void> {
    const now = Date.now();
    const month = new Date(now).toISOString().slice(0, 7); // YYYY-MM
    const archiveFile = join(this.archiveDir, `${month}.sessions.jsonl.gz`);

    const entry: ArchiveEntry = {
      sessionId: session.id,
      data: session,
      archivedAt: now,
    };

    // 追加到归档文件
    await this.appendToArchive(archiveFile, entry);

    // 更新生命周期状态
    await this.store.updateLifecycle!(session.id, {
      lifecycle: 'archived',
      archivedAt: now,
    });

    // 从 sessions.db 删除（归档后不再需要在数据库中）
    await this.store.delete(session.id);
  }

  /**
   * 追加一条记录到压缩归档文件
   */
  private async appendToArchive(filePath: string, entry: ArchiveEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';

    // 读取现有内容（如果有）
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
    await writeFile(filePath, compressed);
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
          if (!agentId || entry.data.agentId === agentId) {
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

  /**
   * 获取所有 agent ID
   */
  private getAgentIds(): string[] {
    return this.store.getAgentIds();
  }

  /**
   * 压缩 buffer
   */
  private async compress(data: Buffer): Promise<Buffer> {
    return promisify(gzip)(data);
  }

  /**
   * 解压 buffer
   */
  private async decompress(data: Buffer): Promise<Buffer> {
    return promisify(gunzip)(data);
  }
}
