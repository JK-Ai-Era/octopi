/**
 * LegacyConverter 探测失败 / 配置工厂（无 soffice 时不抛）
 */
import { createSofficeLegacyConverter } from './soffice.js';
import type { LegacyConverter } from '../types.js';

/**
 * 按配置创建 legacy 转换器；converter=none 返回 null
 *
 * @param options - converter / sofficePath / timeoutMs
 * @returns LegacyConverter | null
 */
export function createLegacyConverterFromConfig(options: {
  converter?: 'none' | 'soffice' | 'remote' | null;
  sofficePath?: string | null;
  timeoutMs?: number;
  cacheDir?: string | null;
}): LegacyConverter | null {
  if (!options.converter || options.converter === 'none') return null;
  if (options.converter === 'soffice') {
    return createSofficeLegacyConverter({
      sofficePath: options.sofficePath,
      timeoutMs: options.timeoutMs,
      cacheDir: options.cacheDir,
    });
  }
  // remote（MinerU/WPS/云转换）后续接入
  return null;
}
