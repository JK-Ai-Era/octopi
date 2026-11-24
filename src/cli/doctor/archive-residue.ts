/**
 * doctor 归档/删除残留扫描（P3，arch/session-archive-recycle.md §8 存量孤儿）
 *
 * 判定口径：会话「在世」= OCTOPI_HOME/sessions/ 下存在其 jsonl/state 文件或元索引条目
 * （名字集按 id 的全部已知规范化形态匹配，偏安全方向：拿不准的不报孤儿，绝不误删在世会话）。
 * 不在世会话的 wire dump 目录 / 空会话目录（含 derived/ 残留）/ knowledge session 源与
 * visibility·hits 行 = 残留；--fix 显式清除。旧月度 gz（迁移保留件）与 archives/.staging
 * 只报告不动手（唯一正文可能只在那里 / reconcile 有收尾语义）。本地确定性，不调用 LLM。
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getOctopiHome } from '@octopi-agent/engine/paths.js';
import { toSessionFileName } from '@octopi-agent/core/session-filename.js';
import { sanitizeSessionDirName } from '@octopi-agent/engine/integration/providers/wire-dump.js';
import type { DataFixResult } from './data.js';
import { knowledgeDbPath, removeKnowledgeSource } from './data.js';

/** 目录递归大小/文件计数（不可读子项显式计入 unreadable，不静默丢） */
interface DirStats {
  bytes: number;
  files: number;
  unreadable: number;
}

function dirStats(path: string): DirStats {
  const out: DirStats = { bytes: 0, files: 0, unreadable: 0 };
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    out.unreadable += 1;
    return out;
  }
  for (const name of entries) {
    const child = join(path, name);
    try {
      const st = statSync(child);
      if (st.isDirectory()) {
        const sub = dirStats(child);
        out.bytes += sub.bytes;
        out.files += sub.files;
        out.unreadable += sub.unreadable;
      } else {
        out.bytes += st.size;
        out.files += 1;
      }
    } catch {
      out.unreadable += 1;
    }
  }
  return out;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/** 在世会话名册（id + 全部规范化形态；孤儿判定的权威） */
export interface LiveSessionRoster {
  ids: Set<string>;
  names: Set<string>;
}

/**
 * 收集在世会话名册：sessions.json 元索引 + 磁盘 jsonl/state 文件名（双源取并集，偏安全）
 *
 * @param home - OCTOPI_HOME
 * @returns id 集合与名字集合
 */
export function collectLiveSessionRoster(home: string): LiveSessionRoster {
  const ids = new Set<string>();
  const names = new Set<string>();
  const add = (id: string): void => {
    ids.add(id);
    names.add(id);
    names.add(toSessionFileName(id));
    names.add(sanitizeSessionDirName(id));
  };
  const dir = join(home, 'sessions');
  try {
    for (const name of readdirSync(dir)) {
      if (name === 'sessions.json') {
        try {
          const meta = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, unknown>;
          for (const id of Object.keys(meta)) add(id);
        } catch {
          // 元索引不可解析：仍以文件名源兜底（doctor 不因单源损坏失明）
        }
      } else if (name.endsWith('.jsonl')) {
        add(name.slice(0, -'.jsonl'.length));
      } else if (name.endsWith('.state.json')) {
        add(name.slice(0, -'.state.json'.length));
      }
    }
  } catch {
    // sessions/ 不存在：名册为空，所有残留面按空集判定
  }
  return { ids, names };
}

/** 残留清单（detect 与 fix 共用的单源判定） */
export interface ResidueInventory {
  dumpDirs: Array<{ path: string; bytes: number }>;
  unscopedDump: { path: string; bytes: number } | null;
  sessionDirs: Array<{ path: string; bytes: number; files: number }>;
  knowledgeSources: Array<{ id: string; displayName: string }>;
  visibilityRows: Array<{ sessionId: string; count: number }>;
  hitRows: Array<{ sessionId: string; count: number }>;
  legacyMonthlyFiles: string[];
  stagingEntries: string[];
}

/**
 * 扫描全部归档/删除残留面（§8 存量孤儿清单）
 *
 * @param home - OCTOPI_HOME（默认运行时 home）
 * @returns 残留清单
 */
export async function collectArchiveResidue(home: string = getOctopiHome()): Promise<ResidueInventory> {
  const live = collectLiveSessionRoster(home);
  const out: ResidueInventory = {
    dumpDirs: [],
    unscopedDump: null,
    sessionDirs: [],
    knowledgeSources: [],
    visibilityRows: [],
    hitRows: [],
    legacyMonthlyFiles: [],
    stagingEntries: [],
  };

  // A. wire dump 目录（隐私面最大的残留；缺省清除后不该有孤儿）
  const dumpsDir = join(home, 'logs', 'llm-requests');
  try {
    for (const name of readdirSync(dumpsDir)) {
      const path = join(dumpsDir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const stats = dirStats(path);
      if (name === '_unscoped') {
        out.unscopedDump = { path, bytes: stats.bytes };
      } else if (!live.names.has(name)) {
        out.dumpDirs.push({ path, bytes: stats.bytes });
      }
    }
  } catch {
    // 目录不存在 = 无残留
  }

  // B. sessions/ 孤儿子目录（无 jsonl/state 支撑；含 derived/ 等残留内容）
  const sessionsDir = join(home, 'sessions');
  try {
    for (const name of readdirSync(sessionsDir)) {
      const path = join(sessionsDir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (live.names.has(name)) continue;
      const stats = dirStats(path);
      out.sessionDirs.push({ path, bytes: stats.bytes, files: stats.files });
    }
  } catch {
    // 目录不存在 = 无残留
  }

  // C. knowledge：失去会话的 session 源与 visibility/hits 行
  const dbPath = knowledgeDbPath();
  if (existsSync(dbPath)) {
    try {
      const { KnowledgeDatabase } = await import('@octopi-agent/engine/harness/knowledge/db.js');
      const db = await KnowledgeDatabase.create({ dbPath });
      try {
        const sources = db.raw
          .prepare("SELECT id, display_name, scope_key FROM knowledge_sources WHERE scope_level = 'session'")
          .all() as Array<{ id: string; display_name?: string; scope_key: string }>;
        for (const s of sources) {
          if (!live.ids.has(s.scope_key)) {
            out.knowledgeSources.push({ id: s.id, displayName: s.display_name || s.id });
          }
        }
        const visSessions = db.raw
          .prepare('SELECT DISTINCT local_session_id AS sid FROM knowledge_session_visibility')
          .all() as Array<{ sid: string }>;
        for (const { sid } of visSessions) {
          if (!sid || live.ids.has(sid)) continue;
          const row = db.raw
            .prepare('SELECT COUNT(*) AS n FROM knowledge_session_visibility WHERE local_session_id = ?')
            .get(sid) as { n: number };
          if (row.n > 0) out.visibilityRows.push({ sessionId: sid, count: row.n });
        }
        const hitSessions = db.raw
          .prepare('SELECT DISTINCT session_id AS sid FROM knowledge_hits')
          .all() as Array<{ sid: string | null }>;
        for (const { sid } of hitSessions) {
          if (!sid || live.ids.has(sid)) continue;
          const row = db.raw
            .prepare('SELECT COUNT(*) AS n FROM knowledge_hits WHERE session_id = ?')
            .get(sid) as { n: number };
          if (row.n > 0) out.hitRows.push({ sessionId: sid, count: row.n });
        }
      } finally {
        db.close();
      }
    } catch {
      // knowledge.db 不可打开：KN 系列已覆盖库健康；这里不重复报、不失明其它残留面
    }
  }

  // D. 旧月度冷备（迁移保留件：坏行/撞 id/封存失败）——只报告，唯一正文可能只在源文件
  const archivesDir = join(home, 'archives');
  try {
    for (const name of readdirSync(archivesDir)) {
      if (name.endsWith('.sessions.jsonl.gz')) out.legacyMonthlyFiles.push(join(archivesDir, name));
    }
  } catch {
    // 无 archives/ = 无残留
  }

  // E. archives/.staging 尾巴（启动 reconcile 有收尾语义；只提示）
  try {
    out.stagingEntries = readdirSync(join(archivesDir, '.staging')).map((n) => join(archivesDir, '.staging', n));
  } catch {
    // 无 staging = 无残留
  }

  return out;
}

/**
 * 归档/删除残留扫描 → doctor findings（ARC001–ARC007）
 *
 * @returns findings（不修改磁盘）
 */
export async function detectArchiveResidue(): Promise<DataFixResult['findings']> {
  const r = await collectArchiveResidue();
  const findings: DataFixResult['findings'] = [];
  const totalDumpBytes = r.dumpDirs.reduce((sum, d) => sum + d.bytes, 0);
  if (r.dumpDirs.length > 0) {
    findings.push({
      id: 'ARC001',
      domain: 'data',
      severity: 'warn',
      message: `orphan wire-dump dirs in logs/llm-requests (no live session): ${r.dumpDirs.length} dir(s), ${formatBytes(totalDumpBytes)}`,
      hint: 'dumps hold full request bodies incl. system prompt — safe to remove once the sessions are truly gone; --fix deletes them',
      fixable: true,
      group: 'data',
    });
  }
  if (r.unscopedDump) {
    findings.push({
      id: 'ARC002',
      domain: 'data',
      severity: 'warn',
      message: `unscoped dump dir logs/llm-requests/_unscoped: ${formatBytes(r.unscopedDump.bytes)}`,
      hint: 'historical dumps that never got a session scope; --fix deletes the dir',
      fixable: true,
      group: 'data',
    });
  }
  if (r.sessionDirs.length > 0) {
    const total = r.sessionDirs.reduce((sum, d) => sum + d.bytes, 0);
    const withFiles = r.sessionDirs.filter((d) => d.files > 0).length;
    findings.push({
      id: 'ARC003',
      domain: 'data',
      severity: 'warn',
      message: `orphan session dirs under sessions/ (no jsonl/state): ${r.sessionDirs.length} dir(s), ${formatBytes(total)}${withFiles > 0 ? `; ${withFiles} still hold residue (attachments/derived/…)` : ''}`,
      hint: '--fix deletes them; content is unreachable without its session',
      fixable: true,
      group: 'data',
    });
  }
  if (r.knowledgeSources.length > 0) {
    findings.push({
      id: 'ARC004',
      domain: 'data',
      severity: 'warn',
      message: `session-scoped knowledge sources without a live session: ${r.knowledgeSources.length} (${r.knowledgeSources.map((s) => s.displayName).slice(0, 3).join(', ')}${r.knowledgeSources.length > 3 ? ', …' : ''})`,
      hint: 'seal/restore re-registers sources for sealed sessions; these lost their session entirely — --fix unregisters them',
      fixable: true,
      group: 'data',
    });
  }
  const visTotal = r.visibilityRows.reduce((sum, v) => sum + v.count, 0);
  const hitTotal = r.hitRows.reduce((sum, v) => sum + v.count, 0);
  if (visTotal > 0 || hitTotal > 0) {
    findings.push({
      id: 'ARC005',
      domain: 'data',
      severity: 'warn',
      message: `knowledge rows for gone sessions: session_visibility=${visTotal}, hits=${hitTotal}`,
      hint: '--fix deletes the rows',
      fixable: true,
      group: 'data',
    });
  }
  if (r.legacyMonthlyFiles.length > 0) {
    findings.push({
      id: 'ARC006',
      domain: 'data',
      severity: 'warn',
      message: `legacy monthly archive files kept by migration: ${r.legacyMonthlyFiles.length}`,
      hint: 'unconverted lines exist only here — serve start retries conversion (idempotent); delete manually only when content is expendable',
      fixable: false,
    });
  }
  if (r.stagingEntries.length > 0) {
    findings.push({
      id: 'ARC007',
      domain: 'data',
      severity: 'info',
      message: `archives/.staging leftovers: ${r.stagingEntries.length} entr(ies)`,
      hint: 'startup reconcile settles or clears them; investigate only if they survive a serve start',
      fixable: false,
    });
  }
  return findings;
}

/**
 * 应用残留清除（--fix）：删孤儿 dump/会话目录、注销孤儿 session 源、删 visibility/hits 行。
 * ARC006/ARC007 永不动手（唯一正文可能只在源文件 / reconcile 有收尾语义）。
 *
 * @param options - dryRun 时只描述将做什么
 * @returns findings + notes
 */
export async function applyArchiveResidueFixes(
  options: { dryRun?: boolean } = {},
): Promise<DataFixResult> {
  const r = await collectArchiveResidue();
  const notes: string[] = [];
  const findings: DataFixResult['findings'] = [];
  const dumpTotal = r.dumpDirs.reduce((sum, d) => sum + d.bytes, 0);
  const dirTotal = r.sessionDirs.reduce((sum, d) => sum + d.bytes, 0);

  if (options.dryRun) {
    if (r.dumpDirs.length > 0) {
      notes.push(`[dry-run] would delete ${r.dumpDirs.length} orphan wire-dump dir(s) (${formatBytes(dumpTotal)})`);
    }
    if (r.unscopedDump) {
      notes.push(`[dry-run] would delete logs/llm-requests/_unscoped (${formatBytes(r.unscopedDump.bytes)})`);
    }
    if (r.sessionDirs.length > 0) {
      notes.push(`[dry-run] would delete ${r.sessionDirs.length} orphan session dir(s) (${formatBytes(dirTotal)})`);
    }
    if (r.knowledgeSources.length > 0) {
      notes.push(`[dry-run] would unregister ${r.knowledgeSources.length} orphan session knowledge source(s)`);
    }
    const visTotal = r.visibilityRows.reduce((sum, v) => sum + v.count, 0);
    const hitTotal = r.hitRows.reduce((sum, v) => sum + v.count, 0);
    if (visTotal > 0 || hitTotal > 0) {
      notes.push(`[dry-run] would delete knowledge rows: session_visibility=${visTotal}, hits=${hitTotal}`);
    }
    if (notes.length === 0) notes.push('[dry-run] no archive residue to clean');
    findings.push({
      id: 'FIX003',
      domain: 'data',
      severity: 'info',
      message: `dry-run archive-residue fixes: ${notes.length} action(s); disk not modified`,
      hint: notes.join('; '),
      fixable: true,
    });
    return { findings, notes };
  }

  for (const d of r.dumpDirs) {
    rmSync(d.path, { recursive: true, force: true });
    notes.push(`wire-dump dir deleted: ${d.path} (${formatBytes(d.bytes)})`);
  }
  if (r.unscopedDump) {
    rmSync(r.unscopedDump.path, { recursive: true, force: true });
    notes.push(`unscoped dump dir deleted: ${r.unscopedDump.path}`);
  }
  for (const d of r.sessionDirs) {
    rmSync(d.path, { recursive: true, force: true });
    notes.push(`orphan session dir deleted: ${d.path} (${formatBytes(d.bytes)})`);
  }
  for (const s of r.knowledgeSources) {
    notes.push(await removeKnowledgeSource(s.id));
  }
  const dbPath = knowledgeDbPath();
  const visTotal = r.visibilityRows.reduce((sum, v) => sum + v.count, 0);
  const hitTotal = r.hitRows.reduce((sum, v) => sum + v.count, 0);
  if (visTotal > 0 || hitTotal > 0) {
    if (existsSync(dbPath)) {
      const { KnowledgeDatabase } = await import('@octopi-agent/engine/harness/knowledge/db.js');
      const db = await KnowledgeDatabase.create({ dbPath });
      try {
        for (const v of r.visibilityRows) {
          db.raw
            .prepare('DELETE FROM knowledge_session_visibility WHERE local_session_id = ?')
            .run(v.sessionId);
        }
        for (const h of r.hitRows) {
          db.raw.prepare('DELETE FROM knowledge_hits WHERE session_id = ?').run(h.sessionId);
        }
      } finally {
        db.close();
      }
      notes.push(`knowledge residue rows deleted: session_visibility=${visTotal}, hits=${hitTotal}`);
    } else {
      // 计数与库现状之间的竞态（库被并发删除）：显式降级，不静默假装清了
      notes.push(`knowledge rows skipped: ${dbPath} disappeared mid-fix`);
    }
  }
  if (notes.length === 0) notes.push('no archive residue to clean');
  findings.push({
    id: 'FIX003',
    domain: 'data',
    severity: 'ok',
    message: `archive-residue fixes applied: ${notes.length} action(s)`,
    hint: notes.join('; ') || undefined,
    fixable: true,
  });
  return { findings, notes };
}
