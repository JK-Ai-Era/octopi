/**
 * P1-3 漂移处置编排（service-topology-p1.md §5，Q2=(a)）：
 * fleet-wide reattest fan-out → 失败实例滚动替换（spawn 同 version/buildRef 过门 → drain 老）。
 *
 * 锚（V5 编排判据）：
 * ① reattest 成功实例留任，失败实例被滚动替换（spawn+drain 调用齐）；
 * ② 替换 spawn 不过门 → fail-loud 留痕（failed 清单），不静默；
 * ③ 结构化 fanOut 明细（per-instance 成败）供编排消费（单一 fan-out 事实源）。
 */

import { describe, expect, it, vi } from 'vitest';

import type { RunControlOp, RunControlResponse } from '../packages/engine/src/harness/activation/run-protocol.js';
import {
  FleetRunBackend,
  type InstanceBackend,
} from '../packages/gateway/src/gateway/supervise/fleet-backend.js';
import { FleetOps, type SpawnOutcome } from '../packages/gateway/src/gateway/supervise/ops.js';
import {
  InstanceRegistry,
  RouteConfig,
  type InstanceRecord,
} from '../packages/gateway/src/gateway/supervise/registry.js';

function makeRecord(instanceId: string): InstanceRecord {
  return {
    instanceId,
    version: 'v1',
    buildRef: '/builds/v1',
    port: 0,
    pid: -1,
    state: 'ready',
    startedAt: 0,
    load: { inFlightRuns: 0, queued: 0 },
  };
}

function makeBackend(
  instanceId: string,
  reattest: (op: RunControlOp) => Promise<RunControlResponse>,
): InstanceBackend {
  const healthSnapshot = { mountedAgents: 1, inFlightRuns: 0, retiredRunners: 0 };
  return {
    healthSnapshot,
    startRun: () =>
      (async function* () {
        /* 假实例：无 run */
      })(),
    control: reattest,
    async health() {
      return healthSnapshot;
    },
    disposeAll(): void {
      /* 假实例：无状态可回收 */
    },
  } as unknown as InstanceBackend;
}

const REATTEST_OP = {
  type: 'reattestSecurity' as const,
  expectHash: 'hash-x',
  allowedChanged: ['toolRights'],
};

function buildOps(onSpawn: (version: string, buildRef: string) => Promise<InstanceBackend>) {
  const route = RouteConfig.seed({ versionPointer: 'v1' });
  const fleet = new FleetRunBackend({ route });
  const registry = new InstanceRegistry();
  const ops = new FleetOps({
    fleet,
    registry,
    route,
    spawnInstance: onSpawn,
    probeOptions: () => ({ securityIntegrityConfigured: true }),
  });
  return { fleet, ops };
}

describe('P1-3 漂移处置编排（reattest 优先，失败滚动替换）', () => {
  it('① 成功实例留任，失败实例滚动替换', async () => {
    const { fleet, ops } = buildOps(async () =>
      makeBackend('i-replacement', async () => ({ ok: true })),
    );
    fleet.register({
      record: makeRecord('i-a'),
      backend: makeBackend('i-a', async () => ({ ok: true })),
    });
    fleet.register({
      record: makeRecord('i-b'),
      backend: makeBackend('i-b', async () => ({ ok: false, error: { message: 'anchor refused' } })),
    });

    const spawnSpy = vi.spyOn(ops, 'spawn').mockResolvedValue({
      ready: [makeRecord('i-replacement')],
      failed: [],
    } satisfies SpawnOutcome);
    const drainSpy = vi.spyOn(ops, 'drain').mockResolvedValue(undefined);

    const res = await ops.remediateDrift(REATTEST_OP);

    expect(res.reattested).toEqual(['i-a']);
    expect(res.replaced).toEqual(['i-b']);
    expect(res.failed).toEqual([]);
    expect(spawnSpy).toHaveBeenCalledWith('v1', '/builds/v1', 1); // 同版本同产物根
    expect(drainSpy).toHaveBeenCalledWith('i-b'); // 只换失败者
  });

  it('② 替换 spawn 不过门 → fail-loud 留痕', async () => {
    const { fleet, ops } = buildOps(async () =>
      makeBackend('i-replacement', async () => ({ ok: true })),
    );
    fleet.register({
      record: makeRecord('i-b'),
      backend: makeBackend('i-b', async () => ({ ok: false, error: { message: 'anchor refused' } })),
    });
    // 替换件不过健康门
    vi.spyOn(ops, 'spawn').mockResolvedValue({
      ready: [],
      failed: [{ record: makeRecord('i-replacement'), reason: 'health gate: smoke failed' }],
    } satisfies SpawnOutcome);

    const res = await ops.remediateDrift(REATTEST_OP);

    expect(res.replaced).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]).toMatch(/i-b/);
    expect(res.failed[0]).toMatch(/smoke failed/);
  });

  it('③ 结构化 fanOut 明细（per-instance 成败）', async () => {
    const { fleet, ops } = buildOps(async () => makeBackend('i-new', async () => ({ ok: true })));
    fleet.register({ record: makeRecord('i-a'), backend: makeBackend('i-a', async () => ({ ok: true })) });
    fleet.register({
      record: makeRecord('i-b'),
      backend: makeBackend('i-b', async () => ({ ok: false, error: { message: 'boom' } })),
    });

    const perInstance = await fleet.fanOut(REATTEST_OP);
    expect(perInstance).toEqual([
      { instanceId: 'i-a', ok: true },
      { instanceId: 'i-b', ok: false, error: 'boom' },
    ]);
    void ops; // ops 参与构造（deps 完整性）
  });
});
