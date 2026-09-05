import { describe, it, expect } from 'vitest';
import { BackpressureController } from '../../../src/harness/memory/extraction/backpressure.js';

describe('BackpressureController', () => {
  it('should cap concurrent acquisitions according to maxConcurrentTriggers', async () => {
    const bp = new BackpressureController({
      baseIntervalMs: 1000,
      pendingThreshold: 10,
      backoffIntervalMs: 2000,
      maxConcurrentTriggers: 2,
    });

    await bp.acquire();
    await bp.acquire();

    // third acquire should not resolve immediately
    let resolved = false;
    const p = bp.acquire().then(() => { resolved = true; });

    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    bp.release();
    await p;
    expect(resolved).toBe(true);

    bp.release();
    bp.release();
  });

  it('should return backoff interval when pending >= threshold', () => {
    const bp = new BackpressureController({
      baseIntervalMs: 1000,
      pendingThreshold: 5,
      backoffIntervalMs: 4000,
    });

    expect(bp.getIntervalMs(0)).toBe(1000);
    expect(bp.getIntervalMs(5)).toBe(4000);
    expect(bp.getIntervalMs(100)).toBe(4000);
  });
});
