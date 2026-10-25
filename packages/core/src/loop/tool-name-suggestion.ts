/**
 * 未知工具名的近似建议（Layer 0 纯字符串逻辑，零外部依赖）
 *
 * 动机：模型会调用不存在的简写名（实测 `edit` 真实出现 33 次并被写进
 * transcript，随后逐轮模仿自己的错误名）。回执只说 `not found` 时模型只能
 * 靠猜或退回 shell，因此错误必须给出可直接采用的正确名。
 *
 * 判定分三档，保守优先（宁缺勿错）：
 * 1. 段级后缀命中：`edit` → `file_edit`（100 档）
 * 2. 段级前缀命中：`ask` → `ask_user`（90 档）
 * 3. 整体编辑距离 ≤ 40%（拼写错：`file_edti` → `file_edit`，60 档）
 */

const MAX_EDIT_DISTANCE_RATIO = 0.4;
const DEFAULT_SUGGESTION_LIMIT = 2;
/** 归一化全等（仅分隔符/大小写差异）——确定唯一目标 */
const EXACT_TIER = 200;
/** 段序颠倒（`edit_file` → `file_edit`）——同样确定唯一目标 */
const REVERSED_TIER = 150;

/**
 * 按非字母数字切成段（`file_edit` → ['file','edit']）
 *
 * @param name - 工具名
 * @returns 小写段列表
 */
function segments(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * 折叠重复首段：`file_file_edit` → `file_edit`
 *
 * 实测样本：模型偶发把命名空间前缀复制一遍，仍属同一工具的错名。
 *
 * @param parts - 段列表
 * @returns 折叠后的段列表
 */
function collapseRepeatedHead(parts: string[]): string[] {
  let out = parts;
  while (out.length >= 2 && out[0] === out[1]) {
    out = out.slice(1);
  }
  return out;
}

/**
 * @param name - 候选段列表
 * @param suffix - 需整体匹配的尾段
 * @returns 尾段是否严格匹配（并要求至少多出一段，避免同长误判）
 */
function endsWithSegments(name: string[], suffix: string[]): boolean {
  if (suffix.length >= name.length) return false;
  return suffix.every((s, i) => name[name.length - suffix.length + i] === s);
}

/**
 * @param name - 候选段列表
 * @param prefix - 需整体匹配的首段
 * @returns 首段是否严格匹配（并要求至少多出一段）
 */
function startsWithSegments(name: string[], prefix: string[]): boolean {
  if (prefix.length >= name.length) return false;
  return prefix.every((s, i) => name[i] === s);
}

/**
 * 标准 Levenshtein 距离（滚动数组，O(min(n,m)) 空间）
 *
 * @param a - 字符串 a
 * @param b - 字符串 b
 * @returns 编辑距离
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 为未知工具名给出候选正确名。
 *
 * 返回多条而不是强行挑一条：`edit` 同时是 `file_edit` / `package_edit` 的
 * 尾段，猜一个反而可能把模型引到错工具上。
 *
 * @param unknown - 模型调用的工具名
 * @param candidates - 当前可见工具名全集
 * @param limit - 最多返回几条（默认 2）
 * @returns 按可信度排序的候选名；无可靠候选时为空数组
 */
export function suggestToolNames(
  unknown: string,
  candidates: readonly string[],
  limit: number = DEFAULT_SUGGESTION_LIMIT,
): string[] {
  const query = collapseRepeatedHead(segments(unknown));
  if (query.length === 0) return [];
  const reversedQuery = [...query].reverse();

  const scored: Array<{ name: string; score: number }> = [];
  for (const candidate of candidates) {
    if (candidate === unknown) continue;
    const parts = segments(candidate);
    if (parts.length === 0) continue;

    let score: number;
    if (parts.join('') === query.join('')) {
      // 仅分隔符/大小写差异（`File_Edit`、`fileedit`）：直接就是它，不再列别的
      score = EXACT_TIER;
    } else if (parts.join('') === reversedQuery.join('')) {
      // 段序颠倒（`edit_file` → `file_edit`）：主流 coding agent 的惯用命名
      score = REVERSED_TIER;
    } else if (endsWithSegments(parts, query)) {
      score = 100 - (parts.length - query.length);
    } else if (startsWithSegments(parts, query)) {
      score = 90 - (parts.length - query.length);
    } else {
      const distance = editDistance(query.join(''), parts.join(''));
      const longest = Math.max(query.join('').length, parts.join('').length);
      score = longest > 0 && distance / longest <= MAX_EDIT_DISTANCE_RATIO ? 60 - distance : 0;
    }
    if (score > 0) scored.push({ name: candidate, score });
  }

  // 同分时短名优先（`file_edit` 先于 `package_edit`）；同名次保留全部候选
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  // 归一化全等 / 段序颠倒已确定唯一目标，其余近似候选只会稀释纠错信号
  if (scored.length > 0 && scored[0].score >= REVERSED_TIER) {
    return [scored[0].name];
  }
  return scored.slice(0, limit).map((s) => s.name);
}

/**
 * 组装未知工具错误的正文（Core 与 Harness 共用同一措辞，避免两处漂移）
 *
 * 无候选时保持历史文案 `Tool "x" not found`，不额外编造建议。
 *
 * @param unknown - 模型调用的工具名
 * @param suggestions - `suggestToolNames` 的结果
 * @returns 回灌给模型的错误正文（调用方自行加 `Error: ` 前缀）
 */
export function formatUnknownToolError(unknown: string, suggestions: readonly string[]): string {
  const base = `Tool "${unknown}" not found`;
  if (suggestions.length === 0) return base;
  if (suggestions.length === 1) return `${base}. Did you mean "${suggestions[0]}"?`;
  const quoted = suggestions.map((s) => `"${s}"`).join(', ');
  return `${base}. Did you mean one of: ${quoted}?`;
}
