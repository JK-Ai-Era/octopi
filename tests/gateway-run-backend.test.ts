/**
 * RunBackend 脚手架（P0a）行为锚：挂载语义 / 退役回收判据 / in-flight 计数 /
 * 并发首建单飞（B1）。
 *
 * 这些行为自 gateway.ts 迁入 RunHost（P0a 契约缝抽取）。独立评审
 * （2026-11-10）确认原搬迁无任何测试锚点（T1/T2/T3），本文件补齐：
 * 退役判据是"行为冻结"里唯一带时间常量的段（5s 重查 / 30min 强制兜底），
 * 必须锚死；并发首建是 blocker B1 的回归锚。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunHost } from '@octopi-agent/engine/harness/run/run-host.js';

interface FakeRunner {
  handle: ReturnType<typeof vi.fn>;
  recordAdmissionRefusal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function fakeRunner(
  handleImpl?: () => AsyncGenerator<string>,
): FakeRunner {
  return {
    handle: vi.fn(
      handleImpl ?? (() => (async function* () { yield 'run-event'; })()),
    ),
    recordAdmissionRefusal: vi.fn(),
    dispose: vi.fn(),
  };
}

function runReq(): never {
  return {
    requestId: 'r1',
    agentId: 'a1',
    sessionId: 's1',
    triggers: [
      { id: 't1', type: 'message', payload: { kind: 'user_message', content: 'hi' }, timestamp: 1 },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  } as never;
}

function backendWith(runner: FakeRunner): RunHost {
  const backend = new RunHost({ redispatch: () => undefined });
  backend.mount({
    agentId: 'a1',
    agent: {} as never,
    runner: runner as never,
    registerTools: () => undefined,
    runConfigDefaults: {},
  });
  return backend;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('挂载语义（fail-loud）', () => {
  it('同 agentId 重复 mount 抛 already mounted（防旧 Runner 泄漏）', () => {
    const backend = new RunHost({ redispatch: () => undefined });
    const spec = {
      agentId: 'a1',
      agent: {} as never,
      runner: fakeRunner() as never,
      registerTools: () => undefined,
      runConfigDefaults: {},
    };
    backend.mount(spec);
    expect(() => backend.mount(spec)).toThrow(/already mounted/);
  });

  it('未挂载 execute/compactSession 同步抛错（fail-loud，不静默空转）', () => {
    const backend = new RunHost({ redispatch: () => undefined });
    expect(() => backend.execute(runReq())).toThrow(/not mounted/);
    expect(() => backend.compactSession('s1', 'a1')).toThrow(/not mounted/);
  });
});

describe('退役回收判据（5s 重查 / 30min 强制兜底）', () => {
  it('in-flight=0：retire 即回收', () => {
    const runner = fakeRunner();
    const backend = backendWith(runner);
    backend.retire('a1');
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });

  it('in-flight>0：不抢单不断流，计数归零后 5s 重查才回收', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = fakeRunner(() =>
      (async function* () {
        await gate;
        yield 'x';
      })(),
    );
    const backend = backendWith(runner);
    const iter = backend.execute(runReq()); // 同步入账 in-flight=1
    backend.retire('a1');
    vi.advanceTimersByTime(60_000); // 多次 5s 重查，仍不回收
    expect(runner.dispose).not.toHaveBeenCalled();
    const consume = (async () => {
      for await (const _ of iter) void _;
    })();
    release();
    await consume; // finally 收敛计数
    vi.advanceTimersByTime(5_000);
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });

  it('30min 长尾：强制兜底回收并 warn', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runner = fakeRunner(() =>
      (async function* () {
        await new Promise(() => undefined); // 永不完成
        yield 'x';
      })(),
    );
    const backend = backendWith(runner);
    void backend.execute(runReq()); // in-flight=1，不消费
    backend.retire('a1');
    vi.advanceTimersByTime(30 * 60_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('force-disposed'));
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposeAll：在挂与退役全部回收（停机 fail-open）', () => {
    const runner = fakeRunner();
    const backend = backendWith(runner);
    const retired = fakeRunner();
    backend.mount({
      agentId: 'a2',
      agent: {} as never,
      runner: retired as never,
      registerTools: () => undefined,
      runConfigDefaults: {},
    });
    backend.retire('a2');
    backend.disposeAll();
    expect(runner.dispose).toHaveBeenCalledTimes(1);
    expect(retired.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('in-flight 计数（退役判据的账）', () => {
  it('执行中计 1，完成后归 0（health 口径）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = fakeRunner(() =>
      (async function* () {
        await gate;
        yield 'x';
      })(),
    );
    const backend = backendWith(runner);
    const iter = backend.execute(runReq());
    expect((await backend.health()).inFlightRuns).toBe(1);
    const consume = (async () => {
      for await (const _ of iter) void _;
    })();
    release();
    await consume;
    expect((await backend.health()).inFlightRuns).toBe(0);
  });
});

describe('并发首建单飞（B1 回归锚）', () => {
  it('两条并发 ensureMounted 只构建一次、共享句柄、无抛错', async () => {
    const runner = fakeRunner();
    const spec = {
      agentId: 'a1',
      agent: { context: {} } as never,
      runner: runner as never,
      registerTools: () => undefined,
      runConfigDefaults: {},
    };
    const buildSpec = vi.fn(async () => spec);
    const host = new RunHost({
      redispatch: () => undefined,
      buildMountSpec: buildSpec,
    });
    const def = { id: 'a1' } as never;
    const [h1, h2] = await Promise.all([
      host.ensureMounted('a1', def),
      host.ensureMounted('a1', def),
    ]);
    // 旧实现此处为缓存后写覆盖（两条都成功但败者 timer 泄漏）；新实现合流为一次构建
    expect(buildSpec).toHaveBeenCalledTimes(1);
    expect(h1).toBe(h2);
    expect(host.mountedAgentIds()).toContain('a1');
  });
});

// ─────────────────────────────────────────────────────────────
// S1 收口锚（arch/service-topology.md §9.5）：RunRequest per-run 覆盖
//（委派 systemPrompt / D3 rightsCeiling）与 startRun 外部中止信号（D4 投影）。
// ─────────────────────────────────────────────────────────────

describe('startRun per-run 覆盖（委派 systemPrompt / D3 rightsCeiling）', () => {
  it('显式覆盖进 runConfig；缺省沿用挂载默认', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const runner = fakeRunner(((_s: string, _i: unknown, config: Record<string, unknown>) => {
      captured.push(config);
      return (async function* () {
        yield 'run-event';
      })();
    }) as never);
    const backend = new RunHost({ redispatch: () => undefined });
    backend.mount({
      agentId: 'a1',
      agent: {} as never,
      runner: runner as never,
      registerTools: () => undefined,
      runConfigDefaults: { systemPrompt: 'mount-prompt' },
    } as never);
    const overrideReq = {
      ...(runReq() as Record<string, unknown>),
      systemPrompt: 'child-prompt',
      rightsCeiling: { tools: ['read'] },
    } as never;
    for await (const _ of backend.startRun(overrideReq)) {
      // 消费完
    }
    for await (const _ of backend.startRun(runReq())) {
      // 消费完
    }
    expect(captured[0]?.systemPrompt).toBe('child-prompt');
    expect(captured[0]?.rightsCeiling).toEqual({ tools: ['read'] });
    expect(captured[1]?.systemPrompt).toBe('mount-prompt');
  });
});

describe('startRun 外部中止信号（委派 D4 本地投影）', () => {
  it('外部 signal 合流到 run 的 controller（run 内可见 abort）', async () => {
    const observed: string[] = [];
    const runner = fakeRunner(((_s: string, _i: unknown, _c: unknown, signal?: AbortSignal) => {
      return (async function* () {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        observed.push('aborted');
        yield 'after-abort';
      })();
    }) as never);
    const backend = backendWith(runner);
    const ctrl = new AbortController();
    const stream = backend.startRun(runReq(), ctrl.signal);
    const iter = stream[Symbol.asyncIterator]();
    const first = iter.next();
    ctrl.abort('stop');
    expect((await first).value).toBe('after-abort');
    expect(observed).toEqual(['aborted']);
  });
});
