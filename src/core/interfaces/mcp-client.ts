/**
 * MCP Client 接口
 *
 * 职责：连接外部 MCP Server，发现并调用其提供的工具/资源。
 * 实现方：基于 @modelcontextprotocol/sdk 的具体实现。
 *
 * 设计原则：
 * - Core 层只定义接口，不依赖 MCP SDK
 * - Harness 层实现桥接逻辑（MCP 工具 → Octopi ToolRegistry）
 * - Integration 层实现传输层（stdio、HTTP）
 */

// ── MCP Server 配置 ──

/** stdio 传输配置 */
export interface McpStdioConfig {
  id: string;
  transport: 'stdio';
  /** 可执行命令（必填） */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** HTTP 传输配置 */
export interface McpHttpConfig {
  id: string;
  transport: 'http';
  /** Server URL（必填） */
  url: string;
  headers?: Record<string, string>;
}

/** MCP Server 连接配置（判别联合） */
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

// ── MCP 原语类型 ──

/** MCP 工具定义（来自 MCP Server） */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** MCP 工具调用结果 */
export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/** MCP 内容块 */
export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text?: string; blob?: string; mimeType?: string } };

/** MCP 资源定义 */
export interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** MCP Prompt 定义 */
export interface McpPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

// ── MCP Server 能力 ──

/** MCP Server 能力声明 */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
}

// ── MCP Client 接口 ──

/**
 * MCP Client 接口
 *
 * 连接外部 MCP Server，发现并调用其工具/资源。
 * 每个 McpClient 实例对应一个 MCP Server 连接。
 */
export interface McpClient {
  /** 连接到 MCP Server 并完成能力协商 */
  connect(): Promise<McpServerCapabilities>;

  /** 列出 Server 提供的所有工具 */
  listTools(): Promise<McpToolDefinition[]>;

  /** 调用 Server 上的工具 */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;

  /** 列出 Server 提供的所有资源 */
  listResources(): Promise<McpResourceDefinition[]>;

  /** 读取指定资源 */
  readResource(uri: string): Promise<unknown>;

  /** 列出 Server 提供的所有 Prompts */
  listPrompts(): Promise<McpPromptDefinition[]>;

  /** 获取指定 Prompt */
  getPrompt(name: string, args?: Record<string, unknown>): Promise<unknown>;

  /** 断开连接 */
  close(): Promise<void>;

  /** 连接状态 */
  readonly connected: boolean;

  /** Server 信息（连接后可用） */
  readonly serverInfo?: { name: string; version: string };
}

// ── MCP Manager 接口 ──

/**
 * MCP Manager 接口
 *
 * 管理多个 MCP Server 连接，自动将 MCP 工具注册到 ToolRegistry。
 */
export interface McpManager {
  /** 连接 MCP Server 并注册其工具 */
  connectServer(config: McpServerConfig): Promise<void>;

  /** 断开 MCP Server 并注销其工具 */
  disconnectServer(id: string): Promise<void>;

  /** 列出所有已连接的 MCP Server ID */
  listServers(): string[];

  /** 获取指定 Server 的工具列表 */
  listServerTools(id: string): McpToolDefinition[];

  /** 断开所有连接 */
  disconnectAll(): Promise<void>;

  /** 获取已连接 Server 的底层客户端（用于读取资源等高级操作） */
  getClient(id: string): McpClient | undefined;
}
