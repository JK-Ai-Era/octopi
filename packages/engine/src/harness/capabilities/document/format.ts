/**
 * 格式嗅探 — 扩展名 + magic bytes
 *
 * @module harness/capabilities/document/format
 */

import { extname } from 'node:path';
import type { DocumentFormatHint, ExtractSource } from './types.js';

const EXT_MAP: Record<string, DocumentFormatHint> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.doc': 'doc',
  '.xls': 'xls',
  '.ppt': 'ppt',
  '.rtf': 'rtf',
  '.odt': 'odt',
  '.ods': 'ods',
  '.odp': 'odp',
  '.odg': 'odg',
  '.htm': 'html',
  '.html': 'html',
  '.md': 'md',
  '.markdown': 'md',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.txt': 'txt',
  '.log': 'txt',
  '.epub': 'epub',
  '.tex': 'tex',
  '.xmind': 'xmind',
};

/** 二进制老格式（需转换闸门） */
export const LEGACY_FORMATS = new Set<DocumentFormatHint>(['doc', 'xls', 'ppt']);

/** DocumentPort 可尝试抽取的扩展名（含老格式；无后端时仍应跳过） */
export const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.doc',
  '.xls',
  '.ppt',
  '.rtf',
  '.odt',
  '.ods',
  '.odp',
  '.odg',
  '.epub',
  '.tex',
  '.xmind',
]);

/**
 * 路径是否属于文档抽取范围
 *
 * @param path - 文件名或路径
 */
export function isDocumentPath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext);
}

/**
 * 按扩展名猜测格式
 *
 * @param name - 文件名或路径
 * @returns 格式；未知为 unknown
 */
export function formatFromName(name: string | undefined): DocumentFormatHint {
  if (!name) return 'unknown';
  const ext = extname(name).toLowerCase();
  return EXT_MAP[ext] ?? 'unknown';
}

/**
 * 从文件头 magic 判断（仅高置信类型；ZIP/OLE2 子类型靠扩展名）
 *
 * @param head - 文件前若干字节
 * @returns 格式；无法判断为 unknown
 */
export function formatFromMagic(head: Uint8Array | undefined): DocumentFormatHint {
  if (!head || head.length < 4) return 'unknown';

  // PDF: %PDF
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
    return 'pdf';
  }
  // RTF: {\rtf
  if (
    head.length >= 5 &&
    head[0] === 0x7b &&
    head[1] === 0x5c &&
    head[2] === 0x72 &&
    head[3] === 0x74 &&
    head[4] === 0x66
  ) {
    return 'rtf';
  }
  // ZIP (PK) 与 OLE2 (D0 CF 11 E0) 可对应多种 Office 子类型，
  // 不猜 docx/doc —— 交由扩展名；无名时保持 unknown。
  return 'unknown';
}

/**
 * 解析输入格式：hint > name > magic
 *
 * @param source - 原始输入
 * @param head - 可选文件头
 * @returns 格式
 */
export function resolveFormat(source: ExtractSource, head?: Uint8Array): DocumentFormatHint {
  if (source.formatHint && source.formatHint !== 'unknown') return source.formatHint;
  const byName = formatFromName(source.name ?? source.path);
  if (byName !== 'unknown') return byName;
  return formatFromMagic(head);
}
