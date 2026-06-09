/**
 * AsyncTask 测试
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AsyncTask,
  TaskTimeoutError,
  TaskCancelledError,
  spawnTask,
  TaskEvents,
  DefaultEventBus,
} from '../../src/core/index.js';
import type { EventBus, AgentEvent } from '../../src/core/index.js';
import type { TaskStore, TaskRecord } from '../../src/core/index.js';

// ── 辅助 ──

function createEvents(): { bus: EventBus; events: AgentEvent[] } {
  const bus = new DefaultEventBus();
  const events: AgentEvent[] = [];
  bus.onAll((e) => events.push(e));
  return { bus, events };
}

function createMockStore(): TaskStore & { records: Map<string, TaskRecord> } {
  const records = new Map<string, TaskRecord>();
  return {
    records,
    async create(task) {
      records.set(task.id, task);
      return task.id;
    },
    async update(taskId, patch) {
      const existing = records.get(taskId);
      if (existing) records.set(taskId, { ...existing, ...patch });
    },
    async get(taskId) { return records.get(taskId) ?? null; },
    async query() { return Array.from(records.values()); },
    async delete(taskId) { records.delete(taskId); },
    async cleanup() { return 0; },
  };
}

// ── 测试 ──

describe('AsyncTask', () => {
  describe('基本生命周期', () => {
    it('创建后状态为 pending', () => {
      const task = new AsyncTask({ type: 'test' });
      expect(task.status).toBe('pending');
      expect(task.isDone).toBe(false);
    });

    it('执行成功后状态为 completed', async () => {
      const task = new AsyncTask<string>({ type: 'test' });
      const result = await task.run(async () => 'hello');
      expect(result).toBe('hello');
      expect(task.status).toBe('completed');
      expect(task.output).toBe('hello');
      expect(task.isDone).toBe(true);
    });

    it('执行失败后状态为 failed', async () => {
      const task = new AsyncTask({ type: 'test' });
      // 观察内部 promise（run 失败会 reject 它）
      task.promise.catch(() => {});
      try {
        await task.run(async () => { throw new Error('boom'); });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect((e as Error).message).toBe('boom');
      }
      expect(task.status).toBe('failed');
      expect(task.error).toBe('boom');
      expect(task.isDone).toBe(true);
    });

    it('不能对非 pending 状态执行 run', async () => {
      const task = new AsyncTask({ type: 'test' });
      await task.run(async () => 'ok');
      await expect(task.run(async () => 'again'))
        .rejects.toThrow('not pending');
    });
  });

  describe('取消', () => {
    it('可以取消 pending 任务', () => {
      const task = new AsyncTask({ type: 'test' });
      // 观察内部 promise（cancel 会 reject 它）
      task.promise.catch(() => {});
      task.cancel('no longer needed');
      expect(task.status).toBe('cancelled');
      expect(task.isDone).toBe(true);
    });

    it('可以取消 running 任务', async () => {
      const task = new AsyncTask({ type: 'test' });

      // 启动但不等待
      const runPromise = task.run(async (_input, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(resolve, 10000);
        });
      }).catch(() => {}); // 捕获 rejection

      // 也观察内部 promise（cancel 会 reject 它）
      task.promise.catch(() => {});

      // 等一下让任务开始执行
      await new Promise(r => setTimeout(r, 10));
      expect(task.status).toBe('running');

      task.cancel('user requested');
      expect(task.status).toBe('cancelled');
    });

    it('取消已完成的任务无效果', async () => {
      const task = new AsyncTask<string>({ type: 'test' });
      await task.run(async () => 'done');
      task.cancel('too late'); // 不应抛错
      expect(task.status).toBe('completed');
    });

    it('wait 对取消的任务抛出 TaskCancelledError', async () => {
      const task = new AsyncTask({ type: 'test' });
      task.promise.catch(() => {}); // 观察内部 promise
      task.cancel('test');
      await expect(task.wait()).rejects.toThrow(TaskCancelledError);
    });
  });

  describe('超时', () => {
    it('超时后任务失败', async () => {
      const task = new AsyncTask({ type: 'test', timeoutMs: 50 });
      // 观察内部 promise（超时会 reject 它）
      task.promise.catch(() => {});
      await expect(task.run(async () => {
        await new Promise(r => setTimeout(r, 1000));
        return 'never';
      })).rejects.toThrow(TaskTimeoutError);

      expect(task.status).toBe('failed');
      expect(task.error).toContain('timed out');
    });

    it('wait 支持超时参数', async () => {
      const task = new AsyncTask<string>({ type: 'test' });
      // 永不完成的任务
      task.run(async () => {
        await new Promise(() => {});
        return 'never';
      }).catch(() => {});
      // 观察内部 promise（wait 超时会 reject 它）
      task.promise.catch(() => {});

      await expect(task.wait(50)).rejects.toThrow(TaskTimeoutError);
    });
  });

  describe('重试', () => {
    it('失败后自动重试', async () => {
      let attempts = 0;
      const task = new AsyncTask<string>({ type: 'test', maxRetries: 2 });

      const result = await task.run(async () => {
        attempts++;
        if (attempts < 3) throw new Error(`fail ${attempts}`);
        return 'success';
      });

      expect(result).toBe('success');
      expect(attempts).toBe(3);
      expect(task.retryCount).toBe(2);
    });

    it('超过最大重试次数后失败', async () => {
      let attempts = 0;
      const task = new AsyncTask({ type: 'test', maxRetries: 1 });
      task.promise.catch(() => {}); // 观察内部 promise

      try {
        await task.run(async () => {
          attempts++;
          throw new Error(`fail ${attempts}`);
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect((e as Error).message).toBe('fail 2');
      }

      expect(attempts).toBe(2); // 1 初始 + 1 重试
      expect(task.retryCount).toBe(1);
    });
  });

  describe('事件', () => {
    it('发射 created/start/completed 事件', async () => {
      const { bus, events } = createEvents();
      const task = new AsyncTask({ type: 'test', agentId: 'agent-1' }, bus);
      await task.run(async () => 'ok');

      const types = events.map(e => e.type);
      expect(types).toContain(TaskEvents.CREATED);
      expect(types).toContain(TaskEvents.STARTED);
      expect(types).toContain(TaskEvents.COMPLETED);
    });

    it('失败时发射 failed 事件', async () => {
      const { bus, events } = createEvents();
      const task = new AsyncTask({ type: 'test' }, bus);
      task.promise.catch(() => {}); // 观察内部 promise
      try { await task.run(async () => { throw new Error('fail'); }); } catch { /* expected */ }

      expect(events.some(e => e.type === TaskEvents.FAILED)).toBe(true);
    });

    it('取消时发射 cancelled 事件', async () => {
      const { bus, events } = createEvents();
      const task = new AsyncTask({ type: 'test' }, bus);
      // cancel 会 reject promise，需要观察
      task.promise.catch(() => {});
      task.cancel();

      expect(events.some(e => e.type === TaskEvents.CANCELLED)).toBe(true);
    });
  });

  describe('持久化', () => {
    it('创建时调用 store.create', () => {
      const { bus } = createEvents();
      const store = createMockStore();
      new AsyncTask({ type: 'test' }, bus, store);

      expect(store.records.size).toBe(1);
    });

    it('完成后调用 store.update', async () => {
      const { bus } = createEvents();
      const store = createMockStore();
      const task = new AsyncTask<string>({ type: 'test' }, bus, store);
      await task.run(async () => 'done');

      const record = Array.from(store.records.values())[0];
      expect(record.status).toBe('completed');
      expect(record.output).toBe('done');
    });

    it('失败时 store 记录 failed 状态', async () => {
      const { bus } = createEvents();
      const store = createMockStore();
      const task = new AsyncTask({ type: 'test' }, bus, store);
      task.promise.catch(() => {}); // 观察内部 promise
      try { await task.run(async () => { throw new Error('fail'); }); } catch { /* expected */ }

      const record = Array.from(store.records.values())[0];
      expect(record.status).toBe('failed');
    });
  });

  describe('toRecord', () => {
    it('返回完整的任务记录', async () => {
      const task = new AsyncTask<string>({ type: 'test', agentId: 'a1' });
      await task.run(async () => 'result');

      const record = task.toRecord();
      expect(record.id).toBe(task.id);
      expect(record.type).toBe('test');
      expect(record.status).toBe('completed');
      expect(record.output).toBe('result');
      expect(record.agentId).toBe('a1');
    });
  });

  describe('spawnTask', () => {
    it('创建并立即启动任务', async () => {
      const { bus } = createEvents();
      const task = spawnTask<string>({ type: 'test' }, async () => 'quick', bus);

      expect(task.status).toBe('running');
      const result = await task.wait();
      expect(result).toBe('quick');
    });
  });

  describe('AbortSignal', () => {
    it('signal 在取消时触发', async () => {
      const task = new AsyncTask({ type: 'test' });
      const abortSpy = vi.fn();
      task.signal.addEventListener('abort', abortSpy);

      // 观察内部 promise（cancel 会 reject 它）
      task.promise.catch(() => {});
      task.cancel();
      expect(abortSpy).toHaveBeenCalledOnce();
    });

    it('executor 收到 signal', async () => {
      const task = new AsyncTask<AbortSignal>({ type: 'test' });
      let capturedSignal: AbortSignal | undefined;

      const runPromise = task.run(async (_input, signal) => {
        capturedSignal = signal;
        return signal;
      });
      runPromise.catch(() => {}); // 观察 promise

      // signal 应该是同一个
      expect(capturedSignal).toBeDefined();
    });
  });
});
