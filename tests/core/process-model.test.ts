/**
 * ProcessModel 测试
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ProcessModel,
  ProcessEvents,
  spawnProcess,
  DefaultEventBus,
} from '../../src/core/index.js';
import type { EventBus, AgentEvent } from '../../src/core/index.js';
import type { ProcessBody, ProcessContext, ExitInfo } from '../../src/core/index.js';

// ── 辅助 ──

function createEvents(): { bus: EventBus; events: AgentEvent[] } {
  const bus = new DefaultEventBus();
  const events: AgentEvent[] = [];
  bus.onAll((e) => events.push(e));
  return { bus, events };
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── 测试 ──

describe('ProcessModel', () => {
  describe('基本生命周期', () => {
    it('创建后状态为 born', () => {
      const proc = new ProcessModel({ name: 'test' });
      expect(proc.state).toBe('born');
      expect(proc.alive).toBe(true);
    });

    it('run 后状态变为 running', async () => {
      const { bus, events } = createEvents();
      const proc = new ProcessModel({ name: 'test', agentId: 'a1' }, bus);

      await proc.run(async (ctx) => {
        expect(ctx.state).toBe('running');
        expect(proc.state).toBe('running');
      });

      expect(proc.state).toBe('dead');
      expect(proc.alive).toBe(false);
    });

    it('正常退出 reason 为 normal', async () => {
      const proc = new ProcessModel({ name: 'test' });
      await proc.run(async () => { /* 正常结束 */ });

      expect(proc.exitInfo).toBeDefined();
      expect(proc.exitInfo!.reason).toBe('normal');
    });

    it('异常退出 reason 为 error', async () => {
      const proc = new ProcessModel({ name: 'test' });
      await proc.run(async () => { throw new Error('crash'); });

      expect(proc.exitInfo!.reason).toBe('error');
      expect(proc.exitInfo!.error).toBe('crash');
    });

    it('不能重复 run', async () => {
      const proc = new ProcessModel({ name: 'test' });
      await proc.run(async () => {});
      await expect(proc.run(async () => {})).rejects.toThrow('already running');
    });
  });

  describe('kill', () => {
    it('可以 kill running 进程', async () => {
      const proc = new ProcessModel({ name: 'test' });
      const runPromise = proc.run(async (ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', resolve);
          // 永不主动结束
          setTimeout(() => {}, 100000);
        });
      });

      await delay(10);
      proc.kill('killed', 'user requested');

      expect(proc.state).toBe('dead');
      expect(proc.exitInfo!.reason).toBe('killed');
      expect(proc.exitInfo!.error).toBe('user requested');
    });

    it('kill 会终止所有子进程', async () => {
      const { bus, events } = createEvents();
      const parent = new ProcessModel({ name: 'parent', agentId: 'a1' }, bus);

      const runPromise = parent.run(async (ctx) => {
        const child = ctx.spawn(async (childCtx) => {
          await new Promise<void>((resolve) => {
            childCtx.signal.addEventListener('abort', resolve);
            setTimeout(() => {}, 100000);
          });
        }, { name: 'child' });

        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', resolve);
          setTimeout(() => {}, 100000);
        });
      });

      await delay(10);
      expect(parent.children.length).toBe(1);

      parent.kill('killed');
      await delay(10);

      expect(parent.children.length).toBe(0);
      expect(events.some(e => e.type === ProcessEvents.CHILD_EXITED)).toBe(true);
    });
  });

  describe('sleep', () => {
    it('休眠指定时间后恢复', async () => {
      const proc = new ProcessModel({ name: 'test' });
      const start = Date.now();

      await proc.run(async (ctx) => {
        await ctx.sleep(50);
        expect(proc.state).toBe('running'); // sleep 结束后恢复
      });

      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    it('sleep 期间可以被 kill', async () => {
      const proc = new ProcessModel({ name: 'test' });
      const runPromise = proc.run(async (ctx) => {
        await ctx.sleep(10000);
      });

      await delay(10);
      proc.kill('killed');
      await runPromise;

      expect(proc.state).toBe('dead');
    });
  });

  describe('子进程', () => {
    it('可以 spawn 子进程', async () => {
      const { bus, events } = createEvents();
      const parent = new ProcessModel({ name: 'parent', agentId: 'a1' }, bus);

      await parent.run(async (ctx) => {
        const child = ctx.spawn(async () => {
          await delay(10);
        }, { name: 'child' });

        expect(child.name).toBe('child');
        expect(child.parentId).toBe(parent.id);
        expect(child.agentId).toBe('a1'); // 继承父进程

        // 等子进程结束
        await delay(50);
      });

      expect(events.some(e => e.type === ProcessEvents.CHILD_SPAWNED)).toBe(true);
    });

    it('子进程退出时父进程收到通知', async () => {
      const { bus, events } = createEvents();
      const parent = new ProcessModel({ name: 'parent' }, bus);

      await parent.run(async (ctx) => {
        ctx.spawn(async () => {
          // 立即退出
        }, { name: 'quick-child' });

        await delay(50);
      });

      expect(events.some(e => e.type === ProcessEvents.CHILD_EXITED)).toBe(true);
    });

    it('waitChild 等待子进程完成', async () => {
      const { bus } = createEvents();
      const parent = new ProcessModel({ name: 'parent' }, bus);

      await parent.run(async (ctx) => {
        const child = ctx.spawn(async () => {
          await delay(30);
        });

        const exitInfo = await ctx.waitChild(child.id, 5000);
        expect(exitInfo.reason).toBe('normal');
      });
    });
  });

  describe('进程间通信', () => {
    it('子进程可以给父进程发消息', async () => {
      const parent = new ProcessModel({ name: 'parent' });

      await parent.run(async (ctx) => {
        ctx.spawn(async (childCtx) => {
          await delay(20);
          await childCtx.send(ctx.id, 'ping', { data: 'hello' });
        }, { name: 'sender' });

        // 用 receive 等待子进程的消息
        const msg = await ctx.receive('ping', 5000);
        expect(msg.payload).toEqual({ data: 'hello' });
      });
    });

    it('receive 等待特定类型消息', async () => {
      const parent = new ProcessModel({ name: 'parent' });

      await parent.run(async (ctx) => {
        ctx.spawn(async (childCtx) => {
          await delay(20);
          await childCtx.send(ctx.id, 'result', { value: 42 });
        }, { name: 'worker' });

        const msg = await ctx.receive('result', 5000);
        expect(msg.payload).toEqual({ value: 42 });
      });
    });

    it('receive 超时抛出错误', async () => {
      const parent = new ProcessModel({ name: 'parent' });

      await parent.run(async (ctx) => {
        await expect(ctx.receive('never', 50))
          .rejects.toThrow('timeout');
      });
    });
  });

  describe('事件发射', () => {
    it('发射 spawned/running/exited 事件', async () => {
      const { bus, events } = createEvents();
      const proc = new ProcessModel({ name: 'test' }, bus);

      await proc.run(async () => {});

      const types = events.map(e => e.type);
      expect(types).toContain(ProcessEvents.RUNNING);
      expect(types).toContain(ProcessEvents.EXITED);
    });

    it('sleep 发射 sleeping 事件', async () => {
      const { bus, events } = createEvents();
      const proc = new ProcessModel({ name: 'test' }, bus);

      await proc.run(async (ctx) => {
        await ctx.sleep(10);
      });

      expect(events.some(e => e.type === ProcessEvents.SLEEPING)).toBe(true);
    });
  });

  describe('spawnProcess', () => {
    it('创建并立即启动进程', async () => {
      const proc = spawnProcess(async () => {
        await delay(10);
      }, { name: 'quick' });

      expect(proc.alive).toBe(true);
      await delay(50);
      expect(proc.alive).toBe(false);
    });
  });

  describe('上下文接口', () => {
    it('ctx 包含所有预期属性', async () => {
      const proc = new ProcessModel({ name: 'test', agentId: 'a1' });
      let ctxRef: ProcessContext | undefined;

      await proc.run(async (ctx) => {
        ctxRef = ctx;
        expect(ctx.id).toBe(proc.id);
        expect(ctx.name).toBe('test');
        expect(ctx.signal).toBeInstanceOf(AbortSignal);
        expect(typeof ctx.send).toBe('function');
        expect(typeof ctx.receive).toBe('function');
        expect(typeof ctx.sleep).toBe('function');
        expect(typeof ctx.spawn).toBe('function');
        expect(typeof ctx.waitChild).toBe('function');
        expect(typeof ctx.exit).toBe('function');
      });
    });
  });
});
