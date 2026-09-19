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
 * @param text - 原始查询
 * @returns 去重后的检索词（小写）
 */
export function tokenizeKeywordQuery(text: string): string[] {
  const raw = (text ?? '').trim().toLowerCase();
  if (!raw) return [];

  const tokens = new Set<string>();
  const parts = raw.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);

  for (const part of parts) {
    if (part.length >= 1) tokens.add(part);
    if (!isCjk(part[0] ?? '')) continue;

    // CJK 连续段：按段再切，生成二元组（保留整段词）
    let run = '';
    const flush = () => {
      if (!run) return;
      if (run.length >= 2) tokens.add(run);
      for (let i = 0; i + 1 < run.length; i++) {
        tokens.add(run.slice(i, i + 2));
      }
      run = '';
    };
    for (const ch of part) {
      if (isCjk(ch)) run += ch;
      else flush();
    }
    flush();
  }

  return [...tokens].filter((t) => t.length > 0);
}

function asText(v: string[] | string | null | undefined): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(' ');
  return String(v);
}

/**
 * 单条记忆的关键词命中得分。
 *
 * @returns 0 表示无命中；字段权重相加
 */
export function scoreKeywordFields(fields: KeywordFields, tokens: string[]): number {
  if (tokens.length === 0) return 0;

  const content = (fields.content ?? '').toLowerCase();
  const futureUse = (fields.futureUse ?? '').toLowerCase();
  const tags = asText(fields.tags).toLowerCase();
  const anchors = asText(fields.anchors).toLowerCase();
  const evidence = (fields.evidence ?? '').toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (content.includes(token)) score += 3;
    if (futureUse.includes(token)) score += 2;
    if (tags.includes(token)) score += 2;
    if (anchors.includes(token)) score += 1;
    if (evidence.includes(token)) score += 1;
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
