/**
 * 内置工具集
 *
 * 提供框架默认的纯工具实现（零外部依赖，所有环境可用）：
 * - shell: 执行 shell 命令
 * - file_read / file_write / file_list: 文件读写列目录
 * - file_edit: 结构化文件编辑（局部替换）
 * - file_search: 跨文件内容搜索
 * - http_request: HTTP 请求
 * - env_info: 运行环境信息
 *
 * 所有有状态工具（memory、task、ask_user）通过 extension-tools 按需注入。
 *
 * 安全注意事项：
 * - shell 工具可以执行任意命令，生产环境应限制命令白名单
 * - file_read/file_write/file_edit 应限制可访问的目录范围
 * - http_request 应限制可访问的域名
 * - 建议在 ToolPolicy 的 deny 列表中禁用不需要的工具
 */

import type { RegisteredTool } from '../../../core/types.js';

import { createFileEditTool } from './file-edit.js';
import { createFileSearchTool } from './file-search.js';
import { createHttpRequestTool } from './http.js';
import { createEnvInfoTool } from './env-info.js';
import { defaultPathEnv, resolvePlatformShell, resolveToolPath } from './platform.js';

/**
 * Shell 工具 — 执行 shell 命令
 *
 * 参数：
 * - command (string, required): 要执行的 shell 命令
 * - cwd (string, optional): 工作目录
 * - timeout (number, optional): 超时时间（毫秒，默认 30000）
 *
 * 返回：
 * - stdout: 标准输出
 * - stderr: 标准错误
 * - exitCode: 退出码
 * - durationMs: 执行耗时
 * - shell: 实际使用的 shell（kind/executable）
 */
export function createShellTool(options?: {
  summary?: import('../../capabilities/summary/index.js').ToolSummarySupport;
}): RegisteredTool {
  const shell = resolvePlatformShell();
  const syntaxHint =
    shell.kind === 'bash'
      ? 'Write POSIX/bash syntax.'
      : shell.kind === 'powershell'
        ? 'Write PowerShell syntax (e.g. Get-ChildItem, Select-String).'
        : 'Write cmd.exe syntax.';

  return {
    definition: {
      name: 'shell',
      description: `LAST RESORT shell. Prefer a dedicated tool when one covers the job (file_read/file_list/file_write/file_edit/file_search/env_info and any task-specific tools). Use shell only when: no dedicated tool covers the operation, the dedicated tool is unavailable, or it still fails after a correct retry (wrong path/args → fix and retry the tool first). Never use shell instead of a working dedicated tool. Detected shell: ${shell.label}. ${syntaxHint}`,
      parameters: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
          required: true,
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (optional)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      timeoutMs: 60_000,
    },
    handler: async (args, context) => {
      const command = args.command as string;
      const cwd = (args.cwd as string | undefined) ?? context?.cwd ?? process.cwd();
      const timeout = (args.timeout as number) ?? 30_000;

      const { spawn } = await import('node:child_process');
      const resolvedShell = resolvePlatformShell();

      return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const child = spawn(resolvedShell.executable, [...resolvedShell.args, command], {
          cwd: resolveToolPath(cwd, context?.cwd),
          timeout,
          env: { ...process.env, PATH: defaultPathEnv() },
          windowsHide: true,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.on('close', async (code) => {
          const durationMs = Date.now() - startTime;
          try {
            const { applyToolOutputGate, resolveSupportBinding } = await import(
              '../../capabilities/summary/index.js'
            );
            const support = options?.summary;
            const binding = resolveSupportBinding('shell', support, 8000);
            const applied = await applyToolOutputGate({
              tool: 'shell',
              rawBody: stdout,
              support: { ...support, binding },
              truncateHint: 'Re-run with a narrower command, or redirect large output to a file and file_read it.',
            });
            const stderrApplied = await applyToolOutputGate({
              tool: 'shell',
              rawBody: stderr,
              support: { ...support, binding: { ...binding, maxReturnChars: Math.min(binding.maxReturnChars, 4000) } },
              truncateHint: 'stderr truncated.',
            });
            resolve({
              stdout: applied.body,
              stderr: stderrApplied.body,
              exitCode: code,
              durationMs,
              truncated: applied.bodyTruncated || stderrApplied.bodyTruncated,
              rawStdoutLength: applied.rawLength,
              shell: {
                kind: resolvedShell.kind,
                executable: resolvedShell.executable,
              },
            });
          } catch {
            // summary 模块不可用时的 L1 替代：裸 slice 硬顶，避免超大结果进主会话
            resolve({
              stdout: stdout.slice(0, 8000),
              stderr: stderr.slice(0, 4000),
              exitCode: code,
              durationMs,
              truncated: stdout.length > 8000 || stderr.length > 4000,
              rawStdoutLength: stdout.length,
              shell: {
                kind: resolvedShell.kind,
                executable: resolvedShell.executable,
              },
            });
          }
        });

        child.on('error', (err) => {
          reject(new Error(`Shell execution failed (${resolvedShell.label}): ${err.message}`));
        });
      });
    },
  };
}

/**
 * File Read 工具 — 读取文件内容
 *
 * 参数：
 * - path (string, required): 文件路径
 * - offset (number, optional): 起始行号（1-indexed）
 * - limit (number, optional): 最大行数
 *
 * 返回：
 * - content: 文件内容
 * - totalLines: 文件总行数
 * - truncated: 是否被截断
 *
 * 大文件：kind_sensitive + L1 硬顶；code 默认不 L2 摘要。
 */
/**
 * 创建 file_read 工具
 *
 * @param options - 可选 SummaryPort / toolBindings 注入（与 octopi.json summary.tools 同源）
 * @returns RegisteredTool
 */
export function createFileReadTool(options?: {
  summary?: import('../../capabilities/summary/index.js').ToolSummarySupport;
}): RegisteredTool {
  return {
    definition: {
      name: 'file_read',
      description: 'Read the contents of a file. Supports text files. Use offset and limit for large files.',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to the file to read',
          required: true,
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (1-indexed, default: 1)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read (default: 2000)',
        },
        summarize: {
          type: 'string',
          description: 'Summary mode: auto (default; code usually raw) | force | off. off still hard-caps size.',
          enum: ['auto', 'force', 'off'],
        },
        summary_task: {
          type: 'string',
          description: 'Optional extraction goal when summarizing file content',
        },
        summary_kind: {
          type: 'string',
          description: 'Optional ContentKind override',
          enum: ['web_page', 'file_text', 'document', 'code', 'api_json', 'log', 'conversation', 'opaque', 'auto'],
        },
        summary_policy: {
          type: 'string',
          description: 'Optional SummaryPolicy id override',
        },
      },
    },
    handler: async (args, context) => {
      const { readFile } = await import('node:fs/promises');
      const pathModule = await import('node:path');

      const rawPath = args.path as string;
      const cwd = context?.cwd ?? process.cwd();
      const path = resolveToolPath(rawPath, cwd);
      const offset = (args.offset as number) ?? 1;
      const limit = (args.limit as number) ?? 2000;

      try {
        const content = await readFile(path, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;

        const start = Math.max(0, offset - 1);
        const end = Math.min(totalLines, start + limit);
        const selected = lines.slice(start, end).join('\n');

        const { applyToolOutputGate, resolveSupportBinding } = await import(
          '../../capabilities/summary/index.js'
        );
        const support = options?.summary;
        const binding = resolveSupportBinding('file_read', support, 12000);

        const applied = await applyToolOutputGate({
          tool: 'file_read',
          rawBody: selected,
          support: { ...support, binding },
          locator: path,
          extension: pathModule.extname(path),
          kind: args.summary_kind as never,
          task: args.summary_task as string | undefined,
          policyId: args.summary_policy as string | undefined,
          summarizeArg: args.summarize as 'auto' | 'force' | 'off' | undefined,
          truncateHint:
            'Use file_read with offset/limit to continue reading, or summarize=force for an overview.',
        });

        return {
          content: applied.body,
          totalLines,
          truncated: end < totalLines || applied.bodyTruncated,
          fromLine: start + 1,
          toLine: end,
          rawLength: applied.rawLength,
          summary: applied.summary,
          summaryUsage: applied.usage,
        };
      } catch (error) {
        throw new Error(`Failed to read file "${path}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * File Write 工具 — 写入文件内容
 *
 * 参数：
 * - path (string, required): 文件路径
 * - content (string, required): 要写入的内容
 * - append (boolean, optional): 是否追加模式（默认覆盖）
 *
 * 返回：
 * - path: 写入的文件路径
 * - bytesWritten: 写入的字节数
 */
export function createFileWriteTool(): RegisteredTool {
  return {
    definition: {
      name: 'file_write',
      description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Use append mode to add to existing files.',
      parameters: {
        path: {
          type: 'string',
          description: 'Path to the file to write',
          required: true,
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
          required: true,
        },
        append: {
          type: 'boolean',
          description: 'If true, append to the file instead of overwriting (default: false)',
        },
      },
    },
    handler: async (args, context) => {
      const { writeFile, appendFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');

      const rawPath = args.path as string;
      const cwd = context?.cwd ?? process.cwd();
      const path = resolveToolPath(rawPath, cwd);
      const content = args.content as string;
      const append = args.append as boolean ?? false;

      try {
        // 确保父目录存在
        await mkdir(dirname(path), { recursive: true });

        if (append) {
          await appendFile(path, content);
        } else {
          await writeFile(path, content);
        }

        return {
          path,
          bytesWritten: Buffer.byteLength(content, 'utf-8'),
          mode: append ? 'append' : 'overwrite',
        };
      } catch (error) {
        throw new Error(`Failed to write file "${path}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * 编译 file_list.pattern：优先 glob（`*.md`），否则正则。
 * `new RegExp('*.md')` 会抛 Nothing to repeat，模型常写 glob。
 */
function compileNamePattern(raw: string | undefined): RegExp | null {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  const looksLikeGlob =
    /[*?]/.test(trimmed) &&
    !trimmed.startsWith('^') &&
    !trimmed.endsWith('$') &&
    !/[()[\]\\]/.test(trimmed);
  if (looksLikeGlob) {
    const escaped = trimmed
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    // 整串匹配：`*.md` 不得命中 `file.md.bak`
    return new RegExp(`^${escaped}$`, 'i');
  }
  try {
    return new RegExp(trimmed, 'i');
  } catch {
    throw new Error(`Invalid pattern "${raw}": use glob (*.md) or a valid regular expression`);
  }
}

/**
 * File List 工具 — 列出目录内容
 *
 * 参数：
 * - path (string, required): 目录路径
 * - recursive (boolean, optional): 是否递归列出（默认 false）
 * - pattern (string, optional): 文件名过滤，glob（`*.md` / `*test*`）或正则
 * - maxEntries (number, optional): 条目硬顶（默认 500）
 * - maxDepth (number, optional): 递归深度上限（默认 4，硬顶 8）；仅 recursive 时生效
 *
 * 返回：
 * - entries: 文件和目录列表（受 maxEntries / L1 约束）
 * - count: 本页条目数
 * - totalCount: 扫描到的总条目（可能 > count）
 * - truncated: 是否被条目上限或 L1 截断
 *
 * 递归时默认跳过 node_modules/.git 等噪音目录；结果进主会话前强制 L1 硬顶。
 */
export function createFileListTool(options?: {
  summary?: import('../../capabilities/summary/index.js').ToolSummarySupport;
}): RegisteredTool {
  const SKIP_DIR_NAMES = new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    '.cache',
    '.next',
    '.nuxt',
    '.turbo',
    '.venv',
    'venv',
    '__pycache__',
    'dist',
    'build',
    'coverage',
    '.idea',
    '.vscode',
  ]);

  return {
    definition: {
      name: 'file_list',
      description:
        'List files and directories in a path. Supports recursive listing and pattern filtering. Recursive mode skips node_modules/.git by default. Output is capped.',
      parameters: {
        path: {
          type: 'string',
          description: 'Directory path to list',
          required: true,
        },
        recursive: {
          type: 'boolean',
          description: 'If true, list recursively (default: false). Skips node_modules/.git/build caches.',
        },
        pattern: {
          type: 'string',
          description: 'Filter by file name: glob (*.md, *test*) or regex. Matched against the file/dir name, not full path.',
        },
        maxEntries: {
          type: 'number',
          description: 'Maximum entries to return (default: 500)',
        },
        maxDepth: {
          type: 'number',
          description: 'Max directory depth when recursive (default: 4, hard cap: 8). Prefer listing a subdirectory path over raising this.',
        },
      },
    },
    handler: async (args, context) => {
      const { readdir, stat } = await import('node:fs/promises');
      const { join, relative } = await import('node:path');

      const rawPath = args.path as string;
      const cwd = context?.cwd ?? process.cwd();
      const basePath = resolveToolPath(rawPath, cwd);
      const recursive = (args.recursive as boolean) ?? false;
      const pattern = compileNamePattern(args.pattern as string | undefined);
      const maxEntries = Math.min(Math.max((args.maxEntries as number) ?? 500, 1), 2000);
      const maxDepth = Math.min(Math.max((args.maxDepth as number) ?? 4, 1), 8);

      const entries: Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }> = [];
      let totalCount = 0;
      let entryCapped = false;
      let depthCapped = false;

      async function walk(dir: string, depth: number) {
        if (entryCapped) return;
        if (depth > maxDepth) {
          depthCapped = true;
          return;
        }
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items) {
          if (entryCapped) return;
          const fullPath = join(dir, item.name);
          const relativePath = relative(basePath, fullPath);

          if (recursive && item.isDirectory() && SKIP_DIR_NAMES.has(item.name)) continue;
          // pattern 只过滤列出的条目；递归时目录始终下钻（否则 recursive+*.md 进不了子目录）
          const matched = !pattern || pattern.test(item.name);

          if (item.isDirectory()) {
            if (matched) {
              totalCount += 1;
              if (entries.length >= maxEntries) {
                entryCapped = true;
                return;
              }
              entries.push({ name: item.name, path: relativePath, type: 'directory' });
            }
            if (recursive) {
              // 子目录内容属于 depth+1；超过 maxDepth 不再下钻
              if (depth + 1 > maxDepth) {
                depthCapped = true;
              } else {
                await walk(fullPath, depth + 1);
              }
            }
          } else if (item.isFile() && matched) {
            totalCount += 1;
            if (entries.length >= maxEntries) {
              entryCapped = true;
              return;
            }
            const s = await stat(fullPath).catch(() => null);
            entries.push({
              name: item.name,
              path: relativePath,
              type: 'file',
              size: s?.size,
            });
          }
        }
      }

      try {
        await walk(basePath, 1);
        const rawBody = JSON.stringify({ entries, count: entries.length, totalCount });

        const { applyToolOutputGate, resolveSupportBinding } = await import(
          '../../capabilities/summary/index.js'
        );
        const support = options?.summary;
        const binding = resolveSupportBinding('file_list', support, 8000);
        const applied = await applyToolOutputGate({
          tool: 'file_list',
          rawBody,
          support: { ...support, binding },
          locator: basePath,
          truncateHint: 'Use path/pattern/maxEntries to narrow the listing, or list a subdirectory.',
        });

        // L1/L2 出口：截断或摘要后不得把完整 entries 旁路回灌
        const maxChars = binding.maxReturnChars;
        const l1Hit = applied.rawLength > maxChars || applied.bodyTruncated;
        const reasons: string[] = [];
        if (entryCapped) reasons.push('max_entries');
        if (depthCapped) reasons.push('max_depth');
        if (applied.summary?.applied) reasons.push('l2_summary');
        if (l1Hit) reasons.push('l1_cap');

        if (applied.summary?.applied || l1Hit) {
          const kept: typeof entries = [];
          let used = 0;
          for (const e of entries) {
            const chunk = JSON.stringify(e).length + 1;
            if (used + chunk > maxChars) break;
            kept.push(e);
            used += chunk;
          }
          return {
            entries: kept,
            count: kept.length,
            totalCount,
            maxDepth,
            truncated: true,
            truncatedReason: reasons.join('+') || undefined,
            depthCapped,
            raw: applied.body,
            rawLength: applied.rawLength,
            summary: applied.summary,
            summaryUsage: applied.usage,
          };
        }

        return {
          entries,
          count: entries.length,
          totalCount,
          maxDepth,
          truncated: entryCapped || depthCapped,
          truncatedReason: reasons.length ? reasons.join('+') : undefined,
          depthCapped,
          skippedDirs: recursive ? [...SKIP_DIR_NAMES] : undefined,
          rawLength: applied.rawLength,
          summary: applied.summary,
          summaryUsage: applied.usage,
        };
      } catch (error) {
        throw new Error(`Failed to list directory "${basePath}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}


/** 获取内置工具（零依赖，所有环境可用）。shell 靠后注册，提示模型优先专用工具 */
export function getBuiltinTools(options?: {
  summary?: import('../../capabilities/summary/index.js').ToolSummarySupport;
}): RegisteredTool[] {
  return [
    createFileReadTool({ summary: options?.summary }),
    createFileListTool({ summary: options?.summary }),
    createFileWriteTool(),
    createFileEditTool(),
    createFileSearchTool(),
    createHttpRequestTool({ summary: options?.summary }),
    createEnvInfoTool(),
    createShellTool({ summary: options?.summary }),
  ];
}
