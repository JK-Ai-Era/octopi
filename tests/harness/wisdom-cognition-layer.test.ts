/**
 * Wisdom / Cognition 接入默认 Assembler + preview
 */

import { describe, it, expect } from 'vitest';
import { createDefaultSystemPromptAssembler } from '@octopi-agent/engine/harness/context/system-prompt-assembler.js';
import { DefaultContextAssembler } from '@octopi-agent/engine/harness/context/assembler.js';
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

    expect(result.systemPrompt).toContain('思维框架');
    expect(result.systemPrompt).toContain('先核对契约');
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

    expect(result.systemPrompt).toContain('相关概念');
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
