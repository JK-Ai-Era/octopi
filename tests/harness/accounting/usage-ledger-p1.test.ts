/**
 * UsageLedger + cache-aware TokenUsage（P1）
 */

import { describe, it, expect } from 'vitest';
import {
  makeTokenUsage,
  nominalTotalTokens,
  reportedPromptTokens,
  emptyTokenUsage,
} from '../../../src/core/types/turn.js';
import { tokenUsageFromOpenAi, tokenUsageFromAnthropic } from '../../../src/integration/providers/usage.js';
import { UsageLedger } from '../../../src/harness/accounting/usage-ledger.js';

describe('TokenUsage 分项', () => {
  it('makeTokenUsage 无 cache 时 uncached≈prompt', () => {
    const u = makeTokenUsage({ promptTokens: 100, completionTokens: 20 });
    expect(u.cacheAware).toBe(false);
    expect(u.inputUncachedTokens).toBe(100);
    expect(u.outputTokens).toBe(20);
    expect(nominalTotalTokens(u)).toBe(120);
  });

  it('makeTokenUsage 有 cache 时拆分 uncached/cached', () => {
    const u = makeTokenUsage({
      promptTokens: 100,
      completionTokens: 10,
      promptCachedTokens: 70,
    });
    expect(u.cacheAware).toBe(true);
    expect(u.inputUncachedTokens).toBe(30);
    expect(u.inputCachedTokens).toBe(70);
    expect(reportedPromptTokens(u)).toBe(100);
  });
});

describe('Provider usage 解析', () => {
  it('OpenAI cached_tokens', () => {
    const u = tokenUsageFromOpenAi({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(u.cacheAware).toBe(true);
    expect(u.inputCachedTokens).toBe(800);
    expect(u.inputUncachedTokens).toBe(200);
    expect(u.outputTokens).toBe(50);
  });

  it('OpenAI 无 details 时 cacheAware=false', () => {
    const u = tokenUsageFromOpenAi({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    expect(u.cacheAware).toBe(false);
    expect(u.inputUncachedTokens).toBe(10);
  });

  it('Anthropic cache_read / cache_creation', () => {
    const u = tokenUsageFromAnthropic({
      input_tokens: 100,
      output_tokens: 30,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 50,
    });
    expect(u.cacheAware).toBe(true);
    expect(u.inputUncachedTokens).toBe(100);
    expect(u.inputCachedTokens).toBe(400);
    expect(u.inputCacheWriteTokens).toBe(50);
    expect(u.outputTokens).toBe(30);
    expect(reportedPromptTokens(u)).toBe(550);
  });
});

describe('UsageLedger', () => {
  it('累加分项且不触发任何 hard 语义', () => {
    const ledger = new UsageLedger();
    ledger.recordUsage(makeTokenUsage({ promptTokens: 100, completionTokens: 10 }));
    ledger.recordUsage(
      makeTokenUsage({ promptTokens: 200, completionTokens: 20, promptCachedTokens: 150 }),
    );
    ledger.recordToolCall(2);
    const snap = ledger.snapshot({ scope: 'run', sessionId: 's', agentId: 'a' });
    expect(snap.llmCalls).toBe(2);
    expect(snap.cacheAware).toBe(true);
    expect(snap.inputCachedTokens).toBe(150);
    expect(snap.outputTokens).toBe(30);
    expect(snap.toolCalls).toBe(2);
    expect(snap.nominalTotalTokens).toBe(110 + 220);
  });

  it('empty usage 不入账', () => {
    const ledger = new UsageLedger();
    ledger.recordUsage(undefined);
    ledger.recordUsage(emptyTokenUsage());
    // empty still counts as a call if object provided
    expect(ledger.snapshot().llmCalls).toBe(1);
  });
});
