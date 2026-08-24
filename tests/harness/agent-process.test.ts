/**
 * AgentProcess 测试 — Announce + Context Fork
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentProcess, spawnAgentProcess, forkAgentProcess, AgentProcessEvents } from '../../src/harness/multi-agent/process.js';
import { DefaultEventBus } from '../../src/core/event-bus.js';
import { Agent } from '../../src/core/loop/agent.js';
import type { ReliabilityHarness } from '../../src/harness/reliability/run-agent.js';
import type { AgentInfo } from '../../src/core/interfaces/agent-registry.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../../src/core/interfaces/model-provider.js';
import type { Message } from '../../src/core/types.js';

// ── Mock 工厂 ──

function createMockModelProvider(response?: string): ModelProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: response ?? 'Task completed.',
      model: 'mock-model',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
    stream: async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { type: 'content' as const, content: response ?? 'Task completed.' };
      yield { type: 'done' as const };
    },
    isAvailable: async () => true,
    getModelInfo: () => null,
    getModelInfo: () => null,
  };
}

function createMockAgent(response?: string): { agent: Agent; harness: ReliabilityHarness } {
  const agent = new Agent({
    model: createMockModelProvider(response),
    systemPrompt: '',
  });
  const harness: ReliabilityHarness = {
    config: {
      planningRetry: { maxAttempts: 0, steerInstruction: '' },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
    },
  };
  return { agent, harness };
}

function createAgentInfo(overrides?: Partial<AgentInfo>): AgentInfo {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    capabilities: ['coding'],
    status: 'active',
    registeredAt: Date.now(),
    lastActiveAt: Date.now(),
    ...overrides,
  };
}

const testMessages: Message[] = [
  { role: 'user', content: 'Hello', timestamp: Date.now() },
];

// ── 测试 ──

describe('AgentProcess', () => {
  let events: DefaultEventBus;

  beforeEach(() => {
    events = new DefaultEventBus();
  });

  // ── 生命周期 ──

  describe('lifecycle', () => {
    it('should start in pending state', () => {
      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        ...createMockAgent(),
        events,
        systemPrompt: 'test',
      });

      expect(process.state).toBe('pending');
    });

    it('should transition to running on start', () => {
      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        ...createMockAgent(),
        events,
        systemPrompt: 'test',
      });

      process.start(testMessages);
      expect(process.state).toBe('running');
    });

    it('should transition to completed after run', async () => {
      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        ...createMockAgent('Done!'),
        events,
        systemPrompt: 'test',
      });

      process.start(testMessages);
      await process.waitForCompletion();

      expect(process.state).toBe('completed');
      expect(process.result?.content).toBe('Done!');
    });

    it('should not allow double start', () => {
      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        ...createMockAgent(),
        events,
        systemPrompt: 'test',
      });

      process.start(testMessages);
      expect(() => process.start(testMessages)).toThrow('already started');
    });
  });

  // ── Announce（推送式完成） ──

  describe('announce', () => {
    it('should emit COMPLETED event on success', async () => {
      const handler = vi.fn();
      events.on(AgentProcessEvents.COMPLETED, handler);

      const process = new AgentProcess({
        agentInfo: createAgentInfo({ id: 'worker-1', name: 'Worker' }),
        ...createMockAgent('Result!'),
        events,
        systemPrompt: 'test',
      });

      process.start(testMessages);
      await process.waitForCompletion();

      expect(handler).toHaveBeenCalledOnce();
      const announce = handler.mock.calls[0][0].data.announce;
      expect(announce.state).toBe('completed');
      expect(announce.processId).toBe(process.id);
      expect(announce.agentInfo.id).toBe('worker-1');
      expect(announce.result?.content).toBe('Result!');
    });

    it('should emit FAILED event on error', async () => {
      const handler = vi.fn();
      events.on(AgentProcessEvents.FAILED, handler);

      // Mock model 让 stream 抛错
      const errorModel: ModelProvider = {
        name: 'error-mock',
        chat: vi.fn().mockRejectedValue(new Error('LLM error')),
        stream: async function* () {
          throw new Error('LLM error');
        },
        isAvailable: async () => true,
        getModelInfo: () => null,
      };
      const { agent, harness } = createMockAgent();
      agent.setModel(errorModel);

      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        agent,
        harness,
        events,
        systemPrompt: 'test',
      });

      process.start(testMessages);
      await process.waitForCompletion();

      expect(process.state).toBe('failed');
      expect(process.error).toContain('LLM error');
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should emit STARTED event', () => {
      const handler = vi.fn();
      events.on(AgentProcessEvents.STARTED, handler);

      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        ...createMockAgent(),
        events,
        systemPrompt: 'test',
      });

      process.start(testMessages);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].data.processId).toBe(process.id);
    });

    it('waitForCompletion should resolve immediately if already completed', async () => {
      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        ...createMockAgent('Done'),
        events,
        systemPrompt: 'test',
      });

      process.start(testMessages);
      await process.waitForCompletion();

      // 第二次等待应该立即 resolve
      const announce = await process.waitForCompletion();
      expect(announce.state).toBe('completed');
    });
  });

  // ── Context Fork ──

  describe('context fork', () => {
    it('should prepend parent messages when forkContext is true', async () => {
      const modelProvider = createMockModelProvider('Forked result');
      const chatSpy = vi.spyOn(modelProvider, 'stream');

      const { agent, harness } = createMockAgent();
      agent.setModel(modelProvider);

      const parentMessages: Message[] = [
        { role: 'user', content: 'Parent question', timestamp: Date.now() },
        { role: 'assistant', content: 'Parent answer', timestamp: Date.now() },
      ];

      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        agent,
        harness,
        events,
        systemPrompt: 'test',
        forkContext: true,
      });

      process.start([{ role: 'user', content: 'Child task', timestamp: Date.now() }], parentMessages);
      await process.waitForCompletion();

      // 验证 stream 被调用
      expect(chatSpy).toHaveBeenCalled();
      // 验证传递的消息包含父消息
      const callArgs = chatSpy.mock.calls[0][0];
      const messages = callArgs.messages;
      expect(messages.length).toBeGreaterThanOrEqual(2); // 至少有 parent + child
    });

    it('should NOT prepend parent messages when forkContext is false', async () => {
      const modelProvider = createMockModelProvider('No fork');
      const chatSpy = vi.spyOn(modelProvider, 'stream');

      const { agent, harness } = createMockAgent();
      agent.setModel(modelProvider);

      const parentMessages: Message[] = [
        { role: 'user', content: 'Parent question', timestamp: Date.now() },
      ];

      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        agent,
        harness,
        events,
        systemPrompt: 'test',
        forkContext: false,
      });

      process.start([{ role: 'user', content: 'Child task', timestamp: Date.now() }], parentMessages);
      await process.waitForCompletion();

      const callArgs = (modelProvider.stream as any).mock.calls[0][0];
      const messageContents = callArgs.messages.map((m: any) =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      );

      expect(messageContents).not.toContain('Parent question');
      expect(messageContents).toContain('Child task');
    });
  });

  // ── Abort ──

  describe('abort', () => {
    it('should abort a running process', async () => {
      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        ...createMockAgent(),
        events,
        systemPrompt: 'test',
      });

      process.start(testMessages);
      expect(process.state).toBe('running');

      process.abort();
      expect(process.state).toBe('aborted');
    });

    it('should emit ABORTED event', () => {
      const handler = vi.fn();
      events.on(AgentProcessEvents.ABORTED, handler);

      const process = new AgentProcess({
        agentInfo: createAgentInfo(),
        ...createMockAgent(),
        events,
        systemPrompt: 'test',
      });

      process.start(testMessages);
      process.abort();

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ── 工厂函数 ──

  describe('factory functions', () => {
    it('spawnAgentProcess should create and start process', async () => {
      const process = spawnAgentProcess(
        {
          agentInfo: createAgentInfo(),
          ...createMockAgent('Spawned!'),
          events,
          systemPrompt: 'test',
        },
        testMessages,
      );

      expect(process.state).toBe('running');
      const announce = await process.waitForCompletion();
      expect(announce.state).toBe('completed');
      expect(announce.result?.content).toBe('Spawned!');
    });

    it('forkAgentProcess should create forked process', async () => {
      const modelProvider = createMockModelProvider('Forked!');
      const chatSpy = vi.spyOn(modelProvider, 'stream');

      const { agent, harness } = createMockAgent();
      agent.setModel(modelProvider);

      const parentMessages: Message[] = [
        { role: 'user', content: 'Parent context', timestamp: Date.now() },
      ];

      const process = forkAgentProcess(
        {
          agentInfo: createAgentInfo(),
          agent,
          harness,
          events,
          systemPrompt: 'test',
        },
        [{ role: 'user', content: 'Fork task', timestamp: Date.now() }],
        parentMessages,
      );

      expect(process.state).toBe('running');
      await process.waitForCompletion();

      // 应该继承了父上下文
      const callArgs = (modelProvider.stream as any).mock.calls[0][0];
      const contents = callArgs.messages.map((m: any) => typeof m.content === 'string' ? m.content : '');
      expect(contents).toContain('Parent context');
    });
  });
});
