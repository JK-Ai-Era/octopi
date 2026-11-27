/**
 * doctor 知识面归属归一化（R4 归属回填，arch/multi-tenancy.md T3d/§9.1-18）
 *
 * 判定口径：「行的域 = 归属对象的域」（T3c F1 语义：visibility 行是写入物，落归属域才可见）——
 * - agent 键行（knowledge_project_agents / knowledge_agent_visibility）→ agent 归属租户
 *   （`agentOwnershipTenantOf` 单源：registry 权威；config agent = default 存量域）
 * - session overlay 行（knowledge_session_visibility）→ 会话 agent 的归属租户
 *   （`<id>.state.json` 的 agentId 解析；解析不了只报告不动手）
 * - project 域源（knowledge_sources.scope_level='project'）→ 其项目登记行的归属域（M1；
 *   同 key 多域且本域无行 = 有歧义，只报告不动手）
 *
 * 域不符的行 = 断言收口前的残行（假成功形状：面板显示已挂载/已屏蔽，但 agent 永远看不见）。
 * `--fix data` 归位：目标域已有同键行 → 删残行（目标域行是规范行）；否则移动。整批事务、
 * 幂等、可 dry-run。本地确定性，零 LLM。
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOctopiHome } from '@octopi-agent/engine/paths.js';
import { agentOwnershipTenantOf } from '@octopi-agent/engine/harness/governance/registry/service.js';
import type { RegistryService } from '@octopi-agent/engine/harness/governance/registry/service.js';
import { knowledgeDbPath } from './data.js';
import type { DataFixResult } from './data.js';

type Finding = DataFixResult['findings'][number];

/** 归属归一化涉及的行族与「除 tenant_id 外的主键列」 */
interface RowFamily {
  table: 'knowledge_project_agents' | 'knowledge_agent_visibility' | 'knowledge_session_visibility';
  keyColumns: string[];
  /** 行 → 归属对象（agentId / sessionId） */
  ownerKey: (row: Record<string, string>) => string;
  /** 归属对象 → 期望域 */
  ownerTenant: (ownerKey: string, ctx: AttributionContext) => string | null;
}

interface AttributionContext {
  registry: RegistryService | null;
  sessionAgent: (sessionId: string) => string | undefined;
}

const ROW_FAMILIES: RowFamily[] = [
  {
    table: 'knowledge_project_agents',
    keyColumns: ['gateway_id', 'local_agent_id', 'project_key'],
    ownerKey: (row) => row['local_agent_id'] ?? '',
    ownerTenant: (agentId, ctx) => (agentId ? agentOwnershipTenantOf(ctx.registry, agentId) : null),
  },
  {
    table: 'knowledge_agent_visibility',
    keyColumns: ['gateway_id', 'local_agent_id', 'source_id'],
    ownerKey: (row) => row['local_agent_id'] ?? '',
    ownerTenant: (agentId, ctx) => (agentId ? agentOwnershipTenantOf(ctx.registry, agentId) : null),
  },
  {
    table: 'knowledge_session_visibility',
    keyColumns: ['gateway_id', 'local_session_id', 'target_type', 'target_id'],
    ownerKey: (row) => row['local_session_id'] ?? '',
    ownerTenant: (sessionId, ctx) => {
      const agentId = ctx.sessionAgent(sessionId);
      return agentId ? agentOwnershipTenantOf(ctx.registry, agentId) : null;
    },
  },
];

/** 待归一行：当前域 ≠ 期望域 */
interface MisalignedRow {
  table: string;
  keyColumns: string[];
  keys: string[];
  tenantId: string;
  expected: string;
  /** 归属对象展示用（agentId/sessionId/sourceId） */
  ownerLabel: string;
}

interface SkippedRow {
  table: string;
  label: string;
  reason: string;
}

interface ScanResult {
  misaligned: MisalignedRow[];
  skipped: SkippedRow[];
  checked: number;
}

/**
 * 会话 → agent 解析（best-effort）：`<id>.state.json` 的 agentId 字段。
 *
 * @param sessionId - 会话 id
 * @returns agentId；解析不到 = undefined（调用方报告并跳过）
 */
export function resolveSessionAgentId(sessionId: string): string | undefined {
  const statePath = join(getOctopiHome(), 'sessions', `${sessionId}.state.json`);
  if (!existsSync(statePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as { agentId?: unknown };
    return typeof parsed.agentId === 'string' && parsed.agentId ? parsed.agentId : undefined;
  } catch {
    return undefined;
  }
}

async function loadRegistry(): Promise<RegistryService | null> {
  const dbPath = join(getOctopiHome(), 'registry.db');
  if (!existsSync(dbPath)) return null;
  const { RegistryService } = await import(
    '@octopi-agent/engine/harness/governance/registry/service.js'
  );
  return RegistryService.create({ dbPath });
}

type QueryableDb = {
  raw: {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    exec(sql: string): unknown;
  };
};

function scanAttribution(db: QueryableDb, ctx: AttributionContext): ScanResult {
  const misaligned: MisalignedRow[] = [];
  const skipped: SkippedRow[] = [];
  let checked = 0;

  for (const family of ROW_FAMILIES) {
    const rows = db.raw
      .prepare(
        `SELECT tenant_id, ${family.keyColumns.join(', ')} FROM ${family.table}`,
      )
      .all() as Array<Record<string, string>>;
    for (const row of rows) {
      checked += 1;
      const ownerKey = family.ownerKey(row);
      const expected = family.ownerTenant(ownerKey, ctx);
      if (expected == null) {
        skipped.push({ table: family.table, label: ownerKey, reason: '归属对象解析不到（会话无 state 记录）' });
        continue;
      }
      const tenantId = row['tenant_id'] ?? '';
      if (tenantId === expected) continue;
      misaligned.push({
        table: family.table,
        keyColumns: family.keyColumns,
        keys: family.keyColumns.map((c) => row[c] ?? ''),
        tenantId,
        expected,
        ownerLabel: ownerKey,
      });
    }
  }

  // project 域源：域 = 其项目登记行的归属域（M1）
  const sources = db.raw
    .prepare(`SELECT id, tenant_id, scope_key FROM knowledge_sources WHERE scope_level = 'project'`)
    .all() as Array<Record<string, string>>;
  for (const src of sources) {
    checked += 1;
    const projectTenants = (
      db.raw
        .prepare(`SELECT DISTINCT tenant_id FROM knowledge_projects WHERE project_key = ?`)
        .all(src['scope_key'] ?? '') as Array<Record<string, string>>
    ).map((r) => r['tenant_id'] ?? '');
    const tenantId = src['tenant_id'] ?? '';
    if (projectTenants.includes(tenantId)) continue; // 本域有项目行 = 自洽（M3 同 key 跨域各一行）
    if (projectTenants.length === 1 && projectTenants[0]) {
      misaligned.push({
        table: 'knowledge_sources',
        keyColumns: ['id'],
        keys: [src['id'] ?? ''],
        tenantId,
        expected: projectTenants[0],
        ownerLabel: src['id'] ?? '',
      });
    } else {
      skipped.push({
        table: 'knowledge_sources',
        label: src['id'] ?? '',
        reason:
          projectTenants.length === 0
            ? '项目无登记行（孤儿源，语义待定）'
            : '项目同 key 多域且本域无行（歧义，勿盲搬）',
      });
    }
  }

  return { misaligned, skipped, checked };
}

/**
 * 归属归一化检测（只读）。
 *
 * @returns findings（KN012–KN015；全对齐时一条 ok）
 */
export async function detectKnowledgeAttribution(): Promise<DataFixResult['findings']> {
  const findings: Finding[] = [];
  const dbPath = knowledgeDbPath();
  if (!existsSync(dbPath)) return findings;
  const { KnowledgeDatabase } = await import('@octopi-agent/engine/harness/knowledge/db.js');
  const db = await KnowledgeDatabase.create({
    dbPath,
    readOnly: true,
    skipMigrate: true,
    sqliteVec: false,
  });
  const registry = await loadRegistry();
  try {
    const scan = scanAttribution(db, {
      registry,
      sessionAgent: resolveSessionAgentId,
    });
    const byTable = new Map<string, MisalignedRow[]>();
    for (const row of scan.misaligned) {
      const list = byTable.get(row.table) ?? [];
      list.push(row);
      byTable.set(row.table, list);
    }
    const agentRows = (byTable.get('knowledge_project_agents') ?? []).concat(
      byTable.get('knowledge_agent_visibility') ?? [],
    );
    if (agentRows.length > 0) {
      findings.push({
        id: 'KN012',
        domain: 'data',
        severity: 'warn',
        message: `knowledge attribution: ${agentRows.length} agent-keyed override row(s) in wrong domain — agent cannot see them (pre-assertion residue)`,
        hint: 'run doctor --fix data to move them to the agent ownership domain',
        fixable: true,
        group: 'data',
      });
    }
    const sourceRows = byTable.get('knowledge_sources') ?? [];
    if (sourceRows.length > 0) {
      findings.push({
        id: 'KN013',
        domain: 'data',
        severity: 'warn',
        message: `knowledge attribution: ${sourceRows.length} project-scope source row(s) in wrong domain — invisible to every tenant (pre-M1 residue)`,
        hint: 'run doctor --fix data to align them to their project row domain',
        fixable: true,
        group: 'data',
      });
    }
    const sessionRows = byTable.get('knowledge_session_visibility') ?? [];
    if (sessionRows.length > 0) {
      findings.push({
        id: 'KN014',
        domain: 'data',
        severity: 'warn',
        message: `knowledge attribution: ${sessionRows.length} session overlay row(s) in wrong domain — overlay has no effect (pre-assertion residue)`,
        hint: 'run doctor --fix data to move them to the session agent ownership domain',
        fixable: true,
        group: 'data',
      });
    }
    if (scan.skipped.length > 0) {
      findings.push({
        id: 'KN015',
        domain: 'data',
        severity: 'info',
        message: `knowledge attribution: ${scan.skipped.length} row(s) skipped (unresolvable/ambiguous) — untouched by --fix`,
        hint: scan.skipped
          .slice(0, 5)
          .map((s) => `${s.table}:${s.label} — ${s.reason}`)
          .join('; '),
        fixable: false,
      });
    }
    if (findings.length === 0) {
      findings.push({
        id: 'KN012',
        domain: 'data',
        severity: 'ok',
        message: `knowledge attribution: ${scan.checked} row(s) checked, all aligned`,
        fixable: false,
      });
    }
    return findings;
  } finally {
    db.close();
    registry?.close();
  }
}

/**
 * 归属归一化修复（--fix data）：错域行移归归属域；目标域已有同键行 → 删残行。
 * 整批事务、幂等；dryRun 只出报告不动库。
 *
 * @param options - dryRun 覆盖（默认 false；doctor --fix --dry-run 传 true）
 * @returns findings + 计数
 */
export async function applyKnowledgeAttributionFixes(options: {
  dryRun?: boolean;
}): Promise<DataFixResult> {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const dbPath = knowledgeDbPath();
  if (!existsSync(dbPath)) return { findings, notes };
  const { KnowledgeDatabase } = await import('@octopi-agent/engine/harness/knowledge/db.js');
  const db = await KnowledgeDatabase.create({
    dbPath,
    readOnly: Boolean(options.dryRun),
    skipMigrate: true,
    sqliteVec: false,
  });
  const registry = await loadRegistry();
  try {
    const scan = scanAttribution(db, { registry, sessionAgent: resolveSessionAgentId });
    if (scan.misaligned.length === 0 && scan.skipped.length === 0) return { findings, notes };
    let moved = 0;
    let dropped = 0;
    if (!options.dryRun) db.raw.exec('BEGIN');
    try {
      for (const row of scan.misaligned) {
        const where = row.keyColumns.map((c) => `${c} = ?`).join(' AND ');
        const exists = db.raw
          .prepare(
            `SELECT 1 AS x FROM ${row.table} WHERE tenant_id = ? AND ${where}`,
          )
          .get(row.expected, ...row.keys) as { x?: number } | undefined;
        if (!options.dryRun) {
          if (exists) {
            db.raw
              .prepare(`DELETE FROM ${row.table} WHERE tenant_id = ? AND ${where}`)
              .run(row.tenantId, ...row.keys);
          } else {
            db.raw
              .prepare(`UPDATE ${row.table} SET tenant_id = ? WHERE tenant_id = ? AND ${where}`)
              .run(row.expected, row.tenantId, ...row.keys);
          }
        }
        if (exists) dropped += 1;
        else moved += 1;
      }
      if (!options.dryRun) db.raw.exec('COMMIT');
    } catch (err) {
      if (!options.dryRun) db.raw.exec('ROLLBACK');
      findings.push({
        id: 'KN012',
        domain: 'data',
        severity: 'warn',
        message: `knowledge attribution fix aborted (${options.dryRun ? 'dry-run' : 'rolled back'}): ${err instanceof Error ? err.message : String(err)}`,
        fixable: false,
      });
      return { findings, notes };
    }
    findings.push({
      id: 'KN012',
      domain: 'data',
      severity: 'ok',
      message: `${options.dryRun ? '[dry-run] would move' : 'attribution fix: moved'} ${moved} row(s) to owner domain, ${dropped} duplicate residue row(s) ${options.dryRun ? 'would be dropped' : 'dropped'}${scan.skipped.length > 0 ? `, ${scan.skipped.length} skipped` : ''}`,
      fixable: false,
    });
    return { findings, notes };
  } finally {
    db.close();
    registry?.close();
  }
}
