/**
 * RunBackend 脚手架（P0a）行为锚：挂载语义 / 退役回收判据 / in-flight 计数 /
 * 并发首建单飞（B1）。
 *
 * 这些行为自 gateway.ts 迁入 InProcessRunBackend（P0a 契约缝抽取）。独立评审
 * （2026-11-10）确认原搬迁无任何测试锚点（T1/T2/T3），本文件补齐：
 * 退役判据是"行为冻结"里唯一带时间常量的段（5s 重查 / 30min 强制兜底），
 * 必须锚死；并发首建是 blocker B1 的回归锚。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InProcessRunBackend } from '@octopi-agent/gateway/gateway/run-backend.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';

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

function backendWith(runner: FakeRunner): InProcessRunBackend {
  const backend = new InProcessRunBackend({ redispatch: () => undefined });
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
    const backend = new InProcessRunBackend({ redispatch: () => undefined });
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
    const backend = new InProcessRunBackend({ redispatch: () => undefined });
    expect(() => backend.execute(runReq())).toThrow(/not mounted/);
    expect(() => backend.compactSession('s1', 'a1', {} as never)).toThrow(/not mounted/);
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
  it('两条并发 ensureAgentHandle 只构建一次、共享句柄、无抛错', async () => {
    const gw = new Gateway(
      { agents: [], knowledge: {} } as unknown as GatewayConfig,
      { load: async () => undefined, save: async () => undefined } as never,
    );
    const runner = fakeRunner();
    const built = {
      agent: { context: {} },
      runner,
      contextEngine: undefined,
      contextHealth: undefined,
      registerTools: () => undefined,
    };
    const gwr = gw as unknown as {
      buildAgent: (a: unknown) => Promise<unknown>;
      ensureAgentHandle: (a: unknown) => Promise<{ agentId: string }>;
      runtime: { listAgents(): Array<{ agentId: string }> };
    };
    const buildSpy = vi
      .spyOn(gwr, 'buildAgent')
      .mockImplementation(async () => built);
    const def = {
      id: 'a1',
      persona: 'inline',
      model: { provider: 'p', model: 'm', contextWindow: 1000 },
    } as never;
    const [h1, h2] = await Promise.all([
      gwr.ensureAgentHandle(def),
      gwr.ensureAgentHandle(def),
    ]);
    // 旧实现此处为缓存后写覆盖（两条都成功但败者 timer 泄漏）；新实现合流为一次构建
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(h1).toBe(h2);
    expect(gwr.runtime.listAgents().map((a) => a.agentId)).toContain('a1');
  });
});
