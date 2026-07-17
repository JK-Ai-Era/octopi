/**
 * MCP Manager — 管理 MCP Server 连接和工具注册
 *
 * 职责：
 * - 连接/断开 MCP Server
 * - 自动发现 MCP 工具并注册到 ToolRegistry
 * - 断开时自动注销工具
 * - 提供工具名称命名空间管理
 *
 * 设计原则：
 * - 每个 MCP Server 的工具以 `{serverId}__{toolName}` 格式注册
 * - 避免不同 Server 的同名工具冲突
 * - 连接失败不影响已有的其他连接
 * - 通过回调注入 ToolRegistry 操作，遵循依赖倒置
 */

import type {
  McpServerConfig,
  McpToolDefinition,
  McpClient,
  McpServerCapabilities,
} from '../../core/interfaces/mcp-client.js';
import type { RegisteredTool, ToolExecutionContext } from '../../core/types.js';
import { mcpToolToOctopiDefinition, extractMcpToolResult, splitNamespacedToolName } from './bridge.js';

/**
 * MCP Manager 依赖注入接口
 *
 * McpManager 不直接依赖 ToolRegistry，通过回调注册/注销工具。
 * 遵循 Harness 层规则：子模块不直接 import 兄弟模块。
 */
export interface McpManagerCallbacks {
  /** 注册工具到 ToolRegistry */
  registerTool: (tool: RegisteredTool) => void;
  /** 从 ToolRegistry 注销工具 */
  unregisterTool: (name: string) => boolean;
  /** 从 ToolRegistry 获取工具 */
  getTool: (name: string) => RegisteredTool | undefined;
}

/** 已连接的 MCP Server 信息 */
interface ConnectedServer {
  client: McpClient;
  /** 该 Server 注册的命名空间工具名列表 */
  registeredTools: string[];
  capabilities: McpServerCapabilities;
}

/**
 * McpManager 实现
 *
 * 使用方式：
 * ```ts
 * const manager = new DefaultMcpManager(
 *   {
 *     registerTool: (t) => toolRegistry.register(t),
 *     unregisterTool: (n) => toolRegistry.unregister(n),
 *     getTool: (n) => toolRegistry.get(n),
 *   },
 *   createSdkMcpClient,
 * );
 * await manager.connectServer({
 *   id: 'filesystem',
 *   transport: 'stdio',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],
 * });
 * // 现在 ToolRegistry 中有 filesystem__read_file 等工具
 * ```
 */
export class DefaultMcpManager {
  private servers = new Map<string, ConnectedServer>();

  constructor(
    private callbacks: McpManagerCallbacks,
    private clientFactory: McpClientFactory,
  ) {}

  async connectServer(config: McpServerConfig): Promise<void> {
    if (this.servers.has(config.id)) {
      throw new Error(`MCP Server "${config.id}" already connected. Disconnect first.`);
    }

    const client = this.clientFactory(config);
    let capabilities: McpServerCapabilities;

    try {
      capabilities = await client.connect();
    } catch (err) {
      await client.close().catch(() => {});
      throw new Error(`Failed to connect MCP Server "${config.id}": ${err instanceof Error ? err.message : String(err)}`);
    }

    const registeredTools: string[] = [];

    // 发现并注册工具
    if (capabilities.tools) {
      const tools = await client.listTools();
      for (const mcpTool of tools) {
        const toolName = this.registerMcpTool(config.id, mcpTool, client);
        registeredTools.push(toolName);
      }
    }

    this.servers.set(config.id, { client, registeredTools, capabilities });
  }

  async disconnectServer(id: string): Promise<void> {
    const server = this.servers.get(id);
    if (!server) return;

    // 注销所有工具
    for (const toolName of server.registeredTools) {
      this.callbacks.unregisterTool(toolName);
    }

    await server.client.close().catch(() => {});
    this.servers.delete(id);
  }

  listServers(): string[] {
    return Array.from(this.servers.keys());
  }

  listServerTools(id: string): McpToolDefinition[] {
    const server = this.servers.get(id);
    if (!server) return [];

    // 从注册的工具名反推 MCP 工具信息
    const result: McpToolDefinition[] = [];
    for (const namespaced of server.registeredTools) {
      const split = splitNamespacedToolName(namespaced);
      if (!split) continue;
      const tool = this.callbacks.getTool(namespaced);
      if (!tool) continue;
      result.push({
        name: split.toolName,
        description: tool.definition.description,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(tool.definition.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }]),
          ),
          required: Object.entries(tool.definition.parameters)
            .filter(([, v]) => v.required)
            .map(([k]) => k),
        },
      });
    }
    return result;
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.servers.keys());
    await Promise.all(ids.map((id) => this.disconnectServer(id)));
  }

  /** 获取已连接 Server 的客户端（用于高级操作如读取资源） */
  getClient(id: string): McpClient | undefined {
    return this.servers.get(id)?.client;
  }

  // ── 内部方法 ──

  private registerMcpTool(serverId: string, mcpTool: McpToolDefinition, client: McpClient): string {
    const definition = mcpToolToOctopiDefinition(mcpTool, serverId);
    const toolName = definition.name;

    const registeredTool: RegisteredTool = {
      definition,
      handler: async (args: Record<string, unknown>, _ctx: ToolExecutionContext) => {
        // 超时控制：MCP Server 可能卡住，不能拖垮主循环
        const timeoutMs = definition.timeoutMs ?? 30_000;
        const result = await Promise.race([
          client.callTool(mcpTool.name, args),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`MCP tool "${mcpTool.name}" timed out after ${timeoutMs}ms`)), timeoutMs)
          ),
        ]);
        if (result.isError) {
          const errorText = result.content
            .filter((c) => c.type === 'text')
            .map((c) => (c as { type: 'text'; text: string }).text)
            .join('\n');
          throw new Error(`MCP tool "${mcpTool.name}" error: ${errorText}`);
        }
        return extractMcpToolResult(result);
      },
    };

    this.callbacks.registerTool(registeredTool);
    return toolName;
  }
}

/**
 * MCP Client 工厂函数类型
 *
 * 根据配置创建 McpClient 实例。
 * Harness 层不直接依赖 MCP SDK，通过工厂注入。
 */
export type McpClientFactory = (config: McpServerConfig) => McpClient;
