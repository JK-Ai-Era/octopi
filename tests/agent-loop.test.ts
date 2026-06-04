/**
 * Octopi 核心测试
 *
 * 覆盖所有核心模块：
 * - ToolRegistry: 工具注册、获取、执行
 * - LLMRouter: Provider 注册、模型列表
 * - PluginManager: Hook 注册、拦截语义
 * - AgentRunner: 端到端消息处理、工具调用循环
 * - Gateway: 创建和注册
 */

import { describe, test, expect } from 'vitest';
import { AgentRunner } from '../src/agent/agent-runner.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { LLMRouter } from '../src/providers/router.js';
import { PluginManager } from '../src/plugins/manager.js';
import { PluginApi } from '../src/plugins/api.js';
import { Gateway } from '../src/gateway/gateway.js';
import type {
  AgentDefinition,
  ChannelMessage,
  LLMProvider,
  RegisteredTool,
} from '../src/core/types.js';

// ============================================================
// 测试用 Mock
// ============================================================

function createMockAgent(): AgentDefinition {
  return {
    id: 'test-agent',
    workspace: '/tmp/test-workspace',
    persona: {
      name: 'Test Bot',
      description: 'A test bot',
      systemPrompt: 'You are a test assistant.',
    },
    tools: { allow: ['*'] },
    model: {
      provider: 'mock',
      model: 'mock-gpt-4o',
      temperature: 0.7,
    },
  };
}

function createMockLLMProvider(): LLMProvider {
  return {
    name: 'mock',
    models: ['mock-gpt-4o'],
    async complete(request) {
      const lastMsg = request.messages[request.messages.length - 1];
      const content = `Echo: ${lastMsg?.content ?? 'empty'}`;
      return {
        content,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'mock-gpt-4o',
        finishReason: 'stop',
      };
    },
  };
}

function createMockToolLLMProvider(toolName: string, toolArgs: Record<string, unknown>): LLMProvider {
  let callCount = 0;
  return {
    name: 'mock',
    models: ['mock-gpt-4o'],
    async complete(request) {
      callCount++;
      if (callCount === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call-1', name: toolName, arguments: toolArgs }],
          model: 'mock-gpt-4o',
          finishReason: 'tool_calls',
        };
      }
      return {
        content: 'Tool executed successfully',
        model: 'mock-gpt-4o',
        finishReason: 'stop',
      };
    },
  };
}

function createMockChannelMessage(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    id: `msg-${Date.now()}`,
    channel: 'test',
    senderId: 'user-1',
    senderName: 'Test User',
    content: 'Hello, Agent!',
    conversationId: 'conv-1',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================
// ToolRegistry 测试
// ============================================================

describe('ToolRegistry', () => {
  test('注册和获取工具', () => {
    const registry = new ToolRegistry();
    const tool: RegisteredTool = {
      definition: {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          input: { type: 'string', description: 'Input', required: true },
        },
      },
      handler: async (args) => `result: ${args.input}`,
    };

    registry.register(tool);
    expect(registry.get('test_tool')).toBeDefined();
    expect(registry.get('test_tool')!.definition.name).toBe('test_tool');
  });

  test('注册重复工具抛出错误', () => {
    const registry = new ToolRegistry();
    const tool: RegisteredTool = {
      definition: { name: 'dup_tool', description: 'Duplicate', parameters: {} },
      handler: async () => null,
    };

    registry.register(tool);
    expect(() => registry.register(tool)).toThrow('already registered');
  });

  test('Agent 级工具覆盖全局工具', () => {
    const registry = new ToolRegistry();

    registry.register({
      definition: { name: 'shared', description: 'Global', parameters: {} },
      handler: async () => 'global',
    });

    registry.register({
      definition: { name: 'shared', description: 'Agent-specific', parameters: {} },
      handler: async () => 'agent',
    }, 'agent-1');

    expect(registry.get('shared')!.definition.description).toBe('Global');
    expect(registry.get('shared', 'agent-1')!.definition.description).toBe('Agent-specific');
  });

  test('execute 工具', async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: 'greet',
        description: 'Greet',
        parameters: { name: { type: 'string', description: 'Name', required: true } },
      },
      handler: async (args) => `Hello, ${args.name}!`,
    });

    const result = await registry.execute(
      'greet',
      { name: 'World' },
      { sessionId: 's1', agentId: 'a1', messages: [] },
    );

    expect(result).toBe('Hello, World!');
  });

  test('缺少必填参数抛出错误', async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: 'strict',
        description: 'Strict tool',
        parameters: { required_param: { type: 'string', description: 'Required', required: true } },
      },
      handler: async () => null,
    });

    await expect(
      registry.execute('strict', {}, { sessionId: 's1', agentId: 'a1', messages: [] }),
    ).rejects.toThrow('missing required parameter');
  });

  test('getDefinitionsForLLM 转换为 OpenAI 格式', () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: 'search',
        description: 'Search the web',
        parameters: {
          query: { type: 'string', description: 'Search query', required: true },
          limit: { type: 'number', description: 'Max results' },
        },
      },
      handler: async () => null,
    });

    const defs = registry.getDefinitionsForLLM('agent-1');
    expect(defs).toHaveLength(1);
    expect((defs[0] as any).type).toBe('function');
    expect((defs[0] as any).function.name).toBe('search');
    expect((defs[0] as any).function.parameters.required).toEqual(['query']);
  });
});

// ============================================================
// LLMRouter 测试
// ============================================================

describe('LLMRouter', () => {
  test('注册和获取 provider', () => {
    const router = new LLMRouter();
    const provider = createMockLLMProvider();
    router.register(provider);

    expect(router.getProvider('mock')).toBe(provider);
    expect(router.getProvider('nonexistent')).toBeUndefined();
  });

  test('列出所有模型', () => {
    const router = new LLMRouter();
    router.register(createMockLLMProvider());

    expect(router.listModels()).toEqual(['mock-gpt-4o']);
  });

  test('列出所有 provider', () => {
    const router = new LLMRouter();
    router.register(createMockLLMProvider());

    expect(router.listProviders()).toEqual(['mock']);
  });
});

// ============================================================
// PluginManager 测试
// ============================================================

describe('PluginManager', () => {
  test('创建和获取 plugins', () => {
    const pm = new PluginManager({ loadPaths: [] });
    expect(pm.getAllPlugins()).toHaveLength(0);
    expect(pm.getRegisteredIds()).toHaveLength(0);
  });

  test('runHook 默认结果', async () => {
    const pm = new PluginManager({ loadPaths: [] });

    const result = await pm.runHook(
      'before_agent_reply',
      { sessionId: 's1', agentId: 'a1', messages: [] },
      null,
    );

    expect(result).toBeNull();
  });

  test('runAllHooks 不抛错（空 plugins）', async () => {
    const pm = new PluginManager({ loadPaths: [] });

    await expect(
      pm.runAllHooks('session_start', { sessionId: 's1', agentId: 'a1' }),
    ).resolves.toBeUndefined();
  });
});

// ============================================================
// AgentRunner 集成测试
// ============================================================

describe('AgentRunner', () => {
  test('端到端消息处理', async () => {
    const agent = createMockAgent();
    const loop = new AgentRunner();

    loop.registerProvider(createMockLLMProvider());

    const session = loop.resolveSession(agent, createMockChannelMessage(), 'main');
    const reply = await loop.processMessage(agent, session, createMockChannelMessage());

    expect(reply.role).toBe('assistant');
    expect(reply.content).toContain('Echo:');
    expect(reply.timestamp).toBeGreaterThan(0);

    await loop.close();
  });

  test('工具调用循环', async () => {
    const agent = createMockAgent();
    const loop = new AgentRunner();

    loop.registerProvider(createMockToolLLMProvider('greet', { name: 'World' }));

    loop.registerTool({
      definition: {
        name: 'greet',
        description: 'Greet someone',
        parameters: {
          name: { type: 'string', description: 'Name', required: true },
        },
      },
      handler: async (args) => `Hello, ${args.name}!`,
    });

    const session = loop.resolveSession(agent, createMockChannelMessage(), 'main');
    const reply = await loop.processMessage(agent, session, createMockChannelMessage());

    expect(reply.role).toBe('assistant');
    expect(reply.content).toBe('Tool executed successfully');

    const messages = loop.getSessionManager().getMessages(session.id) as any[];
    const toolMessages = messages.filter((m: any) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);

    await loop.close();
  });

  test('session write lock 保证串行', async () => {
    const loop = new AgentRunner();

    const lock1 = await loop.getSessionManager().acquireLock('test-session');
    let lock2Resolved = false;

    const lock2Promise = loop.getSessionManager().acquireLock('test-session').then(() => {
      lock2Resolved = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(lock2Resolved).toBe(false);

    lock1();

    await lock2Promise;
    expect(lock2Resolved).toBe(true);

    await loop.close();
  });

  test('session 路由（per-peer）', async () => {
    const agent = createMockAgent();
    const loop = new AgentRunner();

    const msg1 = createMockChannelMessage({ senderId: 'user-a' });
    const msg2 = createMockChannelMessage({ senderId: 'user-b' });

    const session1 = loop.resolveSession(agent, msg1, 'per-peer');
    const session2 = loop.resolveSession(agent, msg2, 'per-peer');
    const session1Again = loop.resolveSession(agent, msg1, 'per-peer');

    expect(session1.id).not.toBe(session2.id);
    expect(session1.id).toBe(session1Again.id);

    await loop.close();
  });
});

// ============================================================
// Gateway 测试
// ============================================================

describe('Gateway', () => {
  test('创建和注册', async () => {
    const agent = createMockAgent();
    const gateway = new Gateway({
      agents: [agent],
    });

    gateway.registerProvider(createMockLLMProvider());

    expect(gateway.getSession('nonexistent')).toBeUndefined();
  });
});
