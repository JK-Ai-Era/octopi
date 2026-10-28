/**
 * Capabilities Compact — P1 行为测试
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import { createCompactEngine } from '@octopi-agent/engine/harness/context/capabilities/compact/index.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { HeuristicTokenEstimator } from '@octopi-agent/engine/harness/context/token-estimator.js';
import { createMemorySummaryCache } from '@octopi-agent/engine/harness/context/capabilities/summary/memory-cache.js';
import { createSummaryPort } from '@octopi-agent/engine/harness/context/capabilities/summary/index.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function mockProvider(content = '{"ok":true}'): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    async chat() {
      return { content, model: 'm', finishReason: 'stop' as const };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
    async isAvailable() {
      return true;
    },
    getModelInfo() {
      return { name: 'm', contextWindow: 32000 };
    },
    getModelInfos() {
      return [{ name: 'm', contextWindow: 32000 }];
    },
  };
}

describe('createCompactEngine', () => {
  it('structure_only：头尾保护 + 中间摘要', async () => {
    const summarize = vi.fn(async (_m: LLMMessage[]) => 'middle-summarized');
    const engine = createCompactEngine({ defaultProtectHead: 2, defaultProtectTail: 2 });
    const messages = Array.from({ length: 10 }, (_, i) => userMsg(`msg-${i}`));
    const out = await engine.compactMessages(messages, {
      protectHead: 2,
      protectTail: 2,
      mode: 'structure_only',
      summarizeFn: summarize,
    });
    expect(out.compacted).toBe(true);
    expect(summarize).toHaveBeenCalled();
    expect(out.summary).toContain('middle-summarized');
    const view = out.view as Message[];
    expect(view[0]?.content).toBe('msg-0');
    expect(view[view.length - 1]?.content).toBe('msg-9');
    expect(view.some((m) => m.metadata?.source === 'contextSummary')).toBe(true);
  });

  it('structure_only protectHead:0/protectTail:0：视图只留摘要，中段原文不残留', async () => {
    const summarize = vi.fn(async () => 'middle-summarized');
    const engine = createCompactEngine();
    const messages = Array.from({ length: 10 }, (_, i) => userMsg(`m${i}-${'x'.repeat(50)}`));
    const out = await engine.compactMessages(messages, {
      protectHead: 0,
      protectTail: 0,
      mode: 'structure_only',
      summarizeFn: summarize,
    });
    const view = out.view as Message[];
    expect(view).toHaveLength(1);
    expect(view[0]?.metadata?.source).toBe('contextSummary');
    // 中段已被摘要替换：after 远小于 before（回归 slice(-0) 把全量当中段残留的 bug）
    expect(out.tokensAfter ?? 0).toBeLessThan(out.tokensBefore / 2);
  });

  it('head_tail_only protectTail:0：tail 为空，不把全量当尾部', async () => {
    const engine = createCompactEngine();
    const messages = Array.from({ length: 5 }, (_, i) => userMsg(`m${i}`));
    const out = await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 0,
      mode: 'head_tail_only',
    });
    const view = out.view as Message[];
    expect(view).toHaveLength(2);
    expect(view[0]?.content).toBe('m0');
    expect(view.some((m) => m.content === 'm4')).toBe(false);
    expect(out.droppedSummary).toContain('4 messages removed');
  });

  it('summary_only keep_partial protectTail:0：视图只留旧摘要，不残留全量', async () => {
    const engine = createCompactEngine();
    const messages = Array.from({ length: 6 }, (_, i) => userMsg(`k${i}`));
    const out = await engine.compactMessages(messages, {
      protectHead: 0,
      protectTail: 0,
      mode: 'summary_only',
      previousSummary: 'OLD-SUMMARY',
      onSummarizeFail: 'keep_partial',
      // 无 summarizeFn/port → 摘要失败 → keep_partial 兜底视图
    });
    const view = out.view as Message[];
    expect(view).toHaveLength(1);
    expect(String(view[0]?.content)).toContain('OLD-SUMMARY');
    expect(out.reason).toBe('partial');
  });

  it('compactText head_tail_only 短文本：too_short 原样返回，不丢正文（slice(-0) 回归）', async () => {
    const engine = createCompactEngine();
    const out = await engine.compactText('abc', { mode: 'head_tail_only' });
    expect(out.compacted).toBe(false);
    expect(out.reason).toBe('too_short');
    expect(out.view).toBe('abc');
  });

  it('head_tail_only：不调用 LLM', async () => {
    const summarize = vi.fn(async () => 'nope');
    const engine = createCompactEngine();
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}`));
    const out = await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 1,
      mode: 'head_tail_only',
      summarizeFn: summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(out.compacted).toBe(true);
  });

  it('无 summarizer 时 structure 回退截断占位', async () => {
    const engine = createCompactEngine();
    const messages = Array.from({ length: 6 }, (_, i) => userMsg(`x${i}`));
    const out = await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 1,
      mode: 'structure_only',
      onSummarizeFail: 'truncate',
    });
    expect(out.compacted).toBe(true);
    expect(out.summary ?? '').toContain('dropped');
  });

  it('summaryPort 路径：conversation extract', async () => {
    const provider = mockProvider('port-summary-text');
    const port = createSummaryPort({
      providers: new Map([['mock', provider]]),
      fallbackProvider: provider,
    });
    const engine = createCompactEngine({ summaryPort: port });
    const messages = Array.from({ length: 8 }, (_, i) => userMsg(`c${i}-` + 'y'.repeat(50)));
    const out = await engine.compactMessages(messages, {
      protectHead: 1,
      protectTail: 1,
      mode: 'structure_only',
    });
    expect(out.summary).toContain('port-summary-text');
  });

  it('compactText structure_only 返回 string view', async () => {
    const summarize = vi.fn(async () => 'text-summary');
    const engine = createCompactEngine();
    const text = 'HEAD\n' + 'body '.repeat(200) + '\nTAIL';
    const out = await engine.compactText(text, { mode: 'structure_only', summarizeFn: summarize });
    expect(typeof out.view).toBe('string');
    expect(out.summary).toContain('text-summary');
  });
});

describe('DefaultContextEngine 委托 compact', () => {
  it('compactStructural 走 capabilities 引擎并回写摘要', async () => {
    const summarize = vi.fn(async (_m: LLMMessage[], opts?: { previousSummary?: string }) => {
      return opts?.previousSummary ? `updated:${opts.previousSummary}` : 'engine-delegated';
    });
    const engine = new DefaultContextEngine({ protectFirstN: 2, protectLastN: 2 });
    const messages = Array.from({ length: 12 }, (_, i) => userMsg(`h${i}`));
    const result = await engine.compactStructural({
      sessionId: 's-compact',
      agentId: 'a1',
      messages,
      summarize,
    });
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.summary).toContain('engine-delegated');
    expect(summarize).toHaveBeenCalled();
  });

  it('过短消息不压缩', async () => {
    const engine = new DefaultContextEngine({ protectFirstN: 3, protectLastN: 3 });
    const result = await engine.compactStructural({
      sessionId: 's-short',
      messages: [userMsg('a'), userMsg('b')],
    });
    expect(result.compacted).toBe(false);
  });

  it('compactStructural tokensAfter = head+摘要+tail 粘性视图口径', async () => {
    const summarize = async () => 'S'.repeat(100);
    const engine = new DefaultContextEngine({ protectFirstN: 2, protectLastN: 2 });
    const messages = Array.from({ length: 12 }, (_, i) => userMsg(`h${i}-${'x'.repeat(200)}`));
    const result = await engine.compactStructural({
      sessionId: 's-view',
      messages,
      summarize,
    });
    expect(result.compacted).toBe(true);
    const est = new HeuristicTokenEstimator();
    expect(result.tokensAfter ?? 0).toBeLessThan(result.tokensBefore);
    // 口径交叉验证（评审 F16③）：报数与实际装配视图对齐，不复刻实现形状自证
    const after = await engine.assemble({
      sessionId: 's-view',
      messages,
      systemPrompt: 'sys',
      tools: [],
    });
    const body = after.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    expect(body).toHaveLength(5); // head 2 + 摘要 1 + tail 2
    const viewTokens = est.estimateMessages(
      after.messages.filter((m) => m.role !== 'system') as unknown as Message[],
    );
    expect(result.tokensAfter).toBe(viewTokens);
  });

  it('compactStructural 摘要失败且无旧摘要：不虚报压缩（tokensAfter = tokensBefore）', async () => {
    const engine = new DefaultContextEngine({ protectFirstN: 2, protectLastN: 2 });
    const messages = Array.from({ length: 12 }, (_, i) => userMsg(`h${i}-${'x'.repeat(200)}`));
    const result = await engine.compactStructural({
      sessionId: 's-fail',
      messages,
      summarize: async () => {
        throw new Error('boom');
      },
    });
    // 无语义摘要 → 无可建视图（装配侧原样保留全量）→ 报数不得显示压缩收益
    expect(result.summary).toBeUndefined();
    expect(result.tokensAfter).toBe(result.tokensBefore);
  });
});

describe('memory summary cache', () => {
  it('LRU 与 TTL', () => {
    const cache = createMemorySummaryCache({ maxEntries: 2, defaultTtlMs: 60_000 });
    const r = {
      text: 'a',
      coverage: 'full' as const,
      tokensIn: 1,
      tokensOut: 1,
      policyId: 'p',
      kind: 'opaque' as const,
    };
    cache.set('k1', r, 60_000);
    cache.set('k2', r, 60_000);
    cache.set('k3', r, 60_000);
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k3')).toBeDefined();
  });
});

describe('交接式摘要：引擎级接线（同形前缀/边界标注）', () => {
  it('compactStructural 从托管 system 消息内建同形 llmPrefix（缓存同源，指令只在尾部）', async () => {
    const engine = new DefaultContextEngine({ protectFirstN: 2, protectLastN: 2 });
    const captured: LLMMessage[][] = [];
    const summarize = async (msgs: LLMMessage[]) => {
      captured.push(msgs);
      return '1. Goal & status: ok.\n2. Open items: none.\n3. Conclusions: n/a.\n4. Evidence: none.';
    };
    const messages: Message[] = [
      {
        role: 'system',
        content: 'MANAGED-SYS-BYTES',
        timestamp: Date.now(),
        metadata: { source: 'systemPrompt' as const },
      },
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((t) => userMsg(t)),
    ];
    const result = await engine.compactStructural({
      sessionId: 's-prefix',
      messages,
      summarize,
      taskSnapshot: '<session_tasks>T</session_tasks>',
    });

    const request = captured[0]!;
    // system 字节 = 托管 system 消息原文（与真实请求逐字同形，缓存命中前提）
    expect(request[0]).toEqual({ role: 'system', content: 'MANAGED-SYS-BYTES' });
    // 全量历史按序保留在前缀（append-only；托管 system 不重复出现），指令只在尾部 user
    const history = request.slice(1, -1).map((m) => String(m.content));
    expect(history).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    const tail = String(request[request.length - 1]!.content);
    expect(tail).toContain('handoff summary');
    expect(tail).toContain('<session_tasks>T</session_tasks>');
    // 覆盖边界行不烘进摘要正文（评审 F11）：previousSummary 干净，[Coverage] 由装配按覆盖点动态渲染
    expect(result.summary).not.toContain('[Coverage]');
    const assembled = await engine.assemble({
      sessionId: 's-prefix',
      messages,
      systemPrompt: 'sys',
      tools: [],
    });
    const summaryMsg = assembled.messages.find((m) =>
      String(m.content ?? '').includes('[Conversation Summary]'),
    );
    expect(summaryMsg).toBeDefined();
    expect(String(summaryMsg!.content)).toContain('[Coverage]');
    expect(String(summaryMsg!.content)).toContain('up to message 5');
  });

  it('摘要失败不推进覆盖、不虚报（评审 F1/F9/F10/F11）：宁可胖不丢', async () => {
    const engine = new DefaultContextEngine({ protectFirstN: 2, protectLastN: 2 });
    const okSummary =
      '1. Goal & status: ok.\n2. Open items: none.\n3. Conclusions: n/a.\n4. Evidence: none.';
    const messages1: Message[] = Array.from({ length: 7 }, (_, i) =>
      userMsg(`a${i}-${'x'.repeat(200)}`),
    );
    // 第一次成功：产生摘要并推进覆盖
    const ok = await engine.compactStructural({
      sessionId: 's-fail2',
      messages: messages1,
      summarize: async () => okSummary,
    });
    expect(ok.compacted).toBe(true);
    expect(ok.coveredMessageCount).toBeDefined();

    // 第二次摘要持续污染（闸门两次命中）：不推进覆盖、报数不虚降、旧摘要不被重复加 [Coverage]
    const messages2: Message[] = [
      ...messages1,
      ...Array.from({ length: 4 }, (_, i) => userMsg(`b${i}-${'y'.repeat(200)}`)),
    ];
    const bad = await engine.compactStructural({
      sessionId: 's-fail2',
      messages: messages2,
      summarize: async () => '<function=file_edit><new_text>replay</new_text></function>',
    });
    expect(bad.compacted).toBe(false);
    expect(bad.reason).toMatch(/^summarize_failed/);
    expect(bad.tokensAfter).toBe(bad.tokensBefore);
    expect(bad.coveredMessageCount).toBe(ok.coveredMessageCount); // 覆盖点未推进
    expect(String(bad.summary)).not.toContain('[Coverage]');
    expect(String(bad.summary)).toContain('Goal & status'); // 旧摘要兜底，中段原文视图里仍在
  });
});
