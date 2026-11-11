/**
 * P1-2 run lease（service-topology-p1.md §4 / §7.2）：同会话至多一个活动 run。
 *
 * 锚（§11 V2 判据拆解）：
 * ① 同会话并发第二路 `lease_held` 直拒（fail-loud 带持有者 instanceId/runId/剩余 TTL）；
 * ② run 终态 release 后同会话可再跑；
 * ③ TTL 过期的泄漏记录可抢占回收；
 * ④ 活动事件 renew 刷期（renewRunLease）；
 * ⑤ unregister 清 lease（与 sticky/pulse/回执路由对称）。
 */

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../packages/core/src/primitives/event-bus.js';
import type { RunRequest } from '../packages/engine/src/harness/activation/index.js';
import {
  FleetRunBackend,
  type InstanceBackend,
} from '../packages/gateway/src/gateway/supervise/fleet-backend.js';
import {
  RouteConfig,
  type InstanceRecord,
} from '../packages/gateway/src/gateway/supervise/registry.js';

function makeRecord(instanceId: string): InstanceRecord {
  return {
    instanceId,
    version: 'self',
    buildRef: 'self',
    port: 0,
    pid: -1,
    state: 'ready',
    startedAt: 0,
    load: { inFlightRuns: 0, queued: 0 },
  };
}

function makeBackend(instanceId: string, holdMs = 0): InstanceBackend & { controls: unknown[] } {
  const controls: unknown[] = [];
  return {
    controls,
    healthSnapshot: { mountedAgents: 1, inFlightRuns: 0, retiredRunners: 0 },
    startRun(req: RunRequest): AsyncIterable<AgentEvent> {
      return (async function* () {
        if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
        yield { type: 'run.started', sessionId: req.sessionId } as unknown as AgentEvent;
        yield { type: 'run.completed' } as unknown as AgentEvent;
      })();
    },
    async control(op: never) {
      controls.push(op);
      return { ok: true };
    },
    async health() {
      return this.healthSnapshot;
    },
    disposeAll(): void {
      /* 测试假实例：无状态可回收 */
    },
  } as unknown as InstanceBackend & { controls: unknown[] };
}

function req(sessionId: string): RunRequest {
  return { sessionId, agentId: 'assistant', messages: [] } as unknown as RunRequest;
}

function fleetWith(instanceId: string, backend: InstanceBackend, leaseTtlMs?: number) {
  const fleet = new FleetRunBackend({
    route: RouteConfig.seed({ versionPointer: 'self' }),
    ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
  });
  fleet.register({ record: makeRecord(instanceId), backend });
  return fleet;
}

describe('P1-2 run lease（同会话至多一个活动 run）', () => {
  it('① 同会话并发第二路 lease_held 直拒（fail-loud 带持有者）', async () => {
    const fleet = fleetWith('run-a', makeBackend('run-a', 50));

    const first = (async () => {
      for await (const _ of fleet.startRun(req('s1'))) void _;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fleet.isInFlight('s1')).toBe(true);

    const second = (async () => {
      for await (const _ of fleet.startRun(req('s1'))) void _;
    })();
    await expect(second).rejects.toThrow(/lease_held/);
    await expect(second).rejects.toThrow(/run-a/); // 持有者 instanceId 在错误面
    await first;
  });

  it('② run 终态 release 后同会话可再跑', async () => {
    const fleet = fleetWith('run-a', makeBackend('run-a'));

    for await (const _ of fleet.startRun(req('s1'))) void _;
    expect(fleet.isInFlight('s1')).toBe(false); // 终态即释放
    // 再跑不拒
    for await (const _ of fleet.startRun(req('s1'))) void _;
  });

  it('③ TTL 过期的泄漏记录可抢占回收', async () => {
    const fleet = fleetWith('run-a', makeBackend('run-a', 300), 30);

    const first = (async () => {
      for await (const _ of fleet.startRun(req('s1'))) void _;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const firstLease = fleet.runLeaseSnapshot('s1');
    // TTL=30ms 过期：泄漏记录可抢（不等第一路结束）
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = (async () => {
      for await (const _ of fleet.startRun(req('s1'))) void _;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondLease = fleet.runLeaseSnapshot('s1');
    expect(secondLease).toBeDefined();
    expect(secondLease!.runId).not.toBe(firstLease!.runId); // 抢占：新 runId 接管
    // 第一路仍在跑（不抢单）；其终态 release 不得误删抢入者的 lease（runId 判等保护）。
    // 注：TTL 30ms 下 second 的 lease 在 await first 期间也会过期（泄漏语义一致），
    // 判据是记录未被 first 的 release 误删，而非仍在 TTL 内。
    await first;
    expect(fleet.runLeaseSnapshot('s1')?.runId).toBe(secondLease!.runId);
    await second;
    expect(fleet.isInFlight('s1')).toBe(false);
  });

  it('④ 活动事件 renew 刷期', async () => {
    const fleet = fleetWith('run-a', makeBackend('run-a', 120), 60);

    const first = (async () => {
      for await (const _ of fleet.startRun(req('s1'))) void _;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 在 TTL 内持续续租：40ms 后 renew（TTL 重置 60ms），80ms 时仍未过期
    await new Promise((resolve) => setTimeout(resolve, 40));
    fleet.renewRunLease('s1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fleet.isInFlight('s1')).toBe(true); // 70ms < renew 后 100ms 到期
    await first;
  });

  it('⑤ unregister 清 lease（与 sticky/pulse/回执对称）', async () => {
    const fleet = fleetWith('run-a', makeBackend('run-a', 50));

    const first = (async () => {
      for await (const _ of fleet.startRun(req('s1'))) void _;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fleet.isInFlight('s1')).toBe(true);

    fleet.unregister('run-a');
    expect(fleet.isInFlight('s1')).toBe(false); // 实例没了 lease 一并失效
    await first;
    // 第一路终态 release 不得误删后续（同 ③ 保护语义）
    const snapshot = fleet.runLeaseSnapshot('s1');
    expect(snapshot).toBeUndefined();
  });
});
