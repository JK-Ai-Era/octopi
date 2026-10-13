/**
 * ToolEffectPolicy P5 / OP-17 — L1 工具资源限制（timeoutMs 看门狗）
 */
import { describe, it, expect } from 'vitest';

import {
  runWithToolLimits,
  resolveToolTimeoutMs,
  ToolTimeoutError,
} from '@octopi-agent/engine/harness/extension/execution-environment/resource-limits.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('runWithToolLimits', () => {
  it('enforces timeoutMs and throws ToolTimeoutError', async () => {
    await expect(
      runWithToolLimits(async () => {
        await sleep(200);
        return 'never';
      }, { timeoutMs: 30, toolName: 'slow_tool' }),
    ).rejects.toThrow(ToolTimeoutError);

    await expect(
      runWithToolLimits(async () => {
        await sleep(200);
        return 'never';
      }, { timeoutMs: 30, toolName: 'slow_tool' }),
    ).rejects.toThrow(/tool_timeout/);
  });

  it('completes when under limit', async () => {
    const r = await runWithToolLimits(async () => 'ok', { timeoutMs: 1000 });
    expect(r).toBe('ok');
  });

  it('no timeoutMs means only abortSignal can stop', async () => {
    const r = await runWithToolLimits(async (sig) => {
      expect(sig.aborted).toBe(false);
      return 42;
    }, {});
    expect(r).toBe(42);
  });

  it('outer abortSignal aborts the run', async () => {
    const ac = new AbortController();
    const p = runWithToolLimits(
      async (sig) => {
        await sleep(500);
        if (sig.aborted) throw new Error('aborted');
        return 'done';
      },
      { abortSignal: ac.signal, toolName: 't' },
    );
    ac.abort();
    await expect(p).rejects.toThrow(/tool_aborted/);
  });

  it('propagates tool errors unchanged', async () => {
    await expect(
      runWithToolLimits(async () => {
        throw new Error('boom');
      }, { timeoutMs: 1000 }),
    ).rejects.toThrow('boom');
  });

  it('resolveToolTimeoutMs ignores non-positive', () => {
    expect(resolveToolTimeoutMs({ timeoutMs: 500 })).toBe(500);
    expect(resolveToolTimeoutMs({ timeoutMs: 0 })).toBeUndefined();
    expect(resolveToolTimeoutMs({ timeoutMs: -1 })).toBeUndefined();
    expect(resolveToolTimeoutMs({})).toBeUndefined();
    expect(resolveToolTimeoutMs()).toBeUndefined();
  });
});
