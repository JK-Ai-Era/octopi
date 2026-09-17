/**
 * ContextLayer 契约与 DefaultContextAssembler 测试
 *
 * 聚焦契约行为：顺序、总预算 priority 竞争、可选 layerShares 硬顶、manifest、单层失败隔离。
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
import { createDefaultLayers } from '../../src/harness/context/layers.js';

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

  it('默认无单层配额：总量有空时低 priority 大层也可全额纳入', async () => {
    const assembler = new DefaultContextAssembler({ structureReserve: 0 });
    // persona 很小 priority 高；skill 很大 priority 低，但总量装得下
    const result = await assembler.assemble({
      sessionId: 's1',
      messages: [userMsg('q')],
      systemBudget: 2000,
      layers: [
        stubLayer('persona', {
          text: 'P'.repeat(40),
          priority: 100,
          droppable: false,
        }),
        stubLayer('skill', {
          text: 'S'.repeat(400),
          priority: 60,
          droppable: true,
        }),
      ],
    });

    const skill = result.manifest.layers.find((l) => l.id === 'skill');
    expect(skill?.included).toBe(true);
    expect(skill?.budgetTokens).toBeUndefined();
    expect(result.systemPrompt).toContain('SSSS');
  });

  it('总量不够时按 priority 竞争：低优先 droppable 被丢弃/截断', async () => {
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
        }),
        stubLayer('memory', {
          text: 'M'.repeat(80),
          priority: 30,
          droppable: true,
        }),
      ],
    });

    const persona = result.manifest.layers.find((l) => l.id === 'persona');
    const memory = result.manifest.layers.find((l) => l.id === 'memory');
    expect(persona?.included).toBe(true);
    expect(memory?.included !== true || (memory?.tokens ?? 0) < 80).toBe(true);
  });

  it('配置 layerShares 的层即使总量有空也被硬顶截断', async () => {
    const assembler = new DefaultContextAssembler({
      structureReserve: 0,
      layerShares: { skill: 0.05 },
    });
    const result = await assembler.assemble({
      sessionId: 's1',
      messages: [userMsg('q')],
      systemBudget: 1000,
      layers: [
        stubLayer('persona', { text: 'P'.repeat(20), priority: 100, droppable: false }),
        stubLayer('skill', { text: 'S'.repeat(400), priority: 60, droppable: true }),
      ],
    });

    const skill = result.manifest.layers.find((l) => l.id === 'skill');
    expect(skill?.included).toBe(true);
    expect(skill?.budgetTokens).toBe(Math.floor(1000 * 0.05));
    expect(skill!.tokens).toBeLessThanOrEqual(50);
  });

  it('单层 assemble 失败不拖垮整体', async () => {
    const assembler = new DefaultContextAssembler();
    const result = await assembler.assemble({
      sessionId: 's1',
      messages: [userMsg('x')],
      systemBudget: 2000,
      layers: [
        stubLayer('persona', { text: 'OK', priority: 100, droppable: false }),
        stubLayer('memory', { fail: true }),
      ],
    });
    expect(result.systemPrompt).toContain('OK');
    expect(result.manifest.layers.find((l) => l.id === 'memory')?.reason).toMatch(/assemble failed/);
  });

  it('manifest 含 included / tokens / sources', async () => {
    const assembler = new DefaultContextAssembler();
    const result = await assembler.assemble({
      sessionId: 's1',
      messages: [userMsg('x')],
      systemBudget: 2000,
      layers: [
        {
          ...stubLayer('persona', { text: 'BODY', priority: 100, droppable: false }),
          async assemble() {
            return { layerId: 'persona', text: 'BODY', tokens: 4, sources: ['persona'] };
          },
        },
      ],
    });
    const p = result.manifest.layers.find((l) => l.id === 'persona');
    expect(p?.included).toBe(true);
    expect(p?.tokens).toBeGreaterThan(0);
    expect(p?.sources).toEqual(['persona']);
  });
});

describe('createDefaultLayers', () => {
  it('未提供依赖的层不注册', () => {
    const layers = createDefaultLayers({});
    expect(layers).toHaveLength(0);
  });

  it('persona + runtime 注册后 order 正确', () => {
    const layers = createDefaultLayers({
      personaText: () => 'P',
      runtimeText: () => 'R',
    });
    expect(layers.map((l) => l.id).sort()).toEqual(['persona', 'runtime']);
  });
});
