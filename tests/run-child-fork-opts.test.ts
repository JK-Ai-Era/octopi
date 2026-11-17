/**
 * run 实例子进程 fork 选项回归：`windowsHide` 必须真正传到 `fork`。
 *
 * 症状锚：Gateway 守护进程无控制台，console 子系统子进程不带 CREATE_NO_WINDOW 时
 * Windows 会为它新开一个可见 node 控制台窗口，且随实例存活不消失。
 *
 * 覆盖面诚实说明：本测试锁的是「我们把 windowsHide 传进 fork」，不是「窗口真的没了」
 * （后者需要 Windows + MainWindowHandle 取证）。它依赖 Node 把未在 ForkOptions 声明的
 * 选项透传给 spawn —— 该透传未文档化，若未来 Node 停止透传，这条会静默失效。
 */

import { describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { EventEmitter } from 'node:events';

const captured = vi.hoisted(() => ({
  calls: [] as Array<{ entry: string; args: string[]; options: Record<string, unknown> }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    fork: (entry: string, args: string[], options: Record<string, unknown>) => {
      captured.calls.push({ entry, args, options });
      const child = new Emitter() as EventEmitter & {
        pid?: number;
        send?: (...a: unknown[]) => boolean;
        kill?: (...a: unknown[]) => boolean;
      };
      child.pid = 4242;
      child.send = () => true;
      child.kill = () => true;
      // 子进程 ready 握手（真实子进程由 run-serve-child 发出同形消息）
      setImmediate(() => child.emit('message', { type: 'ready', port: 51234 }));
      return child;
    },
  };
});

const { RemoteRunBackend, runChildForkOptions } = await import(
  '@octopi-agent/gateway/gateway/remote-run-backend.js'
);

describe('run 实例 fork 选项', () => {
  it('构造器带 windowsHide / execArgv 清空 / ipc 通道 / 剥离继承通道标识', () => {
    const savedFd = process.env.NODE_CHANNEL_FD;
    const savedId = process.env.NODE_CHANNEL_ID;
    process.env.NODE_CHANNEL_FD = '3';
    process.env.NODE_CHANNEL_ID = 'parent-channel';
    try {
      const opts = runChildForkOptions() as Record<string, unknown>;
      expect(opts.windowsHide).toBe(true);
      expect(opts.execArgv).toEqual([]);
      expect(opts.stdio).toEqual(['ignore', 'inherit', 'inherit', 'ipc']);
      const env = opts.env as Record<string, string | undefined>;
      expect(env.NODE_CHANNEL_FD).toBeUndefined();
      expect(env.NODE_CHANNEL_ID).toBeUndefined();
      // 剥离只针对通道标识：其余环境变量必须原样保留
      expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
    } finally {
      if (savedFd === undefined) delete process.env.NODE_CHANNEL_FD;
      else process.env.NODE_CHANNEL_FD = savedFd;
      if (savedId === undefined) delete process.env.NODE_CHANNEL_ID;
      else process.env.NODE_CHANNEL_ID = savedId;
    }
  });

  it('RemoteRunBackend.start() 实际把完整选项交给 fork（防"改了构造器但没接线"）', async () => {
    const savedFd = process.env.NODE_CHANNEL_FD;
    const savedId = process.env.NODE_CHANNEL_ID;
    process.env.NODE_CHANNEL_FD = '3';
    process.env.NODE_CHANNEL_ID = 'parent-channel';
    let bootPath = '';
    try {
      const before = captured.calls.length;
      const backend = await RemoteRunBackend.start({
        octopiHome: '/tmp/octopi-run-fork-opts',
        config: {} as never,
        agentDefinitions: [],
      });
      // 反向证明 mock 返回的 child 就是 start() 真正使用的那一个
      expect(backend.info.pid).toBe(4242);

      const call = captured.calls[before];
      if (!call) throw new Error('fork 未被调用（start 未走真实连线）');
      bootPath = call.args[0] ?? '';
      expect(call.options.windowsHide).toBe(true);
      expect(call.options.execArgv).toEqual([]);
      // stdio 一并断言：只查 windowsHide 的话，改坏 ipc/日志继承仍会绿
      expect(call.options.stdio).toEqual(['ignore', 'inherit', 'inherit', 'ipc']);
      const env = call.options.env as Record<string, string | undefined>;
      expect(env.NODE_CHANNEL_FD).toBeUndefined();
      expect(env.NODE_CHANNEL_ID).toBeUndefined();
    } finally {
      // boot 文件含 provider apiKey + loopback token：断言失败也必须清掉
      if (bootPath) rmSync(bootPath, { force: true });
      if (savedFd === undefined) delete process.env.NODE_CHANNEL_FD;
      else process.env.NODE_CHANNEL_FD = savedFd;
      if (savedId === undefined) delete process.env.NODE_CHANNEL_ID;
      else process.env.NODE_CHANNEL_ID = savedId;
    }
  });
});
