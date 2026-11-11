/**
 * supervise — FleetRunBackend + InstanceRegistry（P0c-2 验收锚）
 *
 * 覆盖：sticky 亲和 / 单飞闸门 / 最少负载分配 / failed 亲和失效 / control 三类路由 /
 * health 聚合 / pulse 归属 / registry 状态机。全部假实例驱动，不碰真进程。
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type {
  RunBackendHealth,
  RunControlOp,
  RunControlResponse,
} from '@octopi-agent/engine/harness/activation/run-protocol.js';
import type { RunRequest } from '@octopi-agent/engine/harness/activation/index.js';
import { FleetRunBackend, type InstanceBackend } from '../packages/gateway/src/gateway/supervise/fleet-backend.js';
import { InstanceRegistry, RouteConfig, type InstanceRecord } from '../packages/gateway/src/gateway/supervise/registry.js';

function makeRecord(instanceId: string, overrides?: Partial<InstanceRecord>): InstanceRecord {
  return {
    instanceId,
    version: 'self',
    buildRef: 'self',
    port: 1000,
    pid: 1,
    state: 'ready',
    startedAt: Date.now(),
    load: { inFlightRuns: 0, queued: 0 },
    ...overrides,
  };
}

interface FakeBackend extends InstanceBackend {
  controls: RunControlOp[];
  failControl: boolean;
  healthSnapshot: RunBackendHealth;
  stopped: boolean;
}

function makeBackend(instanceId: string): FakeBackend {
  return {
    controls: [],
    failControl: false,
    healthSnapshot: {
      mountedAgents: 3,
      inFlightRuns: 0,
      retiredRunners: 0,
      pulses: [{ key: `${instanceId}:p`, intervalMs: 1000 }],
    },
    startRun(req: RunRequest): AsyncIterable<AgentEvent> {
      return (async function* () {
        yield { type: 'run.started', sessionId: req.sessionId } as unknown as AgentEvent;
        yield { type: 'run.completed' } as unknown as AgentEvent;
      })();
    },
    async control(op: RunControlOp): Promise<RunControlResponse> {
      this.controls.push(op);
      if (this.failControl) return { ok: false, error: { message: `${instanceId} refused` } };
      return { ok: true, result: { on: instanceId } };
    },
    async health(): Promise<RunBackendHealth> {
      return this.healthSnapshot;
    },
    async smoke() {
      return { ok: true, agents: [{ agentId: 'a', toolCount: 1, checks: [{ name: 'tools', ok: true }] }] };
    },
    async stop() {
      this.stopped = true;
    },
    stopped: false,
  };
}

const req = (sessionId: string): RunRequest => ({ sessionId, agentId: 'a' }) as RunRequest;

describe('FleetRunBackend routing', () => {
  it('keeps session affinity and picks least-loaded for new sessions', async () => {
    const fleet = new FleetRunBackend({ route: RouteConfig.seed({ versionPointer: 'self' }) });
    const a = makeBackend('run-a');
    const b = makeBackend('run-b');
    fleet.register({ record: makeRecord('run-a'), backend: a });
    fleet.register({ record: makeRecord('run-b'), backend: b });

    // 新会话 → least loaded（先到 a）
    for await (const _ of fleet.startRun(req('s1'))) void _;
    expect(fleet.routeOf('s1')).toBe('run-a');

    // s1 第二 run → 亲和 a（即使 b 更闲）
    for await (const _ of fleet.startRun(req('s1'))) void _;
    expect(fleet.routeOf('s1')).toBe('run-a');
    expect(a.controls).toHaveLength(0);

    // 新会话 s2 → b（a 的 inFlight 已回 0，两者同负载取注册序；改 b 负载高则仍 a）
    b.healthSnapshot.inFlightRuns = 5;
    for await (const _ of fleet.startRun(req('s2'))) void _;
    expect(fleet.routeOf('s2')).toBe('run-a');
  });

  it('rejects a second concurrent run on the same session (single-flight)', async () => {
    const fleet = new FleetRunBackend({ route: RouteConfig.seed({ versionPointer: 'self' }) });
    const a = makeBackend('run-a');
    // 慢实例：startRun 产出前挂起
    a.startRun = () =>
      (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield { type: 'run.completed' } as unknown as AgentEvent;
      })();
    fleet.register({ record: makeRecord('run-a'), backend: a });

    const first = (async () => {
      for await (const _ of fleet.startRun(req('s1'))) void _;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fleet.isInFlight('s1')).toBe(true);

    const second = (async () => {
      for await (const _ of fleet.startRun(req('s1'))) void _;
    })();
    await expect(second).rejects.toThrow(/single-flight/);
    await first;
    expect(fleet.isInFlight('s1')).toBe(false);
  });

  it('re-routes away from failed instance but keeps draining affinity', async () => {
    const fleet = new FleetRunBackend({ route: RouteConfig.seed({ versionPointer: 'self' }) });
    const a = makeBackend('run-a');
    const b = makeBackend('run-b');
    fleet.register({ record: makeRecord('run-a'), backend: a });
    fleet.register({ record: makeRecord('run-b'), backend: b });

    for await (const _ of fleet.startRun(req('s1'))) void _;
    expect(fleet.routeOf('s1')).toBe('run-a');

    // draining：亲和保持
    fleet.list().find((e) => e.record.instanceId === 'run-a')!.record.state = 'draining';
    for await (const _ of fleet.startRun(req('s1'))) void _;
    expect(fleet.routeOf('s1')).toBe('run-a');

    // failed：亲和失效，换 b
    fleet.list().find((e) => e.record.instanceId === 'run-a')!.record.state = 'failed';
    for await (const _ of fleet.startRun(req('s1'))) void _;
    expect(fleet.routeOf('s1')).toBe('run-b');
  });

  it('routes control ops by class: session sticky / fleet-wide fan-out / pulse owner', async () => {
    const fleet = new FleetRunBackend({ route: RouteConfig.seed({ versionPointer: 'self' }) });
    const a = makeBackend('run-a');
    const b = makeBackend('run-b');
    fleet.register({ record: makeRecord('run-a'), backend: a });
    fleet.register({ record: makeRecord('run-b'), backend: b });

    for await (const _ of fleet.startRun(req('s1'))) void _;

    // session-scoped → sticky 实例
    const sessionOp = { type: 'abort', sessionId: 's1', reason: 'x' } as RunControlOp;
    await fleet.control(sessionOp);
    expect(a.controls).toContainEqual(sessionOp);
    expect(b.controls).toHaveLength(0);

    // fleet-wide → 双实例
    const retire = { type: 'retireAgent', agentId: 'a' } as RunControlOp;
    const res = await fleet.control(retire);
    expect(res.ok).toBe(true);
    expect(a.controls).toContainEqual(retire);
    expect(b.controls).toContainEqual(retire);

    // fleet-wide 有实例失败 → 聚合报错（fail-loud，指名实例）
    b.failControl = true;
    const failed = await fleet.control(retire);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain('run-b');
    b.failControl = false;

    // pulse 无归属 fail-loud；有归属定向
    const unowned = await fleet.control({ type: 'pulse', key: 'k:orphan' });
    expect(unowned.ok).toBe(false);
    fleet.setPulseOwner('k:owned', 'run-b');
    await fleet.control({ type: 'pulse', key: 'k:owned' });
    expect(b.controls.at(-1)).toEqual({ type: 'pulse', key: 'k:owned' });

    // 未知形态 fail-loud（无 sessionId、非 fleet-wide、非 pulse、无回执路由）
    const unrouteable = await fleet.control({ type: 'setSessionPreferences' } as RunControlOp);
    expect(unrouteable.ok).toBe(false);
  });

  it('routes point-to-point replies by notify-registered source (third op class)', async () => {
    const fleet = new FleetRunBackend({ route: RouteConfig.seed({ versionPointer: 'self' }) });
    const a = makeBackend('run-a');
    const b = makeBackend('run-b');
    fleet.register({ record: makeRecord('run-a'), backend: a });
    fleet.register({ record: makeRecord('run-b'), backend: b });

    // 未登记回执路由 fail-loud
    const orphan = await fleet.control({
      type: 'clientToolResult',
      callId: 'c9',
      outcome: { ok: true, result: 1 },
    } as RunControlOp);
    expect(orphan.ok).toBe(false);

    // 登记源实例 → 回执定向送达；成功即拆除（第二次回执 fail-loud）
    fleet.setReplyRoute('clientTool:c1', 'run-b');
    const delivered = await fleet.control({
      type: 'clientToolResult',
      callId: 'c1',
      outcome: { ok: true, result: 1 },
    } as RunControlOp);
    expect(delivered.ok).toBe(true);
    expect(b.controls.at(-1)).toMatchObject({ type: 'clientToolResult', callId: 'c1' });
    expect(a.controls).toHaveLength(0);

    const replay = await fleet.control({
      type: 'clientToolResult',
      callId: 'c1',
      outcome: { ok: true, result: 1 },
    } as RunControlOp);
    expect(replay.ok).toBe(false);

    // approvalReply / askUserReply 同类
    fleet.setReplyRoute('approval:ap1', 'run-a');
    await fleet.control({ type: 'approvalReply', approvalId: 'ap1', result: 'allow' } as RunControlOp);
    expect(a.controls.at(-1)).toMatchObject({ type: 'approvalReply', approvalId: 'ap1' });
  });

  it('aggregates health (sum inFlight, max mounted, dedupe pulses, list unreachable)', async () => {
    const fleet = new FleetRunBackend({ route: RouteConfig.seed({ versionPointer: 'self' }) });
    const a = makeBackend('run-a');
    const b = makeBackend('run-b');
    fleet.register({ record: makeRecord('run-a'), backend: a });
    fleet.register({ record: makeRecord('run-b'), backend: b });

    a.healthSnapshot = {
      mountedAgents: 3,
      inFlightRuns: 2,
      retiredRunners: 1,
      pulses: [{ key: 'x:shared', intervalMs: 1000 }],
    };
    b.healthSnapshot = {
      mountedAgents: 3,
      inFlightRuns: 1,
      retiredRunners: 0,
      pulses: [
        { key: 'x:shared', intervalMs: 1000 },
        { key: 'y:only-b', intervalMs: 2000 },
      ],
    };

    const health = await fleet.health();
    expect(health.mountedAgents).toBe(3);
    expect(health.inFlightRuns).toBe(3);
    expect(health.retiredRunners).toBe(1);
    expect(health.pulses!.map((p) => p.key).sort()).toEqual(['x:shared', 'y:only-b']);
    expect(health.unreachableInstances).toBeUndefined();

    b.health = async () => {
      throw new Error('down');
    };
    const degraded = await fleet.health();
    expect(degraded.unreachableInstances).toEqual(['run-b']);
    expect(degraded.inFlightRuns).toBe(2);
  });

  it('pulse inventory is per-instance and ownership rejects unregistered instances', async () => {
    const fleet = new FleetRunBackend({ route: RouteConfig.seed({ versionPointer: 'self' }) });
    const a = makeBackend('run-a');
    fleet.register({ record: makeRecord('run-a'), backend: a });

    const inventory = await fleet.pulseInventory();
    expect(inventory).toEqual([{ instanceId: 'run-a', spec: { key: 'run-a:p', intervalMs: 1000 } }]);

    expect(() => fleet.setPulseOwner('k:x', 'run-nope')).toThrow(/unregistered/);
    fleet.setPulseOwner('k:x', 'run-a');
    expect(fleet.resolvePulseOwner('k:x')).toBe('run-a');
    fleet.clearPulseOwner('k:x');
    expect(fleet.resolvePulseOwner('k:x')).toBeUndefined();

    // 注销实例清归属
    fleet.setPulseOwner('k:x', 'run-a');
    fleet.unregister('run-a');
    expect(fleet.resolvePulseOwner('k:x')).toBeUndefined();
  });
});

describe('InstanceRegistry', () => {
  it('enforces state machine (failed is terminal) and unique ids', () => {
    const registry = new InstanceRegistry();
    registry.add(makeRecord('i1'));
    expect(() => registry.add(makeRecord('i1'))).toThrow(/already registered/);

    registry.setState('i1', 'draining');
    expect(registry.get('i1')!.state).toBe('draining');
    registry.setState('i1', 'failed');
    expect(() => registry.setState('i1', 'ready')).toThrow(/terminal/);
    expect(() => registry.setState('i-nope', 'ready')).toThrow(/not registered/);
  });

  it('seeds RouteConfig from config (Q3=A: runtime + seeding)', () => {
    const route = RouteConfig.seed({ versionPointer: 'self', replicasPerVersion: 2 });
    expect(route.versionPointer).toBe('self');
    expect(route.replicasPerVersion).toBe(2);
    expect(route.weights.get('self')).toBe(100);
  });
});
