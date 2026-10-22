/**
 * 审查修复回归测试
 *
 * 针对 `REVIEW-VERDICT-delegation.md` 确认的 3 P0 + 2 P1。
 *
 * 这些用例的共同点：**走真实连线**，不硬编码 resolver、不用整对象 mock store。
 * 上一轮的假绿正是「测了闸本身、没测连线」造成的——这里刻意绕开那种写法。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlSessionStore } from '@octopi-agent/engine/integration/storage/jsonl.js';
import type { SessionData } from '@octopi-agent/engine/harness/session/types.js';
import {
  DelegationStore,
} from '@octopi-agent/engine/harness/collaboration/delegation/store.js';
import {
  DelegateService,
} from '@octopi-agent/engine/harness/collaboration/delegation/service.js';
import { DefaultAgentRegistry } from '@octopi-agent/engine/harness/collaboration/delegation/registry.js';
import { InProcessTransport } from '@octopi-agent/engine/harness/collaboration/delegation/transport.js';
import {
  createDelegationRuntime,
} from '@octopi-agent/engine/harness/collaboration/delegation/wiring.js';
import {
  DELEGATION_SCHEMA_VERSION,
} from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
import type {
  DelegateRequest,
  DelegateResult,
} from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
import { tightenSessionRights } from '@octopi-agent/engine/harness/governance/session-acl/rights.js';

const PARENT = { agentId: 'main', sessionId: 's-parent', runId: 'r-1' };

function usagelessResult(req: DelegateRequest, extra: Partial<DelegateResult> = {}): DelegateResult {
  return {
    delegationId: req.delegationId,
    status: 'completed',
    childSessionId: req.childSessionId,
    childRunId: req.childRunId,
    schemaVersion: DELEGATION_SCHEMA_VERSION,
    ...extra,
  };
}

function registryWithWorker(maxDepth = 1) {
  const registry = new DefaultAgentRegistry();
  registry.register({
    id: 'worker',
    name: 'worker',
    traits: [],
    status: 'idle',
    delegation: { callable: true, canDelegate: true, maxDepth },
  });
  return registry;
}

/** 永不落地的 transport：保持 running，便于观察中间态 */
function hangingTransport() {
  return new InProcessTransport(() => new Promise<DelegateResult>(() => { /* never */ }));
}

// ══════════════════════════════════════════════════════════════
// P0-1：spawnBy 必须能在生产 store 往返
// ══════════════════════════════════════════════════════════════

describe('P0-1 JsonlSessionStore persists spawnBy (D7)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'del-jsonl-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('save → load round-trips spawnBy through the real Jsonl store', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const spawnBy = {
      delegationId: 'del-abc',
      parentAgentId: 'main',
      parentSessionId: 's-parent',
      parentRunId: 'r-1',
      depth: 1,
    };

    await store.save('cs-1', {
      id: 'cs-1',
      agentId: 'worker',
      primaryAgentId: 'worker',
      spawnBy,
      meta: { id: 'cs-1', createdAt: 1, updatedAt: 1, status: 'idle' } as SessionData['meta'],
      messages: [],
      turns: [],
      metadata: { delegationId: 'del-abc' },
    });

    // 新实例读取：确保真的走了磁盘而不是内存缓存
    const reread = new JsonlSessionStore({ sessionsDir: dir });
    const loaded = await reread.load('cs-1');

    expect(loaded).toBeTruthy();
    expect(loaded!.spawnBy).toEqual(spawnBy);
  });

  it('updateMetadata does not drop spawnBy', async () => {
    const store = new JsonlSessionStore({ sessionsDir: dir });
    const spawnBy = {
      delegationId: 'del-x',
      parentAgentId: 'main',
      parentSessionId: 's-parent',
      parentRunId: 'r-9',
    };
    await store.save('cs-2', {
      id: 'cs-2',
      agentId: 'worker',
      spawnBy,
      meta: { id: 'cs-2', createdAt: 1, updatedAt: 1, status: 'idle' } as SessionData['meta'],
      messages: [],
      turns: [],
      metadata: {},
    });

    await store.updateMetadata?.('cs-2', (m) => ({ ...m, touched: true }));

    const reread = new JsonlSessionStore({ sessionsDir: dir });
    const loaded = await reread.load('cs-2');
    expect(loaded!.spawnBy).toEqual(spawnBy);
  });
});

// ══════════════════════════════════════════════════════════════
// P0-2：childSessionId 必须在子 Run 开始前落库
// ══════════════════════════════════════════════════════════════

describe('P0-2 childSessionId is persisted before the child run starts', () => {
  it('dispatch() returns with ids already on the record', async () => {
    const store = new DelegationStore();
    let seenRequest: DelegateRequest | undefined;
    const service = new DelegateService(
      store,
      registryWithWorker(),
      new InProcessTransport(async (req) => {
        seenRequest = req;
        return usagelessResult(req);
      }),
      {},
    );

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });

    // dispatch 返回时（子 Run 尚未 settle）id 就必须在
    const record = store.get(delegation.id)!;
    expect(record.childSessionId).toMatch(/^cs-/);
    expect(record.childRunId).toMatch(/^run-/);
    // 请求里携带的 id 与库中一致
    expect(seenRequest?.childSessionId).toBe(record.childSessionId);
    expect(seenRequest?.childRunId).toBe(record.childRunId);
  });

  it('findDepthByChildSession resolves during the child run (grandchild gate can fire)', async () => {
    const store = new DelegationStore();
    const service = new DelegateService(
      store,
      registryWithWorker(1),
      new InProcessTransport(async (req) => usagelessResult(req)),
      // 真实连线：深度来自委派单记录，不硬编码
      { resolveParentDepth: (sid) => store.findDepthByChildSession(sid) ?? 0 },
    );

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });

    const childSessionId = store.get(delegation.id)!.childSessionId!;
    // 子 Run 期间就能查到深度 = 1
    expect(store.findDepthByChildSession(childSessionId)).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
// P0-2 续：三代委派必须被 maxDepth 拦下（走生产 resolver）
// ══════════════════════════════════════════════════════════════

describe('P0-2 nested delegation is gated by maxDepth', () => {
  function fakeAgent(agentId: string) {
    return {
      agentId,
      agent: {
        contextSessionId: 'default',
        setSteeringMessages() { /* noop */ },
      },
      runner: {
        async *_handle() {
          yield {
            type: 'turn.end',
            timestamp: Date.now(),
            agentId,
            sessionId: 's',
            data: { content: 'ok' },
          } as never;
        },
        handle(...args: unknown[]) {
          return (this._handle as (...a: unknown[]) => unknown)(...args);
        },
      },
      store: {
        data: new Map<string, SessionData>(),
        async load(id: string) { return this.data.get(id) ?? null; },
        async save(id: string, s: SessionData) { this.data.set(id, s); },
      },
      traits: [] as string[],
      delegation: { callable: true, canDelegate: true, maxDepth: 1 },
    };
  }

  it('a depth-1 child cannot delegate again when maxDepth=1', async () => {
    const boss = fakeAgent('boss');
    const runtime = createDelegationRuntime({ events: undefined });
    runtime.attach(boss as never);

    // 1) 根委派：depth=1，应放行
    const first = await runtime.service.dispatch({
      parent: PARENT,
      target: { agentId: 'boss' },
      task: 'a',
      input: 'i',
    });
    const childSessionId = runtime.delegationStore.get(first.delegation.id)!.childSessionId!;

    // 2) 子（在自己的 session 里）再委派：应因 depth_exceeded 被拒
    await expect(
      runtime.service.dispatch({
        parent: { agentId: 'boss', sessionId: childSessionId, runId: 'r-2' },
        target: { agentId: 'boss' },
        task: 'b',
        input: 'i',
      }),
    ).rejects.toThrow(/depth exceeded/);
  });

  it('maxDepth=2 allows one more level', async () => {
    const boss = fakeAgent('boss');
    const runtime = createDelegationRuntime({ events: undefined });
    runtime.attach({ ...boss, delegation: { callable: true, canDelegate: true, maxDepth: 2 } } as never);

    const first = await runtime.service.dispatch({
      parent: PARENT,
      target: { agentId: 'boss' },
      task: 'a',
      input: 'i',
    });
    const childSessionId = runtime.delegationStore.get(first.delegation.id)!.childSessionId!;

    // 第二代：应放行
    await expect(
      runtime.service.dispatch({
        parent: { agentId: 'boss', sessionId: childSessionId, runId: 'r-2' },
        target: { agentId: 'boss' },
        task: 'b',
        input: 'i',
      }),
    ).resolves.toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════
// P0-3：父的有效权限随调用传播（方案甲）
// ══════════════════════════════════════════════════════════════

describe('P0-3 parent effective rights propagate into the child ceiling (D3)', () => {
  function makeService(childCeiling?: ReturnType<typeof Object>) {
    const registry = new DefaultAgentRegistry();
    registry.register({
      id: 'worker',
      name: 'worker',
      traits: [],
      status: 'idle',
      delegation: {
        callable: true,
        canDelegate: false,
        maxDepth: 1,
        rightsCeiling: childCeiling as never,
      },
    });
    const store = new DelegationStore();
    let seen: DelegateRequest | undefined;
    const service = new DelegateService(
      store,
      registry,
      new InProcessTransport(async (req) => {
        seen = req;
        return usagelessResult(req);
      }),
      {},
    );
    return { service, request: () => seen };
  }

  it('restricted parent tightens an unrestricted child ceiling', async () => {
    const { service, request } = makeService();
    await service.dispatch({
      parent: PARENT,
      // 父被限权：只能读摘要、不能写记忆、不能跑工具面里的 fs-write
      parentRights: {
        canRun: true,
        readScope: 'summary_tail',
        writeMemory: false,
        toolRights: { deny: ['file_write'] },
      },
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });

    const ceiling = request()!.rightsCeiling!;
    expect(ceiling.readScope).toBe('summary_tail');
    expect(ceiling.writeMemory).toBe(false);
    expect(ceiling.toolRights?.deny).toContain('file_write');
  });

  it('child template ceiling cannot widen the parent (only tighten)', async () => {
    const { service, request } = makeService({
      canRun: true,
      readScope: 'full',
      writeMemory: true,
      canHandoff: true,
    });

    await service.dispatch({
      parent: PARENT,
      parentRights: { canRun: false, readScope: 'none', writeMemory: false, canHandoff: false },
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });

    const ceiling = request()!.rightsCeiling!;
    // 子模板声称全权，但父是零权 → 结果必须是零权
    expect(ceiling.canRun).toBe(false);
    expect(ceiling.readScope).toBe('none');
    expect(ceiling.writeMemory).toBe(false);
    expect(ceiling.canHandoff).toBe(false);
  });

  it('no parent rights → only the child template ceiling applies', async () => {
    const { service, request } = makeService({ writeMemory: false });
    await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });
    expect(request()!.rightsCeiling!.writeMemory).toBe(false);
  });

  it('tightenSessionRights is symmetric and never widens', () => {
    const wide = { canRun: true, readScope: 'full' as const, writeMemory: true };
    const tight = { canRun: false, readScope: 'none' as const, writeMemory: false };
    expect(tightenSessionRights(wide, tight)).toMatchObject(tight);
    expect(tightenSessionRights(tight, wide)).toMatchObject(tight);
    expect(tightenSessionRights(wide, undefined)).toMatchObject(wide);
  });
});

// ══════════════════════════════════════════════════════════════
// P1-1 / P1-2：deadline 竞态
// ══════════════════════════════════════════════════════════════

describe('P1 deadline race', () => {
  function makeService(opts: {
    transport: InProcessTransport;
    notifier?: (d: { id: string; status: string }) => void;
  }) {
    const store = new DelegationStore();
    const service = new DelegateService(store, registryWithWorker(), opts.transport, {
      notifier: opts.notifier as never,
    });
    return { service, store };
  }

  /**
   * 可控 transport：子何时 resolve 由测试决定。
   *
   * 刻意**不用** `setTimeout` 制造竞态 —— 那样测试会依赖真实定时器的相对顺序，
   * 高负载下可能翻转（曾造成全量跑偶发红、隔离跑全绿）。
   */
  function controlled() {
    let resolveChild!: (r: DelegateResult) => void;
    const transport = new InProcessTransport(
      () => new Promise<DelegateResult>((res) => { resolveChild = res; }),
    );
    return { transport, settle: (r: DelegateResult) => resolveChild(r) };
  }

  /** 等待条件成立（不依赖固定 sleep 时长） */
  async function until(fn: () => void, timeout = 2000): Promise<void> {
    await vi.waitFor(fn, { timeout, interval: 5 });
  }

  it('P1-1: notify fires exactly once on the timeout path', async () => {
    const notifier = vi.fn();
    const { transport, settle } = controlled();
    const { service } = makeService({ transport, notifier });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
      timeoutMs: 5,
    });

    // 1) deadline 先落 timeout（此时 notify 已投一次）
    await until(() => expect(service.get(delegation.id)!.status).toBe('timeout'));
    await until(() => expect(notifier).toHaveBeenCalledTimes(1));

    // 2) 子随后才 resolve —— 不得再投第二次
    settle({
      delegationId: delegation.id,
      status: 'completed',
      output: 'late',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(notifier).toHaveBeenCalledTimes(1);
    expect(service.get(delegation.id)!.status).toBe('timeout');
  });

  it('P1-2: a late result is traced, never silently dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { transport, settle } = controlled();
    const { service } = makeService({ transport });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
      timeoutMs: 5,
    });

    await until(() => expect(service.get(delegation.id)!.status).toBe('timeout'));

    // 迟到的子结果
    settle({
      delegationId: delegation.id,
      status: 'completed',
      output: 'the late conclusion',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });
    await until(() => expect(service.get(delegation.id)!.error).toContain('late result dropped'));

    const record = service.get(delegation.id)!;
    expect(record.status).toBe('timeout'); // 终态不被覆盖
    expect(record.error).toContain('the late conclusion'); // 但留痕
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('P1-2: a cancelled delegation keeps the user reason (no state-machine text leak)', async () => {
    const { transport, settle } = controlled();
    const { service, store } = makeService({ transport });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });
    service.cancel(delegation.id, 'user asked to stop');

    // 子随后才 resolve
    settle({
      delegationId: delegation.id,
      status: 'completed',
      output: 'late',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });
    await until(() =>
      expect(store.get(delegation.id)!.error).toContain('late result dropped'),
    );

    const record = store.get(delegation.id)!;
    expect(record.status).toBe('cancelled');
    // 用户原因必须保住
    expect(record.error).toContain('user asked to stop');
    // 状态机内部文案不得外泄
    expect(record.error).not.toContain('Invalid delegation transition');
  });

  it('a settled child is not affected by the deadline timer', async () => {
    // 反向对照：子先 resolve 的正常路径不应被 timeout 污染
    const notifier = vi.fn();
    const { transport, settle } = controlled();
    const { service } = makeService({ transport, notifier });

    const { delegation } = await service.dispatch({
      parent: PARENT,
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
      timeoutMs: 50,
    });

    settle({
      delegationId: delegation.id,
      status: 'completed',
      output: 'in time',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    });
    await until(() => expect(service.get(delegation.id)!.status).toBe('completed'));

    const record = service.get(delegation.id)!;
    expect(record.output).toBe('in time');
    expect(record.error).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 防回归：id 不得为空（假绿防护）
// ══════════════════════════════════════════════════════════════

describe('regression guard: child ids are never undefined', () => {
  it('RunnerChildRunPort saves the session under the server-provided id', async () => {
    const saved = new Map<string, SessionData>();
    const fakeRunner = {
      async *handle() {
        yield {
          type: 'turn.end',
          timestamp: Date.now(),
          agentId: 'w',
          sessionId: 's',
          data: { content: 'ok' },
        } as never;
      },
    };
    const { RunnerChildRunPort } = await import(
      '@octopi-agent/engine/harness/collaboration/delegation/child-run.js'
    );
    const port = new RunnerChildRunPort({
      resolve: () => ({
        runner: fakeRunner as never,
        store: {
          async load(id: string) { return saved.get(id) ?? null; },
          async save(id: string, s: SessionData) { saved.set(id, s); },
          async list() { return [...saved.values()].map((s) => s.meta); },
          async delete(id: string) { void saved.delete(id); },
          async exists(id: string) { return saved.has(id); },
        },
      }),
    });

    const out = await port.run({
      delegationId: 'del-1',
      childAgentId: 'worker',
      childSessionId: 'cs-server-123',
      childRunId: 'run-server-456',
      task: 't',
      input: 'i',
      context: 'clean',
      spawnBy: { delegationId: 'del-1', parentAgentId: 'main', parentSessionId: 's', parentRunId: 'r' },
      systemPrompt: 'p',
    });

    expect(saved.has('cs-server-123')).toBe(true);
    expect(saved.has('undefined')).toBe(false);
    expect(out.childSessionId).toBe('cs-server-123');
  });
});

// ══════════════════════════════════════════════════════════════
// A2 覆盖缺口：后置注册的工具必须过 SecurityGuard
// ══════════════════════════════════════════════════════════════

describe('SecurityGuard sees post-build registered delegate tools (A2)', () => {
  async function makeGuardedAgent() {
    const { DefaultSecurityGuard } = await import(
      '@octopi-agent/engine/harness/governance/security/default-security-guard.js'
    );
    const { Agent } = await import('@octopi-agent/engine/harness/run/agent/index.js');
    const guard = new DefaultSecurityGuard({ emit() { /* noop */ } } as never, {} as never);
    const harness = { security: guard } as never;
    const agent = new Agent({
      model: { name: 'test' } as never,
      harness,
    });
    return { agent, guard };
  }

  it('an unregistered tool is blocked, the same tool passes after registerTool', async () => {
    const { agent, guard } = await makeGuardedAgent();

    // 先注册一个无关工具，激活「未注册工具」检查
    // （DefaultSecurityGuard 仅在 registeredTools 非空时才拦 unauthorized_tool）
    agent.registerTool({
      name: 'unrelated_tool',
      description: 'x',
      parameters: {},
      execute: async () => 'ok',
    } as never);

    // 对照组：名单非空、delegate_dispatch 不在名单 → 应被拦
    const before = guard.checkToolCall({
      id: 'c1',
      name: 'delegate_dispatch',
      arguments: {},
    } as never);
    expect(before.isClean).toBe(false);

    // 用 builder 同款路径注册（Agent.registerTool 内部会 syncSecurityRegisteredTools）
    agent.registerTool({
      name: 'delegate_dispatch',
      description: 'delegate',
      parameters: {},
      execute: async () => 'ok',
    } as never);

    const after = guard.checkToolCall({
      id: 'c2',
      name: 'delegate_dispatch',
      arguments: {},
    } as never);
    expect(after.isClean).toBe(true);
  });

  it('all four delegate tools reach the registered-tools set', async () => {
    const { agent, guard } = await makeGuardedAgent();
    for (const name of [
      'delegate_dispatch',
      'delegate_list',
      'delegate_get',
      'delegate_cancel',
    ]) {
      agent.registerTool({
        name,
        description: name,
        parameters: {},
        execute: async () => 'ok',
      } as never);
    }
    for (const name of [
      'delegate_dispatch',
      'delegate_list',
      'delegate_get',
      'delegate_cancel',
    ]) {
      expect(
        guard.checkToolCall({ id: name, name, arguments: {} } as never).isClean,
      ).toBe(true);
    }
  });
});
