import { describe, it, expect } from 'vitest';
import { extractCandidates } from '../../../src/subsystems/memory-extractor/handler.js';
import type { SessionExtractBundle } from '../../../src/subsystems/memory-extractor/contracts/bundle.js';

function baseBundle(overrides?: Partial<SessionExtractBundle>): SessionExtractBundle {
  return {
    sessionId: 's1',
    agentId: 'a1',
    startAt: Date.now() - 10_000,
    endAt: Date.now(),
    events: [],
    condensedTurns: [],
    runSummary: {
      totalTurns: 4,
      totalToolCalls: 6,
      failureRate: 0.25,
      majorErrors: ['E1'],
      resolvedErrors: ['E1'],
    },
    ...overrides,
  };
}

describe('extractCandidates', () => {
  it('should extract preference when constraint_set exists', () => {
    const bundle = baseBundle({
      events: [
        { ts: Date.now(), type: 'constraint_set', sessionId: 's1', turnId: 't1', payload: { text: 'Use ESM only' } },
        { ts: Date.now(), type: 'user_confirm', sessionId: 's1', turnId: 't1', payload: { text: 'OK' } },
      ],
    });

    const candidates = extractCandidates(bundle);
    const preference = candidates.find((c) => c.type === 'preference');
    expect(preference).toBeTruthy();
    expect(preference!.confidence).toBeGreaterThan(0.6);
    expect(preference!.tags).toContain('human');
  });

  it('should extract lesson when repeated failures then fix', () => {
    const bundle = baseBundle({
      events: [
        { ts: 1, type: 'tool_failure', sessionId: 's1', turnId: 't1' },
        { ts: 2, type: 'error', sessionId: 's1', turnId: 't2' },
        { ts: 3, type: 'fix_applied', sessionId: 's1', turnId: 't3' },
      ],
    });

    const candidates = extractCandidates(bundle);
    expect(candidates.some((c) => c.type === 'lesson')).toBe(true);
  });

  it('should extract decision when decision_made exists', () => {
    const bundle = baseBundle({
      events: [
        { ts: 1, type: 'decision_made', sessionId: 's1', turnId: 't2', payload: { text: 'Use SQLite store' } },
      ],
    });

    const candidates = extractCandidates(bundle);
    expect(candidates.some((c) => c.type === 'decision')).toBe(true);
  });
});
