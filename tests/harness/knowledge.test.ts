/**
 * Knowledge Tier 0 catalog + Reflector→Memory 测试
 *
 * 旧 KnowledgeStore / KnowledgeContextEngine 已拆除（arch/knowledge-layer.md §8.1）。
 */

import { describe, it, expect } from 'vitest';
import { KnowledgeLayer } from '../../src/harness/context/layers.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import { LLMReflector } from '../../src/harness/orchestration/reflector/index.js';
import type { ModelProvider } from '../../src/core/interfaces/model-provider.js';
import type { ExecutionRecord } from '../../src/harness/orchestration/cognitive-loop.js';
import type { LayerAssembleContext } from '../../src/harness/context/layer-types.js';
import type { KnowledgeCatalogItem } from '../../src/harness/context/knowledge/types.js';

function mockModel(response: string): ModelProvider {
  return {
    name: 'mock',
    async chat() {
      return { content: response, model: 'mock', finishReason: 'stop' as const };
    },
    async *stream() {},
    async isAvailable() { return true; },
    getModelInfo() { return null; },
    getModelInfos() { return []; },
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

function layerCtx(): LayerAssembleContext {
  return {
    sessionId: 's1',
    messages: [],
    tokenBudget: 2000,
    systemBudget: 2000,
  };
}

const catalog: KnowledgeCatalogItem[] = [
  {
    id: 'src-foo',
    displayName: 'project-foo',
    kind: 'directory',
    status: 'ready',
    description: '主代码与设计文档',
    scaleLabel: '~1.2k files',
    scopeLevel: 'project',
  },
  {
    id: 'src-bar',
    displayName: 'product-specs',
    kind: 'directory',
    status: 'indexing',
    description: '产品需求与 API 规格',
    scopeLevel: 'global',
  },
];

describe('KnowledgeLayer（Tier 0 catalog）', () => {
  it('渲染源列表与描述，不按 query 检索', async () => {
    const layer = new KnowledgeLayer({ getCatalog: () => catalog });
    const result = await layer.assemble(layerCtx());
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Knowledge Sources');
    expect(result!.text).toContain('project-foo');
    expect(result!.text).toContain('主代码与设计文档');
    expect(result!.text).toContain('product-specs');
    expect(result!.sources).toEqual(['src-foo', 'src-bar']);
  });

  it('空 catalog 返回 null', async () => {
    const layer = new KnowledgeLayer({ getCatalog: () => [] });
    expect(await layer.assemble(layerCtx())).toBeNull();
  });

  it('超出 maxEntries 折叠（provider 全集）', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      displayName: `src-${i}`,
      kind: 'file',
    }));
    // provider 返回全集，Layer 负责截断
    const layer = new KnowledgeLayer({ getCatalog: () => many, maxEntries: 3 });
    const result = await layer.assemble(layerCtx());
    expect(result!.text).toContain('…and 9 more');
    expect(result!.text).toContain('src-0');
    expect(result!.text).not.toContain('src-3');
  });

  it('支持异步 provider', async () => {
    const layer = new KnowledgeLayer({
      getCatalog: async () => catalog.slice(0, 1),
    });
    const result = await layer.assemble(layerCtx());
    expect(result!.text).toContain('project-foo');
    expect(result!.text).not.toContain('product-specs');
  });
});

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

  it('高置信度模式写入 Memory method（不写 Knowledge）', async () => {
    const memory = new InMemoryMemoryStore();
    const model = mockModel(JSON.stringify({
      patterns: [{
        type: 'recurring_error',
        description: 'API 频繁超时应加大超时与重试',
        confidence: 0.9,
      }],
    }));

    const reflector = new LLMReflector({ model, memoryStore: memory });
    await reflector.detectPatterns([
      execution({ result: { success: false, error: 'timeout', durationMs: 5000 } }),
      execution({ result: { success: false, error: 'timeout', durationMs: 5000 } }),
    ]);

    const stats = await memory.stats();
    expect(stats.totalEntries).toBe(1);

    const hits = await memory.retrieve({ text: '超时', includeShadow: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].type).toBe('method');
    expect(hits[0].content).toContain('超时');
    expect(hits[0].channel).toBe('model_inference');
  });
});
