/**
 * Context Window 集成测试
 *
 * 验证 Context Pipeline 如何利用 contextWindow 做主动压缩决策。
 */

import { describe, it, expect } from 'vitest';
import { DefaultContextPipeline, CompactStage } from '../src/harness/context/pipeline.js';
import type { StageContext } from '../src/harness/context/pipeline.js';
import type { Message } from '../src/core/types.js';
import type { PipelineInput } from '../src/core/interfaces/context-pipeline.js';

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `Message ${i + 1}: ${'x'.repeat(200)}`,
    timestamp: Date.now() + i,
  }));
}

function makeInput(overrides?: Partial<PipelineInput>): PipelineInput {
  return {
    systemPrompt: 'You are helpful.',
    tools: [],
    ...overrides,
  };
}

describe('Context Window Integration', () => {
  describe('CompactStage', () => {
    it('无 maxTokens 且无 contextWindow 时不压缩', async () => {
      const stage = new CompactStage();
      const messages = makeMessages(50);
      const ctx: StageContext = {
        messages,
        systemPrompt: '',
        tools: [],
        estimatedTokens: 0,
        untrustedRanges: [],
        extra: {},
      };

      const result = await stage.process(ctx);
      expect(result.messages.length).toBe(50);
    });

    it('只有 contextWindow 时用它做上限', async () => {
      const stage = new CompactStage();
      // 创建足够多的消息以触发压缩
      const messages = makeMessages(100);
      const ctx: StageContext = {
        messages,
        systemPrompt: '',
        tools: [],
        contextWindow: 500, // 很小的 context window
        estimatedTokens: 0,
        untrustedRanges: [],
        extra: {},
      };

      const result = await stage.process(ctx);
      // 应该压缩了消息
      expect(result.messages.length).toBeLessThan(100);
    });

    it('只有 maxTokens 时用它做上限', async () => {
      const stage = new CompactStage();
      const messages = makeMessages(100);
      const ctx: StageContext = {
        messages,
        systemPrompt: '',
        tools: [],
        maxTokens: 500,
        estimatedTokens: 0,
        untrustedRanges: [],
        extra: {},
      };

      const result = await stage.process(ctx);
      expect(result.messages.length).toBeLessThan(100);
    });

    it('maxTokens 和 contextWindow 都有时取较小值', async () => {
      const stage = new CompactStage();
      const messages = makeMessages(100);

      // maxTokens 更小
      const ctx1: StageContext = {
        messages: [...messages],
        systemPrompt: '',
        tools: [],
        maxTokens: 300,
        contextWindow: 1000,
        estimatedTokens: 0,
        untrustedRanges: [],
        extra: {},
      };
      const result1 = await stage.process(ctx1);

      // contextWindow 更小
      const ctx2: StageContext = {
        messages: [...messages],
        systemPrompt: '',
        tools: [],
        maxTokens: 1000,
        contextWindow: 300,
        estimatedTokens: 0,
        untrustedRanges: [],
        extra: {},
      };
      const result2 = await stage.process(ctx2);

      // 两者都应该压缩到相似程度（因为有效限制都是 300）
      expect(result1.messages.length).toBeLessThanOrEqual(result2.messages.length + 1);
    });
  });

  describe('DefaultContextPipeline', () => {
    it('PipelineInput.contextWindow 传递到 StageContext', async () => {
      const pipeline = new DefaultContextPipeline([new CompactStage()]);
      const messages = makeMessages(100);

      const output = await pipeline.process(messages, makeInput({
        contextWindow: 500,
      }));

      // 应该触发了压缩
      expect(output.messages.length).toBeLessThan(100);
    });

    it('无 contextWindow 时不做主动压缩', async () => {
      const pipeline = new DefaultContextPipeline([new CompactStage()]);
      const messages = makeMessages(20);

      const output = await pipeline.process(messages, makeInput());

      // 20 条消息不算多，不应该被压缩
      expect(output.messages.length).toBeGreaterThanOrEqual(20);
    });
  });
});
