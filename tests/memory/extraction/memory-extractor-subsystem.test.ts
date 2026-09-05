import { describe, it, expect } from 'vitest';
import { InMemoryMemoryStore } from '../../../src/harness/memory/store.js';
import { createMemoryExtractorSubsystem } from '../../../src/harness/memory/extraction/memory-extractor-subsystem.js';
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

describe('memory-extractor subsystem (with dedup)', () => {
  it('should store accepted candidates only once for repeated same-source bundle', async () => {
    const memoryStore = new InMemoryMemoryStore();
    const { spec } = createMemoryExtractorSubsystem({ memoryStore });

    // We can call think handler directly via spec.think.handler
    const handler = spec.think.handler!;

    const bundle = baseBundle({
      events: [
        { ts: Date.now(), type: 'constraint_set', sessionId: 's1', turnId: 't1', payload: { text: 'Use ESM' } },
      ],
    });

    const input1 = {
      payload: { sessionExtractBundle: bundle },
      sessionMetadata: { agentId: 'a1', sessionId: 's1', turnCount: 1 },
    } as any;

    const out1 = await handler(input1);
    expect(out1.act?.status).toBe('success');

    const stats1 = await memoryStore.stats();
    expect(stats1.totalEntries).toBeGreaterThanOrEqual(1);

    // same bundle again -> should not increase totalEntries (dedupe)
    const out2 = await handler(input1);
    expect(out2.act?.status).toBe('success');

    const stats2 = await memoryStore.stats();
    expect(stats2.totalEntries).toBe(stats1.totalEntries);
  });
});
