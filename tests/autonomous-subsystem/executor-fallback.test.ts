import { describe, it, expect, vi } from 'vitest';
import { TokenBudgetExceededError } from '../../src/harness/autonomous-subsystem/think/executor.js';

describe('TokenBudgetExceededError', () => {
  it('keeps expected name and message', () => {
    const err = new TokenBudgetExceededError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TokenBudgetExceededError');
    expect(err.message).toBe('boom');
  });

  it('uses default message when omitted', () => {
    const err = new TokenBudgetExceededError();
    expect(err.message).toBe('Subsystem token budget exceeded');
  });
});
