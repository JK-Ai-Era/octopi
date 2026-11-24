/**
 * 旧月度冷备（`archives/*.sessions.jsonl.gz`）读取器 —— 一次性转 bundle 迁移用（P2）
 *
 * 旧机制（SessionArchiveManager 月度追加写入）已整体删除；本模块只负责把
 * 存量旧文件读成条目供迁移编排（gateway 侧）逐条转入封存 bundle。
 * 迁移完成后旧文件删除，检索/读取一律走注册表 + bundle（不留双读路径）。
 *
 * @module
 */

import { readdir, readFile } from 'node:fs/promises';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';

const gunzipAsync = promisify(gunzip);

/** 旧月度冷备条目（行 JSON 结构） */
export interface LegacyArchiveEntry {
  sessionId: string;
  data: SessionData;
  archivedAt: number;
}

/**
 * 列出旧月度冷备文件
 *
 * @param archivesDir - OCTOPI_HOME/archives
 * @returns `*.sessions.jsonl.gz` 绝对路径（文件名升序）
 */
export async function findLegacyMonthlyFiles(archivesDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(archivesDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith('.sessions.jsonl.gz'))
    .sort()
    .map((e) => join(archivesDir, e));
}

/**
 * 读取单个旧月度文件的全部条目
 *
 * @param file - `*.sessions.jsonl.gz` 路径
 * @returns entries = 可解析条目；unreadable = 坏行数（>0 时调用侧不得删源文件——
 *   转换幂等以注册表为准，但坏行只存在于源文件，删了即丢）
 * @throws 文件整体不可读（非 gzip / IO 失败）——调用侧跳过该文件并告警
 */
export async function readLegacyMonthlyEntries(
  file: string,
): Promise<{ entries: LegacyArchiveEntry[]; unreadable: number }> {
  const buf = await gunzipAsync(await readFile(file));
  const entries: LegacyArchiveEntry[] = [];
  let unreadable = 0;
  for (const line of buf.toString('utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LegacyArchiveEntry);
    } catch {
      unreadable++;
    }
  }
  return { entries, unreadable };
}
