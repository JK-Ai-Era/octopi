/**
 * LegacyAgentRunner 集成测试
 *
 * 验证旧 API 在新架构下的兼容性。
 */

import { describe, it, expect, vi } from 'vitest';
import { LegacyAgentRunner } from '../src/harness/compat/legacy-agent-runner.js';
import type {
  AgentDefinition,
  ChannelMessage,
  LLMProvider,
  LLMResponse,
  RegisteredTool,
} from '../src/core/types.js';

// ── Helper ──

function createMockProvider(): LLMProvider {
  return {
    name: 'mock',
    models: ['mock-model'],
    complete: vi.fn().mockResolvedValue({
      content: 'Hello from new architecture!',
      model: 'mock-model',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    } as LLMResponse),
  };
}

function createTestAgent(): AgentDefinition {
  return {
    id: 'test-agent',
    workspace: '/tmp/test',
    persona: {
      name: 'Test Agent',
      description: 'A test agent',
      systemPrompt: 'You are a helpful assistant.',
    },
    tools: { allow: ['*'] },
    model: { provider: 'mock', model: 'mock-model' },
  };
}

function createTestMessage(content: string = '你好'): ChannelMessage {
  return {
    id: 'msg_1',
    channel: 'test',
    senderId: 'user_1',
    senderName: 'Test User',
    content,
    conversationId: 'conv_1',
    timestamp: Date.now(),
  };
}

// ── 测试 ──

describe('LegacyAgentRunner', () => {
  it('应该保留 registerProvider API', () => {
    const runner = new LegacyAgentRunner();
    const provider = createMockProvider();

    // 不应该抛出错误
    runner.registerProvider(provider);
  });

  it('应该保留 registerTool API', () => {
    const runner = new LegacyAgentRunner();
    const tool: RegisteredTool = {
      definition: {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {},
      },
      handler: async () => 'result',
    };

    // 不应该抛出错误
    runner.registerTool(tool);
  });

  it('应该保留 resolveSession API', () => {
    const runner = new LegacyAgentRunner();
    const agent = createTestAgent();
    const msg = createTestMessage();

    const session = runner.resolveSession(agent, msg, 'per-peer');

    expect(session).toBeDefined();
    expect(session.agentId).toBe('test-agent');
    expect(session.peerId).toBe('user_1');
  });

  it('应该保留 addEventListener API', () => {
    const runner = new LegacyAgentRunner();
    const listener = vi.fn();

    // 不应该抛出错误
    runner.addEventListener(listener);
  });

  it('应该通过 processMessage 完成完整对话（委托给新架构）', async () => {
    const runner = new LegacyAgentRunner();
    const provider = createMockProvider();
    runner.registerProvider(provider);

    const agent = createTestAgent();
    const msg = createTestMessage('你好');
    const session = runner.resolveSession(agent, msg, 'per-peer');

    const reply = await runner.processMessage(agent, session, msg);

    expect(reply).toBeDefined();
    expect(reply.role).toBe('assistant');
    expect(reply.content).toBe('Hello from new architecture!');
  });

  it('应该发射事件到注册的 listener', async () => {
    const runner = new LegacyAgentRunner();
    const provider = createMockProvider();
    runner.registerProvider(provider);

    const events: any[] = [];
    runner.addEventListener((event) => { events.push(event); });

    const agent = createTestAgent();
    const msg = createTestMessage('你好');
    const session = runner.resolveSession(agent, msg, 'per-peer');

    await runner.processMessage(agent, session, msg);

    // 应该有事件被发射
    expect(events.length).toBeGreaterThan(0);
  });

  it('应该处理工具调用', async () => {
    const runner = new LegacyAgentRunner();

    // 第一次调用返回工具调用，第二次返回纯文本
    let callCount = 0;
    const provider: LLMProvider = {
      name: 'mock',
      models: ['mock-model'],
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'call_1', name: 'test_tool', arguments: { query: 'test' } }],
            model: 'mock-model',
            finishReason: 'tool_calls',
          };
        }
        return {
          content: 'Tool result processed!',
          model: 'mock-model',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      }),
    };
    runner.registerProvider(provider);

    // 注册工具
    runner.registerTool({
      definition: {
        name: 'test_tool',
        description: 'A test tool',
        parameters: { query: { type: 'string', description: 'query', required: true } },
      },
      handler: async () => 'tool executed successfully',
    });

    const agent = createTestAgent();
    const msg = createTestMessage('使用工具');
    const session = runner.resolveSession(agent, msg, 'per-peer');

    const reply = await runner.processMessage(agent, session, msg);

    expect(reply).toBeDefined();
    expect(reply.role).toBe('assistant');
  });
});
