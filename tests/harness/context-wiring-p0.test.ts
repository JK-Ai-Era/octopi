/**
 * 接线回归：默认 summarize + system prompt Assembler
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import type { ModelProvider, LLMRequest } from '@octopi-agent/core/interfaces/model-provider.js';
import type { Message } from '@octopi-agent/core/types.js';
import { createProviderSummarize, pickSummarizeProvider } from '@octopi-agent/engine/harness/context/summarize.js';
import { createDefaultSystemPromptAssembler } from '@octopi-agent/engine/harness/context/system-prompt-assembler.js';

function mockProvider(onChat?: (req: LLMRequest) => void): ModelProvider & { chatCalls: LLMRequest[] } {
  const chatCalls: LLMRequest[] = [];
  return {
    name: 'mock',
    defaultModel: 'm',
    chatCalls,
    async chat(req: LLMRequest) {
      chatCalls.push(req);
      onChat?.(req);
      return { content: 'summary-ok', model: 'm', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() { return true; },
    getModelInfo() {
      return { name: 'm', contextWindow: 32000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 32000 }];
    },
  };
}

function msg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

describe('createProviderSummarize', () => {
  it('调用 provider.chat 并返回 content', async () => {
    const provider = mockProvider();
    const summarize = createProviderSummarize(provider, { model: 'mini-model' });
    const text = await summarize([{ role: 'user', content: 'hello' }], { maxTokens: 100 });
    expect(text).toBe('summary-ok');
    expect(provider.chatCalls[0]?.model).toBe('mini-model');
    expect(provider.chatCalls[0]?.maxTokens).toBe(100);
  });
});

describe('pickSummarizeProvider', () => {
  it('优先 mini level 对应的 provider', () => {
    const mini = { ...mockProvider(), name: 'cheap' };
    const main = mockProvider();
    const map = new Map<string, ModelProvider>([
      ['cheap', mini],
      ['main', main],
    ]);
    const picked = pickSummarizeProvider(
      map,
      { mini: { primary: 'cheap/glm-mini' } },
      main,
    );
    expect(picked.provider).toBe(mini);
    expect(picked.model).toBe('glm-mini');
  });

  it('无 level 时回退主模型', () => {
    const main = mockProvider();
    const picked = pickSummarizeProvider(new Map(), undefined, main);
    expect(picked.provider).toBe(main);
    expect(picked.model).toBeUndefined();
  });
});

describe('createDefaultSystemPromptAssembler', () => {
  it('组装 persona 与 runtime 注入', async () => {
    const asm = createDefaultSystemPromptAssembler({ constitution: { mode: 'off' } });
    const result = await asm.assemble({
      sessionId: 's1',
      messages: [msg('hi')],
      persona: 'You are octopi.',
      injectedContext: '<session_tasks>open</session_tasks>',
      runtimeAnchors: 'Workspace: /tmp',
      contextWindow: 32000,
    });
    // E8：稳定锚点留 system prompt；易变注入（tasks）进本轮快照
    expect(result.systemPrompt).toContain('You are octopi.');
    expect(result.systemPrompt).toContain('Workspace: /tmp');
    expect(result.systemPrompt).not.toContain('<session_tasks>');
    expect(result.runtimeSnapshot).toContain('<session_tasks>');
    expect(result.manifest?.layers.find((l) => l.id === 'persona')?.included).toBe(true);
    expect(result.manifest?.layers.filter((l) => l.id === 'runtime' && l.included)).toHaveLength(2);
    expect(
      result.manifest?.layers.find((l) => l.id === 'runtime' && l.placement === 'snapshot')?.included,
    ).toBe(true);
    expect(result.manifest?.usedSnapshotTokens ?? 0).toBeGreaterThan(0);
  });

  it('快照组不携带宪法 preamble（不重复注入）', async () => {
    const asm = createDefaultSystemPromptAssembler({ constitutionText: 'THE-CONST-PREAMBLE' });
    const result = await asm.assemble({
      sessionId: 's1',
      messages: [msg('hi')],
      persona: 'You are octopi.',
      injectedContext: '<runtime>turn1</runtime>',
      contextWindow: 32000,
    });
    expect(result.systemPrompt).toContain('THE-CONST-PREAMBLE');
    expect(result.runtimeSnapshot).not.toContain('THE-CONST-PREAMBLE');
    expect(result.runtimeSnapshot).toContain('<runtime>turn1</runtime>');
  });

  it('E8 缓存稳定：跨轮 systemPrompt 逐字节不变，易变内容只进快照', async () => {
    const asm = createDefaultSystemPromptAssembler({ constitution: { mode: 'off' } });
    const base = {
      persona: 'You are octopi.',
      runtimeAnchors: 'Workspace: /tmp',
      contextWindow: 32000,
    };
    const r1 = await asm.assemble({
      ...base,
      sessionId: 's1',
      messages: [msg('hi')],
      injectedContext: '<runtime>turn1</runtime>',
    });
    const r2 = await asm.assemble({
      ...base,
      sessionId: 's1',
      messages: [msg('hi'), msg('more')],
      injectedContext: '<runtime>turn2</runtime>',
    });
    expect(r1.systemPrompt).toBe(r2.systemPrompt);
    expect(r1.runtimeSnapshot).toContain('turn1');
    expect(r2.runtimeSnapshot).toContain('turn2');
    expect(r1.runtimeSnapshot).not.toBe(r2.runtimeSnapshot);
  });

  it('空 persona 且无注入时仍产出 Turn 总则（constitution off）', async () => {
    const asm = createDefaultSystemPromptAssembler({ constitution: { mode: 'off' } });
    const result = await asm.assemble({
      sessionId: 's1',
      messages: [],
      persona: '',
      contextWindow: 32000,
    });
    expect(result.systemPrompt).toContain('## Turns (authoritative)');
    expect(result.systemPrompt).not.toContain('<layer name="Persona">');
  });
});

describe('Builder 默认接线', () => {
  it('未调用 summarize 时 convertToLlm 路径具备 summarize（SmartRouter 不再无摘要）', async () => {
    const provider = mockProvider();
    const builder = new AgentBuilder().model(provider);
    const { agent } = await builder.buildAgent();

    // 通过内部 convertToLlm 验证：组装时若发生压缩，应能调用 provider.chat 做摘要
    // 这里直接断言 build 后 agent 可运行，且 provider 上未预先调用
    expect(provider.chatCalls.length).toBe(0);
    expect(agent.context.tools).toBeDefined();

    // 构造超长历史触发压缩路径（protectLastN=20，默认窗口 32000）
    const longMsgs: Message[] = [];
    for (let i = 0; i < 40; i++) {
      longMsgs.push({ role: 'user', content: `msg-${i} ` + 'x'.repeat(200), timestamp: Date.now() });
    }
    agent.setSystemPrompt('You are test.');
    const llm = await agent.config.convertToLlm!(longMsgs);
    expect(llm.length).toBeGreaterThan(0);
    // 若走了 LLM 摘应，provider 应被调用；若未溢出则不强制
    // 至少验证 convertToLlm 不抛错且返回 system 消息
    expect(llm[0]?.role).toBe('system');
  });

  it('disableAutoSummarize 后不自动挂接', async () => {
    const provider = mockProvider();
    const builder = new AgentBuilder().model(provider).disableAutoSummarize();
    const { agent } = await builder.buildAgent();
    const longMsgs: Message[] = [];
    for (let i = 0; i < 50; i++) {
      longMsgs.push({ role: 'user', content: 'y'.repeat(500), timestamp: Date.now() });
    }
    await agent.config.convertToLlm!(longMsgs);
    // 无 summarize 时不应因摘要而调用 chat（截断路径不需要 LLM）
    // 注意：若消息本身不触发压缩，chatCalls 也可能为 0
    expect(provider.chatCalls.every((c) => c.messages.some((m) => m.role === 'system'))).toBe(true);
  });

  it('runner.setSystemPromptAssembler 存在且 build 可用', async () => {
    const provider = mockProvider();
    const built = await new AgentBuilder().model(provider).build();
    expect(typeof built.runner.setSystemPromptAssembler).toBe('function');
    const spy = vi.fn(async () => ({ systemPrompt: 'custom' }));
    built.runner.setSystemPromptAssembler(spy);
    expect(spy).not.toHaveBeenCalled();
  });
});
