/**
 * Document 能力统一装配 — Gateway / Knowledge 共用同一配置源
 *
 * 禁止调用方各自 `createDefaultDocumentPort` 再拼一份默认值：
 * 那样 soffice/超时/限额会分叉（Knowledge worker 曾因此整批 no_adapter）。
 *
 * @module harness/capabilities/document/factory
 */

import { createLegacyConverterFromConfig } from './legacy/factory.js';
import { createDefaultDocumentPort } from './port.js';
import type { DocumentPort, DocumentPortConfig } from './types.js';

/** 根配置 `documents.*`（DocumentsConfigSchema） */
export interface DocumentCapabilityConfig {
  extract?: {
    enabled?: boolean;
    timeoutMs?: number;
    maxFileBytes?: number;
    allowedRoots?: string[];
  };
  legacy?: {
    converter?: 'none' | 'soffice' | 'remote' | null;
    sofficePath?: string | null;
    timeoutMs?: number;
    cacheDir?: string | null;
    cacheMaxBytes?: number;
    maxInputBytes?: number;
  };
}

/**
 * 从 `documents.*` 配置创建 DocumentPort（唯一工厂）。
 *
 * @param cfg - 根配置 documents 段；undefined = 默认 T0 后端、无 legacy 转换
 * @returns DocumentPort
 */
export function createDocumentPortFromConfig(
  cfg?: DocumentCapabilityConfig | null,
): DocumentPort {
  const extract = cfg?.extract;
  const config: DocumentPortConfig = {
    enabled: extract?.enabled !== false,
    ...(extract?.timeoutMs != null ? { timeoutMs: extract.timeoutMs } : {}),
    ...(extract?.maxFileBytes != null ? { maxFileBytes: extract.maxFileBytes } : {}),
    ...(extract?.allowedRoots?.length ? { allowedRoots: extract.allowedRoots } : {}),
  };
  const legacyConverter = createLegacyConverterFromConfig({
    converter: cfg?.legacy?.converter ?? 'none',
    sofficePath: cfg?.legacy?.sofficePath,
    timeoutMs: cfg?.legacy?.timeoutMs,
    cacheDir: cfg?.legacy?.cacheDir,
    cacheMaxBytes: cfg?.legacy?.cacheMaxBytes,
    maxInputBytes: cfg?.legacy?.maxInputBytes,
  });
  return createDefaultDocumentPort({
    config,
    ...(legacyConverter ? { legacyConverter } : {}),
  });
}
