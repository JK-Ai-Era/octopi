/**
 * doctor 数据层：agent.db 迁移 + 旧 session 文件名
 *
 * 本地确定性；better-sqlite3 不可用时只报告，不拖垮 doctor。
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toSessionFileName } from '../../integration/storage/session-filename.js';

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
 * 统计 sessions 目录中仍使用旧冒号文件名的条目
 *
 * @param sessionsDir - agent sessions 目录
 * @returns 旧文件名列表
 */
export function listLegacySessionFiles(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((name) => name.includes(':'))
    .sort();
}

/**
 * 将旧 session 文件名改为跨平台安全名（目标已存在则跳过）
 *
 * @param sessionsDir - agent sessions 目录
 * @returns 重命名说明
 */
export function renameLegacySessionFiles(sessionsDir: string): string[] {
  const notes: string[] = [];
  if (!existsSync(sessionsDir)) return notes;

  for (const name of listLegacySessionFiles(sessionsDir)) {
    let stem: string;
    let suffix: string;
    if (name.endsWith('.state.json')) {
      stem = name.slice(0, -'.state.json'.length);
      suffix = '.state.json';
    } else if (name.endsWith('.jsonl')) {
      stem = name.slice(0, -'.jsonl'.length);
      suffix = '.jsonl';
    } else {
      const dot = name.lastIndexOf('.');
      stem = dot > 0 ? name.slice(0, dot) : name;
      suffix = dot > 0 ? name.slice(dot) : '';
    }
    const safeName = `${toSessionFileName(stem)}${suffix}`;
    if (safeName === name) continue;
    const fromPath = join(sessionsDir, name);
    const toPath = join(sessionsDir, safeName);
    if (existsSync(toPath)) {
      notes.push(`skip legacy session file (target exists): ${name}`);
      continue;
    }
    try {
      renameSync(fromPath, toPath);
      notes.push(`session ${name} → ${safeName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`failed to rename ${name}: ${msg}`);
    }
  }
  return notes;
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
  for (const t of targets) {
    const sessionsDir = join(t.home, 'sessions');
    if (!existsSync(sessionsDir)) continue;
    try {
      liveFiles += readdirSync(sessionsDir).filter((n) => n.endsWith('.jsonl')).length;
    } catch {
      /* ignore unreadable live dir */
    }
  }

  const dataDirExists = Boolean(dataDir && existsSync(dataDir));
  const hintParts = [
    'runtime sessions live under agents/<id>/sessions/; session.store.dataDir is not read by Gateway',
  ];
  if (dataDir) {
    hintParts.push(
      dataDirExists
        ? `legacy dataDir ${dataDir} exists (${legacyFiles < 0 ? 'unreadable' : `${legacyFiles} session-like file(s)`}) — not auto-migrated`
        : `configured dataDir ${dataDir} does not exist`,
    );
  }
  hintParts.push(`live agent sessions/*.jsonl count ≈ ${liveFiles}`);
  if (dataDirExists && legacyFiles > 0 && liveFiles === 0) {
    hintParts.push('legacy files present while live sessions dir looks empty — backup/migration may be pointed at the wrong path');
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

    const sessionsDir = join(t.home, 'sessions');
    const legacy = listLegacySessionFiles(sessionsDir);
    if (legacy.length > 0) {
      findings.push({
        id: 'DB002',
        domain: 'data',
        severity: 'warn',
        message: `agent "${t.id}": ${legacy.length} legacy session filename(s) with ":"`,
        hint: 'rename to Windows-safe names (same mapping as JsonlSessionStore)',
        fixable: true,
        group: 'data',
      });
    }
  }
  return findings;
}

/**
 * 打开 agent.db 触发既有 schema migrate（幂等）
 *
 * @param target - agent home
 * @returns 说明；失败时 throw 由调用方转 finding
 */
export async function migrateAgentDatabase(target: AgentDataTarget): Promise<string> {
  const dbPath = join(target.home, 'agent.db');
  const { AgentDatabase } = await import('../../harness/memory/sqlite/agent-db.js');
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
      const legacy = listLegacySessionFiles(join(t.home, 'sessions'));
      for (const name of legacy) {
        notes.push(`[dry-run] would rename session ${name}`);
      }
    }
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
    mkdirSafe(join(t.home, 'sessions'));
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
        hint: 'schema migrate failed; inspect agent.db and rebuild better-sqlite3 if needed (create is not transactional — file may be partial)',
        fixable: false,
      });
    }

    const renamed = renameLegacySessionFiles(join(t.home, 'sessions'));
    notes.push(...renamed);
    if (renamed.length > 0) {
      findings.push({
        id: 'DB002',
        domain: 'data',
        severity: 'ok',
        message: `agent "${t.id}": session files → ${renamed.join('; ')}`,
        fixable: false,
      });
    }
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
