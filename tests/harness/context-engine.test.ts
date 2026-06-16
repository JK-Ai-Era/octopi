/**
 * DefaultContextEngine 测试
 *
 * 验证 MessageSelector 集成和四区域消息选择。
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultContextEngine } from '../../src/harness/context/default-context-engine.js';
import type { Message } from '../../src/core/types.js';
import type { LLMMessage, ToolDefinition } from '../../src/core/interfaces/model-provider.js';
import type {
  MessageSelector,
  SelectResult,
  SelectOptions,
  TokenEstimator,
  Compressor,
  CompressParams,
  CompressResult,
  AssembleParams,
} from '../../src/core/interfaces/context-engine.js';
import { HeuristicTokenEstimator } from '../../src/harness/context/token-estimator.js';

// ── 辅助函数 ──

function makeMessages(count: number, contentPrefix = 'msg'): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `${contentPrefix} ${i}`,
    timestamp: Date.now() + i,
  }));
}

function makeAssembleParams(overrides?: Partial<AssembleParams>): AssembleParams {
  return {
    sessionId: 'test-session',
    messages: makeMessages(10),
    systemPrompt: 'You are helpful.',
    tools: [],
    tokenBudget: 128000,
    ...overrides,
  };
}

// ── 测试 ──

describe('DefaultContextEngine', () => {
  describe('MessageSelector integration', () => {
    it('should use MessageSelector to split messages into zones', async () => {
      const selectSpy = vi.fn<SelectResult['select']>().mockReturnValue({
        kept: makeMessages(5),
        overflow: [],
        tail: makeMessages(2),
        tailTokens: 100,
        estimatedTokens: 200,
        overflowTokens: 0,
      });

      const mockSelector: MessageSelector = { select: selectSpy };
      const engine = new DefaultContextEngine({ messageSelector: mockSelector });

      const params = makeAssembleParams({ messages: makeMessages(5) });
      await engine.assemble(params);

      // MessageSelector.select 应该被调用
      expect(selectSpy).toHaveBeenCalledOnce();
      expect(selectSpy.mock.calls[0][1]).toMatchObject({
        protectFirstN: 3,  // 默认值
        protectLastN: 20,  // 默认值
      });
    });

    it('should not call Compressor when no overflow', async () => {
      const mockSelector: MessageSelector = {
        select: vi.fn().mockReturnValue({
          kept: makeMessages(5),
          overflow: [],
          tail: makeMessages(2),
          tailTokens: 100,
          estimatedTokens: 200,
          overflowTokens: 0,
        }),
      };

      const compressSpy = vi.fn<Compressor['compress']>().mockResolvedValue({
        result: [],
        estimatedTokens: 0,
      });
      const mockCompressor: Compressor = { compress: compressSpy };

      const engine = new DefaultContextEngine({
        messageSelector: mockSelector,
        compressor: mockCompressor,
      });

      const params = makeAssembleParams();
      const result = await engine.assemble(params);

      // 没有溢出时不应调用 Compressor
      expect(compressSpy).not.toHaveBeenCalled();
      // 结果应该包含所有消息 + system prompt
      expect(result.messages.length).toBeGreaterThan(0);
    });

    it('should compress only overflow messages, not head and tail', async () => {
      const headMsgs = makeMessages(3, 'head');
      const overflowMsgs = makeMessages(5, 'overflow');
      const tailMsgs = makeMessages(2, 'tail');

      const mockSelector: MessageSelector = {
        select: vi.fn().mockReturnValue({
          kept: [...headMsgs, ...tailMsgs],
          overflow: overflowMsgs,
          tail: tailMsgs,
          tailTokens: 100,
          estimatedTokens: 500,
          overflowTokens: 300,
        }),
      };

      const compressSpy = vi.fn<Compressor['compress']>().mockResolvedValue({
        result: [makeMessages(1, 'compressed')[0]],
        estimatedTokens: 50,
      });
      const mockCompressor: Compressor = { compress: compressSpy };

      const engine = new DefaultContextEngine({
        messageSelector: mockSelector,
        compressor: mockCompressor,
      });

      const params = makeAssembleParams();
      await engine.assemble(params);

      // Compressor 应该只收到 overflow 消息
      expect(compressSpy).toHaveBeenCalled();
      const compressArgs = compressSpy.mock.calls[0][0];
      expect(compressArgs.messages).toEqual(overflowMsgs);
      // 不应该包含 head 或 tail
      expect(compressArgs.messages).not.toEqual(expect.arrayContaining(headMsgs));
      expect(compressArgs.messages).not.toEqual(expect.arrayContaining(tailMsgs));
    });

    it('should reassemble: head + compressed overflow + tail', async () => {
      const headMsgs = makeMessages(2, 'head');
      const overflowMsgs = makeMessages(5, 'overflow');
      const tailMsgs = makeMessages(2, 'tail');
      const compressedMsg = makeMessages(1, 'compressed')[0];

      const mockSelector: MessageSelector = {
        select: vi.fn().mockReturnValue({
          kept: [...headMsgs, ...tailMsgs],
          overflow: overflowMsgs,
          tail: tailMsgs,
          tailTokens: 100,
          estimatedTokens: 500,
          overflowTokens: 300,
        }),
      };

      const mockCompressor: Compressor = {
        compress: vi.fn().mockResolvedValue({
          result: [compressedMsg],
          estimatedTokens: 50,
        }),
      };

      const engine = new DefaultContextEngine({
        messageSelector: mockSelector,
        compressor: mockCompressor,
      });

      const params = makeAssembleParams();
      const result = await engine.assemble(params);

      // 结果应该包含 system prompt + head + compressed + tail
      const messageContents = result.messages
        .filter(m => m.role !== 'system')
        .map(m => m.content);

      // head 消息应该存在
      expect(messageContents).toContain('head 0');
      expect(messageContents).toContain('head 1');
      // 压缩后的消息应该存在
      expect(messageContents).toContain('compressed 0');
      // tail 消息应该存在
      expect(messageContents).toContain('tail 0');
      expect(messageContents).toContain('tail 1');
    });

    it('should respect custom protectFirstN and protectLastN', async () => {
      const selectSpy = vi.fn<SelectResult['select']>().mockReturnValue({
        kept: makeMessages(5),
        overflow: [],
        tail: makeMessages(3),
        tailTokens: 150,
        estimatedTokens: 250,
        overflowTokens: 0,
      });

      const mockSelector: MessageSelector = { select: selectSpy };
      const engine = new DefaultContextEngine({
        messageSelector: mockSelector,
        protectFirstN: 5,
        protectLastN: 30,
      });

      const params = makeAssembleParams();
      await engine.assemble(params);

      expect(selectSpy.mock.calls[0][1]).toMatchObject({
        protectFirstN: 5,
        protectLastN: 30,
      });
    });
  });

  describe('BudgetAllocator integration', () => {
    it('should use BudgetAllocator to calculate messages budget', async () => {
      const allocateSpy = vi.fn().mockReturnValue({
        messagesBudget: 50000,
        outputReserve: 4000,
      });

      const mockSelector: MessageSelector = {
        select: vi.fn().mockReturnValue({
          kept: makeMessages(5),
          overflow: [],
          tail: makeMessages(2),
          tailTokens: 100,
          estimatedTokens: 200,
          overflowTokens: 0,
        }),
      };

      const engine = new DefaultContextEngine({
        messageSelector: mockSelector,
        budgetAllocator: { allocate: allocateSpy },
      });

      const params = makeAssembleParams({ tokenBudget: 100000 });
      await engine.assemble(params);

      expect(allocateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tokenBudget: 100000 }),
      );
    });
  });
});
