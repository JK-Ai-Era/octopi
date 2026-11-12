import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SubsystemRun } from '../types.js';
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';

export interface AuditQuery {
  subsystemId?: string;
  status?: SubsystemRun['status'];
  since?: number;
  until?: number;
  agentId?: string;
  /**
   * 归属租户（arch/multi-tenancy.md §4）；缺省不过滤（host 管理面）。
   * 旧布局数据缺 tenantId 视作 DEFAULT_TENANT_ID。
   */
  tenantId?: string;
  limit?: number;
}

export interface AuditReaderConfig {
  auditDir: string;
}

export class AuditReader {
  private auditDir: string;

  constructor(config: AuditReaderConfig) {
    this.auditDir = config.auditDir;
  }

  query(filter?: AuditQuery): SubsystemRun[] {
    const results: SubsystemRun[] = [];
    const searchDirs = this.getSearchDirs(filter?.tenantId, filter?.agentId, filter?.subsystemId);

    for (const dir of searchDirs) {
      if (!existsSync(dir)) continue;

      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();

      for (const file of files) {
        const filePath = join(dir, file);
        try {
          const content = readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter((l) => l.trim());

          for (const line of lines) {
            try {
              const run = JSON.parse(line) as SubsystemRun;
              // 旧布局记录缺 tenantId 视作 DEFAULT（读端统一补齐查询语义）
              if (filter?.tenantId && (run.tenantId ?? DEFAULT_TENANT_ID) !== filter.tenantId) continue;
              if (filter?.status && run.status !== filter.status) continue;
              if (filter?.since && run.timestamp < filter.since) continue;
              if (filter?.until && run.timestamp > filter.until) continue;
              results.push(run);
              if (filter?.limit && results.length >= filter.limit) return results;
            } catch {
              // skip malformed lines
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }

    return results;
  }

  /**
   * 检索目录解析：**双布局兼容**（MAJ-6，2026-11-13 评审）。
   *
   * - 新布局（三段式）：`{tenantId}/[{agentId}/]{subsystemId}/`——writer 恒按记录租户分区；
   * - legacy（旧两段）：`[{agentId}/]{subsystemId}/`（升级前数据，租户视作 DEFAULT）。
   *
   * 叶子分类按段数 + 各解释逐一匹配查询（2 段同时尝试 (tenant,subsystem) 与
   * (agent,subsystem) 两种解释，任一命中即收）。不做模糊 includes 匹配——租户名
   * 与 agent 名可重合，位置语义才是准的。
   */
  private getSearchDirs(tenantId?: string, agentId?: string, subsystemId?: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, parts: string[]): void => {
      if (!existsSync(dir)) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      const hasJsonl = entries.some((e) => e.isFile() && e.name.endsWith('.jsonl'));
      if (hasJsonl && this.partsMatch(parts, tenantId, agentId, subsystemId)) {
        out.push(dir);
      }
      if (parts.length >= 3) return;
      for (const e of entries) {
        if (e.isDirectory()) walk(join(dir, e.name), [...parts, e.name]);
      }
    };
    walk(this.auditDir, []);
    return out;
  }

  /** 叶子路径段对查询的双解释匹配（见 getSearchDirs） */
  private partsMatch(parts: string[], tenantId?: string, agentId?: string, subsystemId?: string): boolean {
    if (parts.length === 3) {
      const [t, a, sub] = parts;
      return matches(tenantId, t) && matches(agentId, a) && matches(subsystemId, sub);
    }
    if (parts.length === 2) {
      const [x, sub] = parts;
      // 解释 A：新布局无 agentId 段（tenant, subsystem）；解释 B：legacy（agent, subsystem，
      // 租户维视作 DEFAULT——不是「不存在」）
      const asTenantSub = matches(tenantId, x) && matches(agentId, undefined) && matches(subsystemId, sub);
      const asLegacy =
        matches(tenantId, DEFAULT_TENANT_ID) && matches(agentId, x) && matches(subsystemId, sub);
      return asTenantSub || asLegacy;
    }
    if (parts.length === 1) {
      // legacy：仅 subsystem 段（租户维视作 DEFAULT，无 agent 维）
      return (
        matches(tenantId, DEFAULT_TENANT_ID) &&
        matches(agentId, undefined) &&
        matches(subsystemId, parts[0])
      );
    }
    return false;
  }
}

/**
 * 查询值与路径段匹配：查询缺省（undefined）= 不限；段缺省（布局无该维）= 仅当查询未限该维才命中。
 * legacy 布局的租户维按 DEFAULT 传入（视作 default，非缺维）。
 *
 * @param want - 查询值
 * @param have - 路径段（undefined=该维度不存在）
 */
function matches(want: string | undefined, have: string | undefined): boolean {
  if (want === undefined) return true;
  return have === want;
}
