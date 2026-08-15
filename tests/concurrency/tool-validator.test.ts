import { describe, it, expect, beforeEach } from 'vitest';
import { ToolValidator } from '../../src/harness/concurrency/tool-validator.js';

describe('ToolValidator', () => {
  let validator: ToolValidator;

  beforeEach(() => {
    validator = new ToolValidator({
      maxResultSize: 1000,
      noopThreshold: 3,
      emptyIsNoop: true,
    });
  });

  describe('validate', () => {
    it('should accept normal results', () => {
      const result = validator.validate('test', {}, { data: 'hello' });
      expect(result.valid).toBe(true);
      expect(result.isNoop).toBe(false);
      expect(result.consecutiveNoops).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should detect __noop flag', () => {
      const result = validator.validate('test', {}, { __noop: true, result: 'no change' });
      expect(result.isNoop).toBe(true);
      expect(result.consecutiveNoops).toBe(1);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should detect empty results', () => {
      const r1 = validator.validate('test', {}, null);
      expect(r1.isNoop).toBe(true);
      expect(r1.consecutiveNoops).toBe(1);

      const r2 = validator.validate('test', {}, '');
      expect(r2.isNoop).toBe(true);
      expect(r2.consecutiveNoops).toBe(2);

      const r3 = validator.validate('test', {}, {});
      expect(r3.isNoop).toBe(true);
      expect(r3.consecutiveNoops).toBe(3);
    });

    it('should detect empty arrays', () => {
      const result = validator.validate('test', {}, []);
      expect(result.isNoop).toBe(true);
    });

    it('should detect whitespace-only strings', () => {
      const result = validator.validate('test', {}, '   \n  ');
      expect(result.isNoop).toBe(true);
    });

    it('should truncate large results', () => {
      const largeResult = 'x'.repeat(2000);
      const result = validator.validate('test', {}, largeResult);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(typeof result.processedResult).toBe('string');
      expect((result.processedResult as string).length).toBeLessThanOrEqual(1050); // 1000 + truncation notice
    });

    it('should reset noop count on valid result', () => {
      validator.validate('test', {}, null);
      validator.validate('test', {}, null);
      expect(validator.getConsecutiveNoops()).toBe(2);

      validator.validate('test', {}, { data: 'valid' });
      expect(validator.getConsecutiveNoops()).toBe(0);
    });
  });

  describe('isNoopLoop', () => {
    it('should return false initially', () => {
      expect(validator.isNoopLoop()).toBe(false);
    });

    it('should return true after threshold reached', () => {
      validator.validate('test', {}, null);
      validator.validate('test', {}, null);
      expect(validator.isNoopLoop()).toBe(false);

      validator.validate('test', {}, null);
      expect(validator.isNoopLoop()).toBe(true);
    });

    it('should reset after valid result', () => {
      validator.validate('test', {}, null);
      validator.validate('test', {}, null);
      validator.validate('test', {}, null);
      expect(validator.isNoopLoop()).toBe(true);

      validator.validate('test', {}, { data: 'valid' });
      expect(validator.isNoopLoop()).toBe(false);
    });
  });

  describe('history', () => {
    it('should track call history', () => {
      validator.validate('tool1', { a: 1 }, 'result1');
      validator.validate('tool2', { b: 2 }, 'result2');

      const history = validator.getHistory(10);
      expect(history).toHaveLength(2);
      expect(history[0].toolName).toBe('tool1');
      expect(history[1].toolName).toBe('tool2');
    });

    it('should limit history size', () => {
      for (let i = 0; i < 150; i++) {
        validator.validate('test', {}, `result${i}`);
      }

      const history = validator.getHistory(150);
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });

  describe('stats', () => {
    it('should calculate stats correctly', () => {
      validator.validate('tool1', {}, { data: 'hello' });
      validator.validate('tool1', {}, null);
      validator.validate('tool2', {}, { data: 'world' });

      const stats = validator.getStats();
      expect(stats.totalCalls).toBe(3);
      expect(stats.noopCalls).toBe(1);
      expect(stats.uniqueTools.has('tool1')).toBe(true);
      expect(stats.uniqueTools.has('tool2')).toBe(true);
      expect(stats.avgResultSize).toBeGreaterThan(0);
    });
  });
});
