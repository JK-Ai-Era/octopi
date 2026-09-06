import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '../../../src/harness/memory/store.js';
import { callHandler } from '../../../src/subsystems/memory-extractor/handler.js';
import type { SessionExtractBundle } from '../../../src/harness/memory/extraction/session-extractor.js';

function baseBundle(overrides?: Partial<SessionExtractBundle>): SessionExtractBundle {
  return {
    sessionId: 's1',
    agentId: 'a1',
    startAt: Date.now() - 10_000,
    endAt: Date.now(),
    events: [],
    condensedTurns: [],
    runSummary: { totalTurns: 4, totalToolCalls: 6, failureRate: 0.1, majorErrors: [], resolvedErrors: [] },
    ...overrides,
  };
}

describe('memory extraction e2e regression', () => {
  it('should not duplicate memory entries when same bundle is processed twice', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const bundle = baseBundle({
      events: [
        { ts: Date.now(), type: 'constraint_set', sessionId: 's1', turnId: 't1', payload: { text: 'Use ESM' } },
        { ts: Date.now(), type: 'user_confirm', sessionId: 's1', turnId: 't1', payload: { text: 'OK' } },
        { ts: Date.now(), type: 'decision_made', sessionId: 's1', turnId: 't2', payload: { text: 'Use SQLite' } },
        { ts: Date.now(), type: 'tool_failure', sessionId: 's1', turnId: 't3' },
        { ts: Date.now(), type: 'tool_failure', sessionId: 's1', turnId: 't4' },
        { ts: Date.now(), type: 'fix_applied', sessionId: 's1', turnId: 't5' },
      ],
    });

    const input = {
      payload: { sessionExtractBundle: bundle },
      sessionMetadata: { agentId: 'a1', sessionId: 's1', turnCount: 3 },
    } as any;

    const out1 = await callHandler(input, memoryStore);
    expect(out1.act?.status).toBe('success');
    const stats1 = await memoryStore.stats();
    expect(stats1.totalEntries).toBeGreaterThan(0);

    const out2 = await callHandler(input, memoryStore);
    expect(out2.act?.status).toBe('success');
    const stats2 = await memoryStore.stats();

    // 关键回归：重复处理不应翻倍
    expect(stats2.totalEntries).toBe(stats1.totalEntries);
  });
});
