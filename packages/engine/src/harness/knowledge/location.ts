/**
 * Knowledge source location — 归一化与词法校验（写入口唯一真相）
 *
 * 为什么在 Service 写入口做：location 是落库数据，UI 只是众多调用方之一
 * （Gateway 的会话附件、CLI、未来 MCP 工具都会注册源）。只在 UI 里清洗，
 * 别的调用方仍会把 `"C:\Users\me\docs"` 这类带引号的粘贴值写进库，索引时
 * 表现为「0 文件、无报错」的死源。
 *
 * 边界：
 * - 这里只做**词法**校验（去包裹引号/空白、绝对路径、URL scheme），不 stat。
 *   盘上是否存在由 ingest 负责，写成源级 error（显式失败），不阻断注册把
 *   离线盘/稍后挂载的路径提前登记。
 */

import { normalizePathLexical } from './file-identity.js';
import type { KnowledgeSourceKind } from './types.js';

/**
 * 注册入口允许的源类型（**唯一真相**）。
 *
 * 用 `Record<KnowledgeSourceKind, true>` 做穷举：将来给 `KnowledgeSourceKind`
 * 加成员而忘记在此登记，会直接编译失败——避免 gateway / HTTP 校验 / ingest
 * 各留一份 `new Set([...])` 而互相漂移。
 */
const KIND_TABLE: Record<KnowledgeSourceKind, true> = {
  workspace: true,
  directory: true,
  file: true,
  url: true,
  connector: true,
};

export const KNOWLEDGE_SOURCE_KINDS: readonly KnowledgeSourceKind[] = Object.keys(
  KIND_TABLE,
) as KnowledgeSourceKind[];

/** 成对包裹引号：Windows「复制为路径」、中文输入法、shell 复制都会带上 */
const WRAPPING_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['`', '`'],
];

/**
 * 去两端空白与成对包裹引号（可多层，如 `" 'C:\x' "`）。
 *
 * @param raw - 用户/调用方原始输入
 * @returns 去除包裹后的文本（可能为空串）
 */
export function stripLocationWrapping(raw: string): string {
  let out = raw.trim();
  let stripped = true;
  while (stripped && out.length >= 2) {
    stripped = false;
    for (const [open, close] of WRAPPING_QUOTES) {
      if (out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim();
        stripped = true;
        break;
      }
    }
  }
  return out;
}

function locationError(message: string): Error {
  return Object.assign(new Error(message), { code: 'location_invalid' });
}

/**
 * 归一化并校验源 location。
 *
 * - 本地类（workspace / directory / file）：必须是绝对路径（词法判定，不要求存在）
 * - url：必须是 http(s)
 * - connector：JSON 配置串（可解析）或 http(s) 的 list URL
 *
 * @param kind - 源类型
 * @param raw - 原始 location
 * @returns 归一化后的 location（保留调用方原分隔符写法，如 Windows 反斜杠）
 * @throws Error(code='location_invalid') 归一化后仍不合法
 */
export function normalizeSourceLocation(kind: KnowledgeSourceKind, raw: string): string {
  if (!KNOWLEDGE_SOURCE_KINDS.includes(kind)) {
    throw locationError(`invalid kind: ${kind}`);
  }
  const location = stripLocationWrapping(raw);
  if (!location) {
    throw locationError('location is required');
  }
  if (kind === 'workspace' || kind === 'directory' || kind === 'file') {
    try {
      normalizePathLexical(location);
    } catch {
      throw locationError(
        `location must be an absolute path (got "${location}"); example: /Users/you/docs or C:/Users/you/docs`,
      );
    }
    return location;
  }
  if (kind === 'url') {
    if (!/^https?:\/\//i.test(location)) {
      throw locationError(`url source location must be http(s): ${location}`);
    }
    return location;
  }
  // connector
  if (location.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(location);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
    } catch {
      throw locationError('connector location JSON is invalid');
    }
    return location;
  }
  if (!/^https?:\/\//i.test(location)) {
    throw locationError(`connector location must be a JSON config or http(s) URL: ${location}`);
  }
  return location;
}
