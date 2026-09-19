/**
 * doctor --restore：从本地备份恢复 octopi.json
 *
 * 仅文件复制；不调用 LLM；恢复前先备份当前配置。
 *
 * @module
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/**
 * 列出配置旁的备份文件（新→旧）
 *
 * @param configPath - 当前配置路径
 * @returns 备份绝对路径列表
 */
export function listConfigBackups(configPath: string): string[] {
  const abs = resolve(configPath);
  const dir = dirname(abs);
  const base = basename(abs);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name === `${base}.bak` || name.startsWith(`${base}.bak.`))
    .map((name) => resolve(dir, name))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

/**
 * 选取最新备份
 *
 * @param configPath - 配置路径
 * @returns 最新备份路径；无则 null
 */
export function latestConfigBackup(configPath: string): string | null {
  const list = listConfigBackups(configPath);
  return list[0] ?? null;
}

export interface RestoreResult {
  ok: boolean;
  configPath: string;
  backupPath?: string;
  preRestoreCopy?: string;
  message: string;
}

/**
 * 用备份覆盖当前配置（当前文件先另存）
 *
 * @param configPath - 目标配置
 * @param backupPath - 备份文件
 * @returns 结果说明
 */
export function restoreConfigFromBackup(configPath: string, backupPath: string): RestoreResult {
  if (!existsSync(backupPath)) {
    return {
      ok: false,
      configPath,
      backupPath,
      message: `backup not found: ${backupPath}`,
    };
  }
  if (!existsSync(configPath)) {
    return {
      ok: false,
      configPath,
      backupPath,
      message: `config not found: ${configPath}`,
    };
  }

  // 校验备份是合法 JSON（避免把损坏文件写回）
  try {
    JSON.parse(readFileSync(backupPath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      configPath,
      backupPath,
      message: `backup is not valid JSON, refuse to restore: ${msg}`,
    };
  }

  const preRestoreCopy = `${configPath}.pre-restore.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(configPath, preRestoreCopy);
  copyFileSync(backupPath, configPath);

  return {
    ok: true,
    configPath,
    backupPath,
    preRestoreCopy,
    message: `restored ${configPath} from ${backupPath} (previous config saved at ${preRestoreCopy})`,
  };
}
