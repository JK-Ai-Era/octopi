/**
 * 共享 fork 选项（`forkChildNodeOptions`）与两个真实调用点的接线回归。
 *
 * 为什么要有这层测试：`windowsHide` / env 清洗 / `execArgv: []` / ipc 末位都是
 * 「不写就静默出问题」的选项，且出问题的地方在真实宿主上（Windows 弹窗、IPC 错绑）。
 * 这里锁三件事：
 * 1. helper 本身产出的选项完整（含 Electron 宿主分支、ipc 末位自动追加）；
 * 2. `RemoteRunBackend.start()` 真的把这份选项交给了 `fork`；
 * 3. knowledge 子进程同理，且它用的 stdio 策略（全静默）没被改成 inherit——
 *    后者在 Windows 上会让管道句柄继承干扰 IPC。
 *
 * 覆盖面诚实说明：本测试锁的是「选项被正确传下去」，不是「窗口真的没出现」——后者
 * 需要 Windows + MainWindowHandle 取证（已人工验证）。它依赖 Node 把未在 `ForkOptions`
 * 声明的 `windowsHide` 透传给 spawn，该透传未文档化；若 Node 停止透传，本测试仍会绿。
 */

import { describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';

const captured = vi.hoisted(() => ({
  calls: [] as Array<{
    entry: string;
    args: string[];
    options: Record<string, unknown>;
  }>,
  /** 是否模拟"子进程立刻发 ready"（run 实例握手）；knowledge 的握手形状不同，故可选 */
  emitReady: true,
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
      if (captured.emitReady) {
        // run-serve-child 的 ready 握手形状
        setImmediate(() => child.emit('message', { type: 'ready', port: 51234 }));
      }
      return child;
    },
  };
});

const { forkChildNodeOptions, isElectronHost } = await import(
  '@octopi-agent/engine/fork-child.js'
);
const { RemoteRunBackend } = await import('@octopi-agent/gateway/gateway/remote-run-backend.js');
const { startKnowledgeServiceProcess } = await import(
  '@octopi-agent/engine/harness/knowledge/start-service-process.js'
);

/** 通道标识全家桶：宿主残留时会原样传给孙进程，必须一个都不剩 */
const CHANNEL_KEYS = [
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_ID',
  'NODE_CHANNEL_SERIALIZATION',
  'NODE_UNIQUE_ID',
] as const;

/** 临时设一组环境变量跑 fn，结束后逐个还原（含「原本不存在」的情形） */
async function withEnv<T>(patch: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    saved.set(key, process.env[key]);
    process.env[key] = patch[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('forkChildNodeOptions', () => {
  it('windowsHide / execArgv 清空 / ipc 末位追加 / 通道标识全部剥离', async () => {
    await withEnv(
      {
        NODE_CHANNEL_FD: '3',
        NODE_CHANNEL_ID: 'parent-channel',
        NODE_CHANNEL_SERIALIZATION: 'advanced',
        NODE_UNIQUE_ID: '7',
      },
      () => {
        const opts = forkChildNodeOptions({
          stdio: ['ignore', 'inherit', 'inherit'],
        }) as Record<string, unknown>;
        expect(opts.windowsHide).toBe(true);
        expect(opts.execArgv).toEqual([]);
        // 调用方只给三路；ipc 由 helper 追加，漏配是类型错误
        expect(opts.stdio).toEqual(['ignore', 'inherit', 'inherit', 'ipc']);

        const env = opts.env as NodeJS.ProcessEnv;
        for (const key of CHANNEL_KEYS) {
          expect(env[key], key).toBeUndefined();
        }
        // 剥离只针对通道标识：其余环境变量必须原样保留
        expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
      },
    );
  });

  it('stdio 前三路由调用方决定：全静默不被 inherit 覆盖', () => {
    const opts = forkChildNodeOptions({ stdio: ['ignore', 'ignore', 'ignore'] });
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
  });

  it('Electron 宿主补 ELECTRON_RUN_AS_NODE=1', async () => {
    const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath');
    // 伪造 Electron 宿主：execPath 命中 /electron|MiMo\.exe/i（versions.electron 无法在测试中伪造）
    Object.defineProperty(process, 'execPath', {
      value: 'C:\\Program Files\\MiMo.exe',
      configurable: true,
    });
    try {
      expect(isElectronHost()).toBe(true);
      const opts = forkChildNodeOptions({ stdio: ['ignore', 'inherit', 'inherit'] });
      expect((opts.env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE).toBe('1');
    } finally {
      if (originalExecPath) Object.defineProperty(process, 'execPath', originalExecPath);
    }
  });

  it('非 Electron 宿主不注入 ELECTRON_RUN_AS_NODE', () => {
    if (isElectronHost()) return; // 真在 Electron 里跑时该断言无意义
    const opts = forkChildNodeOptions({ stdio: ['ignore', 'inherit', 'inherit'] });
    expect((opts.env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE).toBe(
      process.env.ELECTRON_RUN_AS_NODE,
    );
  });
});

describe('run 实例 fork 接线', () => {
  it('RemoteRunBackend.start() 实际把完整选项交给 fork', async () => {
    let bootPath = '';
    try {
      const before = captured.calls.length;
      const backend = await RemoteRunBackend.start({
        octopiHome: join(tmpdir(), `octopi-run-fork-opts-${randomUUID()}`),
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
      const env = call.options.env as NodeJS.ProcessEnv;
      for (const key of CHANNEL_KEYS) {
        expect(env[key], key).toBeUndefined();
      }
    } finally {
      // boot 文件含 provider apiKey + loopback token：断言失败也必须清掉
      if (bootPath) rmSync(bootPath, { force: true });
    }
  });
});

describe('knowledge 子进程 fork 接线', () => {
  it('startKnowledgeServiceProcess() 用全静默 stdio（Windows 管道继承会干扰 IPC）', async () => {
    const before = captured.calls.length;
    const handle = await startKnowledgeServiceProcess({
      dbPath: join(tmpdir(), `octopi-knowledge-fork-opts-${randomUUID()}.db`),
      runtime: { document: undefined } as never,
    } as never).catch(() => null);

    const call = captured.calls[before];
    if (!call) throw new Error('fork 未被调用（knowledge 未走真实连线）');
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.execArgv).toEqual([]);
    // 关键取舍：knowledge 必须全静默，不能是 inherit
    expect(call.options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
    const env = call.options.env as NodeJS.ProcessEnv;
    for (const key of CHANNEL_KEYS) {
      expect(env[key], key).toBeUndefined();
    }

    // mock 的子进程不会真的 ready：start 会超时/失败，这里只断言 fork 参数，
    // 收尾避免留下未处理的 rejection 与挂起的计时器。
    if (handle) await handle.stop().catch(() => undefined);
  }, 15_000);
});
