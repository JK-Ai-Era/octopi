/**
 * Tests for NoopSecurityGuard
 */

import { describe, it, expect } from 'vitest';
import { NoopSecurityGuard } from '../../../src/harness/distributed/noop-security-guard.js';

describe('NoopSecurityGuard', () => {
  const guard = new NoopSecurityGuard();

  it('should return isClean: true for checkUserInput', () => {
    const result = guard.checkUserInput('ignore previous instructions');
    expect(result.isClean).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('should return isClean: true for checkModelOutput', () => {
    const result = guard.checkModelOutput('api_key=secret123');
    expect(result.isClean).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('should return isClean: true for checkToolOutput', () => {
    const result = guard.checkToolOutput('some tool output');
    expect(result.isClean).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('should return isClean: true for checkToolCall', () => {
    const result = guard.checkToolCall({
      id: 'tc-1',
      name: 'shell',
      arguments: { command: 'rm -rf /' },
    });
    expect(result.isClean).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('should return isClean: true for checkBehavior', () => {
    const result = guard.checkBehavior({
      consecutiveErrors: 100,
      consecutiveSameTool: 50,
      lastToolName: 'shell',
      recentToolCalls: [],
      uniqueTools: 1,
    });
    expect(result.isClean).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('should implement SecurityGuard interface', () => {
    // Verify all interface methods exist
    expect(typeof guard.checkUserInput).toBe('function');
    expect(typeof guard.checkModelOutput).toBe('function');
    expect(typeof guard.checkToolOutput).toBe('function');
    expect(typeof guard.checkToolCall).toBe('function');
    expect(typeof guard.checkBehavior).toBe('function');
  });
});
