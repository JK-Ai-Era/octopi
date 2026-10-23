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
    // 无宪法 preamble；Turn 总则恒在；层正文仍带层名标签
    expect(out.systemPrompt).toContain('## Turns (authoritative)');
    expect(out.systemPrompt).toContain('<layer name="Persona">\nonly-persona\n</layer>');
    expect(out.systemPrompt).not.toContain('# 宪法');
  });

  it('purpose 全局说明恒在 system 稳定块（含 constitution off；方案 S）', async () => {
    const { TOOL_PURPOSE_SYSTEM_NOTE } = await import('@octopi-agent/engine/harness/agent/tool-purpose.js');
    for (const constitution of [{ mode: 'off' as const }, { mode: 'product' as const }]) {
      const spa = createDefaultSystemPromptAssembler({ constitution });
      const out = await spa.assemble({
        sessionId: 's',
        messages: [{ role: 'user', content: 'hi', timestamp: Date.now() } as any],
        persona: 'persona-text',
      });
      expect(out.systemPrompt).toContain(TOOL_PURPOSE_SYSTEM_NOTE);
      // 恰好一次：单一文案源，不得在装配面再冒出第二份（builder 兜底 prompt 已删重）
      expect(out.systemPrompt.split(TOOL_PURPOSE_SYSTEM_NOTE).length - 1).toBe(1);
      // 固定块在层正文之前（缓存稳定前缀）
      expect(out.systemPrompt.indexOf(TOOL_PURPOSE_SYSTEM_NOTE))
        .toBeLessThan(out.systemPrompt.indexOf('persona-text'));
    }
  });

  it('空装配路径（无 persona/层）也带 purpose 全局说明', async () => {
    const { TOOL_PURPOSE_SYSTEM_NOTE } = await import('@octopi-agent/engine/harness/agent/tool-purpose.js');
    const spa = createDefaultSystemPromptAssembler({ constitution: { mode: 'off' } });
    const out = await spa.assemble({ sessionId: 's', messages: [], persona: '' });
    expect(out.systemPrompt).toContain(TOOL_PURPOSE_SYSTEM_NOTE);
  });
});
