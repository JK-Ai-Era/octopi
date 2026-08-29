/**
 * 流式工具执行和摘要压缩测试
 */

import { describe, test, expect, vi } from 'vitest';
import { createProgressReporter } from '../src/harness/plugin-ecosystem/tools/streaming.js';
import type { ToolProgressEvent } from '../src/harness/plugin-ecosystem/tools/streaming.js';

describe('流式工具执行', () => {
  describe('createProgressReporter', () => {
    test('创建进度报告器', () => {
      const onProgress = vi.fn();
      const reporter = createProgressReporter('test-tool', 'call-1', onProgress);

      expect(reporter.start).toBeInstanceOf(Function);
      expect(reporter.progress).toBeInstanceOf(Function);
      expect(reporter.output).toBeInstanceOf(Function);
      expect(reporter.complete).toBeInstanceOf(Function);
    });

    test('start 触发开始事件', () => {
      const onProgress = vi.fn();
      const reporter = createProgressReporter('test-tool', 'call-1', onProgress);

      reporter.start();

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'start',
          toolName: 'test-tool',
          callId: 'call-1',
        })
      );
    });

    test('progress 触发进度事件', () => {
      const onProgress = vi.fn();
      const reporter = createProgressReporter('test-tool', 'call-1', onProgress);

      reporter.progress(3, 10, 'Processing...');

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'progress',
          progress: { current: 3, total: 10, message: 'Processing...' },
        })
      );
    });

    test('output 触发输出事件', () => {
      const onProgress = vi.fn();
      const reporter = createProgressReporter('test-tool', 'call-1', onProgress);

      reporter.output('stdout', 'hello');

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'output',
          output: { stream: 'stdout', data: 'hello' },
        })
      );
    });

    test('complete 触发完成事件', () => {
      const onProgress = vi.fn();
      const reporter = createProgressReporter('test-tool', 'call-1', onProgress);

      reporter.complete();

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'complete',
          toolName: 'test-tool',
          callId: 'call-1',
        })
      );
    });

    test('无回调时不报错', () => {
      const reporter = createProgressReporter('test-tool', 'call-1');

      expect(() => {
        reporter.start();
        reporter.progress(1, 10);
        reporter.output('stdout', 'data');
        reporter.complete();
      }).not.toThrow();
    });

    test('完整进度报告流程', () => {
      const events: ToolProgressEvent[] = [];
      const reporter = createProgressReporter('compile', 'call-1', (e) => events.push(e));

      reporter.start();
      reporter.progress(1, 3, 'file1.ts');
      reporter.progress(2, 3, 'file2.ts');
      reporter.progress(3, 3, 'file3.ts');
      reporter.complete();

      expect(events).toHaveLength(5);
      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('progress');
      expect(events[4].type).toBe('complete');
    });
  });
});
