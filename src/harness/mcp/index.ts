/**
 * Harness MCP 模块
 *
 * MCP Client 集成：连接外部 MCP Server，自动注册工具到 ToolRegistry。
 */

export { DefaultMcpManager } from './manager.js';
export type { McpClientFactory, McpManagerCallbacks } from './manager.js';
export {
  mcpToolToOctopiDefinition,
  extractMcpToolResult,
  splitNamespacedToolName,
  MCP_NAMESPACE_SEP,
} from './bridge.js';
