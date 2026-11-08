/**
 * Transform record store — durable ledger for compaction products.
 *
 * Layout (same base as turn-undo, sibling of `undo/` and `attachments/`):
 *
 * ```
 * sessions/<sid>/transform/
 *   <agent-file>.jsonl     # append-only entries: {kind:'record'|'revoke', ...}
 *   blobs/<sha256>         # content-addressed replacement texts
 * ```
 *
 * Durability contract: blobs are written (atomic tmp+rename, skip-if-exists)
 * **before** their record line is appended — a line is never readable without
 * its blob. Revocations are append-only lines; the ledger folds them at load.
 * Appends are serialized per (sessionId, agentId) inside the store (review F5:
 * seq assignment must not race), and load returns records sorted by seq.
 *
 * ⚠️ This must NOT live under `sessions/<sid>/undo/` — that directory is
 * deleted wholesale on turn-undo commit/discard.
 *
 * @module harness/session/transform-store
 */

import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toSessionFileName } from '@octopi-agent/core/session-filename.js';
import type {
  NewTransformRecord,
  TransformLedger,
  TransformRecord,
  TransformStore,
} from '../context/transform/types.js';

/** transform 目录布局 */
export interface SessionTransformPaths {
  /** `sessions/<sid>/transform` */
  root: string;
  blobsDir: string;
}

/**
 * 解析会话 transform 目录
 *
 * @param sessionsDir - 通常 `OCTOPI_HOME/sessions`
 * @param sessionId - 会话 id
 * @returns 路径
 */
export function resolveSessionTransformPaths(
  sessionsDir: string,
  sessionId: string,
): SessionTransformPaths {
  const root = join(sessionsDir, toSessionFileName(sessionId), 'transform');
  return { root, blobsDir: join(root, 'blobs') };
}

/**
 * 复制会话 transform 账本（session fork 用）。
 *
 * 源缺失/复制失败返回 false——调用方降级路径是旧快照迁移（拷贝的 legacy 快照在
 * 目标端一次性转换），不是静默成功。
 *
 * @param sessionsDir - `OCTOPI_HOME/sessions`
 * @param fromSessionId - 源会话
 * @param toSessionId - 目标会话
 * @returns 是否完整复制
 */
export async function copySessionTransformDir(
  sessionsDir: string,
  fromSessionId: string,
  toSessionId: string,
): Promise<boolean> {
  const from = resolveSessionTransformPaths(sessionsDir, fromSessionId).root;
  const to = resolveSessionTransformPaths(sessionsDir, toSessionId).root;
  const st = await stat(from).catch(() => undefined);
  if (!st) return false;
  try {
    await mkdir(to, { recursive: true });
    await cp(from, to, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除会话 transform 账本（会话删除清理；摘要正文含用户内容，不得遗留）。
 *
 * @param sessionsDir - `OCTOPI_HOME/sessions`
 * @param sessionId - 会话 id
 * @returns void
 */
export async function removeSessionTransformDir(
  sessionsDir: string,
  sessionId: string,
): Promise<void> {
  await rm(resolveSessionTransformPaths(sessionsDir, sessionId).root, {
    recursive: true,
    force: true,
  });
}

/** transform 孤儿目录（会话已删除/不在，账本残留） */
export interface OrphanTransformDir {
  sessionDirName: string;
  transformRoot: string;
  ledgerFiles: number;
  blobFiles: number;
}

/**
 * 扫描 transform 孤儿目录（doctor 兜底）。
 *
 * 与 undo 不同：transform 账本**设计上常驻**（记录是持久事实），孤儿判据是
 * 「会话 jsonl 已不存在而 transform/ 仍在」（删除清理之外的残留）。
 *
 * @param sessionsDir - `OCTOPI_HOME/sessions`
 * @returns 孤儿列表
 */
export async function scanOrphanSessionTransform(
  sessionsDir: string,
): Promise<OrphanTransformDir[]> {
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const out: OrphanTransformDir[] = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const transformRoot = join(sessionsDir, ent.name, 'transform');
    const st = await stat(transformRoot).catch(() => undefined);
    if (!st) continue;
    const sessionFile = join(sessionsDir, `${ent.name}.jsonl`);
    if (await stat(sessionFile).catch(() => undefined)) continue; // 会话仍在：正常账本
    let ledgerFiles = 0;
    let blobFiles = 0;
    try {
      const items = await readdir(transformRoot, { withFileTypes: true });
      ledgerFiles = items.filter((i) => i.isFile() && i.name.endsWith('.jsonl')).length;
    } catch { /* 视为 0 */ }
    try {
      blobFiles = (await readdir(join(transformRoot, 'blobs'))).length;
    } catch { /* 视为 0 */ }
    out.push({ sessionDirName: ent.name, transformRoot, ledgerFiles, blobFiles });
  }
  return out;
}

/** Per-agent ledger file name (record lines also carry agentId — load filters by it). */
function agentLedgerFile(root: string, agentId: string): string {
  return join(root, `${agentId === '' ? '_' : encodeURIComponent(agentId)}.jsonl`);
}

type LedgerLine =
  | { kind: 'record'; record: Omit<TransformRecord, 'revoked' | 'text'> }
  | { kind: 'revoke'; seq: number; targetSeq: number; at: number };

/** sha256 hex of replacement text */
function blobHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * JSONL file-backed transform store (durable).
 */
export class JsonlTransformStore implements TransformStore {
  private readonly sessionsDir: string;
  /** per (sessionId, agentId) append chain（F5：seq 分配互斥） */
  private readonly appendChains = new Map<string, Promise<unknown>>();

  /**
   * @param options - sessionsDir (`OCTOPI_HOME/sessions`)
   */
  constructor(options: { sessionsDir: string }) {
    this.sessionsDir = options.sessionsDir;
  }

  /**
   * Load the ledger for (sessionId, agentId), blobs hydrated into `text`,
   * records sorted by seq（fold 的 later-seq-wins 依赖序）。
   *
   * @param sessionId - session id
   * @param agentId - agent id
   * @returns ledger (empty when none)
   */
  async load(sessionId: string, agentId: string): Promise<TransformLedger> {
    const { root, blobsDir } = resolveSessionTransformPaths(this.sessionsDir, sessionId);
    const raw = await readFile(agentLedgerFile(root, agentId), 'utf8').catch(() => undefined);
    if (raw === undefined) return { records: [] };
    const records: TransformRecord[] = [];
    const revokeTargets = new Set<number>();
    let hadEntries = false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      hadEntries = true;
      let entry: LedgerLine;
      try {
        entry = JSON.parse(line) as LedgerLine;
      } catch {
        // 损坏行跳过并保留其余账本：append-only 流的尾行可能被崩溃撕裂；
        // 跳过是降级（少一段覆盖→原文可见），不是成功假象。完整校验在红线测试。
        continue;
      }
      if (entry.kind === 'revoke') {
        revokeTargets.add(entry.targetSeq);
        continue;
      }
      if (entry.record.agentId !== agentId) continue;
      const record: TransformRecord = { ...entry.record, revoked: false };
      if (record.blobRef) {
        const text = await readFile(join(blobsDir, record.blobRef.replace(/^sha256:/, '')), 'utf8').catch(() => undefined);
        if (text === undefined) {
          // blob 丢失（外部清扫）：记录不生效（占位无文可渲染）——原文回可见是
          // 降级方向（宁胖不丢），但不得静默（F7）：如实告警。
          console.warn(
            `[transform] session=${sessionId} agent=${agentId} record seq=${record.seq}: blob ${record.blobRef} missing; record dropped (raw text stays visible)`,
          );
          continue;
        }
        record.text = text;
      }
      records.push(record);
    }
    for (const record of records) {
      if (revokeTargets.has(record.seq)) record.revoked = true;
    }
    // 文件序 → seq 序（跨进程交错写也可能倒置；fold 的 later-seq-wins 依赖它）
    records.sort((a, b) => a.seq - b.seq);
    return { records, hadEntries };
  }

  /**
   * Durably append records and/or revocations (serialized per key — seq safe).
   *
   * @param sessionId - session id
   * @param agentId - agent id
   * @param records - new records (seq assigned here)
   * @param revokeSeqs - seqs to revoke
   * @returns appended records with seq assigned
   */
  async append(
    sessionId: string,
    agentId: string,
    records: NewTransformRecord[],
    revokeSeqs?: number[],
  ): Promise<TransformRecord[]> {
    const key = `${sessionId}\u0000${agentId}`;
    const prev = this.appendChains.get(key) ?? Promise.resolve();
    const task = prev.then(() => this.appendInternal(sessionId, agentId, records, revokeSeqs));
    this.appendChains.set(key, task.catch(() => undefined));
    return task;
  }

  private async appendInternal(
    sessionId: string,
    agentId: string,
    records: NewTransformRecord[],
    revokeSeqs?: number[],
  ): Promise<TransformRecord[]> {
    const { root, blobsDir } = resolveSessionTransformPaths(this.sessionsDir, sessionId);
    await mkdir(blobsDir, { recursive: true });
    const existing = await this.load(sessionId, agentId);
    let nextSeq = existing.records.reduce((n, r) => Math.max(n, r.seq), 0) + 1;
    const at = Date.now();
    const out: TransformRecord[] = [];
    const lines: string[] = [];
    for (const rec of records) {
      const seq = nextSeq++;
      let blobRef: string | undefined;
      if (rec.text !== undefined) {
        const hash = blobHash(rec.text);
        blobRef = `sha256:${hash}`;
        await writeBlobIfAbsent(join(blobsDir, hash), rec.text);
      }
      const record: TransformRecord = { ...rec, seq, blobRef, revoked: false };
      out.push(record);
      const { text: _text, revoked: _revoked, ...persisted } = record;
      lines.push(JSON.stringify({ kind: 'record', record: persisted } satisfies LedgerLine));
    }
    for (const targetSeq of revokeSeqs ?? []) {
      lines.push(JSON.stringify({ kind: 'revoke', seq: nextSeq++, targetSeq, at } satisfies LedgerLine));
    }
    if (lines.length > 0) {
      await appendFile(agentLedgerFile(root, agentId), `${lines.join('\n')}\n`, 'utf8');
    }
    return out;
  }
}

/** 内容寻址 blob：不存在才写（tmp+rename 原子替换，防半截文件） */
async function writeBlobIfAbsent(path: string, text: string): Promise<void> {
  const st = await stat(path).catch(() => undefined);
  if (st) return;
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

let warnedInMemoryDurability = false;

/**
 * In-memory transform store (standalone engines / tests). Same append semantics,
 * no durability — permanence holds across assemblies within the process only.
 * First append logs a one-time durability warning (review F4: degradation must
 * not be silent).
 */
export class InMemoryTransformStore implements TransformStore {
  private readonly ledgers = new Map<string, { records: TransformRecord[]; seq: number }>();

  private key(sessionId: string, agentId: string): string {
    return `${sessionId}\u0000${agentId}`;
  }

  /**
   * Load the ledger for (sessionId, agentId).
   *
   * @param sessionId - session id
   * @param agentId - agent id
   * @returns ledger
   */
  async load(sessionId: string, agentId: string): Promise<TransformLedger> {
    const entry = this.ledgers.get(this.key(sessionId, agentId));
    return { records: entry ? entry.records.map((r) => ({ ...r })) : [] };
  }

  /**
   * Append records and/or revocations in memory.
   *
   * @param sessionId - session id
   * @param agentId - agent id
   * @param records - new records
   * @param revokeSeqs - seqs to revoke
   * @returns appended records
   */
  async append(
    sessionId: string,
    agentId: string,
    records: NewTransformRecord[],
    revokeSeqs?: number[],
  ): Promise<TransformRecord[]> {
    if (records.length > 0 && !warnedInMemoryDurability) {
      warnedInMemoryDurability = true;
      console.warn(
        '[transform] in-memory transform store: compaction products are process-local and will not survive restarts (inject JsonlTransformStore for durability)',
      );
    }
    const key = this.key(sessionId, agentId);
    const entry = this.ledgers.get(key) ?? { records: [], seq: 0 };
    const out: TransformRecord[] = [];
    for (const rec of records) {
      entry.seq += 1;
      const record: TransformRecord = { ...rec, seq: entry.seq, blobRef: undefined, revoked: false };
      entry.records.push(record);
      out.push({ ...record });
    }
    for (const targetSeq of revokeSeqs ?? []) {
      entry.seq += 1;
      const target = entry.records.find((r) => r.seq === targetSeq);
      if (target) target.revoked = true;
    }
    this.ledgers.set(key, entry);
    return out;
  }
}
