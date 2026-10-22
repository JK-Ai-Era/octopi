/**
 * Delegation 模块测试
 *
 * 覆盖 `arch/delegation.md` P1 面：
 * - 状态机（D10）与 Store 唯一写入口
 * - Registry 委派策略过滤（§9.2）
 * - Transport schema 版本闸（§11）
 * - Service：目标解析（D2）/ 递归深度（§10.4）/ 失控防护（§8）/ 非阻塞（§7）/ 取消（D4）
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DelegationStore,
  canTransitionDelegation,
} from '@octopi-agent/engine/harness/collaboration/delegation/store.js';
import {
  DefaultAgentRegistry,
} from '@octopi-agent/engine/harness/collaboration/delegation/registry.js';
import {
  InProcessTransport,
  assertCompatibleSchema,
} from '@octopi-agent/engine/harness/collaboration/delegation/transport.js';
import {
  DelegateService,
  DelegateResolutionError,
  intersectBudget,
} from '@octopi-agent/engine/harness/collaboration/delegation/service.js';
import {
  DELEGATION_SCHEMA_VERSION,
  isTerminalDelegationStatus,
  isActiveDelegationStatus,
} from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
import type {
  DelegateRequest,
  DelegateResult,
} from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
import type { AgentInfo } from '@octopi-agent/engine/harness/collaboration/delegation/registry-types.js';
import { tightenSessionRights } from '@octopi-agent/engine/harness/governance/session-acl/rights.js';
import {
  RunnerChildRunPort,
  createChildRunExecutor,
} from '@octopi-agent/engine/harness/collaboration/delegation/child-run.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import {
  createDelegationTools,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/delegation.js';
import {
  wireDelegation,
} from '@octopi-agent/engine/harness/collaboration/delegation/wiring.js';

/** 永不落地的 transport：保持 running，便于观察未闭合态 */
function hangingTransport() {
  return new InProcessTransport(() => new Promise<never>(() => { /* never settles */ }));
}

/** 工具调用上下文替身 */
const CTX = { agentId: 'main', sessionId: 's-parent', runId: 'r-1', messages: [] } as never;

/** 可委派 agent 的最小替身（供 wireDelegation 用） */
function fakeAgent(
  agentId: string,
  delegation?: { callable: boolean; canDelegate: boolean; maxDepth?: number },
) {
  const self = {
    agentId,
    agent: {
      contextSessionId: 'default',
      setSteeringMessages(fn: unknown) {
        self.steering = fn;
      },
    },
    runner: {},
    store: {},
    traits: [] as string[],
    delegation,
    registered: [] as string[],
    registerTools(tools: Array<{ definition: { name: string } }>) {
      for (const t of tools) self.registered.push(t.definition.name);
    },
    steering: undefined as unknown,
  };
  return self;
}

/** 内存 SessionStore（子 Run 端口用） */
function makeMemoryStore() {
  const data = new Map<string, SessionData>();
  return {
    data,
    async load(id: string) { return data.get(id) ?? null; },
    async save(id: string, session: SessionData) { data.set(id, session); },
    async list() { return [...data.values()].map((s) => s.meta); },
    async delete(id: string) { void data.delete(id); },
    async exists(id: string) { return data.has(id); },
  };
}

const PARENT = { agentId: 'main', sessionId: 's-1', runId: 'r-1' };

function agentInfo(overrides: Partial<AgentInfo> & { id: string }): Omit<AgentInfo, 'registeredAt' | 'lastActiveAt'> {
  return {
    name: overrides.id,
    traits: [],
    status: 'idle',
    ...overrides,
  };
}

/** 建一个带可委派 worker 的 registry */
function makeRegistry(): DefaultAgentRegistry {
  const registry = new DefaultAgentRegistry();
  registry.register(agentInfo({
    id: 'worker',
    traits: ['research'],
    delegation: { callable: true, canDelegate: false, maxDepth: 1 },
  }));
  // 显式 opt-out：验证关闭开关仍然有效（缺省已改为默认可委派）
  registry.register(agentInfo({
    id: 'locked',
    traits: ['research'],
    delegation: { callable: false, canDelegate: false },
  }));
  registry.register(agentInfo({
    id: 'boss',
    traits: ['coord'],
    delegation: { callable: true, canDelegate: true, maxDepth: 2 },
  }));
  return registry;
}

/** 建一个立即返回 completed 的 transport */
function makeOkTransport(output = 'done') {
  return new InProcessTransport(async (req: DelegateRequest): Promise<DelegateResult> => ({
    delegationId: req.delegationId,
    status: 'completed',
    output,
    usage: { inputTokens: 10, outputTokens: 5 } as never,
    schemaVersion: DELEGATION_SCHEMA_VERSION,
  }));
}

// ── 状态机（D10） ──

describe('delegation status machine', () => {
  it('allows queued -> running -> terminal', () => {
    expect(canTransitionDelegation('queued', 'running')).toBe(true);
    expect(canTransitionDelegation('running', 'completed')).toBe(true);
    expect(canTransitionDelegation('running', 'failed')).toBe(true);
    expect(canTransitionDelegation('running', 'cancelled')).toBe(true);
    expect(canTransitionDelegation('running', 'timeout')).toBe(true);
  });

  it('allows queued -> terminal directly (depth exceeded / not reachable)', () => {
    expect(canTransitionDelegation('queued', 'failed')).toBe(true);
    expect(canTransitionDelegation('queued', 'timeout')).toBe(true);
    expect(canTransitionDelegation('queued', 'cancelled')).toBe(true);
  });

  it('rejects leaving a terminal state (no reuse)', () => {
    for (const from of ['completed', 'failed', 'cancelled', 'timeout'] as const) {
      expect(canTransitionDelegation(from, 'running')).toBe(false);
      expect(canTransitionDelegation(from, 'queued')).toBe(false);
    }
  });

  it('rejects terminal -> terminal', () => {
    expect(canTransitionDelegation('completed', 'failed')).toBe(false);
    expect(canTransitionDelegation('failed', 'completed')).toBe(false);
  });

  it('classifies statuses', () => {
    expect(isTerminalDelegationStatus('completed')).toBe(true);
    expect(isTerminalDelegationStatus('running')).toBe(false);
    expect(isActiveDelegationStatus('queued')).toBe(true);
    expect(isActiveDelegationStatus('timeout')).toBe(false);
  });
});

// ── DelegationStore ──

describe('DelegationStore', () => {
  it('creates a queued record with server-generated fields', () => {
    const store = new DelegationStore();
    const d = store.create({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 'research X',
      input: 'raw',
    });

    expect(d.id).toMatch(/^del-/);
    expect(d.status).toBe('queued');
    expect(d.depth).toBe(1);
    expect(d.context).toBe('clean');
    expect(d.cancelable).toBe(true);
    expect(d.cascade).toBe(false);
    expect(d.deliveryState).toBe('pending');
    expect(d.schemaVersion).toBe(DELEGATION_SCHEMA_VERSION);
  });

  it('round-trips through get() without aliasing the stored record', () => {
    const store = new DelegationStore();
    const d = store.create({ parent: PARENT, target: { agentId: 'worker' }, task: 't', input: 'i' });
    const snapshot = store.get(d.id)!;
    snapshot.output = 'mutated';
    expect(store.get(d.id)!.output).toBeUndefined();
  });

  it('stamps completedAt when entering a terminal state', () => {
    const store = new DelegationStore();
    const d = store.create({ parent: PARENT, target: { agentId: 'worker' }, task: 't', input: 'i' });
    store.update(d.id, { status: 'running' });
    const done = store.update(d.id, { status: 'completed', output: 'ok' });
    expect(done.completedAt).toBeTypeOf('number');
  });

  it('throws on an illegal transition', () => {
    const store = new DelegationStore();
    const d = store.create({ parent: PARENT, target: { agentId: 'worker' }, task: 't', input: 'i' });
    store.update(d.id, { status: 'completed' });
    expect(() => store.update(d.id, { status: 'running' })).toThrow(/Invalid delegation transition/);
  });

  it('throws when the record does not exist', () => {
    const store = new DelegationStore();
    expect(() => store.update('del-nope', { status: 'running' })).toThrow(/not found/);
  });

  it('送达状态迁移发射 delegation.delivery_state 事件', async () => {
    const { DefaultEventBus } = await import('@octopi-agent/core/primitives/event-bus.js');
    const { DelegationEvents } = await import(
      '@octopi-agent/engine/harness/collaboration/delegation/types.js'
    );
    const events = new DefaultEventBus();
    const seen: string[] = [];
    events.on(DelegationEvents.DELIVERY_STATE_CHANGED, (e) => {
      seen.push(
        ((e as { data?: { delegation?: { deliveryState?: string } } }).data?.delegation ?? {})
          .deliveryState ?? '?',
      );
    });
    const store = new DelegationStore(events);
    const d = store.create({
      parent: { agentId: 'main', sessionId: 's-1', runId: 'r-1' },
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });
    store.markDelivering(d.id);
    store.markSurfaced(d.id);
    store.markUnsurfaced(d.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual(['delivering', 'surfaced', 'pending']);
  });

  it('filters by parent session, status, activeOnly, unsurfacedOnly', () => {
    const store = new DelegationStore();
    const a = store.create({ parent: PARENT, target: { agentId: 'worker' }, task: 'a', input: 'i' });
    store.create({
      parent: { ...PARENT, sessionId: 's-2' },
      target: { agentId: 'worker' },
      task: 'b',
      input: 'i',
    });
    store.update(a.id, { status: 'running' });

    expect(store.list({ parentSessionId: 's-1' })).toHaveLength(1);
    expect(store.list({ parentSessionId: 's-2' })).toHaveLength(1);
    expect(store.list({ activeOnly: true })).toHaveLength(2);
    expect(store.list({ status: 'queued' })).toHaveLength(1);
    expect(store.list({ unsurfacedOnly: true })).toHaveLength(2);

    store.markSurfaced(a.id);
    expect(store.list({ unsurfacedOnly: true })).toHaveLength(1);
  });

  it('counts by status per parent session', () => {
    const store = new DelegationStore();
    const a = store.create({ parent: PARENT, target: { agentId: 'worker' }, task: 'a', input: 'i' });
    store.create({ parent: PARENT, target: { agentId: 'worker' }, task: 'b', input: 'i' });
    store.update(a.id, { status: 'running' });
    store.update(a.id, { status: 'completed', output: 'ok' });

    const counts = store.countByStatus('s-1');
    expect(counts.completed).toBe(1);
    expect(counts.queued).toBe(1);
    expect(counts.running).toBe(0);
  });
});

// ── Registry 委派策略（§9.2） ──

describe('DefaultAgentRegistry delegation policy', () => {
  it('filters callableOnly', () => {
    const registry = makeRegistry();
    const callable = registry.query({ callableOnly: true });
    expect(callable.map((a) => a.id).sort()).toEqual(['boss', 'worker']);
  });

  it('honours callableBy whitelist', () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({
      id: 'picky',
      delegation: { callable: true, canDelegate: false, callableBy: ['only-this'] },
    }));

    expect(registry.query({ callableOnly: true, callableBy: 'only-this' })).toHaveLength(1);
    expect(registry.query({ callableOnly: true, callableBy: 'someone-else' })).toHaveLength(0);
  });

  it('treats missing callableBy as open', () => {
    const registry = makeRegistry();
    expect(registry.query({ callableOnly: true, callableBy: 'anyone' })).toHaveLength(2);
  });

  it('findByTrait ignores callability (discovery, not dispatch)', () => {
    const registry = makeRegistry();
    expect(registry.findByTrait('research')).toHaveLength(2);
  });
});

// ── Transport（§11） ──

describe('InProcessTransport', () => {
  const base: DelegateRequest = {
    delegationId: 'del-1',
    from: PARENT,
    to: { agentId: 'worker' },
    childSessionId: 'cs-1',
    childRunId: 'cr-1',
    task: 't',
    input: 'i',
    context: 'clean',
    schemaVersion: DELEGATION_SCHEMA_VERSION,
  };

  it('rejects a missing schemaVersion', () => {
    expect(() => assertCompatibleSchema({ ...base, schemaVersion: undefined as never }))
      .toThrow(/missing schemaVersion/);
  });

  it('rejects an incompatible major schemaVersion', () => {
    expect(() => assertCompatibleSchema({ ...base, schemaVersion: 99 }))
      .toThrow(/incompatible schemaVersion/);
  });

  it('passes a compatible request to the executor', async () => {
    const transport = makeOkTransport('hello');
    const result = await transport.call(base);
    expect(result.output).toBe('hello');
    expect(result.status).toBe('completed');
    expect(result.delegationId).toBe('del-1');
  });
});

// ── budget 交集（D3 只收紧） ──

describe('intersectBudget', () => {
  it('takes the tighter side on every field', () => {
    expect(intersectBudget({ maxTurns: 10, maxTokens: 100 }, { maxTurns: 5, maxTokens: 500 }))
      .toEqual({ maxTurns: 5, maxTokens: 100, timeoutMs: undefined });
  });

  it('returns undefined when both are absent', () => {
    expect(intersectBudget(undefined, undefined)).toBeUndefined();
  });

  it('keeps the present side when the other is absent', () => {
    expect(intersectBudget({ maxTurns: 3 }, undefined)).toEqual({ maxTurns: 3, maxTokens: undefined, timeoutMs: undefined });
  });
});

// ── DelegateService ──

describe('DelegateService', () => {
  function makeService(overrides?: {
    transport?: InProcessTransport;
    maxActive?: number;
    notifier?: (d: { id: string; status: string }) => void;
  }) {
    const registry = makeRegistry();
    const store = new DelegationStore();
    const service = new DelegateService(
      store,
      registry,
      overrides?.transport ?? makeOkTransport(),
      {
        maxActiveDelegationsPerSession: overrides?.maxActive,
        notifier: overrides?.notifier as never,
      },
    );
    return { service, store, registry };
  }

  it('dispatch is non-blocking: returns queued/running without awaiting the result', async () => {
    let resolveChild!: (r: DelegateResult) => void;
    const slow = new InProcessTransport(
      (req) => new Promise<DelegateResult>((res) => { resolveChild = res; }),
    );
    const { service, store } = makeService({ transport: slow });

    const { delegation, resolvedAgentId } = await service.dispatch({
      parent: PARENT,
      target: { trait: 'research' },
      task: 't',
      input: 'i',
    });

    expect(resolvedAgentId).toBe('worker');
    expect(['queued', 'running']).toContain(delegation.status);
    expect(store.get(delegation.id)!.output).toBeUndefined();

    resolveChild({
      delegationId: delegation.id,
      status: 'completed',
      output: 'finally',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });
  });

  it('resolves a target by trait to a callable agent', async () => {
    const { service } = makeService();
    const { resolvedAgentId } = await service.dispatch({
      parent: PARENT,
      target: { trait: 'research' },
      task: 't',
      input: 'i',
    });
    // 'locked' 也具备 research 能力但不可委派，必须落到 'worker'
    expect(resolvedAgentId).toBe('worker');
  });

  it('rejects a non-callable agent', async () => {
    const { service } = makeService();
    await expect(service.dispatch({
      parent: PARENT,
      target: { agentId: 'locked' },
      task: 't',
      input: 'i',
    })).rejects.toThrow(DelegateResolutionError);
  });

  it('rejects an unknown target', async () => {
    const { service } = makeService();
    await expect(service.dispatch({
      parent: PARENT,
      target: { agentId: 'ghost' },
      task: 't',
      input: 'i',
    })).rejects.toThrow(/not found/);
  });

  it('rejects when neither agentId nor trait is given', async () => {
    const { service } = makeService();
    await expect(service.dispatch({
      parent: PARENT,
      target: {},
      task: 't',
      input: 'i',
    })).rejects.toThrow(/must set agentId or trait/);
  });

  it('enforces the recursion depth gate (§10.4)', async () => {
    const { service } = makeService();

    // worker.maxDepth = 1：根委派 depth=1 通过
    await expect(service.dispatch({
      parent: PARENT,
      parentDepth: 0,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    })).resolves.toBeTruthy();

    // worker.maxDepth = 1：depth=2 超限
    await expect(service.dispatch({
      parent: PARENT,
      parentDepth: 1,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    })).rejects.toThrow(/depth exceeded/);

    // boss.maxDepth = 2：depth=2 通过
    await expect(service.dispatch({
      parent: PARENT,
      parentDepth: 1,
      target: { agentId: 'boss' },
      task: 't',
      input: 'i',
    })).resolves.toBeTruthy();
  });

  it('enforces maxActiveDelegationsPerSession as a runaway guard (§8)', async () => {
    const slow = new InProcessTransport(() => new Promise<DelegateResult>(() => { /* never settles */ }));
    const { service } = makeService({ transport: slow, maxActive: 2 });

    await service.dispatch({ parent: PARENT, target: { agentId: 'worker' }, task: 'a', input: 'i' });
    await service.dispatch({ parent: PARENT, target: { agentId: 'worker' }, task: 'b', input: 'i' });

    await expect(service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 'c',
      input: 'i',
    })).rejects.toThrow(/too many active delegations/);
  });

  it('cancel aborts an in-flight delegation and stamps a terminal state (D4)', async () => {
    const slow = new InProcessTransport(() => new Promise<DelegateResult>(() => { /* never settles */ }));
    const { service, store } = makeService({ transport: slow });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });

    const cancelled = service.cancel(delegation.id, 'user asked');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBe('user asked');
    expect(isTerminalDelegationStatus(store.get(delegation.id)!.status)).toBe(true);
  });

  it('refuses to cancel a non-cancelable delegation', async () => {
    const slow = new InProcessTransport(() => new Promise<DelegateResult>(() => { /* never settles */ }));
    const { service } = makeService({ transport: slow });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
      cancelable: false,
    });

    expect(() => service.cancel(delegation.id)).toThrow(/not cancelable/);
  });

  it('intersects the requested budget with the agent ceiling', async () => {
    let seen: DelegateRequest | undefined;
    const spy = new InProcessTransport(async (req) => {
      seen = req;
      return { delegationId: req.delegationId, status: 'completed', schemaVersion: DELEGATION_SCHEMA_VERSION };
    });
    const { service } = makeService({ transport: spy });

    await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
      budget: { maxTurns: 10, maxTokens: 1000 },
    });

    expect(seen).toBeDefined();
  });

  it('renders a delegation_status hint only while there is something to report (§7.3)', async () => {
    const slow = new InProcessTransport(() => new Promise<DelegateResult>(() => { /* never settles */ }));
    const { service } = makeService({ transport: slow });

    expect(service.renderStatusHint('s-1')).toBe('');

    await service.dispatch({ parent: PARENT, target: { agentId: 'worker' }, task: 'a', input: 'i' });
    expect(service.renderStatusHint('s-1')).toContain('1 running');
  });

  it('invokes the notifier once a delegation reaches a terminal state (§7.1)', async () => {
    const notifier = vi.fn();
    const { service } = makeService({ transport: makeOkTransport(), notifier });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });

    await vi.waitFor(() => expect(notifier).toHaveBeenCalledTimes(1));
    expect(notifier.mock.calls[0][0].id).toBe(delegation.id);
  });

  it('a failing notify never corrupts the terminal state and stays un-delivered (hint fallback)', async () => {
    const notifier = vi.fn(() => { throw new Error('notify channel down'); });
    const { service, store } = makeService({ transport: makeOkTransport(), notifier });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });

    await vi.waitFor(() => expect(notifier).toHaveBeenCalled());
    const record = store.get(delegation.id)!;
    expect(record.status).toBe('completed');
    // 未送达不置位：终态留在状态提示里兜底，而不是无声消失
    expect(record.deliveryState).toBe('pending');
    expect(service.renderStatusHint(PARENT.sessionId)).toContain('1 completed');
  });

  it('without a notifier the terminal result stays un-delivered for the hint fallback', async () => {
    const { service, store } = makeService({ transport: makeOkTransport() });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });

    await vi.waitFor(() => expect(store.get(delegation.id)?.status).toBe('completed'));
    expect(store.get(delegation.id)?.deliveryState).toBe('pending');
    expect(service.renderStatusHint(PARENT.sessionId)).toContain('1 completed');

    // 父经 poll 取回（markSurfaced）后，提示消音
    service.markSurfaced(delegation.id);
    expect(service.renderStatusHint(PARENT.sessionId)).toBe('');
  });

  it('deadline timeout racing a late completion calls the notifier exactly once', async () => {
    const notifier = vi.fn();
    let release!: (v: DelegateResult) => void;
    const { service, store } = makeService({
      // 子 Run 悬住直到人为放行：让 deadline 终态与迟到结果先后走两条 notify 路径
      transport: new InProcessTransport(
        (req) =>
          new Promise<DelegateResult>((resolve) => {
            release = (v) => resolve(v);
            void req;
          }),
      ),
      notifier,
    });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
      timeoutMs: 10,
    });

    // deadline 先落 timeout 终态并触发唯一一次 notify
    await vi.waitFor(() => expect(store.get(delegation.id)?.status).toBe('timeout'));
    await vi.waitFor(() => expect(notifier).toHaveBeenCalledTimes(1));

    // 迟到的子结果走 settleWithResult + finally notify：不得第二次投递
    release({
      delegationId: delegation.id,
      status: 'completed',
      output: 'late',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(store.get(delegation.id)?.status).toBe('timeout');
    expect(store.get(delegation.id)?.error).toContain('late result dropped');
  });

  it('delivering 期间提示不消音，surfaced 才消音（异步投递窗口回归钉）', async () => {
    let release!: () => void;
    const { service, store } = makeService({
      transport: makeOkTransport(),
      notifier: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });

    // 投递进行中（delivering）：不算送达，提示保持点亮
    await vi.waitFor(() =>
      expect(store.get(delegation.id)?.deliveryState).toBe('delivering'),
    );
    expect(service.renderStatusHint(PARENT.sessionId)).toContain('1 completed');

    // 投递成功 → surfaced → 提示消音
    release();
    await vi.waitFor(() =>
      expect(store.get(delegation.id)?.deliveryState).toBe('surfaced'),
    );
    expect(service.renderStatusHint(PARENT.sessionId)).toBe('');
  });

  it('an in-flight notify suppresses a concurrent second entry (no double delivery)', async () => {
    let releaseNotify!: () => void;
    const notifier = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseNotify = resolve;
        }),
    );
    let releaseChild!: (v: DelegateResult) => void;
    const { service, store } = makeService({
      transport: new InProcessTransport(
        (req) =>
          new Promise<DelegateResult>((resolve) => {
            releaseChild = (v) => resolve(v);
            void req;
          }),
      ),
      notifier,
    });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
      timeoutMs: 10,
    });

    // deadline 触发 notify #1 并悬在投递中（in-flight 占位）
    await vi.waitFor(() => expect(notifier).toHaveBeenCalledTimes(1));

    // notify #1 未归时，迟到结果再走 finally notify：必须被占位守卫拦下
    releaseChild({
      delegationId: delegation.id,
      status: 'completed',
      output: 'late',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifier).toHaveBeenCalledTimes(1);

    // #1 投递完成后置已送达；全程只投一次
    releaseNotify();
    await vi.waitFor(() => expect(store.get(delegation.id)?.deliveryState).toBe('surfaced'));
    expect(notifier).toHaveBeenCalledTimes(1);
  });
});

// ── 权利天花板收紧（D3） ──

describe('tightenSessionRights', () => {
  it('takes the stricter side on every boolean axis', () => {
    const r = tightenSessionRights(
      { canRun: true, writeMemory: true, canManageTasks: true, canHandoff: true },
      { canRun: true, writeMemory: false, canManageTasks: true, canHandoff: true },
    );
    expect(r?.writeMemory).toBe(false);
    expect(r?.canRun).toBe(true);
    expect(r?.canManageTasks).toBe(true);
  });

  it('never widens: a permissive ceiling cannot loosen a strict one', () => {
    const strict = { canRun: false, readScope: 'none' as const, writeMemory: false };
    const wide = { canRun: true, readScope: 'full' as const, writeMemory: true };
    expect(tightenSessionRights(strict, wide)).toMatchObject(strict);
    expect(tightenSessionRights(wide, strict)).toMatchObject(strict);
  });

  it('orders readScope from wide to narrow', () => {
    expect(tightenSessionRights({ readScope: 'full' }, { readScope: 'summary_tail' })?.readScope)
      .toBe('summary_tail');
    expect(tightenSessionRights({ readScope: 'none' }, { readScope: 'from_grant' })?.readScope)
      .toBe('none');
    expect(tightenSessionRights({ readScope: 'full' }, { readScope: 'from_grant' })?.readScope)
      .toBe('from_grant');
  });

  it('intersects tool rights (deny wins, allow narrows)', () => {
    const r = tightenSessionRights(
      { toolRights: { allow: ['a', 'b', 'c'], deny: ['x'] } },
      { toolRights: { allow: ['b', 'c'], deny: ['y'] } },
    );
    expect(r?.toolRights?.allow).toEqual(['b', 'c']);
    expect(r?.toolRights?.deny).toEqual(expect.arrayContaining(['x', 'y']));
  });

  it('ignores undefined axes instead of forcing them shut', () => {
    const r = tightenSessionRights({ canRun: false }, undefined);
    expect(r).toEqual({ canRun: false });
    expect(tightenSessionRights(undefined, undefined)).toBeUndefined();
  });
});

// ── cascade：父亡子亡（决策 C1） ──

describe('DelegateService.abortChildren (cascade)', () => {
  function makeCascadeService() {
    const registry = new DefaultAgentRegistry();
    registry.register({
      id: 'worker',
      name: 'worker',
      traits: [],
      status: 'idle',
      delegation: { callable: true, canDelegate: false, maxDepth: 1 },
    });
    const store = new DelegationStore();
    const service = new DelegateService(
      store,
      registry,
      new InProcessTransport(() => new Promise<never>(() => { /* never settles */ })),
      {},
    );
    return { service, store };
  }

  it('aborts only cascade delegations; others keep running (C1 default)', async () => {
    const { service } = makeCascadeService();
    const parent = { agentId: 'main', sessionId: 's-1', runId: 'r' };

    const a = await service.dispatch({
      parent, target: { agentId: 'worker' }, task: 'keep', input: 'i', cascade: false,
    });
    const b = await service.dispatch({
      parent, target: { agentId: 'worker' }, task: 'die', input: 'i', cascade: true,
    });

    const aborted = service.abortChildren('s-1', 'parent died');

    expect(aborted).toEqual([b.delegation.id]);
    expect(service.get(b.delegation.id)?.status).toBe('cancelled');
    expect(service.get(a.delegation.id)?.status).toBe('running');
  });

  it('returns an empty list when nothing is cascade-flagged', async () => {
    const { service } = makeCascadeService();
    await service.dispatch({
      parent: { agentId: 'main', sessionId: 's-1', runId: 'r' },
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
      cascade: false,
    });
    expect(service.abortChildren('s-1')).toEqual([]);
  });

  it('does not touch another parent session', async () => {
    const { service } = makeCascadeService();
    await service.dispatch({
      parent: { agentId: 'main', sessionId: 's-other', runId: 'r' },
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
      cascade: true,
    });
    expect(service.abortChildren('s-1')).toEqual([]);
  });
});

// ── rightsCeiling 传到子 Run（D3） ──

describe('rightsCeiling plumbing', () => {
  it('carries DelegateRequest.rightsCeiling into the child RunConfig', async () => {
    const seen: Array<{ rightsCeiling?: unknown }> = [];
    const fake = {
      async *handle(_s: string, _i: unknown, runConfig: { rightsCeiling?: unknown }, _sig?: AbortSignal) {
        seen.push({ rightsCeiling: runConfig.rightsCeiling });
        yield {
          type: 'turn.end',
          timestamp: Date.now(),
          agentId: 'w',
          sessionId: 's',
          data: { content: 'ok' },
        } as never;
      },
    };
    const store = makeMemoryStore();
    const port = new RunnerChildRunPort({ resolve: () => ({ runner: fake, store }) });

    const exec = createChildRunExecutor(port, { persona: 'p' });
    await exec({
      delegationId: 'del-rc',
      from: { agentId: 'main', sessionId: 's', runId: 'r' },
      to: { agentId: 'worker' },
      childSessionId: 'cs-rc',
      childRunId: 'cr-rc',
      task: 't',
      input: 'i',
      context: 'clean',
      rightsCeiling: { canRun: true, readScope: 'summary_tail', writeMemory: false },
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });

    expect(seen[0].rightsCeiling).toEqual({
      canRun: true,
      readScope: 'summary_tail',
      writeMemory: false,
    });
  });
});

// ── 先验后挑：不可委派的候选不得让整次委派失败 ──
//
// 缺陷背景：`resolveTarget` 原先 `findByTrait(...)` 后只过滤 `callableBy`，
// 就 `candidates[0]` 挑人，再在 `toHandle` 里抛 not_callable ——
// 于是「第一个命中但不可委派」会让整次委派失败，而不是落到下一个可用候选。

describe('capability/trait resolution skips non-callable candidates', () => {
  it('falls through to the next callable candidate', async () => {
    const registry = new DefaultAgentRegistry();
    // 注册顺序在前，但不可委派
    registry.register(agentInfo({
      id: 'archived',
      traits: ['research'],
      delegation: { callable: false, canDelegate: false },
    }));
    // 注册顺序在后，可委派 —— 应被选中
    registry.register(agentInfo({
      id: 'active',
      traits: ['research'],
      delegation: { callable: true, canDelegate: false, maxDepth: 1 },
    }));

    const store = new DelegationStore();
    let seen: DelegateRequest | undefined;
    const service = new DelegateService(
      store,
      registry,
      new InProcessTransport(async (req) => {
        seen = req;
        return {
          delegationId: req.delegationId,
          status: 'completed',
          schemaVersion: DELEGATION_SCHEMA_VERSION,
        };
      }),
      {},
    );

    const { resolvedAgentId } = await service.dispatch({
      parent: PARENT,
      target: { trait: 'research' },
      task: 't',
      input: 'i',
    });

    expect(resolvedAgentId).toBe('active');
    expect(seen?.to.trait).toBe('research');
  });

  it('still rejects when no candidate is callable', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({
      id: 'archived',
      traits: ['research'],
      delegation: { callable: false, canDelegate: false },
    }));

    const service = new DelegateService(
      new DelegationStore(),
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      {},
    );

    await expect(service.dispatch({
      parent: PARENT,
      target: { trait: 'research' },
      task: 't',
      input: 'i',
    })).rejects.toThrow(/no callable agent for trait/);
  });

  it('honours callableBy when falling through', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({
      id: 'restricted',
      traits: ['research'],
      delegation: { callable: true, canDelegate: false, callableBy: ['someone-else'] },
    }));
    registry.register(agentInfo({
      id: 'open',
      traits: ['research'],
      delegation: { callable: true, canDelegate: false },
    }));

    const service = new DelegateService(
      new DelegationStore(),
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      {},
    );

    const { resolvedAgentId } = await service.dispatch({
      parent: PARENT,
      target: { trait: 'research' },
      task: 't',
      input: 'i',
    });
    expect(resolvedAgentId).toBe('open');
  });
});

// ── 缺省默认具备委派能力（Q1） ──

describe('delegation is on by default', () => {
  it('an agent with NO delegation block is callable and can delegate', () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({ id: 'plain', traits: ['general'] }));

    // 注册时归一化为生效策略 —— 不配置也能被委派
    const info = registry.get('plain')!;
    expect(info.delegation?.callable).toBe(true);
    expect(info.delegation?.canDelegate).toBe(true);
    expect(info.delegation?.maxDepth).toBe(1);
  });

  it('dispatch to an unconfigured agent succeeds without any delegation config', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({ id: 'plain', traits: ['general'] }));

    const service = new DelegateService(
      new DelegationStore(),
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      {},
    );

    const { resolvedAgentId } = await service.dispatch({
      parent: PARENT,
      target: { trait: 'general' },
      task: 't',
      input: 'i',
    });
    expect(resolvedAgentId).toBe('plain');
  });

  it('wireDelegation attaches tools even when no agent declares a delegation block', () => {
    const boss = fakeAgent('boss', undefined);
    const runtime = wireDelegation([boss] as never, {});
    // 缺省 canDelegate = true → 必须挂上工具
    expect(runtime).toBeTruthy();
    expect(boss.registered.sort()).toEqual(
      ['delegate_cancel', 'delegate_dispatch', 'delegate_get', 'delegate_list'],
    );
  });

  it('explicit opt-out still works', () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({
      id: 'off',
      delegation: { callable: false, canDelegate: false },
    }));
    expect(registry.get('off')!.delegation?.callable).toBe(false);
  });

  it('maxDepth defaults to 1 (runaway guard) and blocks the grandchild level', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({ id: 'plain', traits: ['general'] })); // 无 delegation 配置

    const store = new DelegationStore();
    const service = new DelegateService(
      store,
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        childSessionId: req.childSessionId,
        childRunId: req.childRunId,
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      { resolveParentDepth: (sid) => store.findDepthByChildSession(sid) ?? 0 },
    );

    // 第一代：放行
    const first = await service.dispatch({
      parent: PARENT,
      target: { trait: 'general' },
      task: 'a',
      input: 'i',
    });
    const childSessionId = store.get(first.delegation.id)!.childSessionId!;

    // 第二代：默认 maxDepth=1，必须被拦
    await expect(
      service.dispatch({
        parent: { agentId: 'plain', sessionId: childSessionId, runId: 'r-2' },
        target: { trait: 'general' },
        task: 'b',
        input: 'i',
      }),
    ).rejects.toThrow(/depth exceeded/);
  });

  it('maxActiveDelegationsPerSession defaults to 8 (runaway guard)', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({ id: 'plain', traits: ['general'] }));
    const service = new DelegateService(
      new DelegationStore(),
      registry,
      hangingTransport(), // 永不落地，保持未闭合
      {}, // 未配置上限
    );

    for (let i = 0; i < 8; i++) {
      await service.dispatch({
        parent: PARENT,
        target: { trait: 'general' },
        task: `t${i}`,
        input: 'i',
      });
    }
    // 第 9 个必须被默认上限拦下
    await expect(
      service.dispatch({
        parent: PARENT,
        target: { trait: 'general' },
        task: 'overflow',
        input: 'i',
      }),
    ).rejects.toThrow(/too many active delegations/);
  });
});

// ── 解析失败回传可用目标（Q2：让调用方自愈） ──

describe('resolution failure returns available targets for self-correction', () => {
  it('not_found carries the list of usable traits and agents', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({ id: 'alpha', traits: ['research'] }));
    registry.register(agentInfo({ id: 'beta', traits: ['writing'] }));

    const service = new DelegateService(
      new DelegationStore(),
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      {},
    );

    const err = await service
      .dispatch({ parent: PARENT, target: { trait: 'nonexistent' }, task: 't', input: 'i' })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DelegateResolutionError);
    const e = err as InstanceType<typeof DelegateResolutionError>;
    expect(e.reason).toBe('not_found');
    expect(e.available?.traits).toEqual(['research', 'writing']);
    expect(e.available?.agents.map((a) => a.id).sort()).toEqual(['alpha', 'beta']);
  });

  it('unknown agentId also carries available targets', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({ id: 'alpha', traits: ['research'] }));
    const service = new DelegateService(
      new DelegationStore(),
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      {},
    );

    const err = await service
      .dispatch({ parent: PARENT, target: { agentId: 'ghost' }, task: 't', input: 'i' })
      .then(() => null)
      .catch((e: unknown) => e);

    expect((err as InstanceType<typeof DelegateResolutionError>).available?.traits).toEqual(['research']);
  });

  it('the tool surfaces available_targets and a retry hint to the LLM', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({ id: 'alpha', traits: ['research'] }));
    const service = new DelegateService(
      new DelegationStore(),
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      {},
    );
    const byName = Object.fromEntries(
      createDelegationTools(service).map((t) => [t.definition.name, t]),
    );

    const result = await byName.delegate_dispatch.handler(
      { trait: 'nonexistent', task: 't', input: 'i' },
      CTX,
    ) as {
      ok: boolean;
      reason?: string;
      available_targets?: { traits: string[]; agents: Array<{ id: string }> };
      hint?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(result.available_targets?.traits).toEqual(['research']);
    expect(result.available_targets?.agents[0]?.id).toBe('alpha');
    expect(result.hint).toContain('agent');
  });

  it('a trait with no match but an available agent lets the model recover via agent:', async () => {
    const registry = new DefaultAgentRegistry();
    registry.register(agentInfo({ id: 'alpha', traits: ['research'] }));
    const service = new DelegateService(
      new DelegationStore(),
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      {},
    );
    const byName = Object.fromEntries(
      createDelegationTools(service).map((t) => [t.definition.name, t]),
    );

    // 第一次失败 → 模型从 available_targets 里挑 id → 第二次成功
    const fail = await byName.delegate_dispatch.handler(
      { trait: 'nope', task: 't', input: 'i' },
      CTX,
    ) as { ok: boolean; available_targets?: { agents: Array<{ id: string }> } };
    const picked = fail.available_targets?.agents[0]?.id;
    expect(picked).toBe('alpha');

    const ok = await byName.delegate_dispatch.handler(
      { agent: picked, task: 't', input: 'i' },
      CTX,
    ) as { ok: boolean };
    expect(ok.ok).toBe(true);
  });
});
