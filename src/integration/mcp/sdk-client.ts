/**
 * MCP SDK Client 包装器
 *
 * 将 @modelcontextprotocol/sdk 的 Client 包装为 Octopi 的 McpClient 接口。
 * 这是 Integration 层的适配器，隔离外部 SDK 依赖。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type {
  McpClient,
  McpServerConfig,
  McpServerCapabilities,
  McpToolDefinition,
  McpToolResult,
  McpResourceDefinition,
  McpPromptDefinition,
} from '../../core/interfaces/mcp-client.js';

/**
 * 基于 MCP SDK 的 McpClient 实现
 */
export class SdkMcpClient implements McpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  private _connected = false;
  private _serverInfo: { name: string; version: string } | undefined;

  constructor(private config: McpServerConfig) {}

  get connected(): boolean {
    return this._connected;
  }

  get serverInfo(): { name: string; version: string } | undefined {
    return this._serverInfo;
  }

  async connect(): Promise<McpServerCapabilities> {
    if (this._connected) {
      throw new Error('Client already connected');
    }

    // 创建 transport
    this.transport = this.createTransport();

    // 创建 client
    this.client = new Client(
      { name: 'octopi', version: '0.4.0' },
      { capabilities: {} },
    );

    // 连接（SDK 自动完成 initialize 握手）
    await this.client.connect(this.transport);
    this._connected = true;

    // 获取 server 信息
    const serverVersion = this.client.getServerVersion();
    if (serverVersion) {
      this._serverInfo = { name: serverVersion.name, version: serverVersion.version };
    }

    // 获取 server 能力
    const caps = this.client.getServerCapabilities();
    return {
      tools: caps?.tools ? { listChanged: caps.tools.listChanged } : undefined,
      resources: caps?.resources
        ? { subscribe: caps.resources.subscribe, listChanged: caps.resources.listChanged }
        : undefined,
      prompts: caps?.prompts ? { listChanged: caps.prompts.listChanged } : undefined,
      logging: caps?.logging as Record<string, unknown> | undefined,
    };
  }

  async listTools(): Promise<McpToolDefinition[]> {
    this.assertConnected();
    const { tools } = await this.client!.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as McpToolDefinition['inputSchema'],
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this.assertConnected();
    const result = await this.client!.callTool({ name, arguments: args });

    // MCP SDK 可能返回两种格式：
    // 1. 标准格式: { content: [...], isError?: boolean }
    // 2. 兼容格式: { toolResult: unknown }
    if ('content' in result && Array.isArray(result.content)) {
      return {
        content: result.content as McpToolResult['content'],
        isError: result.isError as boolean | undefined,
      };
    }

    // 兼容格式：将 toolResult 包装为 content
    if ('toolResult' in result) {
      const toolResult = result.toolResult;
      if (typeof toolResult === 'string') {
        return { content: [{ type: 'text', text: toolResult }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(toolResult) }] };
    }

    // 空结果
    return { content: [] };
  }

  async listResources(): Promise<McpResourceDefinition[]> {
    this.assertConnected();
    const { resources } = await this.client!.listResources();
    return resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  async readResource(uri: string): Promise<unknown> {
    this.assertConnected();
    const { contents } = await this.client!.readResource({ uri });
    return contents;
  }

  async listPrompts(): Promise<McpPromptDefinition[]> {
    this.assertConnected();
    const { prompts } = await this.client!.listPrompts();
    return prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments as McpPromptDefinition['arguments'],
    }));
  }

  async getPrompt(name: string, args?: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const result = await this.client!.getPrompt({ name, arguments: args as Record<string, string> | undefined });
    return result;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    this.transport = null;
    this._connected = false;
    this._serverInfo = undefined;
  }

  // ── 内部方法 ──

  private createTransport(): StdioClientTransport | StreamableHTTPClientTransport {
    const config = this.config;
    switch (config.transport) {
      case 'stdio':
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
        });
      case 'http':
        return new StreamableHTTPClientTransport(
          new URL(config.url),
          {
            requestInit: config.headers
              ? { headers: config.headers }
              : undefined,
          },
        );
    }
  }

  private assertConnected(): void {
    if (!this._connected || !this.client) {
      throw new Error(`MCP Client "${this.config.id}" not connected. Call connect() first.`);
    }
  }
}

/**
 * 默认 McpClient 工厂
 *
 * 根据配置创建 SdkMcpClient 实例。
 */
export function createSdkMcpClient(config: McpServerConfig): McpClient {
  return new SdkMcpClient(config);
}
