/**
 * MCP Manager 测试 — 连接管理和工具注册
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultMcpManager } from '../../../src/harness/mcp/manager.js';
import type { McpClientFactory, McpManagerCallbacks } from '../../../src/harness/mcp/manager.js';
import type { McpClient, McpServerCapabilities, McpToolDefinition, McpToolResult } from '../../../src/core/interfaces/mcp-client.js';
import type { McpServerConfig } from '../../../src/core/interfaces/mcp-client.js';
import { ToolRegistry } from '../../../src/harness/tools/registry.js';

// ── Mock McpClient ──

function createMockMcpClient(
  tools: McpToolDefinition[] = [],
  capabilities: McpServerCapabilities = { tools: {} },
): McpClient {
  let _connected = false;
  return {
    async connect() {
      _connected = true;
      return capabilities;
    },
    async listTools() {
      return tools;
    },
    async callTool(name: string, _args: Record<string, unknown>): Promise<McpToolResult> {
      return { content: [{ type: 'text', text: `result from ${name}` }] };
    },
    async listResources() { return []; },
    async readResource() { return null; },
    async listPrompts() { return []; },
    async getPrompt() { return null; },
    async close() { _connected = false; },
    get connected() { return _connected; },
    get serverInfo() { return _connected ? { name: 'test-server', version: '1.0.0' } : undefined; },
  };
}

// ── Helpers ──

function createCallbacks(registry: ToolRegistry): McpManagerCallbacks {
  return {
    registerTool: (t) => registry.register(t),
    unregisterTool: (n) => registry.unregister(n),
    getTool: (n) => registry.get(n),
  };
}

// ── Tests ──

describe('DefaultMcpManager', () => {
  let toolRegistry: ToolRegistry;
  let mockClient: McpClient;
  let factory: McpClientFactory;
  let manager: DefaultMcpManager;
  let callbacks: McpManagerCallbacks;

  const defaultConfig: McpServerConfig = {
    id: 'test-server',
    transport: 'stdio',
    command: 'echo',
  };

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    callbacks = createCallbacks(toolRegistry);
    mockClient = createMockMcpClient([
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' } },
          required: ['path'],
        },
      },
      {
        name: 'list_dir',
        description: 'List directory contents',
        inputSchema: {
          type: 'object',
          properties: { dir: { type: 'string', description: 'Directory path' } },
        },
      },
    ]);
    factory = () => mockClient;
    manager = new DefaultMcpManager(callbacks, factory);
  });

  describe('connectServer', () => {
    it('should connect and register tools', async () => {
      await manager.connectServer(defaultConfig);

      expect(manager.listServers()).toEqual(['test-server']);

      const tools = toolRegistry.listForAgent('agent-1');
      const names = tools.map((t) => t.name);
      expect(names).toContain('test-server__read_file');
      expect(names).toContain('test-server__list_dir');
    });

    it('should throw on duplicate connection', async () => {
      await manager.connectServer(defaultConfig);
      await expect(manager.connectServer(defaultConfig)).rejects.toThrow('already connected');
    });

    it('should handle connection failure', async () => {
      const failFactory: McpClientFactory = () => ({
        ...createMockMcpClient(),
        async connect() { throw new Error('Connection refused'); },
      });
      const failManager = new DefaultMcpManager(callbacks, failFactory);

      await expect(failManager.connectServer(defaultConfig)).rejects.toThrow('Failed to connect');
    });

    it('should handle tools without capabilities', async () => {
      const noToolClient = createMockMcpClient([], {});
      const noToolFactory: McpClientFactory = () => noToolClient;
      const noToolManager = new DefaultMcpManager(callbacks, noToolFactory);

      await noToolManager.connectServer(defaultConfig);

      expect(noToolManager.listServers()).toEqual(['test-server']);
      const tools = toolRegistry.listForAgent('agent-1');
      expect(tools).toHaveLength(0);
    });
  });

  describe('disconnectServer', () => {
    it('should disconnect and unregister tools', async () => {
      await manager.connectServer(defaultConfig);
      expect(toolRegistry.listForAgent('agent-1')).toHaveLength(2);

      await manager.disconnectServer('test-server');

      expect(manager.listServers()).toHaveLength(0);
      expect(toolRegistry.listForAgent('agent-1')).toHaveLength(0);
    });

    it('should handle disconnect of non-existent server', async () => {
      await manager.disconnectServer('non-existent');
    });
  });

  describe('callTool through registry', () => {
    it('should call MCP tool through ToolRegistry', async () => {
      await manager.connectServer(defaultConfig);

      const result = await toolRegistry.execute(
        'test-server__read_file',
        { path: '/test.txt' },
        { sessionId: 's1', agentId: 'a1', messages: [] },
      );

      expect(result).toBe('result from read_file');
    });

    it('should propagate MCP tool errors', async () => {
      const errorClient = createMockMcpClient([
        {
          name: 'fail_tool',
          description: 'Always fails',
          inputSchema: { type: 'object' },
        },
      ]);
      errorClient.callTool = async (): Promise<McpToolResult> => ({
        content: [{ type: 'text', text: 'Permission denied' }],
        isError: true,
      });

      const errorFactory: McpClientFactory = () => errorClient;
      const errorManager = new DefaultMcpManager(callbacks, errorFactory);

      await errorManager.connectServer({ ...defaultConfig, id: 'error-server' });

      await expect(
        toolRegistry.execute(
          'error-server__fail_tool',
          {},
          { sessionId: 's1', agentId: 'a1', messages: [] },
        ),
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('listServerTools', () => {
    it('should return tools for connected server', async () => {
      await manager.connectServer(defaultConfig);

      const tools = manager.listServerTools('test-server');
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('read_file');
      expect(tools[1].name).toBe('list_dir');
    });

    it('should return empty for non-existent server', () => {
      expect(manager.listServerTools('non-existent')).toEqual([]);
    });
  });

  describe('disconnectAll', () => {
    it('should disconnect all servers', async () => {
      const client1 = createMockMcpClient([{ name: 'tool1', inputSchema: { type: 'object' } }]);
      const client2 = createMockMcpClient([{ name: 'tool2', inputSchema: { type: 'object' } }]);

      let callCount = 0;
      const multiFactory: McpClientFactory = () => {
        callCount++;
        return callCount === 1 ? client1 : client2;
      };

      const multiManager = new DefaultMcpManager(callbacks, multiFactory);
      await multiManager.connectServer({ id: 'srv1', transport: 'stdio', command: 'echo' });
      await multiManager.connectServer({ id: 'srv2', transport: 'stdio', command: 'echo' });

      expect(multiManager.listServers()).toHaveLength(2);
      expect(toolRegistry.listForAgent('a1')).toHaveLength(2);

      await multiManager.disconnectAll();

      expect(multiManager.listServers()).toHaveLength(0);
      expect(toolRegistry.listForAgent('a1')).toHaveLength(0);
    });
  });

  describe('getClient', () => {
    it('should return client for connected server', async () => {
      await manager.connectServer(defaultConfig);
      const client = manager.getClient('test-server');
      expect(client).toBeDefined();
      expect(client!.connected).toBe(true);
    });

    it('should return undefined for non-existent server', () => {
      expect(manager.getClient('non-existent')).toBeUndefined();
    });
  });

  describe('tool call timeout', () => {
    it('should timeout on slow MCP tool', async () => {
      const slowClient = createMockMcpClient([
        { name: 'slow_tool', description: 'Very slow', inputSchema: { type: 'object' } },
      ]);
      // 设置很短的工具超时
      const origFactory = factory;
      const shortTimeoutFactory: McpClientFactory = (config) => {
        const client = origFactory(config);
        return client;
      };
      // Override callTool to never resolve
      slowClient.callTool = () => new Promise(() => {});

      // 直接注册一个带短超时的工具
      callbacks.registerTool({
        definition: {
          name: 'slow__slow_tool',
          description: 'Very slow',
          parameters: {},
          timeoutMs: 100,
        },
        handler: async () => {
          const result = await Promise.race([
            slowClient.callTool('slow_tool', {}),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('MCP tool "slow_tool" timed out after 100ms')), 100)
            ),
          ]);
          return result;
        },
      });

      await expect(
        toolRegistry.execute(
          'slow__slow_tool',
          {},
          { sessionId: 's1', agentId: 'a1', messages: [] },
        ),
      ).rejects.toThrow('timed out');
    });
  });

  describe('callTool error propagation', () => {
    it('should propagate MCP error content in error message', async () => {
      const errClient = createMockMcpClient([
        { name: 'err_tool', inputSchema: { type: 'object' } },
      ]);
      errClient.callTool = async (): Promise<any> => ({
        content: [
          { type: 'text', text: 'Permission denied' },
          { type: 'text', text: 'File not found' },
        ],
        isError: true,
      });

      const errFactory: McpClientFactory = () => errClient;
      const errManager = new DefaultMcpManager(callbacks, errFactory);
      await errManager.connectServer({ id: 'err', transport: 'stdio', command: 'echo' });

      await expect(
        toolRegistry.execute('err__err_tool', {}, { sessionId: 's1', agentId: 'a1', messages: [] }),
      ).rejects.toThrow('Permission denied\nFile not found');
    });
  });

  describe('listTools failure', () => { 
    it('should fail connection when listTools throws', async () => {
      const failListClient = createMockMcpClient([]);
      failListClient.listTools = async () => { throw new Error('Server crash'); };

      const failFactory: McpClientFactory = () => failListClient;
      const failManager = new DefaultMcpManager(callbacks, failFactory);

      await expect(
        failManager.connectServer({ id: 'crash', transport: 'stdio', command: 'echo' }),
      ).rejects.toThrow('Server crash');

      // 连接不应被记录
      expect(failManager.listServers()).toHaveLength(0);
    });
  });

  describe('multiple servers with same tool names', () => { 
    it('should namespace tools to avoid conflicts', async () => {
      const tools: McpToolDefinition[] = [
        { name: 'search', description: 'Server A search', inputSchema: { type: 'object' } },
      ];

      const sharedFactory: McpClientFactory = () => createMockMcpClient(tools);

      const mgr = new DefaultMcpManager(callbacks, sharedFactory);
      await mgr.connectServer({ id: 'server-a', transport: 'stdio', command: 'echo' });
      await mgr.connectServer({ id: 'server-b', transport: 'stdio', command: 'echo' });

      const allTools = toolRegistry.listForAgent('a1');
      const names = allTools.map((t) => t.name);
      expect(names).toContain('server-a__search');
      expect(names).toContain('server-b__search');
    });
  });
});
