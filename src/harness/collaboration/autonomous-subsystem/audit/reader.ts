import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SubsystemRun } from '../types.js';

export interface AuditQuery {
  subsystemId?: string;
  status?: SubsystemRun['status'];
  since?: number;
  until?: number;
  agentId?: string;
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
    const searchDirs = this.getSearchDirs(filter?.agentId, filter?.subsystemId);

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

  private getSearchDirs(agentId?: string, subsystemId?: string): string[] {
    if (agentId && subsystemId) {
      return [join(this.auditDir, agentId, subsystemId)];
    }
    if (agentId) {
      const agentDir = join(this.auditDir, agentId);
      if (!existsSync(agentDir)) return [];
      return readdirSync(agentDir)
        .filter((d) => !d.startsWith('.'))
        .map((d) => join(agentDir, d));
    }
    if (subsystemId) {
      // 两种可能的路径：
      // 1. auditDir/subsystemId/（无 agentId 分区）
      // 2. auditDir/*/subsystemId/（有 agentId 分区）
      const dirs: string[] = [];
      const directDir = join(this.auditDir, subsystemId);
      if (existsSync(directDir) && statSync(directDir).isDirectory()) {
        dirs.push(directDir);
      }
      if (existsSync(this.auditDir)) {
        for (const entry of readdirSync(this.auditDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name !== subsystemId) {
            const subDir = join(this.auditDir, entry.name, subsystemId);
            if (existsSync(subDir)) dirs.push(subDir);
          }
        }
      }
      return dirs;
    }
    if (!existsSync(this.auditDir)) return [];
    return readdirSync(this.auditDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(this.auditDir, d.name));
  }
}
