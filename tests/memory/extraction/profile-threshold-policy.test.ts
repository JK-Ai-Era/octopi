import { describe, it, expect } from 'vitest';
import { createProfileThresholdPolicy } from '../../../src/harness/memory/extraction/profile-threshold-policy.js';

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

describe('createProfileThresholdPolicy', () => {
  it('should use profile base thresholds and still adapt on failures', () => {
    const policy = createProfileThresholdPolicy({
      profiles: {
        copilot: { baseConfidence: 0.7, baseImportance: 0.7 },
        default: { baseConfidence: 0.6, baseImportance: 0.6 },
      },
      defaultProfile: 'default',
    });

    const healthy = policy({ runSummary: runSummary(), eventCount: 20, agentProfile: 'copilot' });
    const fail = policy({ runSummary: runSummary({ failureRate: 0.8 }), eventCount: 20, agentProfile: 'copilot' });

    expect(healthy.minConfidence).toBeGreaterThanOrEqual(0.7);
    expect(fail.minConfidence).toBeGreaterThan(healthy.minConfidence);
  });

  it('should fallback to default profile when profile missing', () => {
    const policy = createProfileThresholdPolicy({
      profiles: {
        default: { baseConfidence: 0.66, baseImportance: 0.66 },
      },
    });

    const res = policy({ runSummary: runSummary(), eventCount: 12, agentProfile: 'unknown' });
    expect(res.minConfidence).toBeGreaterThanOrEqual(0.66);
    expect(res.minImportance).toBeGreaterThanOrEqual(0.66);
  });
});
