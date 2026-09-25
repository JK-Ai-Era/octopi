/**
 * Memory 召回 + Knowledge catalog 接入默认 Assembler
 */

import { describe, it, expect } from 'vitest';
import { createDefaultSystemPromptAssembler } from '../../src/harness/context/system-prompt-assembler.js';
import { InMemoryMemoryStore } from '../../src/harness/memory/store.js';
import type { Message } from '../../src/core/types.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

describe('Memory/Knowledge 层进 system prompt', () => {
  it('有相关记忆时注入 # 相关记忆', async () => {
    const memoryStore = new InMemoryMemoryStore();
    await memoryStore.store({
      type: 'fact',
      content: '用户偏好 TypeScript strict 模式',
      source: 'test',
      confidence: 0.9,
      importance: 0.8,
      tags: ['typescript'],
    });

    const asm = createDefaultSystemPromptAssembler({ memoryStore });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('typescript strict 怎么开')],
      persona: 'You are test.',
      contextWindow: 32000,
    });

    expect(result.systemPrompt).toContain('相关记忆');
    expect(result.systemPrompt).toContain('TypeScript');
    expect(result.manifest?.layers.find((l) => l.id === 'memory')?.included).toBe(true);
  });

  it('有 catalog 时注入 Knowledge Sources（非内容命中）', async () => {
    const asm = createDefaultSystemPromptAssembler({
      knowledgeCatalog: () => [
        {
          id: 'src-docs',
          displayName: 'octopi-docs',
          kind: 'directory',
          status: 'ready',
          description: '上下文层契约文档',
        },
      ],
    });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('explain octopi context engine')],
      persona: 'You are test.',
      contextWindow: 32000,
    });

    expect(result.systemPrompt).toContain('Knowledge Sources');
    expect(result.systemPrompt).toContain('octopi-docs');
    expect(result.systemPrompt).toContain('上下文层契约文档');
    expect(result.systemPrompt).not.toContain('相关知识');
    expect(result.manifest?.layers.find((l) => l.id === 'knowledge')?.included).toBe(true);
  });

  it('空 catalog 不注入空块，persona 仍在', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const asm = createDefaultSystemPromptAssembler({
      memoryStore,
      knowledgeCatalog: () => [],
    });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('unrelated quantum banana')],
      persona: 'You are test.',
      contextWindow: 32000,
    });
    expect(result.systemPrompt).toContain('You are test.');
    expect(result.systemPrompt).not.toContain('相关记忆');
    expect(result.systemPrompt).not.toContain('Knowledge Sources');
  });

  it('仅注入 retrieval store 时不会因空 persona 短路', async () => {
    const memoryStore = new InMemoryMemoryStore();
    await memoryStore.store({
      type: 'fact',
      content: '使用 vitest 做测试',
      source: 'test',
      confidence: 0.7,
      importance: 0.6,
      tags: [],
    });
    const asm = createDefaultSystemPromptAssembler({ memoryStore });
    const result = await asm.assemble({
      sessionId: 's',
      messages: [userMsg('vitest')],
      persona: '',
      contextWindow: 32000,
    });
    expect(result.systemPrompt).toContain('vitest');
  });
});
