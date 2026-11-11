/**
 * 健康门 + FleetOps（P0c-3 验收锚：probe 判据矩阵 + ops 状态机）。
 * 全假 backend 驱动；真进程链路见 supervise-ops-e2e.test.ts。
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type {
  RunBackendHealth,
  RunControlOp,
  RunControlResponse,
  RunSmokeReport,
} from '@octopi-agent/engine/harness/activation/run-protocol.js';
import type { RunRequest } from '@octopi-agent/engine/harness/activation/index.js';
import { FleetRunBackend, type InstanceBackend } from '../packages/gateway/src/gateway/supervise/fleet-backend.js';
import { InstanceRegistry, RouteConfig } from '../packages/gateway/src/gateway/supervise/registry.js';
import { probeInstance } from '../packages/gateway/src/gateway/supervise/probe.js';
import { FleetOps, type FleetOpsDeps } from '../packages/gateway/src/gateway/supervise/ops.js';

interface FakeBackend extends InstanceBackend {
  stopped: boolean;
  failHealth: boolean;
  smokeReport: RunSmokeReport;
  healthSnapshot: RunBackendHealth;
}

function makeBackend(): FakeBackend {
  return {
    stopped: false,
    failHealth: false,
    smokeReport: { ok: true, agents: [{ agentId: 'a', toolCount: 2, checks: [{ name: 'tools', ok: true }] }] },
    healthSnapshot: { mountedAgents: 1, inFlightRuns: 0, retiredRunners: 0, pulses: [] },
    startRun(req: RunRequest): AsyncIterable<AgentEvent> {
      return (async function* () {
        yield { type: 'run.completed' } as unknown as AgentEvent;
      })();
    },
    async control(_op: RunControlOp): Promise<RunControlResponse> {
      return { ok: true };
    },
    async health(): Promise<RunBackendHealth> {
      if (this.failHealth) throw new Error('down');
      return this.healthSnapshot;
    },
    async smoke(): Promise<RunSmokeReport> {
      return this.smokeReport;
    },
    async stop() {
      this.stopped = true;
    },
  };
}

function makeOps(options?: { securityIntegrityConfigured?: boolean; spawnFailFor?: string }) {
  const route = RouteConfig.seed({ versionPointer: 'v1' });
  const fleet = new FleetRunBackend({ route });
  const registry = new InstanceRegistry();
  const spawned: FakeBackend[] = [];
  const deps: FleetOpsDeps = {
    fleet,
    registry,
    route,
    spawnInstance: async (version, _buildRef, _instanceId) => {
      if (version === options?.spawnFailFor) throw new Error('fork failed');
      const backend = makeBackend();
      spawned.push(backend);
      return backend;
    },
    probeOptions: () => ({ securityIntegrityConfigured: options?.securityIntegrityConfigured ?? false }),
  };
  return { ops: new FleetOps(deps), fleet, registry, route, spawned };
}

describe('probeInstance (health gate)', () => {
  it('passes health + smoke + guard when configured and armed', async () => {
    const backend = makeBackend();
    backend.healthSnapshot.securityGuard = 'armed';
    const result = await probeInstance(backend, { securityIntegrityConfigured: true });
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(['health', 'smoke', 'securityGuard']);
  });

  it('rejects when smoke fails (Q2: smoke is part of the gate)', async () => {
    const backend = makeBackend();
    backend.smokeReport = { ok: false, agents: [{ agentId: 'a', toolCount: 0, checks: [{ name: 'tools', ok: false, detail: 'empty tool surface' }] }] };
    const result = await probeInstance(backend, { securityIntegrityConfigured: false });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'smoke')!.ok).toBe(false);
  });

  it('rejects cross-version guard gap: configured but instance guard absent', async () => {
    const backend = makeBackend();
    // securityGuard 未报（旧版实例）→ absent → 拒（防 fail-open）
    const result = await probeInstance(backend, { securityIntegrityConfigured: true });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'securityGuard')!.ok).toBe(false);
  });

  it('degrades to health+guard when smoke unavailable on old builds (MAJ-3: cross-version rollback)', async () => {
    const backend = makeBackend();
    // 旧构建（pre-v0.108.2）无 /smoke → RemoteRunBackend 报 unavailable
    backend.smokeReport = { ok: false, unavailable: true, agents: [] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await probeInstance(backend, { securityIntegrityConfigured: false });
    expect(result.ok).toBe(true);
    const smoke = result.checks.find((c) => c.name === 'smoke')!;
    expect(smoke.ok).toBe(true);
    expect(smoke.detail).toContain('degraded');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fails loud on unreachable health', async () => {
    const backend = makeBackend();
    backend.failHealth = true;
    const result = await probeInstance(backend, { securityIntegrityConfigured: false });
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]!.detail).toContain('down');
  });
});

describe('FleetOps lifecycle', () => {
  it('spawn gates instances: ready enters routing, failed stays out and gets stopped', async () => {
    const { ops, fleet, spawned } = makeOps();
    const outcome = await ops.spawn('v1', 'ref-v1', 2);
    expect(outcome.ready).toHaveLength(2);
    expect(fleet.list()).toHaveLength(2);

    // 坏实例（fork 成败混淆——用 smoke 拒模拟）：spawnInstance 返回坏 backend
    const { ops: ops2, fleet: fleet2 } = makeOps();
    (ops2 as unknown as { deps: FleetOpsDeps }).deps.spawnInstance = async () => {
      const b = makeBackend();
      b.smokeReport = { ok: false, agents: [] };
      return b;
    };
    const bad = await ops2.spawn('v2', 'ref-v2', 1);
    expect(bad.ready).toHaveLength(0);
    expect(bad.failed).toHaveLength(1);
    expect(bad.failed[0]!.record.state).toBe('failed');
    expect(bad.failed[0]!.reason).toContain('smoke');
    expect(fleet2.list()).toHaveLength(0);
  });

  it('promote/rollback move version pointer; rollback spawns fresh and only promotes when all gate', async () => {
    const { ops, route, spawned } = makeOps();
    await ops.spawn('v1', 'ref-v1', 1);
    ops.promote('v1');
    expect(route.versionPointer).toBe('v1');

    // 回滚旧版本：起新实例 + promote（不复活旧进程）
    const outcome = await ops.rollback('v0', 'ref-v0');
    expect(outcome.ready).toHaveLength(1);
    expect(route.versionPointer).toBe('v0');
    expect(spawned).toHaveLength(2);

    // 半败不切流量
    const { ops: ops3, route: route3 } = makeOps({ spawnFailFor: 'vbad' });
    const failedRollback = await ops3.rollback('vbad', 'ref-bad');
    expect(failedRollback.failed).toHaveLength(1);
    expect(route3.versionPointer).toBe('v1');
  });

  it('scale aligns replica count (spawns shortfall, drains surplus)', async () => {
    const { ops, registry } = makeOps();
    await ops.spawn('v1', 'ref-v1', 1);
    await ops.scale('v1', 'ref-v1', 3);
    expect(registry.listByState('ready')).toHaveLength(3);

    await ops.scale('v1', 'ref-v1', 1);
    expect(registry.listByState('ready')).toHaveLength(1);
  });

  it('drain waits for in-flight, stops backend, unregisters; idempotent and terminal-safe', async () => {
    const { ops, fleet, registry, spawned } = makeOps();
    const outcome = await ops.spawn('v1', 'ref-v1', 1);
    const id = outcome.ready[0]!.instanceId;

    // 模拟在途 run
    outcome.ready[0]!.load.inFlightRuns = 1;
    const draining = ops.drain(id, { drainTimeoutMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    outcome.ready[0]!.load.inFlightRuns = 0;
    await draining;

    expect(spawned[0]!.stopped).toBe(true);
    expect(registry.get(id)).toBeUndefined();
    expect(fleet.list()).toHaveLength(0);

    // 已注销 → fail-loud
    await expect(ops.drain(id)).rejects.toThrow(/not registered/);

    // failed 是终态，不可 drain
    const { ops: ops2 } = makeOps({ spawnFailFor: 'vbad' });
    const bad = await ops2.spawn('vbad', 'ref', 1);
    await expect(ops2.drain(bad.failed[0]!.record.instanceId)).rejects.toThrow(/terminal/);
  });

  it('probe re-gates a live instance and ejects it on failure', async () => {
    const { ops, fleet, spawned } = makeOps();
    const outcome = await ops.spawn('v1', 'ref-v1', 1);
    const id = outcome.ready[0]!.instanceId;

    spawned[0]!.smokeReport = { ok: false, agents: [] };
    const result = await ops.probe(id);
    expect(result.ok).toBe(false);
    expect(fleet.list()).toHaveLength(0);
    expect(spawned[0]!.stopped).toBe(true);
  });
});
