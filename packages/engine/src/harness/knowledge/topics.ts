/**
 * Catalog topics — 从索引路径派生主题线索（无 LLM）
 *
 * 供 Tier 0 catalog 的 `topics` 字段；不依赖人工 description / auto-describe。
 */

const STOP_TOKENS = new Set([
  'src', 'lib', 'dist', 'build', 'out', 'bin', 'pkg', 'packages', 'node_modules',
  'test', 'tests', 'spec', 'specs', 'assets', 'public', 'static', 'vendor',
  'the', 'and', 'for', 'with', 'from', 'and', 'app', 'utils', 'common', 'helpers',
]);

/** 从单条路径抽出候选词（目录名 + 文件名词干） */
function tokensFromPath(path: string): string[] {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const stem = part.replace(/\.[^.]+$/, '');
    for (const t of stem.split(/[-_\s.]+/)) {
      if (!t) continue;
      const lower = t.toLowerCase();
      if (lower.length < 2 || STOP_TOKENS.has(lower) || /^\d+$/.test(lower)) continue;
      out.push(lower);
    }
  }
  return out;
}

/**
 * 路径词频 → 话题短词（≤ maxTopics）
 *
 * @param paths 已入库相对/绝对路径
 * @param maxTopics 上限（默认 6）
 * @returns 稳定排序的短词列表
 */
export function deriveTopicsFromPaths(paths: string[], maxTopics = 6): string[] {
  if (paths.length === 0) return [];
  const counts = new Map<string, number>();
  for (const p of paths) {
    for (const t of tokensFromPath(p)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTopics)
    .map(([t]) => t);
}
