/**
 * ContextLayer 契约与 DefaultContextAssembler 测试
 *
 * 聚焦契约行为：顺序、份额、priority 丢弃、manifest、单层失败隔离。
 * 不测各层业务检索逻辑（后续逐层打磨时再补）。
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '../../src/core/types.js';
import type {
  ContextLayer,
  LayerAssembleContext,
  LayerContent,
} from '../../src/harness/context/layer-types.js';
import { extractLayerQuery, LAYER_ORDER } from '../../src/harness/context/layer-types.js';
import { DefaultContextAssembler } from '../../src/harness/context/assembler.js';
import {
  PersonaLayer,
  RuntimeLayer,
  createDefaultLayers,
} from '../../src/harness/context/layers.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function stubLayer(
  id: ContextLayer['id'],
  opts: {
    priority?: number;
    defaultShare?: number;
    droppable?: boolean;
    order?: number;
    text?: string;
    tokensHint?: number;
    fail?: boolean;
  } = {},
): ContextLayer {
  return {
    id,
    priority: opts.priority ?? 50,
    defaultShare: opts.defaultShare ?? 0.2,
    droppable: opts.droppable ?? true,
    order: opts.order ?? LAYER_ORDER[id],
    async assemble(ctx: LayerAssembleContext): Promise<LayerContent | null> {
      if (opts.fail) throw new Error('layer boom');
      const text = opts.text ?? `[${id}] budget=${ctx.tokenBudget} query=${ctx.query ?? ''}`;
      if (!text.trim()) return null;
      return {
        layerId: id,
        text,
        tokens: opts.tokensHint ?? Math.ceil(text.length / 4),
      };
    },
  };
}

describe('extractLayerQuery', () => {
  it('取最近一条用户消息', () => {
    const q = extractLayerQuery([
      userMsg('first'),
      { role: 'assistant', content: 'ok', timestamp: Date.now() },
      userMsg('second'),
    ]);
    expect(q).toBe('second');
  });

  it('无用户消息时返回空串', () => {
    expect(extractLayerQuery([])).toBe('');
  });
});

describe('DefaultContextAssembler', () => {
  it('无层时产出空 system', async () => {
    const assembler = new DefaultContextAssembler();
    const result = await assembler.assemble({
      sessionId: 's1',
      messages: [],
      systemBudget: 2000,
      layers: [],
    });
    expect(result.systemPrompt).toBe('');
    expect(result.manifest.layers).toHaveLength(0);
  });

  it('按 order 排序拼接，layer 间用分隔符', async () => {
    const assembler = new DefaultContextAssembler();
    const result = await assembler.assemble({
      sessionId: 's1',
      messages: [userMsg('hello')],
      systemBudget: 4000,
      layers: [
        stubLayer('memory', { text: 'MEM', order: 60 }),
        stubLayer('persona', { text: 'PERSONA', order: 20, droppable: false }),
        stubLayer('skill', { text: 'SKILL', order: 30 }),
      ],
    });

    const idxP = result.systemPrompt.indexOf('PERSONA');
    const idxS = result.systemPrompt.indexOf('SKILL');
    const idxM = result.systemPrompt.indexOf('MEM');
    expect(idxP).toBeGreaterThanOrEqual(0);
    expect(idxS).toBeGreaterThan(idxP);
    expect(idxM).toBeGreaterThan(idxS);
    expect(result.systemPrompt).toContain('---');
    expect(result.manifest.usedTokens).toBeGreaterThan(0);
  });

  it('低优先层在预算耗尽时被丢弃或截到极短，高优先保留', async () => {
    const assembler = new DefaultContextAssembler({ structureReserve: 0 });
    const result = await assembler.assemble({
      sessionId: 's1',
      messages: [userMsg('q')],
      systemBudget: 50,
      layers: [
        stubLayer('persona', {
          text: 'P'.repeat(80),
          priority: 100,
          droppable: false,
          defaultShare: 0.95,
          order: 20,
        }),
        stubLayer('memory', {
          text: 'M'.repeat(4000),
          priority: 10,
          droppable: true,
          defaultShare: 0.05,
          order: 60,
        }),
      ],
    });

    const persona = result.manifest.layers.find((l) => l.id === 'persona');
    const memory = result.manifest.layers.find((l) => l.id === 'memory');
    expect(persona?.included).toBe(true);
    // 极小份额：要么丢弃，要么被统一 estimator 截到很短（不会整段 4000 字进入）
    if (memory?.included) {
      expect(memory.tokens).toBeLessThan(10);
    } else {
      expect(memory?.included).toBe(false);
    }
    expect(result.systemPrompt).toContain('P'.repeat(20));
    expect(result.systemPrompt).not.toContain('M'.repeat(50));
  });

  it('单层 assemble 抛错不影响其他层', async () => {
    const assembler = new DefaultContextAssembler();
    const result = await assembler.assemble({
      sessionId: 's1',
      messages: [userMsg('x')],
      systemBudget: 4000,
      layers: [
        stubLayer('persona', { text: 'OK', droppable: false }),
        stubLayer('knowledge', { fail: true }),
      ],
    });

    expect(result.systemPrompt).toContain('OK');
    const failed = result.manifest.layers.find((l) => l.id === 'knowledge');
    expect(failed?.included).toBe(false);
    expect(failed?.reason).toContain('assemble failed');
  });

  it('空内容层标记 empty 且不进入 system', async () => {
    const assembler = new DefaultContextAssembler();
    const result = await assembler.assemble({
      sessionId: 's1',
      messages: [userMsg('x')],
      systemBudget: 4000,
      layers: [
        stubLayer('persona', { text: 'HAS', droppable: false }),
        stubLayer('memory', { text: '   ' }),
      ],
    });
    expect(result.systemPrompt).toBe('HAS');
    expect(result.manifest.layers.find((l) => l.id === 'memory')?.reason).toBe('empty');
  });

  it('不可丢弃层超预算时截断后纳入', async () => {
    const assembler = new DefaultContextAssembler({ structureReserve: 0, layerOverflowRatio: 1 });
    const long = 'X'.repeat(2000); // ~500 tokens
    const result = await assembler.assemble({
      sessionId: 's1',
      messages: [userMsg('x')],
      systemBudget: 400,
      layers: [
        stubLayer('persona', {
          text: long,
          priority: 100,
          droppable: false,
          defaultShare: 1,
          order: 20,
        }),
      ],
    });
    expect(result.manifest.layers[0]?.included).toBe(true);
    // 统一 estimator 截断后应显著短于原文
    expect(result.systemPrompt.length).toBeLessThan(long.length);
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });
});

describe('薄层适配', () => {
  it('PersonaLayer 产出人格文本并保底', async () => {
    const layer = new PersonaLayer({ getText: () => 'You are octopi.' });
    expect(layer.droppable).toBe(false);
    expect(layer.id).toBe('persona');
    const content = await layer.assemble({
      sessionId: 's',
      messages: [],
      tokenBudget: 1000,
      systemBudget: 1000,
    });
    expect(content?.text).toContain('You are octopi.');
  });

  it('RuntimeLayer 包装动态注入', async () => {
    const layer = new RuntimeLayer({
      getText: (ctx) => `tasks for ${ctx.sessionId}`,
    });
    const content = await layer.assemble({
      sessionId: 'abc',
      messages: [],
      tokenBudget: 1000,
      systemBudget: 1000,
    });
    expect(content?.text).toBe('tasks for abc');
  });

  it('createDefaultLayers 只注册有依赖的层', () => {
    const layers = createDefaultLayers({
      personaText: () => 'p',
      runtimeText: () => 'r',
    });
    const ids = layers.map((l) => l.id).sort();
    expect(ids).toEqual(['persona', 'runtime']);
  });
});
