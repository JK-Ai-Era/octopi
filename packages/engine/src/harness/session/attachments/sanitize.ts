/**
 * 附件文件名消毒 — 防路径穿越与不安全字符
 */

import { basename, resolve, sep } from 'node:path';

/** 最大保留的显示名长度（含扩展名） */
const MAX_NAME_LEN = 120;

/**
 * 将用户文件名消毒为 attachments 目录内安全相对名
 *
 * @param raw - 原始文件名
 * @returns 安全文件名（非空）
 */
export function sanitizeAttachmentName(raw: string): string {
  const base = basename(String(raw ?? '').replace(/\\/g, '/'));
  let name = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  if (!name || name === '.' || name === '..') {
    name = 'attachment';
  }
  if (name.length > MAX_NAME_LEN) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME_LEN - ext.length) + ext;
  }
  return name;
}

/**
 * 扩展名（小写，含点）；无扩展名返回空串
 *
 * @param name - 文件名
 */
export function attachmentExtension(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot) : '';
}

/**
 * 判断路径是否落在 root 之内（防穿越）
 *
 * @param root - 允许的根目录（已 resolve）
 * @param candidate - 待校验路径（已 resolve）
 */
export function isPathInside(root: string, candidate: string): boolean {
  const win = process.platform === 'win32';
  const norm = (s: string) => (win ? resolve(s).toLowerCase() : resolve(s));
  const r = norm(root);
  const c = norm(candidate);
  if (c === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(prefix);
}
