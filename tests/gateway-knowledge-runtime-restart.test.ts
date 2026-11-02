/**
 * manageLocal 子进程自愈（拍板 2026-11-02）— 退避自动重启
 *
 * 防回归背景：子进程崩一次 → 状态锁 degraded → knowledge.required 拒一切新 run
 * 直到网关重启（P2 评审项）。拍板「自愈」：意外退出/首启失败 → 指数退避自动重启
 * （无限次），恢复 ready 即放行；生命周期事件上抛（WS 可见）。本文件锁：
 * 退避纯函数、退出→重启→恢复、首启失败→重试、stop() 取消挂起重试、
 * 重启失败继续退避（attempt 递增）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExitFn = (code: number | null, signal: string | null) => void;

function makeFakeChild() {
  let exitFn: ExitFn | null = null;
  return {
    pid: 4242,
    once: (ev: string, cb: ExitFn) => {
      if (ev === 'exit') exitFn = cb;
    },
    triggerExit: (code = 1) => exitFn?.(code, null),
  };
}

describe('knowledgeRestartBackoffMs（指数退避封顶）', () => {
  it('1s→2s→…封顶 60s；可覆盖参数', async () => {
    const { knowledgeRestartBackoffMs } = await import(
      '@octopi-agent/gateway/gateway/knowledge-runtime.js'
    );
    expect(knowledgeRestartBackoffMs(0)).toBe(1_000);
    expect(knowledgeRestartBackoffMs(1)).toBe(2_000);
    expect(knowledgeRestartBackoffMs(3)).toBe(8_000);
    expect(knowledgeRestartBackoffMs(6)).toBe(60_000);
    expect(knowledgeRestartBackoffMs(99)).toBe(60_000);
    expect(knowledgeRestartBackoffMs(0, 10, 20)).toBe(10);
    expect(knowledgeRestartBackoffMs(5, 10, 20)).toBe(20);
  });
});

describe('manageLocal 子进程自愈（退避重启）', () => {
  const savedOctopiHome = process.env.OCTOPI_HOME;
  beforeEach(() => {
    vi.resetModules();
    process.env.OCTOPI_HOME = '/tmp/octopi-self-heal-test';
  });

  afterEach(() => {
    if (savedOctopiHome === undefined) delete process.env.OCTOPI_HOME;
    else process.env.OCTOPI_HOME = savedOctopiHome;
    vi.doUnmock('@octopi-agent/engine/harness/knowledge/start-service-process.js');
    vi.doUnmock('@octopi-agent/engine/harness/knowledge/client.js');
    vi.resetModules();
  });

  interface FakeHandle {
    port: number;
    child: ReturnType<typeof makeFakeChild>;
    stop: ReturnType<typeof vi.fn>;
  }

  /** 装配可编程的子进程 mock + 客户端 mock，返回启动后的 runtime */
  async function boot(opts?: {
    failFirstStarts?: number;
    failHealthTimes?: number;
    /** 第 N 次（1 起）健康握手起挂起，直到 releaseHealth() */
    hangHealthFrom?: number;
  }): Promise<{
    rt: import('@octopi-agent/gateway/gateway/knowledge-runtime.js').GatewayKnowledgeRuntime;
    children: ReturnType<typeof makeFakeChild>[];
    handles: FakeHandle[];
    startMock: ReturnType<typeof vi.fn>;
    events: Array<{ type: string; data: Record<string, unknown> }>;
    releaseHealth: () => void;
  }> {
    const children: ReturnType<typeof makeFakeChild>[] = [];
    const handles: FakeHandle[] = [];
    let failRemaining = opts?.failFirstStarts ?? 0;
    const startMock = vi.fn(async () => {
      if (failRemaining > 0) {
        failRemaining -= 1;
        throw new Error('spawn failed');
      }
      const child = makeFakeChild();
      children.push(child);
      const handle: FakeHandle = {
        port: 65510,
        child,
        stop: vi.fn(async () => {
          child.triggerExit(0);
        }),
      };
      handles.push(handle);
      return handle;
    });
    vi.doMock('@octopi-agent/engine/harness/knowledge/start-service-process.js', () => ({
      startKnowledgeServiceProcess: startMock,
    }));

    let healthCalls = 0;
    const healthWaiters: Array<() => void> = [];
    const releaseHealth = () => {
      for (const w of healthWaiters.splice(0)) w();
    };
    vi.doMock('@octopi-agent/engine/harness/knowledge/client.js', () => ({
      KnowledgeClient: class {
        baseUrl: string;
        constructor(cfg: { baseUrl: string }) {
          this.baseUrl = cfg.baseUrl;
        }
        async health(): Promise<void> {
          healthCalls += 1;
          if (healthCalls <= (opts?.failHealthTimes ?? 0)) throw new Error('health down');
          if (opts?.hangHealthFrom && healthCalls >= opts.hangHealthFrom) {
            await new Promise<void>((resolve) => healthWaiters.push(resolve));
          }
        }
      },
    }));

    const { GatewayKnowledgeRuntime } = await import(
      '@octopi-agent/gateway/gateway/knowledge-runtime.js'
    );
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const rt = new GatewayKnowledgeRuntime();
    await rt.start(
      { manageLocal: true, port: 18280 },
      {
        dataDir: '/tmp/octopi-self-heal-test/knowledge',
        onLifecycle: (e) => events.push(e),
        restartBackoff: { initialMs: 10, maxMs: 20 },
      },
    );
    return { rt, children, handles, startMock, events, releaseHealth };
  }

  async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('until(): timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('意外退出 → exited 事件 → 退避重启 → recovered（状态回 ready）', async () => {
    const { rt, children, startMock, events } = await boot();
    try {
      expect(rt.state).toBe('ready');
      expect(startMock).toHaveBeenCalledTimes(1);

      children[0]!.triggerExit(1);
      await until(() => events.some((e) => e.type === 'knowledge.service.recovered'));
      expect(rt.state).toBe('ready');
      expect(startMock).toHaveBeenCalledTimes(2);
      const seq = events.map((e) => e.type);
      expect(seq).toEqual([
        'knowledge.service.exited',
        'knowledge.service.restarting',
        'knowledge.service.recovered',
      ]);
      const restarting = events.find((e) => e.type === 'knowledge.service.restarting')!;
      expect(restarting.data.attempt).toBe(1);
      expect(restarting.data.backoffMs).toBe(10);
    } finally {
      await rt.stop();
    }
  });

  it('boot 首启失败 → 退避重试成功（degraded → recovered，不再锁到网关重启）', async () => {
    const { rt, startMock, events } = await boot({ failFirstStarts: 1 });
    try {
      expect(rt.state).toBe('degraded'); // 首启失败当场 degraded
      await until(() => events.some((e) => e.type === 'knowledge.service.recovered'));
      expect(rt.state).toBe('ready');
      expect(startMock).toHaveBeenCalledTimes(2);
    } finally {
      await rt.stop();
    }
  });

  it('重启失败继续退避（attempt 递增）；健康失败兜停孤儿后重试', async () => {
    const { rt, startMock, events } = await boot({ failHealthTimes: 2 });
    try {
      expect(rt.state).toBe('degraded'); // 首启 spawn 成功但健康失败
      await until(() => events.some((e) => e.type === 'knowledge.service.recovered'));
      expect(rt.state).toBe('ready');
      // 首启 1 次（boot_failed）+ 重试 2 次（第 1 次 restart_failed，第 2 次成功）
      expect(startMock).toHaveBeenCalledTimes(3);
      const types = events.map((e) => e.type);
      expect(types).toContain('knowledge.service.restart_failed');
      const restarts = events.filter((e) => e.type === 'knowledge.service.restarting');
      expect(restarts.map((e) => e.data.attempt)).toEqual([1, 2]);
    } finally {
      await rt.stop();
    }
  });

  it('stop() 取消挂起重试（不再拉起子进程）', async () => {
    const { rt, children, startMock, events } = await boot();
    try {
      children[0]!.triggerExit(1);
      await until(() => events.some((e) => e.type === 'knowledge.service.restarting'));
      await rt.stop();
      await new Promise((r) => setTimeout(r, 80)); // > backoff(10ms)
      expect(startMock).toHaveBeenCalledTimes(1);
      expect(rt.state).toBe('disabled');
    } finally {
      await rt.stop();
    }
  });

  it('P0-1 竞态锁：stop() 与在途重启无交会——孤儿兜停、不复活、不发 recovered', async () => {
    const { rt, children, handles, startMock, events, releaseHealth } = await boot({
      hangHealthFrom: 2,
    });
    try {
      expect(rt.state).toBe('ready');
      children[0]!.triggerExit(1);
      // 重启已 spawn（第 2 个 handle），健康握手挂起 = 停机窗口
      await until(() => startMock.mock.calls.length === 2);
      await rt.stop();
      releaseHealth();
      await new Promise((r) => setTimeout(r, 80));
      expect(rt.state).toBe('disabled');
      expect(startMock).toHaveBeenCalledTimes(2); // 不再拉起第三个
      expect(handles[1]!.stop).toHaveBeenCalled(); // 在途子进程被兜停，不留孤儿
      expect(events.some((e) => e.type === 'knowledge.service.recovered')).toBe(false);
    } finally {
      await rt.stop();
    }
  });

  it('P1-1 锁：健康失败的孤儿子进程被兜停（不占端口放大故障）', async () => {
    const { rt, handles, events } = await boot({ failHealthTimes: 2 });
    try {
      await until(() => events.some((e) => e.type === 'knowledge.service.recovered'));
      expect(handles[0]!.stop).toHaveBeenCalledTimes(1);
      expect(handles[1]!.stop).toHaveBeenCalledTimes(1);
      expect(handles[2]!.stop).not.toHaveBeenCalled();
    } finally {
      await rt.stop();
    }
  });
});
