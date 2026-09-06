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
    runSummary: { totalTurns: 4, totalToolCalls: 6, failureRate: 0, majorErrors: [], resolvedErrors: [] },
    ...overrides,
  };
}

describe('memory-extractor subsystem (with dedup)', () => {
  it('should store accepted candidates only once for repeated same-source bundle', async () => {
    const memoryStore = new InMemoryMemoryStore();
    // Bundle with enough events to produce candidates AND pass threshold
    const bundle = baseBundle({
      events: [
        { ts: Date.now(), type: 'constraint_set', sessionId: 's1', turnId: 't1', payload: { text: 'Use ESM' } },
        { ts: Date.now(), type: 'user_confirm', sessionId: 's1', turnId: 't2', payload: { text: 'OK' } },
        { ts: Date.now(), type: 'decision_made', sessionId: 's1', turnId: 't3', payload: { text: 'Use SQLite' } },
        { ts: Date.now(), type: 'tool_failure', sessionId: 's1', turnId: 't4' },
        { ts: Date.now(), type: 'tool_failure', sessionId: 's1', turnId: 't5' },
        { ts: Date.now(), type: 'fix_applied', sessionId: 's1', turnId: 't6' },
      ],
    });

    const input1 = {
      payload: { sessionExtractBundle: bundle },
      sessionMetadata: { agentId: 'a1', sessionId: 's1', turnCount: 3 },
    } as any;

    const out1 = await callHandler(input1, memoryStore);
    expect(out1.act?.status).toBe('success');

    const stats1 = await memoryStore.stats();
    expect(stats1.totalEntries).toBeGreaterThanOrEqual(1);

    // same bundle again -> should not increase totalEntries (dedupe)
    const out2 = await callHandler(input1, memoryStore);
    expect(out2.act?.status).toBe('success');

    const stats2 = await memoryStore.stats();
    expect(stats2.totalEntries).toBe(stats1.totalEntries);
  });
});
