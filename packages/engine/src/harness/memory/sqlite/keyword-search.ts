/**
 * 关键词检索 — 无 embedding 时的召回路径
 *
 * 中英混合：空格/标点切词 + CJK 二元组，扩大「技术栈 vs 技术选型」类弱重叠召回。
 * 字段权重：content > future_use/tags > evidence/anchors。
 */

/** 检索覆盖的记忆字段 */
export interface KeywordFields {
  content: string;
  tags?: string[] | string | null;
  futureUse?: string | null;
  anchors?: string[] | string | null;
  evidence?: string | null;
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

/**
 * 查询分词：空白/标点切分；连续 CJK 片段额外产出二元组。
 *
 * 丢弃长度 &lt; 2 的 token：单字母/单字 `includes` 会命中任意子串（`is`⊂`this`）。
 * 派生二元组（长 CJK 滑窗）记入 weak：单独命中不足以过相关性地板。
 *
 * @param text - 原始查询
 * @returns 去重后的检索词（小写）；与 {@link tokenizeKeywordDetail}.all 一致
 */
export function tokenizeKeywordQuery(text: string): string[] {
  return tokenizeKeywordDetail(text).all;
}

/** 分词明细：strong=整词/整段；weak=长 CJK 滑窗二元组 */
export interface KeywordTokens {
  all: string[];
  strong: string[];
  weak: string[];
}

/**
 * 分词并区分强弱 token。
 *
 * @param text - 原始查询
 */
export function tokenizeKeywordDetail(text: string): KeywordTokens {
  const raw = (text ?? '').trim().toLowerCase();
  if (!raw) return { all: [], strong: [], weak: [] };

  const strong = new Set<string>();
  const weak = new Set<string>();
  const parts = raw.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);

  for (const part of parts) {
    if (part.length >= 2) strong.add(part);
    if (!isCjk(part[0] ?? '')) continue;

    let run = '';
    const flush = () => {
      if (!run) return;
      if (run.length >= 2) strong.add(run);
      // 仅长段的滑窗二元组算 weak（整段本身已进 strong）
      if (run.length > 2) {
        for (let i = 0; i + 1 < run.length; i++) {
          const bi = run.slice(i, i + 2);
          if (!strong.has(bi)) weak.add(bi);
        }
      }
      run = '';
    };
    for (const ch of part) {
      if (isCjk(ch)) run += ch;
      else flush();
    }
    flush();
  }

  const all = [...new Set([...strong, ...weak])].filter((t) => t.length >= 2);
  return { all, strong: [...strong].filter((t) => t.length >= 2), weak: [...weak] };
}

function asText(v: string[] | string | null | undefined): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(' ');
  return String(v);
}

/**
 * 单条记忆的关键词命中得分。
 *
 * 字段权重：content > future_use/tags > evidence/anchors。
 * weak token（CJK 滑窗二元组）命中权重减半，避免「什么/好处」类弱重叠单独过关。
 *
 * @returns 0 表示无命中；字段权重相加
 */
export function scoreKeywordFields(
  fields: KeywordFields,
  tokens: string[] | KeywordTokens,
): number {
  const list = Array.isArray(tokens) ? tokens : tokens.all;
  if (list.length === 0) return 0;
  const weakSet = new Set(Array.isArray(tokens) ? [] : tokens.weak);

  const content = (fields.content ?? '').toLowerCase();
  const futureUse = (fields.futureUse ?? '').toLowerCase();
  const tags = asText(fields.tags).toLowerCase();
  const anchors = asText(fields.anchors).toLowerCase();
  const evidence = (fields.evidence ?? '').toLowerCase();

  let score = 0;
  for (const token of list) {
    if (!token) continue;
    const w = weakSet.has(token) ? 0.5 : 1;
    if (content.includes(token)) score += 3 * w;
    if (futureUse.includes(token)) score += 2 * w;
    if (tags.includes(token)) score += 2 * w;
    if (anchors.includes(token)) score += 1 * w;
    if (evidence.includes(token)) score += 1 * w;
  }
  return score;
}

/**
 * 构造 SQLite 多字段 LIKE 条件（OR 各 token × 各字段）。
 *
 * @param tokens - 检索词
 * @returns sql 片段与参数；tokens 为空时 sql 为空
 */
export function buildKeywordLikeSql(tokens: string[]): { sql: string; params: string[] } {
  if (tokens.length === 0) return { sql: '', params: [] };

  const columns = [
    'LOWER(content)',
    "LOWER(COALESCE(future_use, ''))",
    'LOWER(tags)',
    "LOWER(COALESCE(evidence, ''))",
    "LOWER(COALESCE(anchors, ''))",
  ];

  const clauses: string[] = [];
  const params: string[] = [];
  for (const token of tokens) {
    const like = `%${token.toLowerCase()}%`;
    for (const col of columns) {
      clauses.push(`${col} LIKE ?`);
      params.push(like);
    }
  }

  return { sql: ` AND (${clauses.join(' OR ')})`, params };
}
