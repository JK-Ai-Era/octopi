/**
 * File identity — 物理文件稳定主键（arch/knowledge-service-http.md §6.1）
 *
 * identity_key 不含 size/mtime；版本字段只用于触发 re-parse。
 * 不同 authRef 的外源内容视为不同 File。
 */

import { stat } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export type FileIdentityKind = 'unix' | 'win' | 'path' | 'url' | 'connector';

export interface FileIdentity {
  kind: FileIdentityKind;
  /** 稳定键，存 knowledge_files.identity_key */
  key: string;
  /** 版本：原地更新时比较 */
  size: number;
  mtime: number;
  /** 本地规范化绝对路径或 canonical URL */
  canonical: string;
}

export interface StatLike {
  dev?: number | bigint;
  ino?: number | bigint;
  size: number;
  mtimeMs: number;
  isFile?: boolean;
}

/**
 * Windows / POSIX 路径词法归一（§7）。不要求存在。
 */
export function normalizePathLexical(input: string): string {
  let p = input.replace(/\\/g, '/');
  // \\?\C:\x → C:/x；\\?\UNC\server\share → //server/share（strip 后必须再测盘符）
  if (p.startsWith('//?/')) {
    p = p.slice(4);
    if (/^UNC\//i.test(p)) {
      p = `//${p.slice(4)}`;
    }
  }
  p = p.replace(/^\\\?\//, '/').replace(/^\?\//, '/');
  if (/^[a-z]:\//i.test(p)) {
    p = p[0].toUpperCase() + p.slice(1);
  } else if (/^\/[a-z]:\//i.test(p)) {
    // 残留 /C:/x（历史归一或半截 strip）
    p = p[1].toUpperCase() + p.slice(2);
  } else if (p.startsWith('//')) {
    // UNC: //server/share/...
    p = '//' + p.slice(2);
  }
  const abs = p.startsWith('/') || /^[a-z]:\//i.test(p);
  if (!abs) {
    throw new Error(`location_must_be_absolute: ${input}`);
  }
  const isWinDrive = /^[a-z]:\//i.test(p);
  const isUnc = p.startsWith('//');
  const parts = p.split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > (isWinDrive || isUnc ? 1 : 0)) out.pop();
      continue;
    }
    out.push(seg);
  }
  if (isWinDrive) {
    return out.length ? `${out[0]}/${out.slice(1).join('/')}` : `${out[0] ?? 'C:'}/`;
  }
  if (isUnc) {
    return `//${out.join('/')}`;
  }
  return `/${out.join('/')}`;
}

/** 有则 realpath，否则词法 */
export async function normalizeFsPath(input: string): Promise<string> {
  const lexical = normalizePathLexical(input);
  try {
    const real = await realpath(input);
    return normalizePathLexical(real);
  } catch {
    return lexical;
  }
}

export function foldPathForCompare(p: string, kind: 'win' | 'posix'): string {
  return kind === 'win' ? p.toLowerCase() : p;
}

export function pathCompareKind(normalized: string): 'win' | 'posix' {
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? 'win' : 'posix';
}

/**
 * path segment 前缀（`/data/corpus` 不是 `/data/corpus2` 的祖先）
 */
export function isPathPrefix(prefix: string, full: string): boolean {
  const k = pathCompareKind(prefix);
  const a = foldPathForCompare(prefix, k).replace(/\/+$/, '');
  const b = foldPathForCompare(full, k).replace(/\/+$/, '');
  if (a === b) return true;
  return b.startsWith(a.endsWith('/') ? a : `${a}/`);
}

export function canonicalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  // **保留 query**：?id=1 / ?id=2 大概率是不同文档（契约修订）
  u.hostname = u.hostname.toLowerCase();
  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = '';
  }
  let s = u.toString();
  if (s.endsWith('/') && !u.search) s = s.slice(0, -1);
  return s;
}

function authSuffix(authRef: string | null | undefined): string {
  return authRef && authRef.length > 0 ? authRef : 'none';
}

export function urlIdentityKey(raw: string, authRef?: string | null): string {
  return `url:${canonicalizeUrl(raw)}#${authSuffix(authRef)}`;
}

export function connectorIdentityKey(
  connectorId: string,
  resourceKey: string,
  authRef?: string | null,
): string {
  return `connector:${connectorId}:${resourceKey}#${authSuffix(authRef)}`;
}

function pathFallbackKey(normalized: string): string {
  return `path:${normalized}`;
}

/**
 * 本地文件 identity + version。失败退化 path:realpath（不含 size/mtime）。
 */
export async function identifyLocalFile(absPath: string): Promise<FileIdentity> {
  const canonical = await normalizeFsPath(absPath);
  let st: StatLike;
  try {
    st = (await stat(absPath)) as unknown as StatLike;
  } catch (err) {
    throw err;
  }
  const size = Number(st.size ?? 0);
  const mtime = Math.floor(Number(st.mtimeMs ?? 0));
  const ino = st.ino != null ? BigInt(st.ino) : null;
  const dev = st.dev != null ? BigInt(st.dev) : null;
  const isWin = process.platform === 'win32';
  if (ino != null && dev != null && ino > 0n) {
    const key = isWin ? `win:${dev}:${ino}` : `unix:${dev}:${ino}`;
    return { kind: isWin ? 'win' : 'unix', key, size, mtime, canonical };
  }
  return { kind: 'path', key: pathFallbackKey(canonical), size, mtime, canonical };
}

export async function identifyUrl(
  raw: string,
  authRef?: string | null,
  version?: { size?: number; mtime?: number },
): Promise<FileIdentity> {
  const canonical = canonicalizeUrl(raw);
  return {
    kind: 'url',
    key: urlIdentityKey(raw, authRef),
    size: Number(version?.size ?? 0),
    mtime: Number(version?.mtime ?? 0),
    canonical,
  };
}

export function identifyConnector(
  connectorId: string,
  resourceKey: string,
  authRef?: string | null,
  version?: { size?: number; mtime?: number },
): FileIdentity {
  return {
    kind: 'connector',
    key: connectorIdentityKey(connectorId, resourceKey, authRef),
    size: Number(version?.size ?? 0),
    mtime: Number(version?.mtime ?? 0),
    canonical: `${connectorId}:${resourceKey}`,
  };
}

/** Membership logical_path：相对 root，统一 `/` */
export function logicalPathFrom(root: string, abs: string): string {
  const k = pathCompareKind(root);
  const r = foldPathForCompare(normalizePathLexical(root), k).replace(/\/+$/, '');
  const f = foldPathForCompare(normalizePathLexical(abs), k);
  if (!isPathPrefix(normalizePathLexical(root), normalizePathLexical(abs))) {
    // 大小写：win fold 后前缀
    const rf = foldPathForCompare(r, k);
    const ff = foldPathForCompare(f, k);
    if (!ff.startsWith(rf.endsWith('/') ? rf : `${rf}/`) && ff !== rf) {
      throw new Error(`path_outside_root: ${abs} not under ${root}`);
    }
    return ff === rf ? path.basename(f) : ff.slice(rf.length).replace(/^\//, '');
  }
  const rel = path.posix.relative(r, f);
  return rel === '' ? path.posix.basename(f) : rel;
}
