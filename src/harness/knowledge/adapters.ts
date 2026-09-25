/**
 * FormatAdapter 注册制 — 逐文件按扩展名/MIME 分发（源上不写 adapter）
 *
 * 无 adapter 的类型跳过并记 skipped，不挡整库。
 */

export interface KnowledgeChunkDraft {
  ordinal: number;
  text: string;
  startLine: number;
  endLine: number;
  /** 符号名（代码启发式；Markdown 为标题；可选） */
  symbol?: string;
}

export interface FormatAdapter {
  id: string;
  /** 可处理的扩展名（小写，含点） */
  extensions: string[];
  /**
   * 将文件内容切为 chunks
   *
   * @param content - UTF-8 文本
   * @param path - 相对/绝对路径（用于启发式）
   */
  chunk(content: string, path: string): KnowledgeChunkDraft[];
}

/** 默认噪音目录（对齐 file-search） */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '__pycache__',
  '.cache',
  '.DS_Store',
]);

/** 二进制/不可解析扩展（无 adapter 时 skip） */
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.mp3', '.wav', '.flac', '.ogg', '.mp4', '.mov', '.avi', '.mkv',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.pdf', '.doc', '.docx',
  '.xls', '.xlsx', '.ppt', '.pptx', '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot',
  // 敏感/密钥形态：不进索引
  '.env', '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
]);

const MAX_CHUNK_CHARS = 2400;
/** 过小 chunk 合并阈值（结构单位太碎时粘合） */
const MIN_CHUNK_CHARS = 200;
const CODE_WINDOW_LINES = 80;
const CODE_OVERLAP_LINES = 8;

function pushParagraphs(
  content: string,
  startLineBase: number,
  maxChars: number,
): KnowledgeChunkDraft[] {
  const chunks: KnowledgeChunkDraft[] = [];
  const lines = content.split('\n');
  let buf: string[] = [];
  let bufStart = startLineBase;
  let ordinal = 0;

  const flush = (endLine: number) => {
    const text = buf.join('\n').trim();
    if (text) {
      chunks.push({
        ordinal: ordinal++,
        text: text.slice(0, maxChars),
        startLine: bufStart,
        endLine,
      });
    }
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const absLine = startLineBase + i;
    if (buf.length === 0) bufStart = absLine;
    buf.push(line);
    const joined = buf.join('\n');
    if (line.trim() === '' && joined.trim().length >= MIN_CHUNK_CHARS) {
      flush(absLine);
    } else if (joined.length >= maxChars) {
      flush(absLine);
    }
  }
  if (buf.length) flush(startLineBase + lines.length - 1);
  return chunks;
}

/** 纯文本 / 配置：空行分段 */
export const textAdapter: FormatAdapter = {
  id: 'text',
  // 不含 .env / 密钥类扩展（避免敏感串进索引；见审查 .env）
  extensions: ['.txt', '.json', '.yml', '.yaml', '.toml', '.ini', '.csv', '.log', '.xml'],
  chunk(content) {
    return pushParagraphs(content, 1, MAX_CHUNK_CHARS);
  },
};

/** Markdown：按标题切，段内可再断 */
export const markdownAdapter: FormatAdapter = {
  id: 'markdown',
  extensions: ['.md', '.markdown', '.mdx'],
  chunk(content) {
    const lines = content.split('\n');
    const chunks: KnowledgeChunkDraft[] = [];
    let ordinal = 0;
    let sectionStart = 1;
    let buf: string[] = [];

    const flush = (endLine: number) => {
      const text = buf.join('\n').trim();
      if (text) {
        if (text.length <= MAX_CHUNK_CHARS) {
          chunks.push({
            ordinal: ordinal++,
            text,
            startLine: sectionStart,
            endLine,
            symbol: buf.find((l) => /^#{1,6}\s/.test(l))?.replace(/^#+\s*/, '') || undefined,
          });
        } else {
          for (const part of pushParagraphs(text, sectionStart, MAX_CHUNK_CHARS)) {
            chunks.push({ ...part, ordinal: ordinal++ });
          }
        }
      }
      buf = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const abs = i + 1;
      const isHeading = /^#{1,6}\s/.test(line);
      if (isHeading && buf.length) {
        flush(abs - 1);
        sectionStart = abs;
      }
      if (buf.length === 0) sectionStart = abs;
      buf.push(line);
    }
    if (buf.length) flush(lines.length);
    return chunks;
  },
};

/**
 * 体积平衡：结构优先，体积封顶。
 * - 一切：> maxChars 的结构单元内部再切
 * - 代码/段落：< minChars 的相邻单元可合并到 maxChars
 */
function splitOversized(
  unit: { lines: string[]; startLine: number; symbol?: string },
  maxChars: number,
): Array<{ lines: string[]; startLine: number; endLine: number; symbol?: string }> {
  const total = unit.lines.join('\n');
  if (total.length <= maxChars) {
    return [
      {
        lines: unit.lines,
        startLine: unit.startLine,
        endLine: unit.startLine + unit.lines.length - 1,
        symbol: unit.symbol,
      },
    ];
  }
  const out: Array<{ lines: string[]; startLine: number; endLine: number; symbol?: string }> = [];
  let buf: string[] = [];
  let bufStart = unit.startLine;
  for (let i = 0; i < unit.lines.length; i++) {
    const line = unit.lines[i];
    if (buf.length === 0) bufStart = unit.startLine + i;
    buf.push(line);
    if (buf.join('\n').length >= maxChars) {
      out.push({
        lines: buf,
        startLine: bufStart,
        endLine: unit.startLine + i,
        symbol: unit.symbol,
      });
      buf = [];
    }
  }
  if (buf.length) {
    out.push({
      lines: buf,
      startLine: bufStart,
      endLine: unit.startLine + unit.lines.length - 1,
      symbol: unit.symbol,
    });
  }
  return out;
}

function mergeSmallUnits(
  units: Array<{ lines: string[]; startLine: number; endLine: number; symbol?: string }>,
  minChars: number,
  maxChars: number,
): Array<{ lines: string[]; startLine: number; endLine: number; symbol?: string }> {
  const out: Array<{ lines: string[]; startLine: number; endLine: number; symbol?: string }> = [];
  let acc: { lines: string[]; startLine: number; endLine: number; symbol?: string } | null = null;

  const flush = () => {
    if (acc) {
      out.push(acc);
      acc = null;
    }
  };

  for (const u of units) {
    const size = u.lines.join('\n').length;
    if (!acc) {
      acc = { ...u };
      continue;
    }
    const accSize = acc.lines.join('\n').length;
    // 只粘合「无符号」碎块；有符号单元保持独立，避免跨函数/类边界
    const canMerge =
      !acc.symbol &&
      !u.symbol &&
      accSize < minChars &&
      accSize + size + 1 <= maxChars;
    if (canMerge) {
      acc.lines = [...acc.lines, ...u.lines];
      acc.endLine = u.endLine;
      continue;
    }
    flush();
    acc = { ...u };
  }
  flush();
  return out;
}

function unitsToChunks(
  units: Array<{ lines: string[]; startLine: number; endLine: number; symbol?: string }>,
  maxChars: number,
): KnowledgeChunkDraft[] {
  return units.map((u, i) => {
    const text = u.lines.join('\n').trim();
    return {
      ordinal: i,
      text: text.slice(0, maxChars),
      startLine: u.startLine,
      endLine: u.endLine,
      symbol: u.symbol,
    };
  }).filter((c) => c.text.length > 0);
}

/** 符号起始启发式（行首/缩进；非精确 AST，见 OP-13） */
const SYMBOL_PATTERNS: Array<{ re: RegExp; nameGroup: number }> = [
  // TS/JS
  { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, nameGroup: 1 },
  { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
  { re: /^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, nameGroup: 1 },
  // Python
  { re: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
  { re: /^class\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
  // Go / Rust / Java-ish
  { re: /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)/, nameGroup: 1 },
  { re: /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
  { re: /^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
  { re: /^(?:public\s+|private\s+|protected\s+)*(?:static\s+)?(?:class|interface|enum)\s+([A-Za-z_][\w]*)/, nameGroup: 1 },
  { re: /^(?:public\s+|private\s+|protected\s+)(?:static\s+)?(?:final\s+)?[\w<>,\[\]\s]+\s+([A-Za-z_][\w]*)\s*\(/, nameGroup: 1 },
];

function detectSymbolStart(line: string): string | null {
  const trimmed = line.replace(/^\s+/, '');
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')) {
    return null;
  }
  for (const { re, nameGroup } of SYMBOL_PATTERNS) {
    const m = trimmed.match(re);
    if (m?.[nameGroup]) return m[nameGroup];
  }
  return null;
}

/**
 * 代码启发式分块：函数/类/接口等符号边界 + 体积封顶
 *
 * 非 AST；精确符号边界见 OP-13。
 */
export function chunkCodeBySymbols(
  content: string,
  opts?: { maxChars?: number; minChars?: number },
): KnowledgeChunkDraft[] {
  const maxChars = opts?.maxChars ?? MAX_CHUNK_CHARS;
  const minChars = opts?.minChars ?? MIN_CHUNK_CHARS;
  const lines = content.split('\n');
  if (lines.length === 0) return [];

  type Unit = {
    lines: string[];
    startLine: number;
    symbol?: string;
    kind: 'preamble' | 'symbol' | 'orphan';
  };

  const units: Unit[] = [];
  let cur: Unit = { lines: [], startLine: 1, kind: 'preamble' };

  const pushCur = () => {
    if (cur.lines.some((l) => l.trim().length > 0)) {
      units.push({ ...cur, lines: [...cur.lines] });
    }
    cur = { lines: [], startLine: 1, kind: 'preamble' };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const abs = i + 1;
    const symbol = detectSymbolStart(line);
    if (symbol) {
      // 保留符号前紧邻的少量注释/装饰（上一行注释）
      const carry: string[] = [];
      if (cur.kind === 'preamble' || cur.kind === 'symbol') {
        while (cur.lines.length) {
          const last = cur.lines[cur.lines.length - 1] ?? '';
          if (/^\s*(\/\/|\/\*|\*|#|""")/.test(last) || last.trim() === '') {
            carry.unshift(cur.lines.pop()!);
          } else {
            break;
          }
        }
        pushCur();
      } else {
        pushCur();
      }
      cur = {
        lines: [...carry, line],
        startLine: abs - carry.length,
        symbol,
        kind: 'symbol',
      };
      continue;
    }
    if (cur.lines.length === 0) cur.startLine = abs;
    cur.lines.push(line);

    // 单符号过大时预切，避免 units 过肥
    if (cur.kind === 'symbol' && cur.lines.join('\n').length >= maxChars * 1.5) {
      const parts = splitOversized(
        { lines: cur.lines, startLine: cur.startLine, symbol: cur.symbol },
        maxChars,
      );
      for (const p of parts) {
        units.push({ lines: p.lines, startLine: p.startLine, symbol: p.symbol, kind: 'symbol' });
      }
      cur = { lines: [], startLine: abs + 1, kind: 'orphan' };
    }
  }
  pushCur();

  // 超大单元再切；碎单元合并
  const split: Array<{ lines: string[]; startLine: number; endLine: number; symbol?: string }> = [];
  for (const u of units) {
    for (const p of splitOversized(u, maxChars)) {
      split.push(p);
    }
  }
  const merged = mergeSmallUnits(split, minChars, maxChars);
  return unitsToChunks(merged, maxChars);
}

/** 代码：符号启发式（函数/类/接口）；失败/无符号则行窗 */
export const codeAdapter: FormatAdapter = {
  id: 'code-tree',
  extensions: [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp',
    '.rb', '.php', '.cs', '.swift', '.scala', '.sh', '.bash', '.ps1',
    '.sql', '.html', '.css', '.scss', '.vue', '.svelte',
  ],
  chunk(content) {
    const bySymbol = chunkCodeBySymbols(content);
    if (bySymbol.length > 0) return bySymbol;

    // 无符号命中（配置、纯脚本）：行窗兜底
    const lines = content.split('\n');
    const chunks: KnowledgeChunkDraft[] = [];
    let ordinal = 0;
    let start = 0;
    while (start < lines.length) {
      const end = Math.min(start + CODE_WINDOW_LINES, lines.length);
      const text = lines.slice(start, end).join('\n').trim();
      if (text) {
        chunks.push({
          ordinal: ordinal++,
          text: text.slice(0, MAX_CHUNK_CHARS),
          startLine: start + 1,
          endLine: end,
        });
      }
      if (end >= lines.length) break;
      start = end - CODE_OVERLAP_LINES;
    }
    return chunks;
  },
};

export class FormatAdapterRegistry {
  private byExt = new Map<string, FormatAdapter>();

  constructor(adapters: FormatAdapter[] = [textAdapter, markdownAdapter, codeAdapter]) {
    for (const a of adapters) this.register(a);
  }

  register(adapter: FormatAdapter): void {
    for (const ext of adapter.extensions) {
      this.byExt.set(ext.toLowerCase(), adapter);
    }
  }

  /**
   * 按扩展名匹配 adapter
   */
  match(path: string): FormatAdapter | null {
    const lower = path.toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot < 0) return null;
    const ext = lower.slice(dot);
    if (BINARY_EXTENSIONS.has(ext)) return null;
    return this.byExt.get(ext) ?? null;
  }

  /**
   * 判断路径是否应跳过（目录名噪音 / 二进制）
   */
  shouldSkipPath(path: string): boolean {
    const parts = path.split(/[\\/]/);
    for (const p of parts) {
      if (IGNORED_DIRS.has(p)) return true;
      if (p === 'knowledge.db' || p.endsWith('.db')) return true;
    }
    const lower = path.toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot >= 0 && BINARY_EXTENSIONS.has(lower.slice(dot))) return true;
    return false;
  }
}
