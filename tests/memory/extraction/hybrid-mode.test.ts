import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '../../../src/harness/memory/store.js';
import { callHandler } from '../../../src/subsystems/memory-extractor/handler.js';
import type { SessionExtractBundle } from '../../../src/harness/memory/extraction/session-extractor.js';
import type { ModelProvider, LLMResponse } from '../../../src/core/interfaces/model-provider.js';

function mockModelProvider(llmResponse: string): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'mock-mini',
    async chat(): Promise<LLMResponse> {
      return {
        content: llmResponse,
        model: 'mock-mini',
        finishReason: 'stop',
      };
    },
    async *stream() { yield { type: 'done' as const }; },
    async isAvailable() { return true; },
    getModelInfo() { return null; },
    getModelInfos() { return []; },
  };
}

function baseBundle(overrides?: Partial<SessionExtractBundle>): SessionExtractBundle {
  return {
    sessionId: 's-hybrid-1',
    agentId: 'a1',
    startAt: Date.now() - 60_000,
    endAt: Date.now(),
    events: [],
    condensedTurns: [],
    runSummary: { totalTurns: 3, totalToolCalls: 2, failureRate: 0, majorErrors: [], resolvedErrors: [] },
    ...overrides,
  };
}

describe('memory-extractor hybrid mode (LLM enrichment)', () => {
  it('should combine rule and LLM candidates in hybrid mode', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const llmOutput = JSON.stringify([
      {
        type: 'preference',
        content: '用户偏好简洁的代码风格，不喜欢过多注释',
        confidence: 0.85,
        importance: 0.75,
        evidence: ['用户说"代码自解释就好"'],
      },
    ]);

    const bundle = baseBundle({
      events: [
        { ts: Date.now() - 50_000, type: 'constraint_set', sessionId: 's-hybrid-1', turnId: 't1',
          payload: { text: '用 TypeScript strict mode' } },
        { ts: Date.now() - 40_000, type: 'assistant_summary', sessionId: 's-hybrid-1', turnId: 't2',
          payload: { text: '用户提到代码自解释就好，不需要过多注释。总结：启用 strict mode，减少冗余注释。' } },
      ],
    });

    const input = {
      payload: { sessionExtractBundle: bundle },
      sessionMetadata: { agentId: 'a1', sessionId: 's-hybrid-1', turnCount: 2 },
    } as any;

    const result = await callHandler(input, memoryStore, {
      modelProvider: mockModelProvider(llmOutput),
      config: { llmEnrichment: { model: 'mini' } },
    });

    expect(result.signals[0].data?.mode).toBe('hybrid');
    expect(result.signals[0].data?.ruleCandidateCount).toBeGreaterThanOrEqual(1);
    expect(result.signals[0].data?.llmCandidateCount).toBe(1);

    const stats = await memoryStore.stats();
    expect(stats.totalEntries).toBeGreaterThanOrEqual(2);

    const allEntries = await memoryStore.retrieve({ text: '', limit: 100, updateAccess: false });
    const llmEntry = allEntries.find((e) => e.tags.includes('llm'));
    expect(llmEntry).toBeDefined();
    expect(llmEntry!.content).toContain('简洁');
  });

  it('should fallback to code mode when LLM fails', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const failingProvider: ModelProvider = {
      name: 'mock-fail',
      async chat() { throw new Error('LLM unavailable'); },
      async *stream() { yield { type: 'done' as const }; },
      async isAvailable() { return false; },
      getModelInfo() { return null; },
      getModelInfos() { return []; },
    };

    const bundle = baseBundle({
      events: [
        { ts: Date.now() - 50_000, type: 'constraint_set', sessionId: 's-hybrid-2', turnId: 't1',
          payload: { text: 'Use ESM' } },
        { ts: Date.now() - 40_000, type: 'user_confirm', sessionId: 's-hybrid-2', turnId: 't1',
          payload: { text: 'OK' } },
      ],
    });

    const input = {
      payload: { sessionExtractBundle: bundle },
      sessionMetadata: { agentId: 'a1', sessionId: 's-hybrid-2', turnCount: 1 },
    } as any;

    const result = await callHandler(input, memoryStore, {
      modelProvider: failingProvider,
      config: { llmEnrichment: { model: 'mini' } },
    });

    expect(result.act?.status).toBe('success');
    expect(result.signals[0].data?.mode).toBe('hybrid');
    expect(result.signals[0].data?.llmCandidateCount).toBe(0);
    expect(result.signals[0].data?.ruleCandidateCount).toBeGreaterThanOrEqual(1);
  });

  it('should use code mode when no modelProvider is injected', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const bundle = baseBundle({
      events: [
        { ts: Date.now() - 50_000, type: 'constraint_set', sessionId: 's-code-1', turnId: 't1',
          payload: { text: 'Use ESM' } },
      ],
    });

    const input = {
      payload: { sessionExtractBundle: bundle },
      sessionMetadata: { agentId: 'a1', sessionId: 's-code-1', turnCount: 1 },
    } as any;

    const result = await callHandler(input, memoryStore);
    expect(result.signals[0].data?.mode).toBe('code');
    expect(result.signals[0].data?.llmCandidateCount).toBe(0);
  });
});
