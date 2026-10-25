/**
 * 配置审计 sink（P3）— `OCTOPI_HOME/audit/config.jsonl`（JSONL 追加）
 *
 * 记录每次配置/persona 变更：when/what/target/hash/backupPath（回滚锚点）。
 * 审计尽力而为：写失败仅告警，不阻断业务（见 ConfigApplyService.audit）。
 *
 * @module
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigAuditEntry } from '@octopi-agent/gateway/gateway/config-apply.js';
import { getOctopiHome } from './init.js';

/**
 * 创建配置审计 sink（写 `audit/config.jsonl`）
 *
 * @param auditDir - 审计目录（缺省 `OCTOPI_HOME/audit`）
 * @returns sink 函数（写 JSONL 追加）
 */
export function createConfigAuditSink(auditDir?: string): (entry: ConfigAuditEntry) => void {
  const dir = auditDir ?? join(getOctopiHome(), 'audit');
  const file = join(dir, 'config.jsonl');
  return (entry) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8');
  };
}
