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
    runSummary: { totalTurns: 4, totalToolCalls: 6, failureRate: 0.25, majorErrors: ['E1'], resolvedErrors: ['E1'] },
    ...overrides,
  };
}

describe('memory-extractor subsystem confidence gate', () => {
  it('should reject candidates below thresholds', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const bundle = baseBundle({
      events: [
        { ts: Date.now(), type: 'assistant_summary', sessionId: 's1', turnId: 't1', payload: { length: 120 } },
      ],
    });

    const input = { payload: { sessionExtractBundle: bundle }, sessionMetadata: { agentId: 'a1', sessionId: 's1', turnCount: 1 } } as any;
    const out = await callHandler(input, memoryStore);

    expect(out.act?.status).toBe('success');
    const stats = await memoryStore.stats();
    // discovery candidate default confidence/importance are below 0.9
    expect(stats.totalEntries).toBe(0);
  });
});
