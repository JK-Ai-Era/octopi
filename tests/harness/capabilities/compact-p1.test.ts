/**
 * Capabilities Compact — P1 行为测试
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '../../../src/core/types.js';
import type { LLMMessage } from '../../../src/core/interfaces/model-provider.js';
import { createCompactEngine } from '../../../src/harness/capabilities/compact/index.js';
import { DefaultContextEngine } from '../../../src/harness/context/default-context-engine.js';
import { createMemorySummaryCache } from '../../../src/harness/capabilities/summary/memory-cache.js';
import { createSummaryPort } from '../../../src/harness/capabilities/summary/index.js';
import type { ModelProvider } from '../../../src/core/interfaces/model-provider.js';

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
    cache.set('k1', r);
    cache.set('k2', r);
    cache.set('k3', r);
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k3')).toBeDefined();
  });
});
