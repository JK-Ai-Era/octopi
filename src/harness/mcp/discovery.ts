/**
 * MCP Server 目录自动发现
 *
 * 从约定目录自动扫描 MCP Server 配置文件。
 * 每个 JSON 文件定义一个 MCP Server。
 *
 * 文件格式：
 * ```json
 * {
 *   "id": "filesystem",
 *   "transport": "stdio",
 *   "command": "npx",
 *   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
 * }
 * ```
 *
 * 使用方式：
 * ```ts
 * import { loadMcpServersFromDir } from './mcp/discovery.js';
 *
 * const configs = await loadMcpServersFromDir('~/.octopi/mcp-servers');
 * for (const config of configs) {
 *   await manager.connectServer(config);
 * }
 * ```
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { McpServerConfig } from '../../core/interfaces/mcp-client.js';

/** 默认 MCP Server 配置目录 */
export const DEFAULT_MCP_SERVERS_DIR = resolve(homedir(), '.octopi', 'mcp-servers');

/**
 * 从目录中加载所有 MCP Server 配置
 *
 * 扫描目录下的所有 `.json` 文件，解析为 McpServerConfig。
 * 跳过无效文件并打印警告。
 *
 * @param dir - 配置目录路径（默认 ~/.octopi/mcp-servers/）
 * @returns 有效的 MCP Server 配置列表
 */
export async function loadMcpServersFromDir(
  dir: string = DEFAULT_MCP_SERVERS_DIR,
): Promise<McpServerConfig[]> {
  const configs: McpServerConfig[] = [];

  let files: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name);
  } catch (err: unknown) {
    // 目录不存在：返回空列表，不报错
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  for (const file of files.sort()) {
    const filePath = join(dir, file);
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const config = validateMcpServerConfig(parsed);
      if (config) {
        configs.push(config);
      } else {
        console.warn(`[MCP Discovery] Skipping invalid config: ${filePath}`);
      }
    } catch (err) {
      console.warn(`[MCP Discovery] Failed to load ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return configs;
}

/**
 * 校验 MCP Server 配置
 *
 * @returns 有效的 McpServerConfig 或 null
 */
function validateMcpServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  // 必须有 id 和 transport
  if (typeof obj.id !== 'string' || !obj.id) return null;
  if (obj.transport !== 'stdio' && obj.transport !== 'http') return null;

  // stdio 必须有 command
  if (obj.transport === 'stdio' && typeof obj.command !== 'string') return null;

  // http 必须有 url
  if (obj.transport === 'http' && typeof obj.url !== 'string') return null;

  const config: McpServerConfig = {
    id: obj.id,
    transport: obj.transport,
  };

  if (typeof obj.command === 'string') config.command = obj.command;
  if (Array.isArray(obj.args)) config.args = obj.args.filter((a): a is string => typeof a === 'string');
  if (obj.env && typeof obj.env === 'object') config.env = obj.env as Record<string, string>;
  if (typeof obj.cwd === 'string') config.cwd = obj.cwd;
  if (typeof obj.url === 'string') config.url = obj.url;
  if (obj.headers && typeof obj.headers === 'object') config.headers = obj.headers as Record<string, string>;

  return config;
}
