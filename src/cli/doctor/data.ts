/**
 * doctor 数据层：agent.db 迁移检查 + session.store 废弃检测 + knowledge.db schema 升级
 *
 * 本地确定性；node:sqlite / agent.db 不可用时只报告，不拖垮 doctor。
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOctopiHome } from '@octopi-agent/engine/paths.js';

export interface DataFixResult {
  findings: Array<{
    id: string;
    domain: 'data' | 'config';
    severity: 'error' | 'warn' | 'info' | 'ok';
    message: string;
    hint?: string;
    fixable: boolean;
    group?: 'data' | 'config';
  }>;
  notes: string[];
}

export interface AgentDataTarget {
  id: string;
  home: string;
}

/**
 * 从配置 raw 解析 agent 数据目录目标
 *
 * @param home - OCTOPI_HOME
 * @param raw - 配置对象
 * @returns agent id + home 列表
 */
export function resolveAgentDataTargets(
  home: string,
  raw: Record<string, unknown> | null,
): AgentDataTarget[] {
  const agents = raw && Array.isArray(raw.agents) ? raw.agents : [{ id: 'default' }];
  const out: AgentDataTarget[] = [];
  for (const agent of agents) {
    const a = (typeof agent === 'object' && agent !== null ? agent : {}) as Record<string, unknown>;
    const id = typeof a.id === 'string' && a.id ? a.id : 'default';
    const agentHome =
      typeof a.home === 'string' && a.home
        ? a.home
        : typeof a.persona === 'string'
          ? a.persona
          : join(home, 'agents', id);
    out.push({ id, home: agentHome });
  }
  return out;
}

/**
 * 检测废弃 session.store.dataDir 与真实会话落点对照（不迁移数据）
 *
 * @param raw - 未展开配置
 * @param targets - agent home
 * @param configDir - 配置文件所在目录（dataDir 相对基准）
 * @returns findings
 */
export function checkDeprecatedSessionStore(
  raw: Record<string, unknown> | null,
  targets: AgentDataTarget[],
  configDir: string,
): DataFixResult['findings'] {
  const findings: DataFixResult['findings'] = [];
  if (!raw || typeof raw !== 'object') return findings;
  const session = raw.session;
  if (!session || typeof session !== 'object') return findings;
  const store = (session as Record<string, unknown>).store;
  if (!store || typeof store !== 'object') return findings;

  const dataDirRaw = (store as Record<string, unknown>).dataDir;
  const dataDir =
    typeof dataDirRaw === 'string' && dataDirRaw ? resolve(configDir, dataDirRaw) : undefined;

  let legacyFiles = 0;
  if (dataDir && existsSync(dataDir)) {
    try {
      legacyFiles = readdirSync(dataDir).filter((n) => n.endsWith('.jsonl') || n === 'sessions.json').length;
    } catch {
      // 目录不可读时仍报告废弃字段，不猜测内容
      legacyFiles = -1;
    }
  }

  let liveFiles = 0;
  const liveDir = getOctopiHome() + '/sessions';
  if (existsSync(liveDir)) {
    try {
      liveFiles = readdirSync(liveDir).filter((n) => n.endsWith('.jsonl')).length;
    } catch {
      /* ignore unreadable */
    }
  }

  const dataDirExists = Boolean(dataDir && existsSync(dataDir));
  const hintParts = [
    'runtime sessions live under OCTOPI_HOME/sessions/; session.store.dataDir is not read by Gateway',
  ];
  if (dataDir) {
    hintParts.push(
      dataDirExists
        ? `configured dataDir ${dataDir} exists (${legacyFiles < 0 ? 'unreadable' : `${legacyFiles} session-like file(s)`}) — not read by runtime`
        : `configured dataDir ${dataDir} does not exist`,
    );
  }
  hintParts.push(`live sessions/*.jsonl count ≈ ${liveFiles} in OCTOPI_HOME/sessions/`);
  if (dataDirExists && legacyFiles > 0 && liveFiles === 0) {
    hintParts.push('dataDir has session files but OCTOPI_HOME/sessions/ is empty — data may not be in the active path');
  }

  findings.push({
    id: 'CFG010',
    domain: 'config',
    severity: dataDirExists && legacyFiles > 0 && liveFiles === 0 ? 'warn' : 'info',
    message: 'session.store is deprecated; Gateway ignores store/dataDir',
    hint: hintParts.join('; '),
    fixable: true,
    group: 'config',
  });

  return findings;
}

/**
 * 检测数据层问题（不修改磁盘）
 *
 * @param targets - agent home 列表
 * @returns findings
 */
export function detectDataLayer(targets: AgentDataTarget[]): DataFixResult['findings'] {
  const findings: DataFixResult['findings'] = [];
  for (const t of targets) {
    const dbPath = join(t.home, 'agent.db');
    if (!existsSync(dbPath)) {
      findings.push({
        id: 'DB001',
        domain: 'data',
        severity: 'info',
        message: `agent "${t.id}": agent.db not present yet`,
        hint: 'created/migrated on --fix data group or first serve',
        fixable: true,
        group: 'data',
      });
    }

  }
  findings.push(...detectKnowledgeDb());
  return findings;
}

/** 异步检测 knowledge 源注册健康（doctor detect 合并） */
export async function detectKnowledgeSourcesAsync(): Promise<DataFixResult['findings']> {
  return detectKnowledgeSourceHealth();
}

/** knowledge.db 路径（OCTOPI_HOME/knowledge/） */
export function knowledgeDbPath(): string {
  return join(getOctopiHome(), 'knowledge', 'knowledge.db');
}

/**
 * 检测 knowledge.db 是否仍是旧 schema（source_id/path 文件表，无 identity_key）
 */
export function detectKnowledgeDb(): DataFixResult['findings'] {
  const findings: DataFixResult['findings'] = [];
  const dbPath = knowledgeDbPath();
  if (!existsSync(dbPath)) {
    findings.push({
      id: 'KN001',
      domain: 'data',
      severity: 'info',
      message: 'knowledge.db not present yet (Knowledge Service will create on first start)',
      hint: 'managed by Knowledge Service (manageLocal) or remote baseUrl',
      fixable: false,
    });
    return findings;
  }
  try {
    // 轻量探测：不 import sqlite 也能报文件在；schema 细节留给 --fix
    findings.push({
      id: 'KN002',
      domain: 'data',
      severity: 'info',
      message: `knowledge.db present (${formatBytes(statSync(dbPath).size)}); schema check on --fix data`,
      hint: 'v2 File identity schema: knowledge_files.identity_key + knowledge_memberships',
      fixable: true,
      group: 'data',
    });
  } catch {
    findings.push({
      id: 'KN003',
      domain: 'data',
      severity: 'warn',
      message: 'knowledge.db unreadable',
      hint: 'check permissions on OCTOPI_HOME/knowledge/',
      fixable: false,
    });
  }
  return findings;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 打开 knowledge.db 触发 v2 schema 迁移（幂等；Index 可重建）
 */
export async function migrateKnowledgeDatabase(): Promise<string> {
  const dbPath = knowledgeDbPath();
  const dir = join(getOctopiHome(), 'knowledge');
  mkdirSync(dir, { recursive: true });
  const created = !existsSync(dbPath);
  if (!created) {
    // 迁移前备份（同目录 .bak）
    const bak = `${dbPath}.pre-v2.bak`;
    if (!existsSync(bak)) {
      copyFileSync(dbPath, bak);
    }
  }
  const { KnowledgeDatabase } = await import(
    '@octopi-agent/engine/harness/knowledge/db.js'
  );
  const db = await KnowledgeDatabase.create({ dbPath });
  try {
    const stats = db.stats();
    return created
      ? `knowledge: created knowledge.db (File identity schema)`
      : `knowledge: schema migrate ok (sources=${stats.sources ?? 0}, files=${stats.files ?? 0}; index rebuild via reindex)`;
  } finally {
    db.close();
  }
}

export interface KnowledgeSourceInfo {
  id: string;
  displayName: string;
  location: string;
  status: string;
  scopeLevel: string;
  scopeKey: string;
  kind: string;
}

/**
 * 列出 knowledge.db 中的源注册（不含索引投影）。
 * 源是用户数据，**不**在 migrate 时自动删除。
 */
export async function listKnowledgeSources(): Promise<KnowledgeSourceInfo[]> {
  const dbPath = knowledgeDbPath();
  if (!existsSync(dbPath)) return [];
  const { KnowledgeDatabase } = await import(
    '@octopi-agent/engine/harness/knowledge/db.js'
  );
  const db = await KnowledgeDatabase.create({ dbPath });
  try {
    const rows = db.raw
      .prepare(
        `SELECT id, display_name, location, status, scope_level, scope_key, kind
         FROM knowledge_sources ORDER BY created_at`,
      )
      .all() as Array<{
      id: string;
      display_name: string;
      location: string;
      status: string;
      scope_level: string;
      scope_key: string;
      kind: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      location: r.location,
      status: r.status,
      scopeLevel: r.scope_level,
      scopeKey: r.scope_key,
      kind: r.kind,
    }));
  } finally {
    db.close();
  }
}

/**
 * 检测源注册状态：location 是否还在、是否需 reindex。
 * **不**自动删源；仅报告，删除走 --allow-delete-legacy-dirs 或管理面。
 */
export async function detectKnowledgeSourceHealth(): Promise<DataFixResult['findings']> {
  const findings: DataFixResult['findings'] = [];
  let sources: KnowledgeSourceInfo[] = [];
  try {
    sources = await listKnowledgeSources();
  } catch (err) {
    findings.push({
      id: 'KN004',
      domain: 'data',
      severity: 'warn',
      message: `knowledge: cannot list sources: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'open knowledge.db failed — run doctor --fix data first',
      fixable: false,
    });
    return findings;
  }
  if (sources.length === 0) {
    findings.push({
      id: 'KN005',
      domain: 'data',
      severity: 'info',
      message: 'knowledge: no sources registered',
      hint: 'register sources via Web UI or API',
      fixable: false,
    });
    return findings;
  }

  const missing: KnowledgeSourceInfo[] = [];
  for (const s of sources) {
    if (s.scopeLevel === 'session') continue;
    if (s.kind === 'url' || s.kind === 'connector') continue;
    if (s.location && !existsSync(s.location)) {
      missing.push(s);
    }
  }

  findings.push({
    id: 'KN006',
    domain: 'data',
    severity: 'info',
    message: `knowledge: ${sources.length} source(s) registered (index rebuild via reindex)`,
    hint: sources.map((s) => `${s.displayName || s.id} [${s.status}]`).slice(0, 8).join('; '),
    fixable: false,
  });

  for (const s of missing) {
    findings.push({
      id: 'KN007',
      domain: 'data',
      severity: 'warn',
      message: `knowledge source "${s.displayName || s.id}": location missing (${s.location})`,
      hint:
        'path no longer exists — remove the source via Web UI if obsolete; doctor will not auto-delete source registrations',
      fixable: false,
    });
  }

  return findings;
}

/**
 * 显式删除知识源注册（用户确认后）。
 * 仅删 registration + 本源 memberships；不删共享 File 的 chunks（零认领才 purge）。
 */
export async function removeKnowledgeSource(sourceId: string): Promise<string> {
  const dbPath = knowledgeDbPath();
  const { KnowledgeDatabase } = await import(
    '@octopi-agent/engine/harness/knowledge/db.js'
  );
  const db = await KnowledgeDatabase.create({ dbPath });
  try {
    const src = db.raw
      .prepare('SELECT display_name FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { display_name?: string } | undefined;
    if (!src) return `knowledge source ${sourceId}: not found`;
    db.raw.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(sourceId);
    db.raw.prepare('DELETE FROM knowledge_project_agents WHERE 1=0').run(); // no-op placeholder
    db.raw
      .prepare('DELETE FROM knowledge_memberships WHERE source_id = ?')
      .run(sourceId);
    // 零认领 File 的 purge 交给服务启动 reconcile；此处只解绑
    return `knowledge source "${src.display_name || sourceId}": removed (run reindex/reconcile to purge orphan index)`;
  } finally {
    db.close();
  }
}

/**
 * 打开 agent.db 触发既有 schema migrate（幂等）
 *
 * @param target - agent home
 * @returns 说明；失败时 throw 由调用方转 finding
 */
export async function migrateAgentDatabase(target: AgentDataTarget): Promise<string> {
  const dbPath = join(target.home, 'agent.db');
  const { AgentDatabase } = await import('@octopi-agent/engine/harness/memory/sqlite/agent-db.js');
  const created = !existsSync(dbPath);
  const db = await AgentDatabase.create({ dbPath });
  try {
    const stats = db.stats();
    return created
      ? `agent "${target.id}": created agent.db`
      : `agent "${target.id}": agent.db opened + schema migrate ok (memories=${stats.memories ?? 0})`;
  } finally {
    db.close();
  }
}

/**
 * 应用数据层修复
 *
 * @param targets - agent home 列表
 * @param options - dryRun 时只描述将做什么
 * @returns findings + notes
 */
export async function applyDataLayerFixes(
  targets: AgentDataTarget[],
  options: { dryRun?: boolean } = {},
): Promise<DataFixResult> {
  const notes: string[] = [];
  const findings: DataFixResult['findings'] = [];

  if (options.dryRun) {
    for (const t of targets) {
      const dbPath = join(t.home, 'agent.db');
      notes.push(
        existsSync(dbPath)
          ? `[dry-run] would open+migrate ${dbPath}`
          : `[dry-run] would create ${dbPath}`,
      );
    }
    const kdb = knowledgeDbPath();
    notes.push(
      existsSync(kdb)
        ? `[dry-run] would backup+migrate ${kdb} to File identity schema`
        : `[dry-run] would create ${kdb}`,
    );
    findings.push({
      id: 'FIX002',
      domain: 'data',
      severity: 'info',
      message: `dry-run data fixes: ${notes.length} action(s); disk not modified`,
      hint: notes.join('; ') || undefined,
      fixable: true,
    });
    return { findings, notes };
  }

  for (const t of targets) {
    mkdirSafe(t.home);
    try {
      notes.push(await migrateAgentDatabase(t));
      findings.push({
        id: 'DB001',
        domain: 'data',
        severity: 'ok',
        message: notes[notes.length - 1]!,
        fixable: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`agent "${t.id}" agent.db failed: ${msg}`);
      findings.push({
        id: 'DB003',
        domain: 'data',
        severity: 'error',
        message: `agent "${t.id}": agent.db migrate failed: ${msg}`,
        hint: 'schema migrate failed; inspect agent.db — requires Node.js >= 24 node:sqlite (create is not transactional — file may be partial)',
        fixable: false,
      });
    }
  }

  // knowledge.db：File identity schema（v2）
  try {
    notes.push(await migrateKnowledgeDatabase());
    findings.push({
      id: 'KN002',
      domain: 'data',
      severity: 'ok',
      message: notes[notes.length - 1]!,
      hint: 'index rebuild via source reindex (Index non-authoritative)',
      fixable: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`knowledge.db migrate failed: ${msg}`);
    findings.push({
      id: 'KN003',
      domain: 'data',
      severity: 'error',
      message: `knowledge: schema migrate failed: ${msg}`,
      hint: 'requires Node.js >= 24 node:sqlite; pre-v2 backup written as knowledge.db.pre-v2.bak',
      fixable: false,
    });
  }

  const failed = findings.filter((f) => f.id === 'DB003').length;
  findings.push({
    id: 'FIX002',
    domain: 'data',
    severity: failed > 0 ? 'error' : 'ok',
    message:
      failed > 0
        ? `data-layer fixes completed with ${failed} failure(s) (${notes.length} note(s))`
        : `data-layer fixes completed (${notes.length} note(s))`,
    hint: notes.slice(0, 5).join('; ') || undefined,
    fixable: false,
  });

  return { findings, notes };
}

function mkdirSafe(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
