/**
 * Wisdom / Cognition 接入默认 Assembler + preview
 */

import { describe, it, expect } from 'vitest';
import { createDefaultSystemPromptAssembler } from '@octopi-agent/engine/harness/context/system-prompt-assembler.js';
import { DefaultContextAssembler } from '@octopi-agent/engine/harness/context/assembler.js';
import { WisdomLayer } from '@octopi-agent/engine/harness/context/layers.js';
import type { LayerAssembleContext } from '@octopi-agent/engine/harness/context/layer-types.js';
import { InMemoryConceptGraph } from '@octopi-agent/engine/harness/memory/cognition.js';
import { InMemoryWisdomStore } from '@octopi-agent/engine/harness/memory/wisdom.js';
import type { Message } from '@octopi-agent/core/types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

async function seedWisdom(store: InMemoryWisdomStore, statement: string) {
  return store.admit({
    statement,
    scenario: { problemTypes: ['验证型宣称'], signals: ['证据'] },
    effect: { posture: '先证伪', questions: ['证据在哪里？'] },
    derivedFrom: { memoryIds: ['m1', 'm2'] },
    kind: 'corrective',
    origin: 'factory',
    initialStatus: 'active',
  });
}

describe('Wisdom/Cognition 层接入默认 Assembler', () => {
  it('WisdomStore 有条目时注入 # 思维框架', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    await seedWisdom(wisdomStore, '先核对契约，再改实现');

    const asm = createDefaultSystemPromptAssembler({ wisdomStore });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('怎么改七层模型')],
      persona: 'You are test.',
      contextWindow: 32000,
    });

    // E8：Wisdom 属易变快照，进 runtimeSnapshot 而非 system prompt
    expect(result.runtimeSnapshot).toContain('思维框架');
    expect(result.runtimeSnapshot).toContain('先核对契约');
    expect(result.systemPrompt).not.toContain('思维框架');
    const wisdom = result.manifest?.layers.find((l) => l.id === 'wisdom');
    expect(wisdom?.included).toBe(true);
  });

  it('CognitionStore 有相关概念时注入 # 相关概念', async () => {
    const graph = new InMemoryConceptGraph();
    const a = await graph.admitConcept({
      name: 'ContextLayer',
      kind: 'construct',
      description: '七层契约',
      supportCount: 2,
    });
    const b = await graph.admitConcept({
      name: 'Assembler',
      kind: 'construct',
      description: '装配器',
      supportCount: 2,
    });
    await graph.admitEdge({
      sourceId: a.id!,
      targetId: b.id!,
      relationType: 'part_of',
      strength: 0.9,
      description: 'layer feeds assembler',
      basis: {
        memoryIds: ['m1', 'm2'],
        cue: 'layer feeds assembler',
        evidenceClass: 'mereonymy',
        licensedAt: Date.now(),
      },
      evidenceText: 'layer feeds assembler',
    });
    await graph.promote([a.id!, b.id!], 'active');

    const asm = createDefaultSystemPromptAssembler({ cognitionStore: graph });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('ContextLayer 和 Assembler 什么关系')],
      persona: 'You are test.',
      contextWindow: 32000,
    });

    expect(result.runtimeSnapshot).toContain('相关概念');
    const cognition = result.manifest?.layers.find((l) => l.id === 'cognition');
    expect(cognition?.included).toBe(true);
  });

  it('未提供 wisdom/cognition 时 manifest 不出现这两层', async () => {
    const asm = createDefaultSystemPromptAssembler({});
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('hello')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    const ids = (result.manifest?.layers ?? []).map((l) => l.id);
    expect(ids).not.toContain('wisdom');
    expect(ids).not.toContain('cognition');
  });

  it('蒸馏出生的 trial 条目场景匹配时被注入且计入 applied（回归：trial 召回死锁）', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    const admitted = await wisdomStore.admit({
      statement: '蒸馏出的范式必须能被试用，否则永远无法挣得信任',
      scenario: { problemTypes: ['验证型宣称', '范围裁剪'], signals: ['证据'] },
      effect: { posture: '先证伪', questions: ['证据在哪里？'] },
      derivedFrom: { memoryIds: ['m1', 'm2'] },
      kind: 'corrective',
      origin: 'distilled',
    });
    expect(admitted.action).toBe('created');
    const entry = await wisdomStore.get(admitted.id!);
    expect(entry?.status).toBe('trial');

    const asm = createDefaultSystemPromptAssembler({ wisdomStore });

    // 场景匹配命中：注入 turn 快照并记 applied
    const hit = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('这是验证型宣称的处理')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(hit.runtimeSnapshot ?? '').toContain('蒸馏出的范式必须能被试用');
    expect((await wisdomStore.get(admitted.id!))?.outcomes.applied).toBe(1);

    // 无场景匹配：trial 形状够格（2 个 problemTypes）但状态不许进 core → 不注入、不记 applied
    const miss = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('今天天气不错')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(miss.runtimeSnapshot ?? '').not.toContain('蒸馏出的范式必须能被试用');
    expect(miss.manifest?.layers.find((l) => l.id === 'wisdom')?.included ?? false).toBe(false);
    expect((await wisdomStore.get(admitted.id!))?.outcomes.applied).toBe(1);
  });

  it('wisdomIncludeTrial:false 时 trial 条目不注入（wisdom.injection.trialVisible 语义）', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    const admitted = await wisdomStore.admit({
      statement: '关闭 trial 可见性后这条范式不应出现',
      scenario: { problemTypes: ['验证型宣称'] },
      effect: { posture: '先证伪' },
      derivedFrom: { memoryIds: ['m1', 'm2'] },
      kind: 'corrective',
      origin: 'distilled',
    });
    const asm = createDefaultSystemPromptAssembler({ wisdomStore, wisdomIncludeTrial: false });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('这是验证型宣称的处理')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(result.runtimeSnapshot ?? '').not.toContain('关闭 trial 可见性后这条范式不应出现');
  });
});

describe('includeLayerContent / preview', () => {
  it('默认写入 content 与 preview', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    await seedWisdom(wisdomStore, 'layer content should appear for UI click-through');

    const asm = createDefaultSystemPromptAssembler({ wisdomStore });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('debug layers')],
      persona: 'You are test.',
      contextWindow: 32000,
    });

    const wisdom = result.manifest?.layers.find((l) => l.id === 'wisdom');
    expect(wisdom?.content).toContain('layer content should appear');
    expect(wisdom?.preview).toBeTruthy();
  });

  it('关闭 includeLayerContent 后 content 为 undefined', async () => {
    const wisdomStore = new InMemoryWisdomStore();
    await seedWisdom(wisdomStore, 'should not leak full content when disabled');
    const assembler = new DefaultContextAssembler({
      includeLayerContent: false,
      includeLayerPreview: false,
    });
    const asm = createDefaultSystemPromptAssembler({ wisdomStore, assembler });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('x')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    const wisdom = result.manifest?.layers.find((l) => l.id === 'wisdom');
    expect(wisdom?.content).toBeUndefined();
    expect(wisdom?.preview).toBeUndefined();
  });
});

describe('WisdomLayer applied 记账', () => {
  it('被 truncate 裁掉的条目不记 applied / 不报 sources', async () => {
    const mk = (id: string, ch: string) => ({
      entry: {
        id,
        statement: ch.repeat(50),
        scenario: { problemTypes: ['t'] },
        effect: {},
      },
      bucket: 'core' as const,
    });
    const applied: string[][] = [];
    const layer = new WisdomLayer({
      select: async () => [mk('w1', '一'), mk('w2', '二')],
      onInjected: (ids) => {
        applied.push(ids);
      },
    });
    // maxChars = max(80, 50*2) = 100：第一条完整保留，第二条被裁掉
    const out = await layer.assemble({
      sessionId: 's',
      messages: [],
      query: 'x',
      tokenBudget: 50,
      systemBudget: 50,
    } satisfies LayerAssembleContext);
    expect(out).not.toBeNull();
    expect(applied).toEqual([['w1']]);
    expect(out!.sources).toContain('w1');
    expect(out!.sources).not.toContain('w2');
    expect(out!.dropped).toBeTruthy();
  });
});
