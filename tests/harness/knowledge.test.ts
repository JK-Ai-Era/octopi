/**
 * KnowledgeStore + Reflector 测试
 */

import { describe, it, expect } from 'vitest';
import {
  MemoryKnowledgeStore,
  KnowledgeStage,
  LLMReflector,
} from '../../src/harness/index.js';
import type { KnowledgeEntry } from '../../src/harness/index.js';
import type { ExecutionRecord, Pattern } from '../../src/harness/task-system/supervisor/types.js';
import type { ModelProvider } from '../../src/core/interfaces/model-provider.js';

// ── 辅助 ──

function mockModel(response: string): ModelProvider {
  return {
    name: 'mock',
    async chat() {
      return { content: response, model: 'mock', finishReason: 'stop' as const };
    },
    async *stream() {},
    async isAvailable() { return true; },
      getModelInfo() { return null; },
  };
}

function execution(overrides?: Partial<ExecutionRecord>): ExecutionRecord {
  return {
    trigger: { type: 'user.message', timestamp: Date.now(), data: { content: 'test' } },
    result: { success: true, output: 'ok', durationMs: 100 },
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── MemoryKnowledgeStore 测试 ──

describe('MemoryKnowledgeStore', () => {
  describe('CRUD', () => {
    it('store 返回 id', async () => {
      const store = new MemoryKnowledgeStore();
      const id = await store.store({ type: 'fact', content: 'TypeScript is typed JS', source: 'test', confidence: 0.9, tags: ['ts'] });
      expect(id).toBeDefined();
    });

    it('get 获取条目', async () => {
      const store = new MemoryKnowledgeStore();
      const id = await store.store({ type: 'fact', content: 'hello', source: 'test', confidence: 0.8, tags: [] });
      const entry = await store.get(id);
      expect(entry?.content).toBe('hello');
      expect(entry?.type).toBe('fact');
    });

    it('update 更新条目', async () => {
      const store = new MemoryKnowledgeStore();
      const id = await store.store({ type: 'fact', content: 'old', source: 'test', confidence: 0.5, tags: [] });
      await store.update(id, { content: 'new', confidence: 0.9 });
      const entry = await store.get(id);
      expect(entry?.content).toBe('new');
      expect(entry?.confidence).toBe(0.9);
    });

    it('delete 删除条目', async () => {
      const store = new MemoryKnowledgeStore();
      const id = await store.store({ type: 'fact', content: 'to delete', source: 'test', confidence: 0.5, tags: [] });
      await store.delete(id);
      expect(await store.get(id)).toBeNull();
    });
  });

  describe('retrieve', () => {
    it('关键词匹配', async () => {
      const store = new MemoryKnowledgeStore();
      await store.store({ type: 'fact', content: 'TypeScript is a typed superset of JavaScript', source: 'test', confidence: 0.9, tags: ['ts'] });
      await store.store({ type: 'fact', content: 'Python is a dynamic language', source: 'test', confidence: 0.8, tags: ['python'] });
      await store.store({ type: 'fact', content: 'TypeScript compiles to JavaScript', source: 'test', confidence: 0.95, tags: ['ts'] });

      const results = await store.retrieve('typescript');
      expect(results.length).toBe(2);
      expect(results[0].content).toContain('TypeScript');
    });

    it('按类型过滤', async () => {
      const store = new MemoryKnowledgeStore();
      await store.store({ type: 'fact', content: 'a fact', source: 'test', confidence: 0.9, tags: [] });
      await store.store({ type: 'lesson', content: 'a lesson', source: 'test', confidence: 0.9, tags: [] });

      const results = await store.retrieve('fact lesson', { type: 'lesson' });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('lesson');
    });

    it('按标签过滤', async () => {
      const store = new MemoryKnowledgeStore();
      await store.store({ type: 'fact', content: 'tagged', source: 'test', confidence: 0.9, tags: ['important'] });
      await store.store({ type: 'fact', content: 'untagged', source: 'test', confidence: 0.9, tags: [] });

      const results = await store.retrieve('tagged untagged', { tags: ['important'] });
      expect(results.length).toBe(1);
      expect(results[0].tags).toContain('important');
    });

    it('按置信度过滤', async () => {
      const store = new MemoryKnowledgeStore();
      await store.store({ type: 'fact', content: 'high confidence', source: 'test', confidence: 0.9, tags: [] });
      await store.store({ type: 'fact', content: 'low confidence', source: 'test', confidence: 0.2, tags: [] });

      const results = await store.retrieve('confidence', { minConfidence: 0.5 });
      expect(results.length).toBe(1);
      expect(results[0].confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('更新访问计数', async () => {
      const store = new MemoryKnowledgeStore();
      const id = await store.store({ type: 'fact', content: 'tracked', source: 'test', confidence: 0.9, tags: [] });

      await store.retrieve('tracked');
      await store.retrieve('tracked');

      const entry = await store.get(id);
      expect(entry?.accessCount).toBe(2);
    });

    it('限制返回数量', async () => {
      const store = new MemoryKnowledgeStore();
      for (let i = 0; i < 10; i++) {
        await store.store({ type: 'fact', content: `item ${i}`, source: 'test', confidence: 0.5, tags: [] });
      }

      const results = await store.retrieve('item', { limit: 3 });
      expect(results.length).toBe(3);
    });
  });

  describe('list', () => {
    it('列出所有条目', async () => {
      const store = new MemoryKnowledgeStore();
      await store.store({ type: 'fact', content: 'a', source: 'test', confidence: 0.5, tags: [] });
      await store.store({ type: 'lesson', content: 'b', source: 'test', confidence: 0.5, tags: [] });

      const all = await store.list();
      expect(all.length).toBe(2);
    });
  });

  describe('stats', () => {
    it('返回正确的统计', async () => {
      const store = new MemoryKnowledgeStore();
      await store.store({ type: 'fact', content: 'a', source: 'test', confidence: 0.8, tags: [] });
      await store.store({ type: 'lesson', content: 'b', source: 'test', confidence: 0.6, tags: [] });

      const stats = await store.stats();
      expect(stats.totalEntries).toBe(2);
      expect(stats.byType.fact).toBe(1);
      expect(stats.byType.lesson).toBe(1);
      expect(stats.avgConfidence).toBeCloseTo(0.7);
    });
  });
});

// ── KnowledgeStage 测试 ──

describe('KnowledgeStage', () => {
  it('无消息时不注入', async () => {
    const store = new MemoryKnowledgeStore();
    const stage = new KnowledgeStage({ store });
    const ctx = { messages: [], systemPrompt: 'base', tools: [], systemPromptAddition: '' };
    const result = await stage.process(ctx);
    expect(result.systemPrompt).toBe('base');
  });

  it('有相关知识时注入', async () => {
    const store = new MemoryKnowledgeStore();
    await store.store({ type: 'fact', content: 'TypeScript uses .ts files', source: 'test', confidence: 0.9, tags: ['ts'] });

    const stage = new KnowledgeStage({ store });
    const ctx = {
      messages: [{ role: 'user' as const, content: 'How do I use TypeScript?', timestamp: Date.now() }],
      systemPrompt: 'base',
      tools: [],
    };
    const result = await stage.process(ctx);
    expect(result.systemPrompt).toContain('TypeScript');
    expect(result.systemPrompt).toContain('相关知识');
  });

  it('无相关知识时不注入', async () => {
    const store = new MemoryKnowledgeStore();
    await store.store({ type: 'fact', content: 'Go is a compiled language', source: 'test', confidence: 0.9, tags: ['go'] });

    const stage = new KnowledgeStage({ store });
    const ctx = {
      messages: [{ role: 'user' as const, content: 'Rust ownership model', timestamp: Date.now() }],
      systemPrompt: 'base',
      tools: [],
    };
    const result = await stage.process(ctx);
    expect(result.systemPrompt).toBe('base');
  });
});

// ── LLMReflector 测试 ──

describe('LLMReflector', () => {
  it('assess 返回评估结果', async () => {
    const model = mockModel(JSON.stringify({
      quality: 0.8,
      success: true,
      issues: [],
      suggestions: ['可以优化响应速度'],
    }));

    const reflector = new LLMReflector({ model });
    const assessment = await reflector.assess(execution());

    expect(assessment.quality).toBe(0.8);
    expect(assessment.success).toBe(true);
  });

  it('assess 解析失败时返回默认值', async () => {
    const model = mockModel('这不是JSON');
    const reflector = new LLMReflector({ model });
    const assessment = await reflector.assess(execution());
    expect(assessment.quality).toBe(0.5);
  });

  it('detectPatterns 返回模式', async () => {
    const model = mockModel(JSON.stringify({
      patterns: [{
        type: 'recurring_error',
        description: '多次超时',
        confidence: 0.85,
      }],
    }));

    const reflector = new LLMReflector({ model });
    const patterns = await reflector.detectPatterns([
      execution({ result: { success: false, error: 'timeout', durationMs: 5000 } }),
      execution({ result: { success: false, error: 'timeout', durationMs: 5000 } }),
    ]);

    expect(patterns.length).toBe(1);
    expect(patterns[0].type).toBe('recurring_error');
    expect(patterns[0].confidence).toBe(0.85);
  });

  it('detectPatterns 少于 2 条记录返回空', async () => {
    const model = mockModel('{}');
    const reflector = new LLMReflector({ model });
    const patterns = await reflector.detectPatterns([execution()]);
    expect(patterns).toEqual([]);
  });

  it('高置信度模式自动存入 KnowledgeStore', async () => {
    const store = new MemoryKnowledgeStore();
    const model = mockModel(JSON.stringify({
      patterns: [{
        type: 'recurring_error',
        description: 'API 频繁超时',
        confidence: 0.9,
      }],
    }));

    const reflector = new LLMReflector({ model, knowledgeStore: store });
    await reflector.detectPatterns([
      execution({ result: { success: false, error: 'timeout', durationMs: 5000 } }),
      execution({ result: { success: false, error: 'timeout', durationMs: 5000 } }),
    ]);

    const stats = await store.stats();
    expect(stats.totalEntries).toBe(1);

    const entries = await store.list();
    expect(entries[0].content).toContain('API');
    expect(entries[0].confidence).toBe(0.9);
  });
});
