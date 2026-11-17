/**
 * LegacyConverter 探测失败 / 配置工厂（无 soffice 时不抛）
 */
import { createSofficeLegacyConverter } from './soffice.js';
import type { LegacyConverter } from '../types.js';

/**
 * 按配置创建 legacy 转换器；converter=none 返回 null
 *
 * @param options - converter / sofficePath / timeoutMs / cacheDir / cacheMaxBytes / maxInputBytes
 * @returns LegacyConverter | null
 */
export function createLegacyConverterFromConfig(options: {
  converter?: 'none' | 'soffice' | 'remote' | null;
  sofficePath?: string | null;
  timeoutMs?: number;
  cacheDir?: string | null;
  cacheMaxBytes?: number;
  maxInputBytes?: number;
}): LegacyConverter | null {
  if (!options.converter || options.converter === 'none') return null;
  if (options.converter === 'soffice') {
    return createSofficeLegacyConverter({
      sofficePath: options.sofficePath,
      timeoutMs: options.timeoutMs,
      cacheDir: options.cacheDir,
      cacheMaxBytes: options.cacheMaxBytes,
      maxInputBytes: options.maxInputBytes,
    });
  }
  // 'remote'（MinerU/WPS/云转换）为前瞻性枚举值，尚无实现——fail-loud，
  // 禁止静默退回「不做转换」（那会让抽取悄悄降级为 T0-only）。
  throw new Error(
    'not_implemented: documents.legacy.converter="remote" (MinerU/WPS/cloud) — use "soffice" or "none"',
  );
}
