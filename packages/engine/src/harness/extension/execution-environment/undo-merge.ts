/**
 * Turn 文件 undo 合并 — 补丁逆放（文本）/ 整文件策略（二进制）
 *
 * 逆放语义：把 agent 的 before→after 差分 **逆向** 打到 current 上，
 * 只动仍与 after 对齐的行；用户改过/插入的行原样保留。
 * 不做对称 diff3（会把「用户插行」误判成与「agent 改行」冲突）。
 */

const isWin = process.platform === 'win32';

/** 是否可按文本处理 */
export function isProbablyText(buf: Uint8Array): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  return s.split('\n');
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

function linesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if (n * m > 4_000_000) return [];
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

interface Edit {
  /** after 中被替换的行 */
  afterLines: string[];
  /** 对应的 before 行 */
  beforeLines: string[];
}

/** after → before 的编辑块 */
function computeEdits(after: string[], before: string[]): Edit[] {
  if (linesEqual(after, before)) return [];
  const pairs = lcsPairs(after, before);
  const edits: Edit[] = [];
  let ai = 0;
  let bi = 0;
  const flush = (aEnd: number, bEnd: number) => {
    if (aEnd > ai || bEnd > bi) {
      edits.push({
        afterLines: after.slice(ai, aEnd),
        beforeLines: before.slice(bi, bEnd),
      });
    }
  };
  for (const [a, b] of pairs) {
    flush(a, b);
    ai = a + 1;
    bi = b + 1;
  }
  flush(after.length, before.length);
  return edits;
}

function indexOfSlice(hay: string[], needle: string[], from: number): number {
  if (needle.length === 0) return from;
  for (let i = from; i + needle.length <= hay.length; i++) {
    if (needle.every((line, k) => line === hay[i + k])) return i;
  }
  return -1;
}

export type ReverseOverwriteResult =
  | { kind: 'restored'; content: string; skippedHunks: number }
  | { kind: 'kept_current'; reason: 'hunk_not_found' }
  | { kind: 'conflict'; reason: 'too_large' };

/**
 * 逆放 agent overwrite（补丁逆放）。
 *
 * @param before - 写前文本
 * @param after - 写后文本
 * @param current - 磁盘现状文本
 * @returns 逆放结果
 */
export function reverseAgentOverwrite(
  before: string,
  after: string,
  current: string,
): ReverseOverwriteResult {
  if (current === after || current === before) {
    return { kind: 'restored', content: before, skippedHunks: 0 };
  }
  const afterL = splitLines(after);
  const beforeL = splitLines(before);
  const currentL = splitLines(current);
  const edits = computeEdits(afterL, beforeL);
  if (edits.length === 0) {
    return { kind: 'restored', content: before, skippedHunks: 0 };
  }

  // 先在 current 中定位全部 hunk（不重叠），再按位置升序逆放；
  // 游标只前进，避免乱序匹配导致内容重复。
  type Located = { idx: number; afterLines: string[]; beforeLines: string[] };
  const located: Located[] = [];
  const occupied: Array<{ start: number; end: number }> = [];
  const overlaps = (start: number, end: number) =>
    occupied.some((o) => start < o.end && end > o.start);

  for (const edit of edits) {
    if (edit.afterLines.length === 0 && edit.beforeLines.length === 0) continue;
    let idx = indexOfSlice(currentL, edit.afterLines, 0);
    while (idx >= 0) {
      const end = idx + edit.afterLines.length;
      if (!overlaps(idx, end)) {
        located.push({ idx, afterLines: edit.afterLines, beforeLines: edit.beforeLines });
        occupied.push({ start: idx, end });
        break;
      }
      idx = indexOfSlice(currentL, edit.afterLines, idx + 1);
    }
  }

  located.sort((a, b) => a.idx - b.idx);

  const result: string[] = [];
  let cursor = 0;
  let skippedHunks = 0;
  const matched = located.length;
  for (const h of located) {
    if (h.idx < cursor) {
      skippedHunks += 1;
      continue;
    }
    result.push(...currentL.slice(cursor, h.idx));
    result.push(...h.beforeLines);
    cursor = h.idx + h.afterLines.length;
  }
  result.push(...currentL.slice(cursor));
  // 未能定位的 edit 记 skipped（用户改掉了 after 痕迹）
  skippedHunks += edits.filter((e) => e.afterLines.length > 0 || e.beforeLines.length > 0).length - matched;

  return { kind: 'restored', content: joinLines(result), skippedHunks: Math.max(0, skippedHunks) };
}

/** 路径比较键（Windows 忽略大小写） */
export function pathKey(p: string): string {
  const norm = p.replace(/\\/g, '/');
  return isWin ? norm.toLowerCase() : norm;
}

/**
 * 保留兼容入口：补丁逆放（行级）。
 *
 * @param after - agent 写后
 * @param current - 现状
 * @param before - agent 写前
 * @returns 合并行；失败 null
 */
export function merge3Lines(after: string[], current: string[], before: string[]): string[] | null {
  const r = reverseAgentOverwrite(joinLines(before), joinLines(after), joinLines(current));
  return r.kind === 'restored' ? splitLines(r.content) : null;
}
