/**
 * LLM Wire Dump — 前缀比对分析
 *
 * 读 `<dir>/<session>/index.jsonl`，按时间顺序把相邻两次调用逐条比对，
 * 回答「前缀在哪一条消息、哪个字符断开」。
 *
 * 判据：前缀缓存只认最长公共前缀，因此相邻调用的 `messages` 序列逐单元 hash 比对
 * 即是 provider 的缓存判据（tools 变化单独标记）。
 *
 * @module integration/providers/wire-dump-diff
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  wireUnitPayloads,
  type WireDumpIndexRecord,
  type WireDumpRequestRecord,
  type WireDumpResultRecord,
} from './wire-dump.js';

/** 一次调用的合并视图（request 行 + 可选 result 行） */
export interface WireCallSummary {
  request: WireDumpRequestRecord;
  result?: WireDumpResultRecord;
  /** body 文件是否仍存在（环形裁剪/oversize 后可能缺失） */
  hasBody: boolean;
}

/** 相邻两次调用的前缀比对结果 */
export interface WirePrefixDiff {
  /** identical：完全一致；append-only：纯追加；truncated：尾部被删；diverged：中部改写 */
  stability: 'identical' | 'append-only' | 'truncated' | 'diverged';
  /** 逐单元 hash 相同的单元数 */
  commonPrefix: number;
  appended: number;
  removed: number;
  /** 公共前缀在 next 侧的字符数（≈ 可命中缓存的输入量） */
  stableChars: number;
  /**
   * 实际可复用缓存的前缀字符数
   *
   * tools / model 变化会让整段前缀缓存失效，此时为 0：Anthropic 文档明确缓存层级为
   * tools → system → messages，OpenAI 的完整渲染上下文同样把工具定义排在消息之前。
   * 仅消息前缀稳定不足以命中缓存。`mode` 变化不影响缓存，不参与此判定。
   */
  cacheableChars: number;
  divergence?: {
    index: number;
    prevRole?: string;
    nextRole?: string;
    prevLen?: number;
    nextLen?: number;
  };
  toolsChanged: boolean;
  modelChanged: boolean;
  modeChanged: boolean;
}

/** 单条消息内部的字符级差异 */
export interface WireUnitDiffDetail {
  index: number;
  /** 单元内首个不同字符的偏移（0 = 单元开头即不同） */
  offset: number;
  prevSnippet: string;
  nextSnippet: string;
}

/**
 * 读取 session 目录里第一条 request 记录（用于按真实 sessionId 匹配被 sanitize 过的目录名）
 *
 * @param dirPath - session 目录
 * @returns 首条 request 行；不存在时 null
 */
export function readFirstWireDumpRequest(dirPath: string): WireDumpRequestRecord | null {
  const indexPath = join(dirPath, 'index.jsonl');
  if (!existsSync(indexPath)) return null;
  let head: string;
  try {
    // 只需靠前的行：截取前 64KB 足够覆盖若干条索引行
    head = readFileSync(indexPath, 'utf8').slice(0, 65_536);
  } catch {
    return null;
  }
  // 首行可能是 result 行、半行或损坏行：逐行找第一条能解析的 request
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as WireDumpIndexRecord;
      if (rec.type === 'request') return rec;
    } catch {
      // 截断/损坏行（多半是 64KB 边界或进程被杀）：跳过，继续找下一行
      continue;
    }
  }
  return null;
}

/**
 * 读取单个 session 目录的 index.jsonl（request 与 result 按 id 合并、按时间排序）
 *
 * @param dirPath - session 目录（含 index.jsonl）
 * @returns 调用摘要列表；无索引时返回空数组
 */
export function readWireDumpIndex(dirPath: string): WireCallSummary[] {
  const indexPath = join(dirPath, 'index.jsonl');
  if (!existsSync(indexPath)) return [];

  const requests: WireDumpRequestRecord[] = [];
  const results = new Map<string, WireDumpResultRecord>();

  for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec: WireDumpIndexRecord;
    try {
      rec = JSON.parse(line) as WireDumpIndexRecord;
    } catch {
      // 半行（进程被杀）无法解析：跳过，后续行仍可读
      continue;
    }
    if (rec.type === 'request') requests.push(rec);
    else if (rec.type === 'result') results.set(rec.id, rec);
  }

  requests.sort((a, b) => (a.at === b.at ? a.n - b.n : a.at - b.at));

  return requests.map((request) => ({
    request,
    result: results.get(request.id),
    hasBody: request.file != null && existsSync(join(dirPath, request.file)),
  }));
}

/**
 * 列出 dump 根目录下的 session 目录（按 index.jsonl 更新时间倒序）
 *
 * @param rootDir - dump 根目录
 * @returns session 目录列表
 */
export function listWireDumpSessions(rootDir: string): Array<{ dir: string; sessionId: string; mtimeMs: number }> {
  if (!existsSync(rootDir)) return [];
  const out: Array<{ dir: string; sessionId: string; mtimeMs: number }> = [];
  for (const name of readdirSync(rootDir)) {
    const dir = join(rootDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const indexPath = join(dir, 'index.jsonl');
    const mtimeMs = existsSync(indexPath) ? statSync(indexPath).mtimeMs : 0;
    if (mtimeMs === 0) continue;
    out.push({ dir, sessionId: name, mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 读取一次调用的完整请求体
 *
 * @param dirPath - session 目录
 * @param request - 索引中的 request 行
 * @returns 请求体；缺失/损坏时 null
 */
export function loadWireDumpBody(
  dirPath: string,
  request: WireDumpRequestRecord,
): Record<string, unknown> | null {
  if (!request.file) return null;
  try {
    return JSON.parse(readFileSync(join(dirPath, request.file), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 比对相邻两次调用的前缀
 *
 * @param prev - 上一次调用
 * @param next - 本次调用
 * @returns 前缀比对结果
 */
export function compareWireCalls(prev: WireCallSummary, next: WireCallSummary): WirePrefixDiff {
  const a = prev.request;
  const b = next.request;
  const limit = Math.min(a.hashes.length, b.hashes.length);

  let common = 0;
  while (
    common < limit &&
    a.hashes[common] === b.hashes[common] &&
    a.roles[common] === b.roles[common]
  ) {
    common += 1;
  }

  const appended = b.hashes.length - common;
  const removed = a.hashes.length - common;
  const diverged = common < limit;
  const stability: WirePrefixDiff['stability'] = diverged
    ? 'diverged'
    : appended === 0 && removed === 0
      ? 'identical'
      : removed === 0
        ? 'append-only'
        : 'truncated';

  let stableChars = 0;
  for (let i = 0; i < common; i++) stableChars += b.lens[i] ?? 0;

  const toolsChanged = a.toolsHash !== b.toolsHash;
  const modelChanged = a.model !== b.model;

  return {
    stability,
    commonPrefix: common,
    appended,
    removed,
    stableChars,
    // tools/model 在请求最前，一变就整段缓存失效——此时消息前缀再稳也命中不了
    cacheableChars: toolsChanged || modelChanged ? 0 : stableChars,
    divergence: diverged
      ? {
          index: common,
          prevRole: a.roles[common],
          nextRole: b.roles[common],
          prevLen: a.lens[common],
          nextLen: b.lens[common],
        }
      : undefined,
    toolsChanged,
    modelChanged,
    modeChanged: a.mode !== b.mode,
  };
}

/**
 * 定位单个前缀单元内部的字符级差异
 *
 * @param prevBody - 上次调用的请求体
 * @param nextBody - 本次调用的请求体
 * @param index - 分歧单元下标（来自 {@link compareWireCalls} 的 divergence.index）
 * @returns 字符偏移与上下文片段；单元缺失时 null
 */
export function explainWireDivergence(
  prevBody: Record<string, unknown>,
  nextBody: Record<string, unknown>,
  index: number,
): WireUnitDiffDetail | null {
  const prevPayloads = wireUnitPayloads(prevBody);
  const nextPayloads = wireUnitPayloads(nextBody);
  const prevText = prevPayloads[index]?.text;
  const nextText = nextPayloads[index]?.text;
  if (prevText == null || nextText == null) return null;

  const limit = Math.min(prevText.length, nextText.length);
  let offset = 0;
  while (offset < limit && prevText[offset] === nextText[offset]) offset += 1;

  return {
    index,
    offset,
    prevSnippet: snippetAround(prevText, offset),
    nextSnippet: snippetAround(nextText, offset),
  };
}

/**
 * 取偏移附近的片段：前 80 字符 + 断点标记 + 后 80 字符
 *
 * `<|>` 是断点标记（对应返回的 `offset`），不是原文内容——原文在断点处是连续的。
 *
 * @param text - 单元 JSON 文本
 * @param offset - 首个不同字符的偏移
 * @returns 带断点标记的片段
 */
function snippetAround(text: string, offset: number): string {
  const start = Math.max(0, offset - 80);
  const end = Math.min(text.length, offset + 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, offset)}<|>${text.slice(offset, end)}${end < text.length ? '…' : ''}`;
}
