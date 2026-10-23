/**
 * file_search 工具 — 跨文件内容搜索
 *
 * 在文件系统中搜索文本或正则模式，返回文件路径 + 行号 + 上下文行。
 * 等效于 grep/rg，但输出结构化，便于 LLM 解析。
 *
 * 特性：
 * - pattern_mode: auto（默认）/ literal / regex；`patterns[]` 多词任一命中
 * - auto 仅认强信号（锚点/转义类/`.*`/`{n}`），代码字面量保持 literal
 * - auto 下 `a|b` 恒为「分支字面 OR」：分支 trim + 转义后以 `|` 连接（`.` 是字面点，非通配）；
 *   任一分支为空（`foo|`、`|`）则整词按字面搜；要搜含竖线的字面文本用 pattern_mode=literal
 * - 二进制嗅探：文件头 4KB 含 NUL 判为二进制跳过（无扩展名二进制如 .DS_Store 不漏入结果）
 * - 结果含 matchedFiles 聚合（每文件命中数）与 diagnostics.root（实际搜索根，便于发现 path 传错）
 * - 路径感知 glob（支持 `**` / `*` / `?` / `{a,b}`，匹配 root 相对路径；`\` 转义）
 * - 逐行流式扫描；`max_file_bytes` 安全阀（默认 50MB）跳过异常巨文件
 * - 上下文行（before/after）
 * - 结果数量限制
 * - L1 输出硬顶（F1-B1）：结构化收缩、零 LLM，file+line 清单永远全保；
 *   预算经 `summary.tools.file_search.maxReturnChars` 可调（缺省 8000）
 * - 忽略常见无关目录（node_modules, .git 等）
 * - 零结果时返回 diagnostics + hints，便于调用方自纠
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import type { FileHandle } from 'node:fs/promises';
import {
  resolveSupportBinding,
  type ToolSummarySupport,
} from '../../../context/capabilities/summary/index.js';
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
  /** 实际搜索根（已解析），调用方核对 path 是否传错 */
  root: string;
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
  /** 头 4KB 含 NUL 被判为二进制跳过的文件数 */
  filesSkippedBinary: number;
  maxFileBytes: number;
}

/** truncated 原因：条数截断（max_results）与/或 L1 预览体收缩（l1_cap） */
type TruncatedReason = 'max_results' | 'l1_cap' | 'max_results+l1_cap';

/** 搜索结果 */
interface SearchResult {
  matches: SearchMatch[];
  /**
   * 返回的匹配条数（= matches.length）。max_results 截断时真实命中更多，
   * 此字段是下界（见 truncatedReason），不是全量总数
   */
  totalMatches: number;
  /** 每文件命中数（按命中数降序、文件名升序；max_results 截断时只覆盖已返回的命中） */
  matchedFiles: Array<{ file: string; matches: number }>;
  /** 有信息被收起：max_results（条数截断）和/或 l1_cap（预览体收缩） */
  truncated: boolean;
  /** truncated 原因 */
  truncatedReason?: TruncatedReason;
  /** L1 结构化收缩记录；未收缩时不出现 */
  outputCap?: SearchOutputCap;
  searchedFiles: number;
  diagnostics: SearchDiagnostics;
  hints: string[];
}

/** L1 输出收缩记录（仅在收缩发生时出现；file+line 清单永远全保） */
interface SearchOutputCap {
  /** 恒为 true */
  applied: true;
  /** 已执行的收缩阶段（按序）：剥上下文行 → content 行截断 → 预览只留前 K 条 */
  stages: Array<'context_lines' | 'content_lines' | 'preview_cap'>;
  /** 收缩前 matches 的 JSON 字符长度 */
  rawLength: number;
  /** matches 清单体预算（binding.maxReturnChars；定位符优先，必要时可超出） */
  budgetChars: number;
  /** content 预览行字符上限 */
  contentPreviewChars: number;
  /** 保留完整 content 预览的条数（不影响 file+line 清单完整性） */
  previewKept: number;
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

/** L1 收缩后 content 预览行的字符上限（超长行是单条膨胀元凶；定位符不受影响） */
const CONTENT_PREVIEW_CHARS = 200;

/** content 行机械截断标记（机械截断 ≠ 摘要改写） */
const CONTENT_TRUNCATED_MARK = '…[truncated]';

/** 预览整条省略占位（file+line 永远全保） */
const PREVIEW_OMITTED = '…[preview omitted]';

/** file_search L1 缺省预算（与 summary registry 缺省一致；可经 summary.tools.file_search.maxReturnChars 覆盖） */
const DEFAULT_MAX_RETURN_CHARS = 8000;

/**
 * 创建 file_search 工具
 *
 * @param options - 可选 summary support（L1 预算 binding；file_search 恒不跑 L2）
 * @returns RegisteredTool
 */
export function createFileSearchTool(options?: { summary?: ToolSummarySupport }): RegisteredTool {
  return {
    definition: {
      name: 'file_search',
      capabilities: ['fs-read'],
      description:
        'Search file contents (like grep/rg) with structured results. ' +
        'Provide `pattern` (one term) or `patterns` (any-of literals) — match semantics on those params. ' +
        '`glob` filters by relative path (always case-insensitive; `**` crosses directories, `*` does not). ' +
        '`path` = root dir to walk recursively, or one file to search. ' +
        'Empty results include diagnostics.hints for how to retry. ' +
        'Default case-insensitive content match (`case_sensitive=true` for exact). ' +
        'Files scanned as line streams; `max_file_bytes` skips larger files; first 4KB NUL ⇒ treated as binary.',
      parameters: {
        pattern: {
          type: 'string',
          description:
            'Single search term. Auto: regex only on strong signals — anchors (^…$), ' +
            'escapes (\\d \\w \\s \\b …) or escaped metachars, `.*`/`.+`, `{n}`; ' +
            '`a|b` = literal OR of trimmed branches (empty branch → whole-term literal); ' +
            'everything else is literal text (e.g. `arr[0]`, `C++`, `foo.bar`).',
        },
        patterns: {
          type: 'array',
          description: 'Multiple terms; a line matches if ANY term matches.',
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
            'Matches relative path; bare name (no `/`) matches at any depth; `*` does not cross directories.',
        },
        pattern_mode: {
          type: 'string',
          description: 'How to compile pattern/patterns (default: auto; set "regex"/"literal" to force)',
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
      const { open, readdir, stat } = await import('node:fs/promises');
      const { basename, extname, join, relative } = await import('node:path');

      const rawRoot = args.path as string | undefined;
      const rootPath = rawRoot
        ? resolveToolPath(rawRoot, context.cwd ?? process.cwd(), {
            allowRoots: context.pathRoots,
            containment: context.pathContainment,
          })
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
      let filesSkippedBinary = 0;
      const perFileCounts = new Map<string, number>();
      let truncated = false;

      async function considerFile(fullPath: string, relPath: string): Promise<void> {
        if (truncated) return;
        filesSeen += 1;

        // glob 过滤：root 相对路径（无 `/` 的模式等价于任意深度 globstar）
        if (fileFilter && !fileFilter.test(relPath)) return;
        filesMatchedByGlob += 1;

        // 扩展名粗判二进制，避免把不可读内容塞进结果
        const ext = extname(fullPath).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          filesSkipped += 1;
          return;
        }

        let size = 0;
        try {
          size = (await stat(fullPath)).size;
        } catch {
          // stat 失败（竞态删除/无权限）→ 跳过该文件
          filesSkipped += 1;
          return;
        }
        if (size > maxFileBytes) {
          filesSkipped += 1;
          filesSkippedOversize += 1;
          return;
        }

        // 内容嗅探：头 4KB 含 NUL 视为二进制（扩展名粗判覆盖不到的 .bin/.dat/无后缀二进制）。
        // NUL 在 UTF-8/UTF-16 文本中不出现，误判面可忽略；吞掉读失败并按可读处理（下行扫描自会兜底）。
        if (size > 0) {
          let handle: FileHandle | undefined;
          try {
            handle = await open(fullPath, 'r');
            const buf = Buffer.alloc(Math.min(4096, size));
            const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
            if (buf.subarray(0, bytesRead).includes(0)) {
              filesSkipped += 1;
              filesSkippedBinary += 1;
              return;
            }
          } catch {
            // 读失败：不计二进制，交由下方行扫描决定（其失败路径计 filesSkipped）
          } finally {
            await handle?.close().catch(() => {
              // 关闭失败不影响搜索结果；句柄随进程回收
            });
          }
        }

        filesSearched += 1;
        await searchFileLines({
          fullPath,
          relPath,
          matchers: content.matchers,
          contextLines,
          onMatch: (match) => {
            allMatches.push(match);
            perFileCounts.set(match.file, (perFileCounts.get(match.file) ?? 0) + 1);
            if (allMatches.length >= maxResults) {
              truncated = true;
            }
          },
          shouldStop: () => truncated,
        });
      }

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
          // 统一为 `/`，保证 Windows 相对路径也能过 glob
          const relPath = relative(rootPath, fullPath).split('\\').join('/');
          await considerFile(fullPath, relPath);
        }
      }

      // path 可为目录（递归）或单文件（只搜该文件）
      const rootInfo = await stat(rootPath).catch(() => null);
      if (rootInfo?.isFile()) {
        await considerFile(rootPath, basename(rootPath).split('\\').join('/'));
      } else {
        await walk(rootPath);
      }

      const diagnostics: SearchDiagnostics = {
        root: rootPath,
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
        filesSkippedBinary,
        maxFileBytes,
      };

      // 每文件命中聚合：降序（命中多的优先），同数按文件名升序
      const matchedFiles = [...perFileCounts.entries()]
        .map(([file, matches]) => ({ file, matches }))
        .sort((a, b) => b.matches - a.matches || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

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

      // F1-B1：L1 结构化硬顶（零 LLM）。定位符（file+line）永远全保，只收缩预览体；
      // 不走字符串 gate，避免截断 JSON 丢掉尾部定位符。
      // 注：预算只约束 matches 清单体；matchedFiles/diagnostics/hints 不进预算。
      // file_search 不经过外层 applyToolOutputGate（否则会按字符腰斩 JSON），
      // 因此超出预算是安全的——设计上定位符优先于预算。
      const binding = resolveSupportBinding('file_search', options?.summary, DEFAULT_MAX_RETURN_CHARS);
      const shrunk = shrinkMatchesForBudget(allMatches, binding.maxReturnChars);
      if (shrunk.cap) {
        hints.push(buildOutputCapHint(shrunk.cap));
      }

      const truncatedReason: TruncatedReason | undefined =
        truncated && shrunk.cap
          ? 'max_results+l1_cap'
          : truncated
            ? 'max_results'
            : shrunk.cap
              ? 'l1_cap'
              : undefined;

      return {
        matches: shrunk.matches,
        totalMatches: allMatches.length,
        matchedFiles,
        truncated: truncated || Boolean(shrunk.cap),
        truncatedReason,
        outputCap: shrunk.cap,
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
 * `|` 不是正则信号：`a|b` 走 compileAlternationLiteral 的分支字面 OR。
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
  return false;
}

/**
 * auto 模式下把 `a|b|c` 编译为「分支字面 OR」
 *
 * 分支各自 trim + 转义后以 `|` 连接（`.` 是字面点，不是通配），
 * 对应模型自然写法 `foo()|a+b`。任一分支为空（`foo|`、`|`、`a||b`）
 * 则放弃（返回 null），整词按字面搜——竖线在正则里是空分支语义，代码里几乎从不想要。
 *
 * @param term - 含 `|` 的搜索词
 * @param flags - 正则标志（大小写敏感性由调用方给）
 * @returns 分支字面 OR 正则；不适合作交替时 null（调用方按整词字面处理）
 */
function compileAlternationLiteral(term: string, flags: string): RegExp | null {
  const branches = term.split('|').map((b) => b.trim());
  if (branches.length < 2 || branches.some((b) => b.length === 0)) return null;
  return new RegExp(branches.map((b) => escapeRegex(b)).join('|'), flags);
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
    let forcedLiteral = false;
    if (asRegex) {
      try {
        re = new RegExp(term, flags);
      } catch (error) {
        if (requested === 'regex') {
          throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
        }
        // auto 下像正则但编译失败 → 回退字面量
        forcedLiteral = true;
        autoForcedLiteral = true;
        asRegex = false;
      }
    }
    if (!re && requested === 'auto' && !forcedLiteral && term.includes('|')) {
      // auto 的 `a|b`：分支字面 OR（分支 trim + 转义，`.` 是字面点）；空分支 → 整词字面
      re = compileAlternationLiteral(term, flags);
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

// ── L1 输出收缩（F1-B1：结构化硬顶，零 LLM） ──

/**
 * L1 结构化收缩：把 matches 清单体压进预算，定位符（file+line）永远全保
 *
 * 收缩顺序（arch/long-session-latency.md §5 B1）：
 * 1. 剥 before/after 上下文行；
 * 2. content 行截到 `contentPreviewChars`（显式截断标记）；
 * 3. 预览只留前 K 条，其余保留 file+line + 省略占位。
 * 即使 K=0 仍超预算，file+line 清单也全保（定位符零损失优先于预算）。
 *
 * @param matches - 原始命中列表
 * @param budgetChars - matches 清单体的 JSON 字符预算
 * @param contentPreviewChars - content 预览行字符上限
 * @returns 收缩后的 matches 与收缩记录（未收缩时无 cap）
 */
function shrinkMatchesForBudget(
  matches: SearchMatch[],
  budgetChars: number,
  contentPreviewChars: number = CONTENT_PREVIEW_CHARS,
): { matches: SearchMatch[]; cap?: SearchOutputCap } {
  const rawLength = JSON.stringify(matches).length;
  if (rawLength <= budgetChars) return { matches };

  const stages: SearchOutputCap['stages'] = [];
  const makeCap = (previewKept: number): SearchOutputCap => ({
    applied: true,
    stages,
    rawLength,
    budgetChars,
    contentPreviewChars,
    previewKept,
  });

  // 阶段 1：剥 before/after 上下文行
  const hadContext = matches.some((m) => (m.before?.length ?? 0) > 0 || (m.after?.length ?? 0) > 0);
  let current: SearchMatch[] = matches.map((m) => ({ file: m.file, line: m.line, content: m.content }));
  if (hadContext) stages.push('context_lines');
  if (JSON.stringify(current).length <= budgetChars) {
    return { matches: current, cap: makeCap(current.length) };
  }

  // 阶段 2：content 行截到 contentPreviewChars（超长行是单条膨胀元凶）
  // 只在真的截断了行时才计入 stages：否则 hint 会谎报 content_lines，
  // 让调用方误以为要重跑窄命令拿回完整行（实际是被省略的预览，应 file_read）。
  const contentTruncated = current.some((m) => m.content.length > contentPreviewChars);
  if (contentTruncated) {
    current = current.map((m) =>
      m.content.length > contentPreviewChars
        ? {
            file: m.file,
            line: m.line,
            content: `${m.content.slice(0, contentPreviewChars)}${CONTENT_TRUNCATED_MARK}`,
          }
        : m,
    );
    stages.push('content_lines');
    if (JSON.stringify(current).length <= budgetChars) {
      return { matches: current, cap: makeCap(current.length) };
    }
  }

  // 阶段 3：预览只留前 K 条；file+line 紧凑清单全保
  stages.push('preview_cap');
  for (let kept = current.length - 1; kept >= 0; kept--) {
    const trial = current.map((m, i) =>
      i < kept ? m : { file: m.file, line: m.line, content: PREVIEW_OMITTED },
    );
    if (JSON.stringify(trial).length <= budgetChars) {
      return { matches: trial, cap: makeCap(kept) };
    }
  }
  // 全部省略预览仍超预算：定位符清单按设计全保，接受超出
  return {
    matches: current.map((m) => ({ file: m.file, line: m.line, content: PREVIEW_OMITTED })),
    cap: makeCap(0),
  };
}

/**
 * 构建 L1 收缩后的自纠提示
 *
 * @param cap - 收缩记录
 * @returns 可操作提示（如何拿回完整内容）
 */
function buildOutputCapHint(cap: SearchOutputCap): string {
  return (
    `L1 output cap applied (${cap.stages.join('+')}): match bodies shrunk to fit maxReturnChars=${cap.budgetChars}; ` +
    'the file+line list is complete. Narrow the glob/path or lower max_results for full lines, ' +
    'or file_read the specific files.'
  );
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
