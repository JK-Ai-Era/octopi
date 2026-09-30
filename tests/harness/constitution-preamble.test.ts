import { describe, it, expect } from 'vitest';
import { DefaultContextAssembler } from '@octopi-agent/engine/harness/context/assembler.js';
import { PersonaLayer } from '@octopi-agent/engine/harness/context/layers.js';
import { createDefaultSystemPromptAssembler } from '@octopi-agent/engine/harness/context/system-prompt-assembler.js';
import { InMemoryMemoryStore } from '@octopi-agent/engine/harness/memory/store.js';

describe('constitution preamble assembly', () => {
  it('places constitution first and keeps persona', async () => {
    const assembler = new DefaultContextAssembler({
      constitutionPreamble: '# 宪法\nMemory 工具契约在此',
    });
    const result = await assembler.assemble({
      sessionId: 's1',
      systemBudget: 2000,
      messages: [],
      layers: [
        new PersonaLayer({ getText: () => '我是小鱼', sources: ['persona'] }),
      ],
    });
    expect(result.systemPrompt.startsWith('# 宪法')).toBe(true);
    expect(result.systemPrompt).toContain('我是小鱼');
  });

  it('product constitution loads and assembler can be created with it', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const spa = createDefaultSystemPromptAssembler({
      memoryStore,
      constitution: { mode: 'product' },
    });
    const out = await spa.assemble({
      sessionId: 's',
      messages: [{ role: 'user', content: '记住：用 npm', timestamp: Date.now() } as any],
      persona: 'persona-text',
    });
    expect(out.systemPrompt).toContain('memory_store');
    expect(out.systemPrompt).toContain('Memory');
    expect(out.systemPrompt.indexOf('Memory')).toBeLessThan(out.systemPrompt.indexOf('persona-text'));
  });

  it('constitution off yields no platform preamble', async () => {
    const spa = createDefaultSystemPromptAssembler({
      constitution: { mode: 'off' },
    });
    const out = await spa.assemble({
      sessionId: 's',
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() } as any],
      persona: 'only-persona',
    });
    // 无宪法 preamble；层正文仍带层名标签
    expect(out.systemPrompt).toBe('<layer name="Persona">\nonly-persona\n</layer>');
  });
});
