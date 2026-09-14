import { describe, it, expect } from 'vitest';
import { estimateTextTokens } from '../../src/harness/context/token-estimator.js';
import { TokenBudgetExceededError } from '../../src/harness/autonomous-subsystem/think/executor.js';
import { ThinkExecutor } from '../../src/harness/autonomous-subsystem/think/executor.js';
import { ModelResolver } from '../../src/harness/autonomous-subsystem/think/model-resolver.js';

const resolver = new ModelResolver({ levels: {}, defaultProvider: 'mock' });
const executor = new ThinkExecutor({
  modelResolver: resolver,
  modelProvider: {} as never,
  errorStrategy: {} as never,
});

describe('token budget uses heuristic estimator (not raw char length)', () => {
  it('English JSON: estimate ≈ chars/4, far below raw char length', () => {
    const en = 'memory extraction candidate '.repeat(40);
    const raw = JSON.stringify({ content: en });
    expect(estimateTextTokens(raw)).toBeLessThan(raw.length / 2);
    expect(estimateTextTokens(raw)).toBeGreaterThan(0);
  });

  it('CJK JSON: estimator tracks token density (≈1 token/char)', () => {
    const cjk = '中文记忆提取测试'.repeat(50);
    const raw = JSON.stringify({ content: cjk });
    // CJK 每字约 1 token，与 code unit 数同量级；不应盲目等于 raw.length 以外的错误口径
    const tokens = estimateTextTokens(raw);
    expect(tokens).toBeGreaterThan(cjk.length * 0.5);
    expect(tokens).toBeLessThan(cjk.length * 2);
  });

  it('code path rejects when estimate exceeds budget, allows when under', async () => {
    const think = {
      strategy: 'deterministic' as const,
      implementation: 'code' as const,
      handler: async () => ({ signals: [{ action: 'no-op' as const, reason: 'ok' }] }),
    };

    await expect(
      executor.execute(think, { workingDirectory: '/tmp' }, 'none', undefined, {}, {
        tokenBudget: 1,
      }),
    ).rejects.toBeInstanceOf(TokenBudgetExceededError);

    await expect(
      executor.execute(think, { workingDirectory: '/tmp' }, 'none', undefined, {}, {
        tokenBudget: 10_000,
      }),
    ).resolves.toMatchObject({ output: { signals: [{ action: 'no-op' }] } });
  });
});
