/**
 * SmartStage 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SmartStage,
  createSmartSummarizer,
  createSmartRelevanceFilter,
} from '../../src/harness/context/smart-stage.js';
import { DefaultEventBus } from '../../src/core/event-bus.js';
import type { ModelProvider, LLMRequest, LLMResponse } from '../../src/core/interfaces/model-provider.js';
import type { StageContext } from '../../src/harness/context/pipeline.js';
import type { Message } from '../../src/core/types.js';

// ── Mock 工厂 ──

function createMockModelProvider(response: string): ModelProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: response,
      model: 'mock-model',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
    stream: async function* () {
      yield { type: 'content' as const, content: response };
      yield { type: 'done' as const };
    },
    isAvailable: async () => true,
  };
}

function createStageContext(messages?: Message[]): StageContext {
  return {
    messages: messages ?? [
      { role: 'user', content: 'Hello', timestamp: Date.now() },
      { role: 'assistant', content: 'Hi there!', timestamp: Date.now() },
      { role: 'user', content: 'How are you?', timestamp: Date.now() },
    ],
    systemPrompt: 'You are helpful.',
    tools: [],
    estimatedTokens: 100,
    untrustedRanges: [],
    extra: {},
  };
}

// ── 测试 ──

describe('SmartStage', () => {
  let events: DefaultEventBus;

  beforeEach(() => {
    events = new DefaultEventBus();
  });

  // ── 基本功能 ──

  describe('basic functionality', () => {
    it('should call LLM and apply decision', async () => {
      const model = createMockModelProvider('LLM decision result');
      const applyDecision = vi.fn().mockImplementation(async (response: string, ctx: StageContext) => {
        return { ...ctx, extra: { ...ctx.extra, decision: response } };
      });

      const stage = new SmartStage({
        name: 'test-smart',
        model,
        systemPrompt: 'You are a test.',
        buildPrompt: (ctx) => `Analyze ${ctx.messages.length} messages`,
        applyDecision,
      });

      const ctx = createStageContext();
      const result = await stage.process(ctx);

      expect(applyDecision).toHaveBeenCalledWith('LLM decision result', ctx);
      expect(result.extra.decision).toBe('LLM decision result');
    });

    it('should skip when disabled', async () => {
      const model = createMockModelProvider('should not be called');
      const applyDecision = vi.fn();

      const stage = new SmartStage({
        name: 'test-smart',
        model,
        systemPrompt: 'test',
        buildPrompt: () => 'test',
        applyDecision,
        enabled: false,
      });

      const ctx = createStageContext();
      const result = await stage.process(ctx);

      expect(applyDecision).not.toHaveBeenCalled();
      expect(result).toBe(ctx);
    });

    it('should use fallback when LLM fails', async () => {
      const model = createMockModelProvider('response');
      model.chat = vi.fn().mockRejectedValue(new Error('LLM error'));

      const fallback = vi.fn().mockImplementation(async (ctx: StageContext) => {
        return { ...ctx, extra: { ...ctx.extra, fallback: true } };
      });

      const stage = new SmartStage({
        name: 'test-smart',
        model,
        systemPrompt: 'test',
        buildPrompt: () => 'test',
        applyDecision: async (_, ctx) => ctx,
        fallback,
      });

      const ctx = createStageContext();
      const result = await stage.process(ctx);

      expect(fallback).toHaveBeenCalled();
      expect(result.extra.fallback).toBe(true);
    });

    it('should return original context when LLM fails and no fallback', async () => {
      const model = createMockModelProvider('response');
      model.chat = vi.fn().mockRejectedValue(new Error('LLM error'));

      const stage = new SmartStage({
        name: 'test-smart',
        model,
        systemPrompt: 'test',
        buildPrompt: () => 'test',
        applyDecision: async (_, ctx) => ctx,
      });

      const ctx = createStageContext();
      const result = await stage.process(ctx);

      expect(result).toBe(ctx);
    });
  });

  // ── 缓存 ──

  describe('caching', () => {
    it('should cache results', async () => {
      const model = createMockModelProvider('cached result');
      const chatSpy = vi.spyOn(model, 'chat');

      const stage = new SmartStage({
        name: 'test-smart',
        model,
        systemPrompt: 'test',
        buildPrompt: (ctx) => `messages:${ctx.messages.length}`,
        applyDecision: async (response, ctx) => ({ ...ctx, extra: { result: response } }),
      });

      const ctx = createStageContext();

      // 第一次调用
      await stage.process(ctx);
      expect(chatSpy).toHaveBeenCalledTimes(1);

      // 第二次调用（应该使用缓存）
      await stage.process(ctx);
      expect(chatSpy).toHaveBeenCalledTimes(1);
    });

    it('should clear cache', async () => {
      const model = createMockModelProvider('result');
      const chatSpy = vi.spyOn(model, 'chat');

      const stage = new SmartStage({
        name: 'test-smart',
        model,
        systemPrompt: 'test',
        buildPrompt: () => 'same prompt',
        applyDecision: async (_, ctx) => ctx,
      });

      const ctx = createStageContext();

      await stage.process(ctx);
      stage.clearCache();
      await stage.process(ctx);

      expect(chatSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── 超时 ──

  describe('timeout', () => {
    it('should timeout when LLM takes too long', async () => {
      const model = createMockModelProvider('response');
      model.chat = vi.fn().mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({
          content: 'late response',
          model: 'mock',
          finishReason: 'stop',
        }), 10000)),
      );

      const fallback = vi.fn().mockImplementation(async (ctx: StageContext) => ctx);

      const stage = new SmartStage({
        name: 'test-smart',
        model,
        systemPrompt: 'test',
        buildPrompt: () => 'test',
        applyDecision: async (_, ctx) => ctx,
        timeoutMs: 100,
        fallback,
      });

      const ctx = createStageContext();
      await stage.process(ctx);

      expect(fallback).toHaveBeenCalled();
    });
  });

  // ── 事件 ──

  describe('events', () => {
    it('should emit fallback event when LLM fails', async () => {
      const model = createMockModelProvider('response');
      model.chat = vi.fn().mockRejectedValue(new Error('test error'));

      const handler = vi.fn();
      events.on('smart_stage.fallback', handler);

      const stage = new SmartStage({
        name: 'test-smart',
        model,
        systemPrompt: 'test',
        buildPrompt: () => 'test',
        applyDecision: async (_, ctx) => ctx,
        events,
      });

      const ctx = createStageContext();
      await stage.process(ctx);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].data.name).toBe('test-smart');
    });
  });
});

// ── 内置工厂 ──

describe('createSmartSummarizer', () => {
  it('should create a summarizer stage', () => {
    const model = createMockModelProvider('summary');
    const stage = createSmartSummarizer(model);

    expect(stage.name).toBe('smart-summarizer');
  });

  it('should summarize conversation', async () => {
    const model = createMockModelProvider('User asked about weather, assistant provided forecast.');
    const stage = createSmartSummarizer(model);

    const messages: Message[] = [
      { role: 'user', content: 'What is the weather?', timestamp: Date.now() },
      { role: 'assistant', content: 'It is sunny today.', timestamp: Date.now() },
      { role: 'user', content: 'And tomorrow?', timestamp: Date.now() },
      { role: 'assistant', content: 'Tomorrow will be cloudy.', timestamp: Date.now() },
      { role: 'user', content: 'Thanks!', timestamp: Date.now() },
    ];

    const ctx = createStageContext(messages);
    const result = await stage.process(ctx);

    // 应该有摘要 + 最后几条消息
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toContain('对话摘要');
  });
});

describe('createSmartRelevanceFilter', () => {
  it('should create a relevance filter stage', () => {
    const model = createMockModelProvider('[0, 2, 4]');
    const stage = createSmartRelevanceFilter(model);

    expect(stage.name).toBe('smart-relevance-filter');
  });

  it('should filter messages by relevance', async () => {
    const model = createMockModelProvider('[0, 1, 4]');
    const stage = createSmartRelevanceFilter(model, { keepRatio: 0.6 });

    const messages: Message[] = [
      { role: 'user', content: 'Hello', timestamp: Date.now() },
      { role: 'assistant', content: 'Hi!', timestamp: Date.now() },
      { role: 'user', content: 'Random topic', timestamp: Date.now() },
      { role: 'assistant', content: 'Random response', timestamp: Date.now() },
      { role: 'user', content: 'Back to main topic', timestamp: Date.now() },
    ];

    const ctx = createStageContext(messages);
    const result = await stage.process(ctx);

    // 应该只保留索引 0, 1, 4 的消息
    expect(result.messages.length).toBe(3);
  });
});
