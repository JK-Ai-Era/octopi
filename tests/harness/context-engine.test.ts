/**
 * DefaultContextEngine 测试
 *
 * 验证 MessageSelector 集成和四区域消息选择。
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type { Message } from '@octopi-agent/core/types.js';
import type {
  MessageSelector,
  SelectResult,
  SelectOptions,
  TokenEstimator,
  AssembleParams,
} from '@octopi-agent/engine/harness/context/types.js';
import type { CompactEngine } from '@octopi-agent/engine/harness/context/capabilities/compact/index.js';
import { HeuristicTokenEstimator } from '@octopi-agent/engine/harness/context/token-estimator.js';

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
      const selectSpy = vi.fn<MessageSelector['select']>().mockReturnValue({
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
        protectFirstN: 5,  // 默认值（交接快照头 5，2026-10-28 拍板）
        protectLastN: 20,  // 默认值
      });
    });

    it('should not call compact engine when no overflow', async () => {
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

      const compactSpy = vi.fn<CompactEngine['compactMessages']>();
      const mockCompact: CompactEngine = {
        compactMessages: compactSpy,
        compactText: vi.fn(),
      };

      const engine = new DefaultContextEngine({
        messageSelector: mockSelector,
        compactEngine: mockCompact,
      });

      const params = makeAssembleParams();
      const result = await engine.assemble(params);

      // 没有溢出时不应调用压缩执行
      expect(compactSpy).not.toHaveBeenCalled();
      // 结果应该包含所有消息 + system prompt
      expect(result.messages.length).toBeGreaterThan(0);
    });

    it('overflow 零 compactMessages（Q1）：收敛不经 LLM 压缩执行', async () => {
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

      const compactSpy = vi.fn<CompactEngine['compactMessages']>().mockResolvedValue({
        ok: true,
        compacted: true,
        tokensBefore: 0,
        summarizeAttempted: false,
        view: [makeMessages(1, 'compressed')[0]],
      });
      const mockCompact: CompactEngine = { compactMessages: compactSpy, compactText: vi.fn() };

      const engine = new DefaultContextEngine({
        messageSelector: mockSelector,
        compactEngine: mockCompact,
      });

      const params = makeAssembleParams();
      await engine.assemble(params);

      // Q1 纯机械：overflow 收敛全程零 LLM——compactMessages 一次都不许被调
      expect(compactSpy).not.toHaveBeenCalled();
    });

    it('收敛重组保序：幸存者=输入的保序子序列（identity 契约）', async () => {
      // 身份契约：MessageSelector 返回的必须是输入数组的同引用对象（产品翻译按身份定锚）
      const headMsgs = makeMessages(2, 'head');
      const overflowMsgs = makeMessages(5, 'overflow');
      const tailMsgs = makeMessages(2, 'tail');
      const messages = [...headMsgs, ...overflowMsgs, ...tailMsgs];
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

      const mockCompact: CompactEngine = {
        compactMessages: vi.fn().mockResolvedValue({
          ok: true,
          compacted: true,
          tokensBefore: 0,
          summarizeAttempted: false,
          view: [compressedMsg],
        }),
        compactText: vi.fn(),
      };

      const engine = new DefaultContextEngine({
        messageSelector: mockSelector,
        compactEngine: mockCompact,
      });

      const params = makeAssembleParams({ messages });
      const result = await engine.assemble(params);

      // Q1 纯机械：零 LLM 压缩执行，「compressed」摘要文本不许出现
      const messageContents = result.messages
        .filter(m => m.role !== 'system')
        .map(m => String(m.content ?? ''));
      expect(mockCompact.compactMessages).not.toHaveBeenCalled();
      expect(messageContents.join('\n')).not.toContain('compressed 0');

      // identity 契约：幸存者=输入的保序子序列（收敛砍原对象、不重排、不伪造）
      const origins = [...headMsgs, ...overflowMsgs, ...tailMsgs].map((m) => String(m.content ?? ''));
      const survivorIdx = messageContents
        .map((c) => origins.findIndex((o) => c === o))
        .filter((i) => i >= 0);
      expect(survivorIdx.length).toBeGreaterThan(0);
      for (let i = 1; i < survivorIdx.length; i++) {
        expect(survivorIdx[i]).toBeGreaterThan(survivorIdx[i - 1]!);
      }
    });

    it('should respect custom protectFirstN and protectLastN', async () => {
      const selectSpy = vi.fn<MessageSelector['select']>().mockReturnValue({
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
        inputLimit: 90000,
        messagesLimit: 50000,
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
