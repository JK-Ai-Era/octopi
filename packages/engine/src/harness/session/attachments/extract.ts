/**
 * 附件抽取 — 生成可读伴生文本（.extracted.md）
 *
 * 本期：文本类直接可读（extractPath = path）；PDF/Office 无 adapter 不抽取。
 * 归属：Session 资产侧，不进 Knowledge ingest（要检索再升 source）。
 */

import { extname } from 'node:path';
import type { AttachmentKind } from './types.js';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.yaml', '.yml',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.html', '.css', '.scss', '.sql', '.sh', '.bash', '.ps1',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.sql', '.sh', '.bash', '.ps1',
]);

/**
 * 按扩展名归类附件
 *
 * @param name - 文件名
 */
export function classifyAttachmentKind(name: string): AttachmentKind {
  const ext = extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (ext === '.pdf' || ext === '.docx' || ext === '.xlsx' || ext === '.pptx') return 'document';
  return 'other';
}

/**
 * 是否可直接当 UTF-8 文本读取
 *
 * @param kind - 附件类型
 * @param name - 文件名
 */
export function isPlainReadable(kind: AttachmentKind, name: string): boolean {
  if (kind === 'image') return false;
  const ext = extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || kind === 'text' || kind === 'code';
}

/**
 * 从缓冲区尝试得到抽取文本
 *
 * @returns 抽取正文；不可抽取返回 null
 */
export function extractText(
  data: Buffer,
  name: string,
  kind: AttachmentKind,
): { text: string; chars: number } | null {
  if (!isPlainReadable(kind, name)) {
    // PDF/Office：本期不抽（FormatAdapter 另册）
    return null;
  }
  // 含 NUL 视为二进制误标
  if (data.includes(0)) return null;
  const text = data.toString('utf8');
  return { text, chars: text.length };
}

/**
 * 伴生抽取文件名（原件旁）
 *
 * @param fileName - 原件相对名
 */
export function extractCompanionName(fileName: string): string {
  const ext = extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${stem}.extracted.md`;
}
