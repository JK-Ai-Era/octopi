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
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';

export interface AuditWriterConfig {
  /** 审计根目录（默认 ~/.octopi/audit） */
  auditDir: string;
  /** Agent ID（分区） */
  agentId?: string;
  /** 归属租户（arch/multi-tenancy.md §4：每条审计事件带租户）；分区 + 记录代打 */
  tenantId?: string;
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
  private tenantId?: string;

  constructor(config: AuditWriterConfig) {
    this.auditDir = config.auditDir;
    this.agentId = config.agentId;
    this.tenantId = config.tenantId;
  }

  /**
   * 写入审计记录
   *
   * @param run - 子系统执行记录
   */
  write(run: SubsystemRun): void {
    try {
      // 事件必带租户（§4 隔离矩阵）：run 自带 > 写入器配置 > DEFAULT；
      // **分区与记录用同一个租户**（MIN-3：分区≠记录会让按租户取证失去完整性）
      const tenantId = run.tenantId ?? this.tenantId ?? DEFAULT_TENANT_ID;
      const record: SubsystemRun = { ...run, tenantId };
      const filePath = this.getFilePath(tenantId, run.subsystemId, run.timestamp);
      const dir = dirname(filePath);

      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
    } catch {
      // 审计写入失败不阻塞主系统
    }
  }

  /**
   * 获取审计文件路径（三段式：{auditDir}/{tenantId}/[{agentId}/]{subsystemId}/{date}.jsonl）。
   * 分区段 = 记录的生效租户（与记录恒一致）。
   */
  private getFilePath(tenantId: string, subsystemId: string, timestamp: number): string {
    const date = new Date(timestamp).toISOString().slice(0, 10); // YYYY-MM-DD
    const parts = [this.auditDir, safeSegment(tenantId, 'tenantId')];

    if (this.agentId) {
      parts.push(safeSegment(this.agentId, 'agentId'));
    }

    parts.push(safeSegment(subsystemId, 'subsystemId'), `${date}.jsonl`);

    return join(...parts);
  }
}

/**
 * 路径段安全断言：ID 进文件路径前拒分隔符与 `..`（路径穿越面；NIT 2026-11-13 评审）。
 *
 * @param value - 路径段
 * @param label - 字段名（报错用）
 */
function safeSegment(value: string, label: string): string {
  if (!value || /[/\\]/.test(value) || value.includes('..')) {
    throw new Error(`audit_unsafe_path_segment: ${label}=${value}`);
  }
  return value;
}
