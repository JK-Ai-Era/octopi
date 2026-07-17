/**
 * MCP ↔ Octopi 格式转换桥
 *
 * 职责：
 * - MCP Tool → Octopi ToolDefinition（用于注册到 ToolRegistry）
 * - MCP Tool Result → Octopi 工具结果（用于返回给 Agent Loop）
 *
 * 设计原则：
 * - 纯函数，无副作用
 * - 命名空间前缀避免工具名冲突
 */

import type {
  McpToolDefinition,
  McpToolResult,
  McpContentBlock,
} from '../../core/interfaces/mcp-client.js';
import type { ToolDefinition, ToolParameter } from '../../core/types.js';

/**
 * 命名空间分隔符
 * MCP 工具注册到 Octopi ToolRegistry 时使用 `{serverId}__{toolName}` 格式
 */
export const MCP_NAMESPACE_SEP = '__';

/**
 * 从命名空间工具名中提取 serverId 和原始工具名
 */
export function splitNamespacedToolName(namespaced: string): {
  serverId: string;
  toolName: string;
} | null {
  const idx = namespaced.indexOf(MCP_NAMESPACE_SEP);
  if (idx <= 0) return null;
  return {
    serverId: namespaced.slice(0, idx),
    toolName: namespaced.slice(idx + MCP_NAMESPACE_SEP.length),
  };
}

/**
 * MCP Tool → Octopi ToolDefinition
 *
 * @param mcpTool - MCP Server 返回的工具定义
 * @param serverId - MCP Server ID（用于命名空间前缀）
 * @returns Octopi ToolDefinition
 */
export function mcpToolToOctopiDefinition(
  mcpTool: McpToolDefinition,
  serverId: string,
): ToolDefinition {
  const params: Record<string, ToolParameter> = {};
  const properties = mcpTool.inputSchema.properties ?? {};
  const required = new Set(mcpTool.inputSchema.required ?? []);

  for (const [key, prop] of Object.entries(properties)) {
    const p = prop as Record<string, unknown>;
    const param: ToolParameter = {
      type: (p.type as ToolParameter['type']) ?? 'string',
      description: (p.description as string) ?? '',
      required: required.has(key),
    };
    if (p.enum) param.enum = p.enum as string[];
    params[key] = param;
  }

  return {
    name: `${serverId}${MCP_NAMESPACE_SEP}${mcpTool.name}`,
    description: mcpTool.description ?? '',
    parameters: params,
  };
}

/**
 * 从 MCP 工具结果中提取文本内容
 *
 * MCP 结果是 content 数组，可能包含多种类型。
 * 大多数情况下 Agent 需要的是文本结果。
 *
 * @returns 单个文本返回 string，多个文本返回 string[]，无文本返回原始 content
 */
export function extractMcpToolResult(result: McpToolResult): unknown {
  const textBlocks = result.content.filter((c): c is McpContentBlock & { type: 'text' } => c.type === 'text');
  const imageBlocks = result.content.filter((c): c is McpContentBlock & { type: 'image' } => c.type === 'image');

  // 只有文本：返回单个字符串或数组
  if (imageBlocks.length === 0) {
    if (textBlocks.length === 1) return textBlocks[0].text;
    if (textBlocks.length > 1) return textBlocks.map((b) => b.text);
  }

  // 混合内容：返回结构化数据（保留原始 base64 数据）
  return result.content.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'image':
        return { type: 'image', mimeType: block.mimeType, data: block.data };
      case 'audio':
        return { type: 'audio', mimeType: block.mimeType, data: block.data };
      case 'resource':
        return { type: 'resource', uri: block.resource.uri, text: block.resource.text ?? '' };
    }
  });
}
