/**
 * file_search 工具 — 跨文件内容搜索
 *
 * 在文件系统中搜索文本或正则模式，返回文件路径 + 行号 + 上下文行。
 * 等效于 grep/rg，但输出结构化，便于 LLM 解析。
 *
 * 特性：
 * - pattern_mode: auto（默认）/ literal / regex；`patterns[]` 多词任一命中
 * - auto 仅认强信号（锚点/转义类/`.*`/`{n}`/词式 `a|b`），代码字面量保持 literal
 * - 路径感知 glob（支持 `**` / `*` / `?` / `{a,b}`，匹配 root 相对路径；`\` 转义）
 * - 逐行流式扫描；`max_file_bytes` 安全阀（默认 50MB）跳过异常巨文件
 * - 上下文行（before/after）
 * - 结果数量限制
 * - 忽略常见无关目录（node_modules, .git 等）
 * - 零结果时返回 diagnostics + hints，便于调用方自纠
 */

import type { RegisteredTool } from '../../../core/types.js';
import { resolveToolPath } from './platform.js';

/** 单条匹配结果 */
interface SearchMatch {
  file: string;
  line: number;
  content: string;
  before?: string[];
  after?: string[];
}

/** 搜索诊断（零结果自纠用） */
interface SearchDiagnostics {
  patternMode: 'literal' | 'regex' | 'mixed';
  patterns: string[];
  compiledPatterns: string[];
  glob?: string;
  compiledGlob?: string;
  filesSeen: number;
  filesMatchedByGlob: number;
  filesSearched: number;
  filesSkipped: number;
  filesSkippedOversize: number;
  maxFileBytes: number;
}

/** 搜索结果 */
interface SearchResult {
  matches: SearchMatch[];
  /** 返回的匹配条数；truncated=true 时可能还有更多未返回 */
  totalMatches: number;
  truncated: boolean;
  searchedFiles: number;
  diagnostics: SearchDiagnostics;
  hints: string[];
}

/** pattern 解析模式 */
type PatternMode = 'auto' | 'literal' | 'regex';

/** 编译后的内容匹配器 */
interface ContentMatchers {
  mode: 'literal' | 'regex' | 'mixed';
  matchers: RegExp[];
  sources: string[];
  compiled: string[];
  kinds: Array<'literal' | 'regex'>;
  autoForcedLiteral: boolean;
}

/** 需要忽略的目录 */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
  '.next', '.nuxt', '__pycache__', '.cache', '.DS_Store',
]);

/** 单文件读取安全阀默认值（50MB；可经 max_file_bytes 调整） */
const DEFAULT_MAX_FILE_BYTES = 50_000_000;

/**
 * 创建 file_search 工具
 *
 * @returns RegisteredTool
 */
export function createFileSearchTool(): RegisteredTool {
  return {
    definition: {
      name: 'file_search',
      description:
        'Search file contents (like grep/rg) with structured results. ' +
        'Provide `pattern` (one term) or `patterns` (any-of literals). ' +
        'Default pattern_mode=auto compiles as regex only on strong signals: ' +
        'anchors (^…$), escapes (\\d \\w \\s), `.*`/`.+`, `{n}` quantifiers, or word alternation (`foo|bar`). ' +
        'Code tokens stay literal: `arr[0]`, `useState()`, `a+b`, `C++`, `foo.bar`, `memory*`. ' +
        'Set pattern_mode="regex" or "literal" to force. ' +
        "Glob filters by root-relative path (always case-insensitive): '*.md' (any depth), 'src/**/*.ts', '**/memory*.md'. " +
        "`**` crosses directories, `*` does not. " +
        'Empty results include diagnostics.hints for how to retry. ' +
        'Default case-insensitive content match; set case_sensitive=true for exact case. ' +
        'Files are read as line streams; max_file_bytes (default 50MB) skips oversized files.',
      parameters: {
        pattern: {
          type: 'string',
          description:
            'Single search term. Auto: regex only for ^ $ \\d .* {n} or word `a|b`; everything else is literal text.',
        },
        patterns: {
          type: 'array',
          description: 'Multiple terms; a line matches if ANY term matches. Prefer this over `a|b` for OR-of-literals.',
          items: { type: 'string', description: 'search term' },
          minItems: 1,
        },
        path: {
          type: 'string',
          description: 'Root directory to search from (default: current directory)',
        },
        glob: {
          type: 'string',
          description:
            "Path glob relative to root (case-insensitive), e.g. '*.md', 'src/**/*.ts', '**/memory*.md'. " +
            'Matches relative path; bare `*` does not cross directories.',
        },
        pattern_mode: {
          type: 'string',
          description: 'How to compile pattern/patterns (default: auto)',
          enum: ['auto', 'literal', 'regex'],
        },
        regex: {
          type: 'boolean',
          description: 'Deprecated alias: true → pattern_mode=regex, false → literal. Prefer pattern_mode.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Case sensitive search (default: false)',
        },
        context_lines: {
          type: 'number',
          description: 'Number of context lines before/after each match (default: 0, max: 5)',
          minimum: 0,
          maximum: 5,
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of matches to return (default: 50, max: 200)',
          minimum: 1,
          maximum: 200,
        },
        max_file_bytes: {
          type: 'number',
          description:
            'Skip files larger than this many bytes (default: 50000000 ≈ 50MB). ' +
            'Files are scanned as a line stream; raise this for huge text corpora.',
          minimum: 1,
        },
      },
      timeoutMs: 30_000,
    },
    handler: async (args, context) => {
      const { readdir, stat } = await import('node:fs/promises');
      const { join, relative, extname } = await import('node:path');

      const rawRoot = args.path as string | undefined;
      const rootPath = rawRoot
        ? resolveToolPath(rawRoot, context.cwd ?? process.cwd())
        : (context.cwd ?? process.cwd());

      const terms = collectPatternTerms(args);
      const patternMode = resolvePatternMode(args);
      const caseSensitive = (args.case_sensitive as boolean | undefined) ?? false;
      const contextLines = Math.min((args.context_lines as number) ?? 0, 5);
      const maxResults = Math.min((args.max_results as number) ?? 50, 200);
      const maxFileBytes = resolveMaxFileBytes(args);
      const glob = args.glob as string | undefined;

      const content = compileContentMatchers(terms, patternMode, caseSensitive);
      let fileFilter: RegExp | null = null;
      let compiledGlob: string | undefined;
      if (glob) {
        try {
          fileFilter = globToPathRegex(glob);
          compiledGlob = fileFilter.source;
        } catch (error) {
          throw new Error(`Invalid glob "${glob}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const allMatches: SearchMatch[] = [];
      let filesSeen = 0;
      let filesMatchedByGlob = 0;
      let filesSearched = 0;
      let filesSkipped = 0;
      let filesSkippedOversize = 0;
      let truncated = false;

      async function walk(dir: string): Promise<void> {
        if (truncated) return;

        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return; // 无权限/目录消失 → 跳过该目录
        }

        for (const entry of entries) {
          if (truncated) return;

          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name)) {
              await walk(fullPath);
            }
            continue;
          }

          if (!entry.isFile()) continue;
          filesSeen += 1;

          // 统一为 `/`，保证 Windows 相对路径也能过 glob
          const relPath = relative(rootPath, fullPath).split('\\').join('/');

          // glob 过滤：root 相对路径（无 `/` 的模式等价于任意深度 globstar）
          if (fileFilter && !fileFilter.test(relPath)) continue;
          filesMatchedByGlob += 1;

          // 扩展名粗判二进制，避免把不可读内容塞进结果
          const ext = extname(entry.name).toLowerCase();
          if (BINARY_EXTENSIONS.has(ext)) {
            filesSkipped += 1;
            continue;
          }

          let size = 0;
          try {
            size = (await stat(fullPath)).size;
          } catch {
            // stat 失败（竞态删除/无权限）→ 跳过该文件
            filesSkipped += 1;
            continue;
          }
          if (size > maxFileBytes) {
            filesSkipped += 1;
            filesSkippedOversize += 1;
            continue;
          }

          filesSearched += 1;
          await searchFileLines({
            fullPath,
            relPath,
            matchers: content.matchers,
            contextLines,
            onMatch: (match) => {
              allMatches.push(match);
              if (allMatches.length >= maxResults) {
                truncated = true;
              }
            },
            shouldStop: () => truncated,
          });
        }
      }

      await walk(rootPath);

      const diagnostics: SearchDiagnostics = {
        patternMode: content.mode,
        patterns: content.sources,
        compiledPatterns: content.compiled,
        glob,
        compiledGlob,
        filesSeen,
        filesMatchedByGlob,
        filesSearched,
        filesSkipped,
        filesSkippedOversize,
        maxFileBytes,
      };

      const hints = buildHints({
        totalMatches: allMatches.length,
        content,
        patternModeRequested: patternMode,
        glob,
        filesSeen,
        filesMatchedByGlob,
        filesSearched,
        filesSkipped,
        filesSkippedOversize,
        maxFileBytes,
      });

      return {
        matches: allMatches,
        totalMatches: allMatches.length,
        truncated,
        searchedFiles: filesSearched,
        diagnostics,
        hints,
      } satisfies SearchResult;
    },
  };
}

// ── pattern 编译 ──

/**
 * 收集 pattern / patterns 术语列表
 *
 * @param args - 工具入参
 * @returns 非空搜索词数组
 */
function collectPatternTerms(args: Record<string, unknown>): string[] {
  const terms: string[] = [];
  const single = args.pattern;
  if (typeof single === 'string' && single.trim()) terms.push(single);

  const multi = args.patterns;
  if (Array.isArray(multi)) {
    for (const item of multi) {
      const s = typeof item === 'string' ? item : String(item ?? '');
      if (s.trim()) terms.push(s);
    }
  }

  if (terms.length === 0) {
    throw new Error('Provide pattern (string) or patterns (non-empty string[])');
  }
  return terms;
}

/**
 * 解析 pattern 编译模式：pattern_mode 优先，regex 布尔为兼容别名
 *
 * @param args - 工具入参
 * @returns 请求的模式
 */
function resolvePatternMode(args: Record<string, unknown>): PatternMode {
  const explicit = args.pattern_mode;
  if (explicit === 'auto' || explicit === 'literal' || explicit === 'regex') {
    return explicit;
  }
  const legacy = args.regex;
  if (legacy === true) return 'regex';
  if (legacy === false) return 'literal';
  return 'auto';
}

/**
 * 解析单文件字节安全阀
 *
 * @param args - 工具入参
 * @returns 正整数字节上限
 */
function resolveMaxFileBytes(args: Record<string, unknown>): number {
  const raw = args.max_file_bytes;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  return DEFAULT_MAX_FILE_BYTES;
}

/**
 * 判断 auto 模式下术语是否应按正则编译
 *
 * 只认强信号。代码字面量保持 literal：
 * `arr[0]` / `useState()` / `a+b` / `C++` / `foo.bar` / `memory*` 均不为正则。
 * 词式交替（`foo|bar`）视为 OR 正则，对应模型常见写法。
 *
 * @param term - 搜索词
 * @returns 是否像正则
 */
function looksLikeRegex(term: string): boolean {
  if (term.startsWith('^') || term.endsWith('$')) return true;
  // 转义类（\d \w …）或转义元字符（\[ \( …）→ 显式正则意图
  if (/\\[dDwWsSbBnrptfv0-9.*+?^${}()|[\]\\]/.test(term)) return true;
  if (/\.\*|\.\+/.test(term)) return true;
  if (/\{\d+(?:,\d*)?\}/.test(term)) return true;
  if (term.includes('|')) {
    const branches = term.split('|');
    return branches.length >= 2 && branches.every(isWordLikeBranch);
  }
  return false;
}

/**
 * 交替分支是否为词式（可安全当作 OR 字面量正则）
 *
 * @param branch - `a|b` 的单个分支
 * @returns 是否不含正则元字符
 */
function isWordLikeBranch(branch: string): boolean {
  return branch.length > 0 && /^[\w.\- /:']+$/.test(branch);
}

/**
 * 转义正则特殊字符
 *
 * @param str - 字面量
 * @returns 正则安全的字面量
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 编译内容匹配器（多词 OR）
 *
 * @param terms - 搜索词列表
 * @param requested - 请求的 pattern 模式
 * @param caseSensitive - 是否区分大小写
 * @returns 编译结果
 */
function compileContentMatchers(
  terms: string[],
  requested: PatternMode,
  caseSensitive: boolean,
): ContentMatchers {
  // 无需 `g`：.test() 不用 lastIndex 扫描
  const flags = caseSensitive ? '' : 'i';
  const matchers: RegExp[] = [];
  const sources: string[] = [];
  const compiled: string[] = [];
  const kinds: Array<'literal' | 'regex'> = [];
  let autoForcedLiteral = false;

  for (const term of terms) {
    sources.push(term);
    let asRegex: boolean;
    if (requested === 'regex') asRegex = true;
    else if (requested === 'literal') asRegex = false;
    else asRegex = looksLikeRegex(term);

    let re: RegExp | null = null;
    if (asRegex) {
      try {
        re = new RegExp(term, flags);
      } catch (error) {
        if (requested === 'regex') {
          throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
        }
        // auto 下像正则但编译失败 → 回退字面量
        autoForcedLiteral = true;
        asRegex = false;
      }
    }
    if (!re) {
      re = new RegExp(escapeRegex(term), flags);
    }
    matchers.push(re);
    compiled.push(re.source);
    kinds.push(asRegex ? 'regex' : 'literal');
  }

  const usedRegex = kinds.some((k) => k === 'regex');
  const usedLiteral = kinds.some((k) => k === 'literal');
  return {
    mode: usedRegex && usedLiteral ? 'mixed' : usedRegex ? 'regex' : 'literal',
    matchers,
    sources,
    compiled,
    kinds,
    autoForcedLiteral,
  };
}

/**
 * 判断一行是否命中任一匹配器
 *
 * @param line - 文本行
 * @param matchers - 已编译匹配器
 * @returns 是否命中
 */
function lineMatches(line: string, matchers: RegExp[]): boolean {
  for (const re of matchers) {
    if (re.test(line)) return true;
  }
  return false;
}

/**
 * 流式扫描单文件：逐行匹配，环形缓冲 before，挂起 after 收齐后再回调
 *
 * @param options - 路径 / 匹配器 / 上下文行数 / 回调
 * @returns 无
 */
async function searchFileLines(options: {
  fullPath: string;
  relPath: string;
  matchers: RegExp[];
  contextLines: number;
  onMatch: (match: SearchMatch) => void;
  shouldStop: () => boolean;
}): Promise<void> {
  const { createReadStream } = await import('node:fs');
  const { createInterface } = await import('node:readline');

  const { fullPath, relPath, matchers, contextLines, onMatch, shouldStop } = options;

  let stream;
  try {
    stream = createReadStream(fullPath, { encoding: 'utf8' });
  } catch {
    // 同步打开失败（权限/路径失效）→ 本文件无匹配
    return;
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const beforeRing: string[] = [];
  const pending: Array<{ line: number; content: string; before: string[]; after: string[] }> = [];
  let lineNo = 0;

  const flushReady = (final: boolean) => {
    while (pending.length > 0) {
      const head = pending[0];
      if (!final && head.after.length < contextLines) break;
      pending.shift();
      const match: SearchMatch = {
        file: relPath,
        line: head.line,
        content: head.content,
      };
      if (contextLines > 0) {
        match.before = head.before;
        match.after = head.after;
      }
      onMatch(match);
      if (shouldStop()) return;
    }
  };

  try {
    for await (const line of rl) {
      if (shouldStop()) break;
      lineNo += 1;

      for (const p of pending) {
        if (p.after.length < contextLines) p.after.push(line);
      }
      flushReady(false);
      if (shouldStop()) break;

      if (lineMatches(line, matchers)) {
        pending.push({
          line: lineNo,
          content: line,
          before: contextLines > 0 ? beforeRing.slice(-contextLines) : [],
          after: [],
        });
      }

      if (contextLines > 0) {
        beforeRing.push(line);
        if (beforeRing.length > contextLines) beforeRing.shift();
      }
    }
    flushReady(true);
  } catch {
    // 流中断（读错误）→ 丢弃未完成上下文，已回调的保留
  } finally {
    rl.close();
    stream.destroy();
  }
}

// ── glob 编译 ──

/**
 * 将路径 glob 编译为正则（匹配 root 相对路径）
 *
 * 语义对齐 rg/git：
 * - `**` 跨目录；`*` / `?` 不跨 `/`
 * - 无 `/` 的模式（如 `*.md`）等价于任意深度的 globstar 匹配
 * - 支持 `{a,b}` 花括号（可多组）
 *
 * @param glob - glob 模式
 * @returns 整串匹配相对路径的正则（大小写不敏感）
 */
function globToPathRegex(glob: string): RegExp {
  const trimmed = glob.trim();
  if (!trimmed) throw new Error('glob must be non-empty');
  const normalized = trimmed.includes('/') ? trimmed : `**/${trimmed}`;
  const source = globToSource(normalized);
  return new RegExp(`^${source}$`, 'i');
}

/**
 * 将（已规范化）glob 片段编译为正则源
 *
 * @param glob - 含路径分隔符的 glob
 * @returns 正则源片段（无首尾锚点）
 */
function globToSource(glob: string): string {
  let out = '';
  let i = 0;

  while (i < glob.length) {
    const ch = glob[i];

    // `\*` `\?` 等 → 字面量
    if (ch === '\\' && i + 1 < glob.length && '*?[]{}\\/!'.includes(glob[i + 1])) {
      out += escapeRegex(glob[i + 1]);
      i += 2;
      continue;
    }

    if (ch === '*' && glob[i + 1] === '*') {
      i += 2;
      if (glob[i] === '/') {
        i += 1;
        // `**/` → 任意深度前缀（含零层）
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
      continue;
    }

    if (ch === '*') {
      i += 1;
      out += '[^/]*';
      continue;
    }

    if (ch === '?') {
      i += 1;
      out += '[^/]';
      continue;
    }

    if (ch === '{') {
      const end = findBraceEnd(glob, i);
      if (end === -1) {
        out += '\\{';
        i += 1;
        continue;
      }
      const alts = splitBraceAlts(glob.slice(i + 1, end));
      out += `(?:${alts.map((alt) => globToSource(alt)).join('|')})`;
      i = end + 1;
      continue;
    }

    if ('.+^$()|[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }

  return out;
}

/**
 * 找到配对的 `}`（跳过嵌套 `{}`）
 *
 * @param glob - glob 字符串
 * @param openIndex - `{` 下标
 * @returns 配对 `}` 下标；无则 -1
 */
function findBraceEnd(glob: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < glob.length; i++) {
    if (glob[i] === '{') depth += 1;
    else if (glob[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 拆分花括号内的顶层逗号备选
 *
 * @param body - `{}` 内部
 * @returns 备选列表
 */
function splitBraceAlts(body: string): string[] {
  const alts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      alts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  alts.push(current);
  return alts;
}

// ── hints ──

/**
 * 构建零结果 / 异常检索的自纠提示
 *
 * @param input - 诊断输入
 * @returns 提示列表
 */
function buildHints(input: {
  totalMatches: number;
  content: ContentMatchers;
  patternModeRequested: PatternMode;
  glob?: string;
  filesSeen: number;
  filesMatchedByGlob: number;
  filesSearched: number;
  filesSkipped: number;
  filesSkippedOversize: number;
  maxFileBytes: number;
}): string[] {
  const hints: string[] = [];
  if (input.totalMatches > 0) return hints;

  if (input.glob && input.filesMatchedByGlob === 0) {
    hints.push(
      `glob ${JSON.stringify(input.glob)} matched 0 files (seen ${input.filesSeen}). ` +
        "Patterns match root-relative paths: use '*.md' for any depth, 'src/**/*.ts' for nested. " +
        'Bare `*` does not cross directories; `**` does.',
    );
  }

  if (input.filesSkippedOversize > 0) {
    hints.push(
      `${input.filesSkippedOversize} file(s) exceeded max_file_bytes=${input.maxFileBytes} and were skipped. ` +
        'Raise max_file_bytes to search huge text files.',
    );
  }

  if (input.filesMatchedByGlob > 0 && input.filesSearched === 0) {
    hints.push(
      `glob matched ${input.filesMatchedByGlob} files but searched 0 ` +
        `(${input.filesSkipped} skipped as binary/oversize/unreadable). Try a narrower path or text extensions.`,
    );
  }

  if (input.content.autoForcedLiteral) {
    hints.push(
      'Some terms look like regex but failed to compile; they were searched as literal text. Fix the regex or set pattern_mode="literal".',
    );
  }

  const wantsRegex = input.content.sources.some(
    (s) => s.includes('|') || s.startsWith('^') || s.endsWith('$') || s.includes('\\d') || s.includes('.*'),
  );
  if (input.patternModeRequested === 'literal' && wantsRegex) {
    hints.push(
      'pattern/patterns contain regex metacharacters but were forced to literal. Set pattern_mode="regex" (or omit it for auto).',
    );
  }

  if (input.patternModeRequested === 'auto' && input.content.mode !== 'literal' && input.filesSearched > 0) {
    hints.push(
      `Compiled as ${input.content.mode} matching: ${input.content.compiled.map((c) => JSON.stringify(c)).join(', ')}. ` +
        'If you meant literal code text (e.g. arr[0], useState()), set pattern_mode="literal".',
    );
  }

  if (input.filesSearched > 0 && hints.length === 0) {
    hints.push(
      `Searched ${input.filesSearched} files with ${input.content.mode} matching and found 0 lines. ` +
        'Try broader terms, a wider path/glob, or patterns:["a","b"] for OR-of-literals.',
    );
  }

  return hints;
}

/** 常见二进制文件扩展名（svg 为可检索文本，不在此列） */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flv',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot',
  '.sqlite', '.db',
]);
