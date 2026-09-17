/**
 * Wisdom / Cognition 接入默认 Assembler + preview
 */

import { describe, it, expect } from 'vitest';
import { createDefaultSystemPromptAssembler } from '../../src/harness/context/system-prompt-assembler.js';
import { DefaultContextAssembler } from '../../src/harness/context/assembler.js';
import { InMemoryConceptGraph } from '../../src/harness/memory/cognition.js';
import type { WisdomStore, WisdomEntry } from '../../src/harness/memory/types.js';
import type { Message } from '../../src/core/types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

class TestWisdomStore implements WisdomStore {
  private entries: WisdomEntry[] = [];

  async store(entry: Omit<WisdomEntry, 'id' | 'createdAt'>): Promise<string> {
    const id = `wis_${this.entries.length + 1}`;
    this.entries.push({ ...entry, id, createdAt: Date.now() });
    return id;
  }

  async getAll(): Promise<WisdomEntry[]> {
    return this.entries;
  }

  async delete(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
  }
}

describe('Wisdom/Cognition 层接入默认 Assembler', () => {
  it('WisdomStore 有条目时注入 # 思维框架', async () => {
    const wisdomStore = new TestWisdomStore();
    await wisdomStore.store({
      content: '先核对契约，再改实现',
      derivedFrom: ['lesson'],
      priority: 80,
    });

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
    const a = await graph.addConcept({ name: 'ContextLayer', description: '七层契约' });
    const b = await graph.addConcept({ name: 'Assembler', description: '装配器' });
    await graph.addEdge({
      sourceId: a,
      targetId: b,
      relationType: 'related',
      strength: 0.9,
      description: 'layer feeds assembler',
    });

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

  it('未提供 wisdom/cognition 时 manifest 不出现这两层（或 unregistered 由 snapshot 侧呈现）', async () => {
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
    const wisdomStore = new TestWisdomStore();
    await wisdomStore.store({
      content: 'layer content should appear for UI click-through',
      derivedFrom: [],
      priority: 50,
    });

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
    const wisdomStore = new TestWisdomStore();
    await wisdomStore.store({
      content: 'should not leak full content when disabled',
      derivedFrom: [],
      priority: 10,
    });
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
