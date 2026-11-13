/**
 * T4b 委派租户闸（arch/multi-tenancy.md §8）：
 * 委派限本租户——target.tenantId == source.tenantId，跨租户 fail-loud；
 * 子 run 归属继承位（ChildRunInput.tenantId）随父租户传播。
 */

import { describe, it, expect } from 'vitest';
import {
  DelegateService,
  DelegateResolutionError,
  DefaultAgentRegistry,
  DelegationStore,
  InProcessTransport,
  createChildRunExecutor,
  DELEGATION_SCHEMA_VERSION,
} from '@octopi-agent/engine/harness/collaboration/delegation/index.js';
import type {
  ChildRunInput,
  ChildRunPort,
} from '@octopi-agent/engine/harness/collaboration/delegation/child-run.js';
import type { DelegateRequest } from '@octopi-agent/engine/harness/collaboration/delegation/types.js';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';

function makeService(agents: Array<{ id: string; tenantId?: string }>) {
  const events = new DefaultEventBus();
  const registry = new DefaultAgentRegistry();
  for (const a of agents) {
    registry.register({
      id: a.id,
      name: a.id,
      traits: [],
      status: 'idle',
      ...(a.tenantId === undefined ? {} : { tenantId: a.tenantId }),
      delegation: { callable: true, canDelegate: false, maxDepth: 1 },
    });
  }
  const store = new DelegationStore(events);
  const service = new DelegateService(
    store,
    registry,
    new InProcessTransport(async (req) => ({
      delegationId: req.delegationId,
      status: 'completed',
      output: 'ok',
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    })),
    {},
  );
  return { service, store };
}

const baseParent = { agentId: 'main', sessionId: 's1', runId: 'r1' };

describe('委派租户闸（§8：只可委派本租户 agent）', () => {
  it('跨租户 dispatch 一律拒：delegate_cross_tenant fail-loud', async () => {
    const { service } = makeService([
      { id: 'main', tenantId: 'tA' },
      { id: 'worker', tenantId: 'tB' },
    ]);
    await expect(
      service.dispatch({
        parent: { ...baseParent, tenantId: 'tA' },
        target: { agentId: 'worker' },
        task: 't',
        input: 'i',
      }),
    ).rejects.toThrow(/cross-tenant/);
  });

  it('同租户 dispatch 放行；缺省域（config agent）彼此可派', async () => {
    const { service, store } = makeService([
      { id: 'main', tenantId: 'tA' },
      { id: 'worker', tenantId: 'tA' },
      { id: 'host-a' },
      { id: 'host-b' },
    ]);
    const same = await service.dispatch({
      parent: { ...baseParent, tenantId: 'tA' },
      target: { agentId: 'worker' },
      task: 't',
      input: 'i',
    });
    expect(same.resolvedAgentId).toBe('worker');

    const legacy = await service.dispatch({
      parent: { agentId: 'host-a', sessionId: 's2', runId: 'r2' },
      target: { agentId: 'host-b' },
      task: 't',
      input: 'i',
    });
    expect(legacy.resolvedAgentId).toBe('host-b');
    expect(store.list()).toHaveLength(2);
  });

  it('缺省域父不得派他租户 agent；租户父不得派缺省域 agent（对称拒）', async () => {
    const { service } = makeService([
      { id: 'main' },
      { id: 'worker', tenantId: 'tB' },
    ]);
    await expect(
      service.dispatch({
        parent: baseParent,
        target: { agentId: 'worker' },
        task: 't',
        input: 'i',
      }),
    ).rejects.toThrow(/cross-tenant/);

    const { service: svc2 } = makeService([
      { id: 'main', tenantId: 'tB' },
      { id: 'host-worker' },
    ]);
    await expect(
      svc2.dispatch({
        parent: { ...baseParent, tenantId: 'tB' },
        target: { agentId: 'host-worker' },
        task: 't',
        input: 'i',
      }),
    ).rejects.toThrow(/cross-tenant/);
  });

  it('trait 解析不跨域选人（MAJ-8）：他租户候选被过滤，落 not_found 而非被硬拒', async () => {
    const events = new DefaultEventBus();
    const registry = new DefaultAgentRegistry();
    registry.register({
      id: 'worker',
      name: 'worker',
      traits: ['review'],
      status: 'idle',
      tenantId: 'tB',
      delegation: { callable: true, canDelegate: false, maxDepth: 1 },
    });
    const service = new DelegateService(
      new DelegationStore(events),
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        output: 'ok',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      {},
    );
    // 旧行为：trait 命中他租户候选 → 硬拒 cross_tenant（本域明明可以没有候选也炸）；
    // 新行为（MAJ-8）：选人阶段就按父域过滤——他租户候选不参与，落 not_found
    await expect(
      service.dispatch({
        parent: { ...baseParent, tenantId: 'tA' },
        target: { trait: 'review' },
        task: 't',
        input: 'i',
      }),
    ).rejects.toThrow(/no callable agent/);
  });

  it('trait 选人按父域过滤（MAJ-8 主锚）：他租户同 trait 不抢选，本域候选可达', async () => {
    const events = new DefaultEventBus();
    const registry = new DefaultAgentRegistry();
    // A 的候选插入在前——B 的父派仍须选中 B 自己的候选（不依赖插入序）
    registry.register({ id: 'wa', name: 'wa', traits: ['researcher'], status: 'idle', tenantId: 'tA', delegation: { callable: true, canDelegate: false, maxDepth: 1 } });
    registry.register({ id: 'wb', name: 'wb', traits: ['researcher'], status: 'idle', tenantId: 'tB', delegation: { callable: true, canDelegate: false, maxDepth: 1 } });
    const service = new DelegateService(
      new DelegationStore(events),
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        output: 'ok',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      {},
    );
    const result = await service.dispatch({
      parent: { ...baseParent, tenantId: 'tB' },
      target: { trait: 'researcher' },
      task: 't',
      input: 'i',
    });
    expect(result.resolvedAgentId).toBe('wb');
  });

  it('可用目标回传不泄他租户（MIN-1）', async () => {
    const events = new DefaultEventBus();
    const registry = new DefaultAgentRegistry();
    registry.register({ id: 'wa', name: 'wa', traits: ['researcher'], status: 'idle', tenantId: 'tA', delegation: { callable: true, canDelegate: false, maxDepth: 1 } });
    const service = new DelegateService(
      new DelegationStore(events),
      registry,
      new InProcessTransport(async (req) => ({
        delegationId: req.delegationId,
        status: 'completed',
        output: 'ok',
        schemaVersion: DELEGATION_SCHEMA_VERSION,
      })),
      {},
    );
    try {
      await service.dispatch({
        parent: { ...baseParent, tenantId: 'tB' },
        target: { trait: 'researcher' },
        task: 't',
        input: 'i',
      });
      expect.unreachable('dispatch should fail without a same-tenant candidate');
    } catch (err) {
      expect(err).toBeInstanceOf(DelegateResolutionError);
      const info = (err as DelegateResolutionError).available as
        | { agents?: Array<{ id: string }> }
        | undefined;
      expect(info?.agents?.map((a) => a.id) ?? []).not.toContain('wa');
    }
  });
});

describe('子 run 归属继承位（ChildRunInput.tenantId 随父传播）', () => {
  it('createChildRunExecutor 把 request.from.tenantId 透传给子 run', async () => {
    const captured: ChildRunInput[] = [];
    const port: ChildRunPort = {
      run: async (input) => {
        captured.push(input);
        return {
          delegationId: input.delegationId,
          status: 'completed',
          output: 'ok',
          usage: emptyUsage(),
          childSessionId: input.childSessionId,
          childRunId: input.childRunId,
        } as never;
      },
    };
    const executor = createChildRunExecutor(port, { persona: 'child' });
    const request: DelegateRequest = {
      schemaVersion: DELEGATION_SCHEMA_VERSION,
      delegationId: 'd1',
      from: { agentId: 'main', sessionId: 's1', runId: 'r1', tenantId: 'tA' },
      to: { agentId: 'worker' },
      task: 't',
      input: 'i',
      context: 'clean',
      childSessionId: 'c-s1',
      childRunId: 'c-r1',
    } as unknown as DelegateRequest;
    const result = await executor(request);
    expect(result.status).toBe('completed');
    expect(captured[0]!.tenantId).toBe('tA');
  });

  it('父无归属（存量）时子 run 不带 tenantId（落 DEFAULT 语义）', async () => {
    const captured: ChildRunInput[] = [];
    const port: ChildRunPort = {
      run: async (input) => {
        captured.push(input);
        return {
          delegationId: input.delegationId,
          status: 'completed',
          output: 'ok',
          usage: emptyUsage(),
          childSessionId: input.childSessionId,
          childRunId: input.childRunId,
        } as never;
      },
    };
    const executor = createChildRunExecutor(port, { persona: 'child' });
    const request: DelegateRequest = {
      schemaVersion: DELEGATION_SCHEMA_VERSION,
      delegationId: 'd2',
      from: { agentId: 'main', sessionId: 's1', runId: 'r1' },
      to: { agentId: 'worker' },
      task: 't',
      input: 'i',
      context: 'clean',
      childSessionId: 'c-s2',
      childRunId: 'c-r2',
    } as unknown as DelegateRequest;
    await executor(request);
    expect(captured[0]!.tenantId).toBeUndefined();
  });
});

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    inputCachedTokens: 0,
    inputUncachedTokens: 0,
    inputCacheWriteTokens: 0,
  };
}
