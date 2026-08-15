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
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('__noop');
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

    it('should truncate large string results', () => {
      const largeResult = 'x'.repeat(2000);
      const result = validator.validate('test', {}, largeResult);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(typeof result.processedResult).toBe('string');
      expect((result.processedResult as string).length).toBeLessThanOrEqual(1050);
    });

    it('should truncate large object results', () => {
      const largeResult = { data: 'x'.repeat(2000) };
      const result = validator.validate('test', {}, largeResult);
      expect(result.warnings.length).toBeGreaterThan(0);
      // 截断后应该是字符串（包含类型信息）
      expect(typeof result.processedResult).toBe('string');
      expect((result.processedResult as string)).toContain('truncated');
    });

    it('should reset noop count on valid result', () => {
      validator.validate('test', {}, null);
      validator.validate('test', {}, null);
      expect(validator.getConsecutiveNoops()).toBe(2);

      validator.validate('test', {}, { data: 'valid' });
      expect(validator.getConsecutiveNoops()).toBe(0);
    });

    it('should not double-count __noop + empty as two noops', () => {
      // { __noop: true } 本身不是 empty（有 __noop 属性），应该只触发 __noop 警告
      const r1 = validator.validate('test', {}, { __noop: true });
      expect(r1.isNoop).toBe(true);
      expect(r1.warnings).toHaveLength(1);
      expect(r1.warnings[0]).toContain('__noop');

      // __noop + 空值：__noop 优先，不再检查 empty
      const r2 = validator.validate('test', {}, { __noop: true, result: null });
      expect(r2.isNoop).toBe(true);
      expect(r2.warnings).toHaveLength(1); // 只有 __noop 警告，不重复
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

    it('should record isNoop in history', () => {
      validator.validate('test', {}, null);
      validator.validate('test', {}, { data: 'valid' });

      const history = validator.getHistory(10);
      expect(history[0].isNoop).toBe(true);
      expect(history[1].isNoop).toBe(false);
    });

    it('should store cloned results in history', () => {
      const original = { data: 'hello' };
      validator.validate('test', {}, original);

      // 修改原始对象
      original.data = 'changed';

      // 历史中应该保留原始值
      const history = validator.getHistory(1);
      expect((history[0].result as { data: string }).data).toBe('hello');
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

    it('should count __noop flagged results in stats', () => {
      validator.validate('test', {}, { __noop: true });
      validator.validate('test', {}, { data: 'valid' });

      const stats = validator.getStats();
      expect(stats.noopCalls).toBe(1);
    });
  });

  describe('config defaults', () => {
    it('should work with default config', () => {
      const v = new ToolValidator();
      const result = v.validate('test', {}, { data: 'hello' });
      expect(result.valid).toBe(true);
    });

    it('should handle null/undefined args gracefully', () => {
      const result = validator.validate('test', null, 'result');
      expect(result.valid).toBe(true);

      const result2 = validator.validate('test', undefined, 'result');
      expect(result2.valid).toBe(true);
    });
  });
});
