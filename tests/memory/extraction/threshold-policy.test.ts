import { describe, it, expect } from 'vitest';
import { defaultThresholdPolicy } from '../../../src/harness/memory/extraction/threshold-policy.js';

function runSummary(overrides?: Record<string, unknown>) {
  return {
    totalTurns: 4,
    totalToolCalls: 6,
    failureRate: 0,
    majorErrors: [] as string[],
    resolvedErrors: [] as string[],
    ...overrides,
  };
}

describe('defaultThresholdPolicy', () => {
  it('should return base thresholds for healthy session', () => {
    const res = defaultThresholdPolicy({ runSummary: runSummary(), eventCount: 20 });
    expect(res.minConfidence).toBeGreaterThanOrEqual(0.6);
    expect(res.minImportance).toBeGreaterThanOrEqual(0.6);
  });

  it('should increase thresholds when failureRate is high', () => {
    const base = defaultThresholdPolicy({ runSummary: runSummary(), eventCount: 20 });
    const highFail = defaultThresholdPolicy({ runSummary: runSummary({ failureRate: 0.8 }), eventCount: 20 });
    expect(highFail.minConfidence).toBeGreaterThan(base.minConfidence);
    expect(highFail.minImportance).toBeGreaterThan(base.minImportance);
  });

  it('should increase thresholds when eventCount is low', () => {
    const base = defaultThresholdPolicy({ runSummary: runSummary(), eventCount: 20 });
    const lowEvents = defaultThresholdPolicy({ runSummary: runSummary(), eventCount: 3 });
    expect(lowEvents.minConfidence).toBeGreaterThanOrEqual(base.minConfidence);
    expect(lowEvents.minImportance).toBeGreaterThanOrEqual(base.minImportance);
  });
});
