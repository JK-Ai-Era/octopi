/**
 * P1-4 canary 权重 + 扩容（service-topology-p1.md §6/§7，Q5 合一）。
 *
 * 锚：
 * ① V3：setWeights 会话级抽样分流（分布近似权重）；sticky 会话不迁移；
 * ② setWeights fail-loud（和≠100 / 空版本 / 无 ready 副本黑洞拒绝）；
 * ③ promote ≡ setWeights({target:100})（指针=100/0 特例，单一账本）；
 * ④ V4：scale 1→2→1 收敛（少补 spawn、多退 drain）；
 * ⑤ 负载判据纳入队列深度（inFlightRuns + queued）。
 */

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../packages/core/src/primitives/event-bus.js';
import type { RunRequest } from '../packages/engine/src/harness/activation/index.js';
import {
  FleetRunBackend,
  type InstanceBackend,
} from '../packages/gateway/src/gateway/supervise/fleet-backend.js';
import { FleetOps } from '../packages/gateway/src/gateway/supervise/ops.js';
import {
  InstanceRegistry,
  RouteConfig,
  type InstanceRecord,
} from '../packages/gateway/src/gateway/supervise/registry.js';

function makeRecord(instanceId: string, version: string): InstanceRecord {
  return {
    instanceId,
    version,
    buildRef: `/builds/${version}`,
    port: 0,
    pid: -1,
    state: 'ready',
    startedAt: 0,
    load: { inFlightRuns: 0, queued: 0 },
  };
}

function makeBackend(): InstanceBackend {
  return {
    healthSnapshot: { mountedAgents: 1, inFlightRuns: 0, retiredRunners: 0 },
    startRun(req: RunRequest): AsyncIterable<AgentEvent> {
      return (async function* () {
        yield { type: 'run.completed', sessionId: req.sessionId } as unknown as AgentEvent;
      })();
    },
    async control() {
      return { ok: true };
    },
    async health() {
      return this.healthSnapshot;
    },
    disposeAll(): void {
      /* 假实例：无状态可回收 */
    },
    async stop(): Promise<void> {
      /* 假实例：无进程可停 */
    },
  } as unknown as InstanceBackend;
}

function req(sessionId: string): RunRequest {
  return { sessionId, agentId: 'assistant', messages: [] } as unknown as RunRequest;
}

function setup() {
  const route = RouteConfig.seed({ versionPointer: 'self' });
  const fleet = new FleetRunBackend({ route });
  const registry = new InstanceRegistry();
  const ops = new FleetOps({
    fleet,
    registry,
    route,
    spawnInstance: async () => makeBackend(),
    probeOptions: () => ({ securityIntegrityConfigured: true }),
  });
  const register = (instanceId: string, version: string): InstanceRecord => {
    const record = makeRecord(instanceId, version);
    registry.add(record);
    fleet.register({ record, backend: makeBackend() });
    return record;
  };
  return { route, fleet, registry, ops, register };
}

describe('P1-4 canary 权重 + 扩容', () => {
  it('① V3 会话级抽样分流近似权重；sticky 会话不迁移', async () => {
    const { route, fleet, ops, register } = setup();
    register('i-self-1', 'self');
    register('i-canary-1', 'v-canary');

    ops.setWeights({ self: 50, 'v-canary': 50 });

    // 30 个新会话（uuid 形态 id）按 hash 抽样分流
    const counts: Record<string, number> = { self: 0, 'v-canary': 0 };
    for (let i = 0; i < 30; i += 1) {
      const sid = `0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      for await (const _ of fleet.startRun(req(sid))) void _;
      counts[fleet.routeOf(sid)!.includes('canary') ? 'v-canary' : 'self'] += 1;
    }
    expect(counts.self).toBeGreaterThanOrEqual(6); // 统计容差：两侧 ≥20%
    expect(counts['v-canary']).toBeGreaterThanOrEqual(6);

    // sticky 不迁移：跑过的会话再跑仍钉原实例（不受权重变化影响）
    ops.setWeights({ self: 100 });
    const sid = `0000000-0000-4000-8000-${String(0).padStart(12, '0')}`;
    const before = fleet.routeOf(sid);
    for await (const _ of fleet.startRun(req(sid))) void _;
    expect(fleet.routeOf(sid)).toBe(before);
    expect(route.weights.get('self')).toBe(100);
  });

  it('② setWeights fail-loud（和≠100 / 空 / 无 ready 黑洞拒绝）', () => {
    const { ops, register } = setup();
    register('i-self-1', 'self');

    expect(() => ops.setWeights({ self: 60 })).toThrow(/summing to 100/);
    expect(() => ops.setWeights({})).toThrow(/at least one version/);
    expect(() => ops.setWeights({ self: 50, ghost: 50 })).toThrow(/no ready instance/);
  });

  it('③ promote ≡ setWeights({target:100})（指针=100/0 特例）', () => {
    const { route, ops, register } = setup();
    register('i-self-1', 'self');
    register('i-v2-1', 'v2');

    ops.setWeights({ self: 80, v2: 20 });
    expect(route.versionPointer).toBe('self'); // 多版本：指针不变（展示面）

    ops.promote('v2');
    expect(route.versionPointer).toBe('v2');
    expect(Object.fromEntries(route.weights)).toEqual({ v2: 100 }); // 单一账本
  });

  it('④ V4 scale 1→2→1 收敛（少补 spawn、多退 drain）', async () => {
    const { ops, register } = setup();
    register('i-v1-1', 'v1');

    // 外缘 mock：真健康门是 HTTP probe（假实例无 HTTP 面）——spawn 收敛逻辑仍真实执行；
    // mock 同步登记 registry（scale 的 alive 计数依赖登记事实）
    vi.spyOn(ops, 'spawn').mockImplementation(async () => {
      const record = register('i-v1-2', 'v1');
      return { ready: [record], failed: [] };
    });

    const up = await ops.scale('v1', '/builds/v1', 2);
    expect(up.ready).toHaveLength(1); // 补 1
    expect(up.failed).toEqual([]);

    const drainSpy = vi.spyOn(ops, 'drain').mockResolvedValue(undefined);
    const down = await ops.scale('v1', '/builds/v1', 1);
    expect(down.ready).toEqual([]); // 多退不补
    expect(drainSpy).toHaveBeenCalledTimes(1); // drain 1 个
  });

  it('⑤ 负载判据=inFlightRuns（MAJ-5 勘误：queued reserved 无生产者，不空转假数据）', async () => {
    const { fleet, register } = setup();
    const a = register('i-a', 'self');
    const b = register('i-b', 'self');
    a.load.queued = 5; // queued 变化不得影响选择（reserved，随排队语义落地再纳入）
    b.load.inFlightRuns = 1;

    // 判据只看 inFlightRuns：a=0 < b=1 → 选 a
    for await (const _ of fleet.startRun(req('s-pick'))) void _;
    expect(fleet.routeOf('s-pick')).toBe('i-a');
  });
});
