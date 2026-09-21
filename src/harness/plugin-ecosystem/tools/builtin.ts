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
export function createShellTool(): RegisteredTool {
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
      description: `Execute a shell command. Detected shell: ${shell.label}. ${syntaxHint} Use sparingly - prefer file_read/file_list/file_write for file operations. Useful for: git commands, npm scripts, system info.`,
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

        child.on('close', (code) => {
          resolve({
            stdout: stdout.slice(0, 50_000), // 限制输出大小
            stderr: stderr.slice(0, 10_000),
            exitCode: code,
            durationMs: Date.now() - startTime,
            shell: {
              kind: resolvedShell.kind,
              executable: resolvedShell.executable,
            },
          });
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

        const { applyToolSummary, resolveSupportBinding } = await import(
          '../../capabilities/summary/index.js'
        );
        const support = options?.summary;
        const binding = resolveSupportBinding('file_read', support, 12000);

        const applied = await applyToolSummary({
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
 * File List 工具 — 列出目录内容
 *
 * 参数：
 * - path (string, required): 目录路径
 * - recursive (boolean, optional): 是否递归列出（默认 false）
 * - pattern (string, optional): 文件名过滤正则
 *
 * 返回：
 * - entries: 文件和目录列表
 * - count: 总数
 */
export function createFileListTool(): RegisteredTool {
  return {
    definition: {
      name: 'file_list',
      description: 'List files and directories in a path. Supports recursive listing and pattern filtering.',
      parameters: {
        path: {
          type: 'string',
          description: 'Directory path to list',
          required: true,
        },
        recursive: {
          type: 'boolean',
          description: 'If true, list recursively (default: false)',
        },
        pattern: {
          type: 'string',
          description: 'Regex pattern to filter file names (optional)',
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
      const pattern = args.pattern ? new RegExp(args.pattern as string) : null;

      const entries: Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }> = [];

      async function walk(dir: string) {
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items) {
          const fullPath = join(dir, item.name);
          const relativePath = relative(basePath, fullPath);

          if (pattern && !pattern.test(item.name)) continue;

          if (item.isDirectory()) {
            entries.push({ name: item.name, path: relativePath, type: 'directory' });
            if (recursive) {
              await walk(fullPath);
            }
          } else if (item.isFile()) {
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
        await walk(basePath);
        return { entries, count: entries.length };
      } catch (error) {
        throw new Error(`Failed to list directory "${basePath}": ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}


/** 获取内置工具（零依赖，所有环境可用） */
export function getBuiltinTools(options?: {
  summary?: import('../../capabilities/summary/index.js').ToolSummarySupport;
}): RegisteredTool[] {
  return [
    createShellTool(),
    createFileReadTool({ summary: options?.summary }),
    createFileWriteTool(),
    createFileListTool(),
    createFileEditTool(),
    createFileSearchTool(),
    createHttpRequestTool({ summary: options?.summary }),
    createEnvInfoTool(),
  ];
}
