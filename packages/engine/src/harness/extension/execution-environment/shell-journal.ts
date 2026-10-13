/**
 * Shell 账本（ToolEffectPolicy §5.6）
 *
 * 无 L4 时由 shell 工具在 spawn 前后制造记账边界：
 * before 快照（内容寻址）→ 执行 → after diff → 注入 TurnFileUndoLog。
 * 清点范围外不装懂；预算撞顶停采 before、业务跑完，标 truncated。
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ToolFileEffects } from '@octopi-agent/core/types/tools.js';
import { pathKey } from './undo-merge.js';

export interface ShellJournalLimit {
  maxFiles?: number;
  maxBytes?: number;
  maxFileSize?: number;
}

export interface ShellJournalOptions {
  /** 清点根（allowRoots）；空 = 无法盘点 */
  roots: string[];
  limit?: ShellJournalLimit;
  /** 排除目录名 */
  excludeDirs?: string[];
}

export interface ShellInventoryEntry {
  path: string;
  hash: string;
  size: number;
}

export interface ShellJournalCapture {
  /** 路径 → hash */
  map: Map<string, ShellInventoryEntry>;
  truncated: boolean;
  scannedFiles: number;
}

const DEFAULT_EXCLUDES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.octopi',
  'coverage',
]);

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 遍历 roots，收集文件内容哈希（供 before/after 对比）。
 *
 * @param options - 根与预算
 * @returns 采集结果；truncated=true 表示撞顶未扫全
 */
export async function captureShellInventory(
  options: ShellJournalOptions,
): Promise<ShellJournalCapture> {
  const map = new Map<string, ShellInventoryEntry>();
  const exclude = new Set(options.excludeDirs ?? [...DEFAULT_EXCLUDES]);
  const limit = options.limit ?? {};
  let scanned = 0;
  let bytes = 0;
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (truncated) return;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (exclude.has(item.name)) continue;
        await walk(full);
        continue;
      }
      if (!item.isFile()) continue;
      if (limit.maxFiles !== undefined && limit.maxFiles > 0 && scanned >= limit.maxFiles) {
        truncated = true;
        return;
      }
      const st = await stat(full).catch(() => undefined);
      if (!st) continue;
      if (limit.maxFileSize !== undefined && limit.maxFileSize > 0 && st.size > limit.maxFileSize) {
        continue;
      }
      if (limit.maxBytes !== undefined && limit.maxBytes > 0 && bytes + st.size > limit.maxBytes) {
        truncated = true;
        return;
      }
      const data = await readFile(full).catch(() => undefined);
      if (!data) continue;
      scanned += 1;
      bytes += data.length;
      map.set(pathKey(full), {
        path: full,
        hash: sha256Hex(data),
        size: data.length,
      });
    }
  };

  for (const root of options.roots) {
    const st = await stat(root).catch(() => undefined);
    if (!st) continue;
    if (st.isDirectory()) await walk(root);
    else if (st.isFile()) {
      const data = await readFile(root).catch(() => undefined);
      if (data) {
        scanned += 1;
        bytes += data.length;
        map.set(pathKey(root), { path: root, hash: sha256Hex(data), size: data.length });
      }
    }
  }

  return { map, truncated, scannedFiles: scanned };
}

export interface ShellDiff {
  created: string[];
  modified: string[];
  deleted: string[];
}

/**
 * 对比 before/after 清单。
 *
 * @param before - shell 前
 * @param after - shell 后
 * @returns 变更集
 */
export function diffShellInventory(
  before: ShellJournalCapture,
  after: ShellJournalCapture,
): ShellDiff {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [key, entry] of after.map) {
    const prev = before.map.get(key);
    if (!prev) created.push(entry.path);
    else if (prev.hash !== entry.hash) modified.push(entry.path);
  }
  for (const [key, entry] of before.map) {
    if (!after.map.has(key)) deleted.push(entry.path);
  }
  return { created, modified, deleted };
}

/**
 * 采 before 时同时保留可恢复字节（内容寻址，去重）。
 * 删除/修改的 before 从这里取，再交给 ToolFileEffects。
 */
export interface ShellSnapshotStore {
  get(path: string): Promise<Buffer | undefined>;
  put(path: string, data: Buffer): Promise<void>;
  hashOf(path: string): string | undefined;
}

export function createShellSnapshotStore(): ShellSnapshotStore {
  const byPath = new Map<string, Buffer>();
  const hashes = new Map<string, string>();
  return {
    async get(path: string) {
      return byPath.get(pathKey(path));
    },
    async put(path: string, data: Buffer) {
      const key = pathKey(path);
      byPath.set(key, data);
      hashes.set(key, sha256Hex(data));
    },
    hashOf(path: string) {
      return hashes.get(pathKey(path));
    },
  };
}

/**
 * shell 前：快照 roots 内文件字节（供 undo）。
 *
 * @param options - roots + 预算
 * @returns 采集 + 字节库
 */
export async function snapshotShellRoots(options: ShellJournalOptions): Promise<{
  capture: ShellJournalCapture;
  store: ShellSnapshotStore;
}> {
  const store = createShellSnapshotStore();
  const exclude = new Set(options.excludeDirs ?? [...DEFAULT_EXCLUDES]);
  const limit = options.limit ?? {};
  const map = new Map<string, ShellInventoryEntry>();
  let scanned = 0;
  let bytes = 0;
  let truncated = false;

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (truncated) return;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (exclude.has(item.name)) continue;
        await walk(full);
        continue;
      }
      if (!item.isFile()) continue;
      if (limit.maxFiles !== undefined && limit.maxFiles > 0 && scanned >= limit.maxFiles) {
        truncated = true;
        return;
      }
      const st = await stat(full).catch(() => undefined);
      if (!st) continue;
      if (limit.maxFileSize !== undefined && limit.maxFileSize > 0 && st.size > limit.maxFileSize) {
        continue;
      }
      if (limit.maxBytes !== undefined && limit.maxBytes > 0 && bytes + st.size > limit.maxBytes) {
        truncated = true;
        return;
      }
      const data = await readFile(full).catch(() => undefined);
      if (!data) continue;
      scanned += 1;
      bytes += data.length;
      await store.put(full, data);
      map.set(pathKey(full), {
        path: full,
        hash: sha256Hex(data),
        size: data.length,
      });
    }
  };

  for (const root of options.roots) {
    const st = await stat(root).catch(() => undefined);
    if (!st) continue;
    if (st.isDirectory()) await walk(root);
    else if (st.isFile()) {
      const data = await readFile(root).catch(() => undefined);
      if (data) {
        scanned += 1;
        bytes += data.length;
        await store.put(root, data);
        map.set(pathKey(root), { path: root, hash: sha256Hex(data), size: data.length });
      }
    }
  }

  return { capture: { map, truncated, scannedFiles: scanned }, store };
}

/**
 * shell 后：diff 并写入效应账本。
 *
 * @param effects - undo log
 * @param before - 前清单
 * @param after - 后清单
 * @param store - before 字节
 * @returns 变更与是否已入账
 */
export async function journalShellDiff(
  effects: ToolFileEffects,
  before: ShellJournalCapture,
  after: ShellJournalCapture,
  store: ShellSnapshotStore,
): Promise<ShellDiff & { journaled: boolean; notInventable: string[] }> {
  // 截断的 before 不得把「未扫到的旧文件」推断成 create（否则 discard 会误删）
  const beforeIncomplete = before.truncated;
  const diff = diffShellInventory(before, after);
  const notInventable: string[] = [];
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const p of diff.created) {
    if (beforeIncomplete) {
      notInventable.push(p);
      continue;
    }
    const data = await readFile(p).catch(() => undefined);
    await effects.recordCreate(p, data);
    created.push(p);
  }
  for (const p of diff.modified) {
    const beforeBytes = await store.get(p);
    const afterBytes = await readFile(p).catch(() => undefined);
    if (beforeBytes !== undefined) {
      await effects.recordOverwrite(p, beforeBytes, afterBytes);
      modified.push(p);
    } else if (beforeIncomplete || before.truncated) {
      notInventable.push(p);
    }
  }
  for (const p of diff.deleted) {
    const beforeBytes = await store.get(p);
    if (beforeBytes !== undefined) {
      await effects.recordDelete(p, beforeBytes);
      deleted.push(p);
    } else {
      notInventable.push(p);
    }
  }

  // after 也不完整时，未覆盖范围视为不可逆
  if (after.truncated) {
    // 未扫到的路径未知；标记预算截断供 noteNotReversed
  }

  return { created, modified, deleted, journaled: true, notInventable };
}

/** 相对路径辅助（诊断用） */
export function relToRoot(root: string, path: string): string {
  return relative(root, path) || path;
}

/** 供 discard 读取的不可逆清单文件名 */
export const NOT_REVERSED_FILE = 'not-reversed.json';

/**
 * 落盘不可逆效应清单（不进 log.jsonl）。
 *
 * @param undoRoot - sessions/<sid>/undo
 * @param payload - 原因 + 路径清单
 */
export async function writeNotReversed(
  undoRoot: string,
  payload: {
    reason: 'inventory_only' | 'budget_truncated' | 'no_roots' | 'shell_journal_off';
    created?: string[];
    modified?: string[];
    deleted?: string[];
  },
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(undoRoot, { recursive: true });
  await writeFile(
    join(undoRoot, NOT_REVERSED_FILE),
    JSON.stringify(payload) + '\n',
    'utf8',
  );
}