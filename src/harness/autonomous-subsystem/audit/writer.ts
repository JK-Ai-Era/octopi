/**
 * Autonomous Subsystem — AuditWriter
 *
 * 审计写入器。将 SubsystemRun 持久化到 JSONL 文件。
 * 替代旧的 AuditTrail。
 *
 * @module autonomous-subsystem/audit/writer
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { SubsystemRun } from '../types.js';

export interface AuditWriterConfig {
  /** 审计根目录（默认 ~/.octopi/audit） */
  auditDir: string;
  /** Agent ID（多租户时用于分区） */
  agentId?: string;
}

/**
 * AuditWriter — 审计写入器
 *
 * 将 SubsystemRun 以 JSONL 格式写入文件。
 * 路径格式：{auditDir}/[{agentId}/]{subsystemId}/{date}.jsonl
 */
export class AuditWriter {
  private auditDir: string;
  private agentId?: string;

  constructor(config: AuditWriterConfig) {
    this.auditDir = config.auditDir;
    this.agentId = config.agentId;
  }

  /**
   * 写入审计记录
   *
   * @param run - 子系统执行记录
   */
  write(run: SubsystemRun): void {
    try {
      const filePath = this.getFilePath(run.subsystemId, run.timestamp);
      const dir = dirname(filePath);

      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      appendFileSync(filePath, JSON.stringify(run) + '\n', 'utf-8');
    } catch {
      // 审计写入失败不阻塞主系统
    }
  }

  /**
   * 获取审计文件路径
   */
  private getFilePath(subsystemId: string, timestamp: number): string {
    const date = new Date(timestamp).toISOString().slice(0, 10); // YYYY-MM-DD
    const parts = [this.auditDir];

    if (this.agentId) {
      parts.push(this.agentId);
    }

    parts.push(subsystemId, `${date}.jsonl`);

    return join(...parts);
  }
}
