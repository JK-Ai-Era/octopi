/**
 * ScenarioRunner 断言库测试
 *
 * 覆盖所有内置断言：notEmpty, contains, notContains, callsTool, noToolCalls, lengthBetween, matches
 */

import { describe, it, expect } from 'vitest';
import {
  notEmpty,
  contains,
  notContains,
  callsTool,
  noToolCalls,
  lengthBetween,
  matches,
} from '../src/testing/scenario-runner.js';
import type { TurnResult } from '../src/testing/scenario-runner.js';

// 辅助函数：创建 TurnResult
function makeResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    content: 'default content',
    toolCalls: [],
    events: ['turn.end'],
    isEmpty: false,
    durationMs: 100,
    ...overrides,
  };
}

describe('Built-in Assertions', () => {

  describe('notEmpty', () => {
    it('should pass for non-empty response', () => {
      expect(notEmpty()(makeResult({ content: 'hello' }))).toBeNull();
    });

    it('should fail for empty response', () => {
      expect(notEmpty()(makeResult({ content: '', isEmpty: true }))).toBe('Response is empty');
    });

    it('should fail for whitespace-only response', () => {
      // isEmpty 是基于 content.trim() 的，但 notEmpty 检查 isEmpty 标志
      expect(notEmpty()(makeResult({ content: '  ', isEmpty: true }))).toBe('Response is empty');
    });
  });

  describe('contains', () => {
    it('should pass when content contains text', () => {
      expect(contains('world')(makeResult({ content: 'hello world' }))).toBeNull();
    });

    it('should fail when content does not contain text', () => {
      expect(contains('xyz')(makeResult({ content: 'hello world' }))).toBe('Response does not contain "xyz"');
    });

    it('should be case-sensitive', () => {
      expect(contains('Hello')(makeResult({ content: 'hello' }))).toBe('Response does not contain "Hello"');
    });

    it('should handle empty search text', () => {
      expect(contains('')(makeResult({ content: 'anything' }))).toBeNull();
    });
  });

  describe('notContains', () => {
    it('should pass when content does not contain text', () => {
      expect(notContains('xyz')(makeResult({ content: 'hello world' }))).toBeNull();
    });

    it('should fail when content contains text', () => {
      expect(notContains('world')(makeResult({ content: 'hello world' }))).toBe('Response should not contain "world"');
    });
  });

  describe('callsTool', () => {
    it('should pass when specified tool was called', () => {
      expect(callsTool('file_read')(makeResult({ toolCalls: ['file_read', 'file_write'] }))).toBeNull();
    });

    it('should fail when specified tool was not called', () => {
      expect(callsTool('shell')(makeResult({ toolCalls: ['file_read'] }))).toBe('Tool "shell" was not called (called: file_read)');
    });

    it('should fail when no tools were called', () => {
      expect(callsTool('shell')(makeResult({ toolCalls: [] }))).toBe('Tool "shell" was not called (called: none)');
    });
  });

  describe('noToolCalls', () => {
    it('should pass when no tools were called', () => {
      expect(noToolCalls()(makeResult({ toolCalls: [] }))).toBeNull();
    });

    it('should fail when tools were called', () => {
      expect(noToolCalls()(makeResult({ toolCalls: ['file_read'] }))).toBe('Expected no tool calls, but called: file_read');
    });

    it('should fail when multiple tools were called', () => {
      expect(noToolCalls()(makeResult({ toolCalls: ['a', 'b'] }))).toBe('Expected no tool calls, but called: a, b');
    });
  });

  describe('lengthBetween', () => {
    it('should pass when length is in range', () => {
      expect(lengthBetween(1, 100)(makeResult({ content: 'hello' }))).toBeNull();
    });

    it('should pass at exact boundaries', () => {
      expect(lengthBetween(5, 5)(makeResult({ content: 'hello' }))).toBeNull();
    });

    it('should fail when too short', () => {
      expect(lengthBetween(10, 100)(makeResult({ content: 'hi' }))).toBe('Response length 2 not in range [10, 100]');
    });

    it('should fail when too long', () => {
      expect(lengthBetween(1, 3)(makeResult({ content: 'hello world' }))).toBe('Response length 11 not in range [1, 3]');
    });
  });

  describe('matches', () => {
    it('should pass when content matches pattern', () => {
      expect(matches(/^hello/)(makeResult({ content: 'hello world' }))).toBeNull();
    });

    it('should fail when content does not match pattern', () => {
      expect(matches(/^\d+$/)(makeResult({ content: 'hello' }))).toMatch(/does not match/);
    });

    it('should support complex patterns', () => {
      expect(matches(/\d{3}-\d{4}/)(makeResult({ content: 'call 123-4567 now' }))).toBeNull();
    });
  });

  describe('composing multiple assertions', () => {
    it('should all pass for valid result', () => {
      const result = makeResult({
        content: 'I used the file_read tool to read test.txt',
        toolCalls: ['file_read'],
      });

      expect(notEmpty()(result)).toBeNull();
      expect(contains('file_read')(result)).toBeNull();
      expect(callsTool('file_read')(result)).toBeNull();
      expect(lengthBetween(10, 200)(result)).toBeNull();
    });

    it('should detect multiple failures independently', () => {
      const result = makeResult({
        content: '',
        isEmpty: true,
        toolCalls: [],
      });

      expect(notEmpty()(result)).toBe('Response is empty');
      expect(contains('anything')(result)).not.toBeNull();
      // noToolCalls 应该通过
      expect(noToolCalls()(result)).toBeNull();
    });
  });
});
