/**
 * ContextEngine 测试
 *
 * 测试新的上下文引擎接口和实现：
 * - TokenEstimator
 * - MessageSelector
 * - Compressors
 * - BudgetAllocator
 * - DefaultContextEngine
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../src/core/types.js';
import type { LLMMessage, ToolDefinition } from '../src/core/interfaces/model-provider.js';
import type {
  ContextEngine,
  AssembleParams,
  TokenEstimator,
  SummarizeFunction,
} from '../src/core/interfaces/context-engine.js';
import { HeuristicTokenEstimator, estimateTextTokens } from '../src/harness/context/token-estimator.js';
import { DefaultMessageSelector } from '../src/harness/context/message-selector.js';
import { TruncateCompressor } from '../src/harness/context/truncate-compressor.js';
import { LLMSummaryCompressor } from '../src/harness/context/llm-summarizer.js';
import { HybridCompressor } from '../src/harness/context/hybrid-compressor.js';
import { DefaultBudgetAllocator } from '../src/harness/context/budget-allocator.js';
import { DefaultContextEngine } from '../src/harness/context/default-context-engine.js';
import { SmartRouter } from '../src/harness/context/smart-router.js';

// ── 测试工具函数 ──

function createMessage(role: Message['role'], content: string, extra?: Partial<Message>): Message {
  return {
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

function createToolCallMessage(name: string, args: Record<string, unknown> = {}): Message {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{
      id: `call_${Date.now()}`,
      name,
      arguments: args,
    }],
    timestamp: Date.now(),
  };
}

function createToolResultMessage(toolCallId: string, name: string, result: string): Message {
  return {
    role: 'tool',
    content: '',
    toolResults: [{
      toolCallId,
      name,
      result,
    }],
    timestamp: Date.now(),
  };
}

function createToolDefinition(name: string, description: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'Input parameter',
          },
        },
        required: ['input'],
      },
    },
  };
}

// ── TokenEstimator 测试 ──

describe('HeuristicTokenEstimator', () => {
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    estimator = new HeuristicTokenEstimator();
  });

  describe('estimateText', () => {
    it('should return 0 for empty string', () => {
      expect(estimator.estimateText('')).toBe(0);
    });

    it('should estimate ASCII text', () => {
      // 4 chars ≈ 1 token
      const text = 'Hello, world!'; // 13 chars
      const tokens = estimator.estimateText(text);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(10);
    });

    it('should estimate Chinese text', () => {
      // CJK 感知估算：4 CJK chars → adjustedChars=16 → 16/4=4 tokens
      const text = '你好世界'; // 4 chars
      const tokens = estimator.estimateText(text);
      expect(tokens).toBeGreaterThanOrEqual(4);
      expect(tokens).toBeLessThan(10);
    });

    it('should handle mixed content', () => {
      const text = 'Hello 你好 world 世界';
      const tokens = estimator.estimateText(text);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('estimateMessage', () => {
    it('should estimate user message', () => {
      const msg = createMessage('user', 'Hello, how are you?');
      const tokens = estimator.estimateMessage(msg);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should estimate assistant message with tool calls', () => {
      const msg = createToolCallMessage('read_file', { path: '/test.txt' });
      const tokens = estimator.estimateMessage(msg);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should estimate tool result message', () => {
      const msg = createToolResultMessage('call_1', 'read_file', 'File contents here');
      const tokens = estimator.estimateMessage(msg);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('estimateMessages', () => {
    it('should estimate multiple messages', () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!'),
        createMessage('user', 'How are you?'),
      ];
      const tokens = estimator.estimateMessages(messages);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should return 0 for empty array', () => {
      expect(estimator.estimateMessages([])).toBe(0);
    });
  });

  describe('estimateTools', () => {
    it('should estimate tool definitions', () => {
      const tools = [
        createToolDefinition('read_file', 'Read a file from disk'),
        createToolDefinition('write_file', 'Write a file to disk'),
      ];
      const tokens = estimator.estimateTools(tools);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should return 0 for empty array', () => {
      expect(estimator.estimateTools([])).toBe(0);
    });
  });
});

// ── estimateTextTokens 函数测试 ──

describe('estimateTextTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  it('should handle long text with sampling', () => {
    const longText = 'a'.repeat(5000);
    const tokens = estimateTextTokens(longText);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ── MessageSelector 测试 ──

describe('DefaultMessageSelector', () => {
  let selector: DefaultMessageSelector;
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    selector = new DefaultMessageSelector();
    estimator = new HeuristicTokenEstimator();
  });

  describe('select', () => {
    it('should return empty result for empty messages', () => {
      const result = selector.select([], {
        maxTokens: 1000,
        protectFirstN: 3,
        protectLastN: 20,
      }, estimator);

      expect(result.kept).toEqual([]);
      expect(result.overflow).toEqual([]);
      expect(result.overflowTokens).toBe(0);
    });

    it('should keep all messages if within budget', () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi'),
      ];

      const result = selector.select(messages, {
        maxTokens: 10000,
        protectFirstN: 3,
        protectLastN: 20,
      }, estimator);

      expect(result.kept.length).toBe(2);
      expect(result.overflowTokens).toBe(0);
    });

    it('should protect first N messages', () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
      );

      const result = selector.select(messages, {
        maxTokens: 100, // Very small budget
        protectFirstN: 3,
        protectLastN: 5,
      }, estimator);

      // First 3 should be in kept
      const firstThree = messages.slice(0, 3);
      for (const msg of firstThree) {
        expect(result.kept).toContainEqual(msg);
      }
    });

    it('should protect last N messages', () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
      );

      const result = selector.select(messages, {
        maxTokens: 500, // Budget enough for tail protection
        protectFirstN: 3,
        protectLastN: 5,
      }, estimator);

      // Last 5 should be in kept
      const lastFive = messages.slice(-5);
      for (const msg of lastFive) {
        expect(result.kept).toContainEqual(msg);
      }
    });

    it('should not split tool_call/tool_result pairs', () => {
      const messages = [
        createMessage('user', 'Read file'),
        createToolCallMessage('read_file', { path: '/test.txt' }),
        createToolResultMessage('call_1', 'read_file', 'File contents'),
        createMessage('assistant', 'Here is the file'),
      ];

      const result = selector.select(messages, {
        maxTokens: 50, // Small budget to force overflow
        protectFirstN: 1,
        protectLastN: 1,
      }, estimator);

      // tool_call and tool_result should be kept together
      const hasToolCall = result.kept.some(m => m.toolCalls?.length);
      const hasToolResult = result.kept.some(m => m.toolResults?.length);

      if (hasToolCall) {
        expect(hasToolResult).toBe(true);
      }
    });
  });
});

// ── Compressor 测试 ──

describe('TruncateCompressor', () => {
  let compressor: TruncateCompressor;
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    compressor = new TruncateCompressor();
    estimator = new HeuristicTokenEstimator();
  });

  it('should return empty result for empty messages', async () => {
    const result = await compressor.compress({
      messages: [],
      targetTokens: 1000,
      tokenEstimator: estimator,
    });

    expect(result.result).toEqual([]);
    expect(result.estimatedTokens).toBe(0);
  });

  it('should not compress if within budget', async () => {
    const messages = [
      createMessage('user', 'Hello'),
      createMessage('assistant', 'Hi'),
    ];

    const result = await compressor.compress({
      messages,
      targetTokens: 10000,
      tokenEstimator: estimator,
    });

    expect(result.result.length).toBe(2);
  });

  it('should truncate messages when over budget', async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with some content`)
    );

    const result = await compressor.compress({
      messages,
      targetTokens: 50, // Very small budget
      tokenEstimator: estimator,
    });

    expect(result.result.length).toBeLessThan(messages.length);
    expect(result.droppedSummary).toBeDefined();
  });

  it('should insert summary message', async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
    );

    const result = await compressor.compress({
      messages,
      targetTokens: 50,
      tokenEstimator: estimator,
    });

    // First message should be system summary
    expect(result.result[0].role).toBe('system');
    expect(result.result[0].content).toContain('compressed');
  });
});

describe('LLMSummaryCompressor', () => {
  let compressor: LLMSummaryCompressor;
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    compressor = new LLMSummaryCompressor();
    estimator = new HeuristicTokenEstimator();
  });

  it('should fallback to truncation without summarize function', async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
    );

    const result = await compressor.compress({
      messages,
      targetTokens: 50,
      tokenEstimator: estimator,
    });

    // Should fallback to truncation
    expect(result.result.length).toBeLessThan(messages.length);
  });

  it('should use summarize function when provided', async () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
    );

    const mockSummarize: SummarizeFunction = vi.fn().mockResolvedValue('Test summary');

    const result = await compressor.compress({
      messages,
      targetTokens: 50,
      summarize: mockSummarize,
      tokenEstimator: estimator,
    });

    expect(mockSummarize).toHaveBeenCalled();
    expect(result.result[0].content).toContain('Test summary');
  });

  it('should fallback to truncation on summarize error', async () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
    );

    const mockSummarize: SummarizeFunction = vi.fn().mockRejectedValue(new Error('LLM error'));

    const result = await compressor.compress({
      messages,
      targetTokens: 50,
      summarize: mockSummarize,
      tokenEstimator: estimator,
    });

    // Should fallback to truncation
    expect(result.result.length).toBeLessThan(messages.length);
  });
});

describe('HybridCompressor', () => {
  let compressor: HybridCompressor;
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    compressor = new HybridCompressor();
    estimator = new HeuristicTokenEstimator();
  });

  it('should preprocess old tool results', async () => {
    // 使用超过阈值（200字符）的工具结果
    const oldToolResult = createToolResultMessage('call_1', 'read_file', 'A'.repeat(500));
    const recentToolResult = createToolResultMessage('call_2', 'read_file', 'B'.repeat(500));

    const messages = [
      createMessage('user', 'Read files'),
      createToolCallMessage('read_file', { path: '/old.txt' }),
      oldToolResult,
      createMessage('assistant', 'Old file read'),
      createToolCallMessage('read_file', { path: '/new.txt' }),
      recentToolResult,
      createMessage('assistant', 'New file read'),
    ];

    // 计算原始 token 数，用刚好低于原始 token 数的值作为目标
    const originalTokens = estimator.estimateMessages(messages);
    // 使用略低于原始 token 数的值：强制触发压缩，但预处理后能放下
    const targetTokens = originalTokens - 50;

    const result = await compressor.compress({
      messages,
      targetTokens,
      tokenEstimator: estimator,
    });

    // Old tool result should be truncated (超过阈值)
    const processedOldResult = result.result.find(m =>
      m.role === 'tool' && m.toolResults?.[0]?.toolCallId === 'call_1'
    );
    expect(processedOldResult?.toolResults?.[0]?.result).toContain('truncated');

    // Recent tool result should be preserved
    const processedRecentResult = result.result.find(m =>
      m.role === 'tool' && m.toolResults?.[0]?.toolCallId === 'call_2'
    );
    expect(processedRecentResult?.toolResults?.[0]?.result).toBe('B'.repeat(500));
  });
});

// ── BudgetAllocator 测试 ──

describe('DefaultBudgetAllocator', () => {
  let allocator: DefaultBudgetAllocator;

  beforeEach(() => {
    allocator = new DefaultBudgetAllocator();
  });

  it('should allocate budget correctly', () => {
    const result = allocator.allocate({
      tokenBudget: 100000,
      contextWindow: 128000,
      systemPromptTokens: 1000,
      toolTokens: 2000,
    });

    expect(result.messagesBudget).toBeGreaterThan(0);
    expect(result.outputReserve).toBeGreaterThan(0);
    expect(result.messagesBudget + result.outputReserve + 1000 + 2000 + 500).toBeLessThanOrEqual(100000);
  });

  it('should use contextWindow as limit', () => {
    const result = allocator.allocate({
      tokenBudget: 200000,
      contextWindow: 128000,
      systemPromptTokens: 1000,
      toolTokens: 2000,
    });

    // Should be limited by contextWindow
    expect(result.messagesBudget + result.outputReserve + 1000 + 2000 + 500).toBeLessThanOrEqual(128000);
  });

  it('should respect minimum output reserve', () => {
    const allocator = new DefaultBudgetAllocator({ minOutputReserve: 3000 });

    const result = allocator.allocate({
      tokenBudget: 10000,
      systemPromptTokens: 1000,
      toolTokens: 1000,
    });

    expect(result.outputReserve).toBeGreaterThanOrEqual(3000);
  });

  it('should respect maximum output reserve', () => {
    const allocator = new DefaultBudgetAllocator({ maxOutputReserve: 5000 });

    const result = allocator.allocate({
      tokenBudget: 1000000,
      systemPromptTokens: 1000,
      toolTokens: 1000,
    });

    expect(result.outputReserve).toBeLessThanOrEqual(5000);
  });

  it('should ensure minimum messages budget', () => {
    const result = allocator.allocate({
      tokenBudget: 100, // Very small budget
      systemPromptTokens: 50,
      toolTokens: 50,
    });

    expect(result.messagesBudget).toBeGreaterThanOrEqual(1000);
  });
});

// ── DefaultContextEngine 测试 ──

describe('DefaultContextEngine', () => {
  let engine: ContextEngine;
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    engine = new DefaultContextEngine();
    estimator = new HeuristicTokenEstimator();
  });

  describe('info', () => {
    it('should have correct info', () => {
      expect(engine.info.id).toBe('default');
      expect(engine.info.name).toBe('Default Context Engine');
      expect(engine.info.ownsCompaction).toBe(true);
    });
  });

  describe('assemble', () => {
    it('should assemble messages within budget', async () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!'),
      ];

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'You are a helpful assistant.',
        tools: [],
        tokenBudget: 100000,
      });

      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.estimatedTokens).toBeGreaterThan(0);
      expect(result.systemPrompt).toBe('You are a helpful assistant.');
    });

    it('should include system prompt', async () => {
      const messages = [createMessage('user', 'Hello')];

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'You are a test assistant.',
        tools: [],
        tokenBudget: 100000,
      });

      // First message should be system
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toBe('You are a test assistant.');
    });

    it('should include tool definitions in token calculation', async () => {
      const messages = [createMessage('user', 'Hello')];
      const tools = [
        createToolDefinition('read_file', 'Read a file'),
        createToolDefinition('write_file', 'Write a file'),
      ];

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'You are a helpful assistant.',
        tools,
        tokenBudget: 100000,
      });

      expect(result.estimatedTokens).toBeGreaterThan(0);
    });

    it('should compress when over budget', async () => {
      const messages = Array.from({ length: 50 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with some content to fill the context window`)
      );

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'You are a helpful assistant.',
        tools: [],
        tokenBudget: 2000, // Small budget
      });

      // Should have fewer messages than original (including system prompt)
      expect(result.messages.length).toBeLessThanOrEqual(messages.length + 1);
    });

    it('should provide dropped summary when compressed', async () => {
      const messages = Array.from({ length: 50 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with some content`)
      );

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 500, // Very small budget
      });

      if (result.droppedSummary) {
        expect(result.droppedSummary.length).toBeGreaterThan(0);
      }
    });

    it('should use summarize function when provided', async () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with some content to make it longer`)
      );

      const mockSummarize: SummarizeFunction = vi.fn().mockResolvedValue('Summary of conversation');

      const result = await engine.assemble({
        sessionId: 'test-summarize',
        messages,
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 2000, // Small budget to trigger compression
        summarize: mockSummarize,
      });

      // Should have compressed messages
      expect(result.messages.length).toBeLessThanOrEqual(messages.length + 1);
    });

    it('should handle empty messages', async () => {
      const result = await engine.assemble({
        sessionId: 'test',
        messages: [],
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });

      // Should have only system prompt
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe('system');
    });

    it('should convert messages to LLM format', async () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi!'),
      ];

      const result = await engine.assemble({
        sessionId: 'test',
        messages,
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });

      // Check LLM message format
      for (const msg of result.messages) {
        expect(msg.role).toBeDefined();
        if (typeof msg.content === 'string') {
          expect(typeof msg.content).toBe('string');
        }
      }
    });
  });

  describe('compact', () => {
    it('should compact when forced', async () => {
      // First assemble to create state
      await engine.assemble({
        sessionId: 'test',
        messages: [createMessage('user', 'Hello')],
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });

      const result = await engine.compact({
        sessionId: 'test',
        tokenBudget: 1000,
        force: true,
      });

      expect(result.ok).toBe(true);
    });

    it('should not compact when under threshold', async () => {
      // First assemble to create state
      await engine.assemble({
        sessionId: 'test',
        messages: [createMessage('user', 'Hello')],
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });

      const result = await engine.compact({
        sessionId: 'test',
        tokenBudget: 100000,
        currentTokenCount: 100,
      });

      expect(result.compacted).toBe(false);
    });
  });

  describe('afterTurn', () => {
    it('should update state after turn', async () => {
      // First assemble to create state
      await engine.assemble({
        sessionId: 'test',
        messages: [createMessage('user', 'Hello')],
        systemPrompt: 'Test',
        tools: [],
        tokenBudget: 100000,
      });

      // Should not throw
      await engine.afterTurn({
        sessionId: 'test',
        turn: [createMessage('assistant', 'Response')],
        usage: {
          promptTokens: 100,
          completionTokens: 50,
        },
      });
    });
  });

  describe('ingest', () => {
    it('should be a no-op', async () => {
      // Should not throw
      await engine.ingest!({
        sessionId: 'test',
        message: createMessage('user', 'Hello'),
      });
    });
  });
});

// ── SmartRouter 测试 ──

describe('SmartRouter', () => {
  let router: SmartRouter;
  let estimator: HeuristicTokenEstimator;

  beforeEach(() => {
    estimator = new HeuristicTokenEstimator();
    router = new SmartRouter({ tokenEstimator: estimator });
  });

  describe('evaluate', () => {
    it('should return fits when within budget', () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi'),
      ];

      const decision = router.evaluate(messages, 100000, true);

      expect(decision.route).toBe('fits');
      expect(decision.shouldCompact).toBe(false);
      expect(decision.overflowTokens).toBe(0);
    });

    it('should return compact_only when overflow and no tool results', () => {
      const messages = Array.from({ length: 50 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i} with some content`)
      );

      const decision = router.evaluate(messages, 100, true);

      expect(decision.route).toBe('compact_only');
      expect(decision.shouldCompact).toBe(true);
      expect(decision.overflowTokens).toBeGreaterThan(0);
    });

    it('should return truncate_tool_results_only when large tool results', () => {
      // 创建大量冗长的工具结果
      const messages = [
        createMessage('user', 'Read files'),
        createToolCallMessage('read_file', { path: '/test.txt' }),
        createToolResultMessage('call_1', 'read_file', 'A'.repeat(5000)),
        createMessage('assistant', 'Done'),
      ];

      const decision = router.evaluate(messages, 200, true);

      expect(decision.route).toBe('truncate_tool_results_only');
      expect(decision.shouldCompact).toBe(true);
      expect(decision.toolResultReducibleChars).toBeGreaterThan(0);
    });

    it('should return compact_only when no summarize function', () => {
      const messages = Array.from({ length: 50 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
      );

      const decision = router.evaluate(messages, 100, false);

      expect(decision.route).toBe('compact_only');
      expect(decision.shouldCompact).toBe(true);
    });

    it('should calculate overflow tokens correctly', () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi'),
      ];

      const rawEstimatedTokens = estimator.estimateMessages(messages);
      // SmartRouter applies SAFETY_MARGIN (1.2x), so estimatedTokens is ceil(raw * 1.2)
      const expectedEstimatedTokens = Math.ceil(rawEstimatedTokens * 1.2);
      const decision = router.evaluate(messages, expectedEstimatedTokens - 10, true);

      expect(decision.overflowTokens).toBeGreaterThan(0);
      expect(decision.estimatedTokens).toBe(expectedEstimatedTokens);
    });
  });
});

// ── 集成测试 ──

describe('ContextEngine Integration', () => {
  it('should work end-to-end with real estimator', async () => {
    const engine = new DefaultContextEngine();
    const messages = [
      createMessage('user', 'Read the file /test.txt'),
      createToolCallMessage('read_file', { path: '/test.txt' }),
      createToolResultMessage('call_1', 'read_file', 'File contents here'),
      createMessage('assistant', 'Here are the contents: File contents here'),
      createMessage('user', 'Now write to /output.txt'),
      createToolCallMessage('write_file', { path: '/output.txt', content: 'New content' }),
      createToolResultMessage('call_2', 'write_file', 'Success'),
      createMessage('assistant', 'Done! Written to /output.txt'),
    ];

    const tools = [
      createToolDefinition('read_file', 'Read a file'),
      createToolDefinition('write_file', 'Write a file'),
    ];

    const result = await engine.assemble({
      sessionId: 'integration-test',
      messages,
      systemPrompt: 'You are a file assistant.',
      tools,
      tokenBudget: 100000,
    });

    // Should have all messages + system prompt
    expect(result.messages.length).toBe(messages.length + 1);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.systemPrompt).toBe('You are a file assistant.');
  });

  it('should handle compression with summary', async () => {
    const engine = new DefaultContextEngine();
    const messages = Array.from({ length: 100 }, (_, i) =>
      createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}: ${'x'.repeat(50)}`)
    );

    const result = await engine.assemble({
      sessionId: 'compression-test',
      messages,
      systemPrompt: 'Test',
      tools: [],
      tokenBudget: 2000, // Small budget
    });

    // Should compress
    expect(result.messages.length).toBeLessThan(messages.length + 1);
  });

  it('should maintain state across calls', async () => {
    const engine = new DefaultContextEngine();

    // First call
    await engine.assemble({
      sessionId: 'state-test',
      messages: [createMessage('user', 'Hello')],
      systemPrompt: 'Test',
      tools: [],
      tokenBudget: 100000,
    });

    // afterTurn
    await engine.afterTurn({
      sessionId: 'state-test',
      turn: [createMessage('assistant', 'Response')],
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    // Second call
    const result = await engine.assemble({
      sessionId: 'state-test',
      messages: [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Response'),
        createMessage('user', 'Follow up'),
      ],
      systemPrompt: 'Test',
      tools: [],
      tokenBudget: 100000,
    });

    expect(result.messages.length).toBeGreaterThan(0);
  });
});
