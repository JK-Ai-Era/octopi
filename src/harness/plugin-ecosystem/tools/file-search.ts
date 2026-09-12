/**
 * file_search 工具 — 跨文件内容搜索
 *
 * 在文件系统中搜索文本或正则模式，返回文件路径 + 行号 + 上下文行。
 * 等效于 grep/rg，但输出结构化，便于 LLM 解析。
 *
 * 特性：
 * - 文本搜索和正则搜索
 * - glob 文件名过滤
 * - 上下文行（before/after）
 * - 结果数量限制
 * - 忽略常见无关目录（node_modules, .git 等）
 */

import type { RegisteredTool } from '../../../core/types.js';

/** 单条匹配结果 */
interface SearchMatch {
  file: string;
  line: number;
  content: string;
  before?: string[];
  after?: string[];
}

/** 搜索结果 */
interface SearchResult {
  matches: SearchMatch[];
  totalMatches: number;
  truncated: boolean;
  searchedFiles: number;
}

/** 需要忽略的目录 */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
  '.next', '.nuxt', '__pycache__', '.cache', '.DS_Store',
]);

export function createFileSearchTool(): RegisteredTool {
  return {
    definition: {
      name: 'file_search',
      description: 'Search for text or regex patterns across files. Returns file paths, line numbers, and context lines. Similar to grep/rg but with structured output.',
      parameters: {
        pattern: {
          type: 'string',
          description: 'Text or regex pattern to search for',
          required: true,
        },
        path: {
          type: 'string',
          description: 'Root directory to search from (default: current directory)',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files, e.g. "*.ts", "*.{js,ts}" (optional)',
        },
        regex: {
          type: 'boolean',
          description: 'Treat pattern as regex (default: false, plain text search)',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Case sensitive search (default: true)',
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
      },
      timeoutMs: 30_000,
    },
    handler: async (args, context) => {
      const { readdir, stat, readFile } = await import('node:fs/promises');
      const { join, relative, extname } = await import('node:path');

      const rootPath = (args.path as string | undefined)
        ? (args.path as string).startsWith('/')
          ? (args.path as string)
          : join(context.cwd ?? process.cwd(), args.path as string)
        : context.cwd ?? process.cwd();

      const pattern = args.pattern as string;
      const isRegex = (args.regex as boolean) ?? false;
      const caseSensitive = (args.case_sensitive as boolean) ?? true;
      const contextLines = Math.min((args.context_lines as number) ?? 0, 5);
      const maxResults = Math.min((args.max_results as number) ?? 50, 200);
      const glob = args.glob as string | undefined;

      // 构建搜索正则
      let searchRegex: RegExp;
      try {
        const flags = caseSensitive ? 'g' : 'gi';
        searchRegex = isRegex ? new RegExp(pattern, flags) : new RegExp(escapeRegex(pattern), flags);
      } catch (error) {
        throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
      }

      // 编译 glob 为文件名匹配正则
      const fileFilter = glob ? globToRegex(glob) : null;

      const allMatches: SearchMatch[] = [];
      let searchedFiles = 0;
      let truncated = false;

      // 递归遍历目录
      async function walk(dir: string): Promise<void> {
        if (truncated) return;

        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return; // 无权限等，跳过
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

          // glob 过滤
          if (fileFilter && !fileFilter.test(entry.name)) continue;

          // 跳过二进制文件（通过扩展名粗判）
          const ext = extname(entry.name).toLowerCase();
          if (BINARY_EXTENSIONS.has(ext)) continue;

          // 读取并搜索
          let fileContent: string;
          try {
            fileContent = await readFile(fullPath, 'utf-8');
          } catch {
            continue; // 读取失败，跳过
          }

          const lines = fileContent.split('\n');
          searchedFiles++;

          for (let i = 0; i < lines.length; i++) {
            if (truncated) return;

            // 重置 regex lastIndex（global flag）
            searchRegex.lastIndex = 0;
            if (!searchRegex.test(lines[i])) continue;

            const match: SearchMatch = {
              file: relative(rootPath, fullPath),
              line: i + 1,
              content: lines[i],
            };

            // 上下文行
            if (contextLines > 0) {
              const beforeStart = Math.max(0, i - contextLines);
              match.before = lines.slice(beforeStart, i);
              const afterEnd = Math.min(lines.length, i + 1 + contextLines);
              match.after = lines.slice(i + 1, afterEnd);
            }

            allMatches.push(match);
            if (allMatches.length >= maxResults) {
              truncated = true;
            }
          }
        }
      }

      await walk(rootPath);

      return {
        matches: allMatches,
        totalMatches: allMatches.length,
        truncated,
        searchedFiles,
      } satisfies SearchResult;
    },
  };
}

// ── 辅助函数 ──

/** 转义正则特殊字符 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 将简单 glob 模式转为正则（支持 * 和 {a,b}） */
function globToRegex(glob: string): RegExp {
  let pattern = glob
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  // 支持 {js,ts} 语法
  const braceMatch = pattern.match(/\{([^}]+)\}/);
  if (braceMatch) {
    const alternatives = braceMatch[1].split(',').map(s => s.trim());
    pattern = pattern.replace(braceMatch[0], `(${alternatives.join('|')})`);
  }

  return new RegExp(`^${pattern}$`, 'i');
}

/** 常见二进制文件扩展名 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flv',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot',
  '.sqlite', '.db',
]);
