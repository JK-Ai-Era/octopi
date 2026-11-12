/**
 * P0c-4 验收演练（arch/service-topology-p0c.md §6）——真进程。
 *
 * 演练 1 自救演练：坏版本起 → 健康门拒 → 流量留旧版本 → 修好晋升 → drain 旧版。
 * 演练 2 多活演练：同版本 2 副本，两会话 sticky 分到不同实例；pulse 归属全 fleet 唯一。
 * （结构性断言「零 self-arm 定时器」在 tests/pulse-structure.test.ts。）
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteRunBackend } from '../packages/gateway/src/gateway/remote-run-backend.js';
import { FleetRunBackend, type InstanceBackend } from '../packages/gateway/src/gateway/supervise/fleet-backend.js';
import { InstanceRegistry, RouteConfig } from '../packages/gateway/src/gateway/supervise/registry.js';
import { FleetOps } from '../packages/gateway/src/gateway/supervise/ops.js';
import { PulseScheduler } from '../packages/gateway/src/gateway/pulse-scheduler.js';
import type { RunServeBoot } from '../packages/gateway/src/gateway/run-serve-child.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_REF = join(REPO_ROOT, 'packages/gateway/dist/gateway');

let home: string;
let configPath: string;
let hangServer: Server;
let hangUrl: string;
let badBuildRef: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'octopi-drills-'));
  configPath = join(home, 'octopi.json');
  writeFileSync(configPath, JSON.stringify({ agents: [] }));
  // 坏版本 fixture：入口存在但一启动就炸（「起不来」型坏构建）
  badBuildRef = join(home, 'bad-build');
  mkdirSync(badBuildRef, { recursive: true });
  writeFileSync(join(badBuildRef, 'run-serve-child.js'), "throw new Error('bad build: assembly corrupted');\n");
  // LLM 挂起服务器：不回包（让 run 挂在模型调用上，制造在途）
  hangServer = createServer(() => undefined);
  await new Promise<void>((resolve) => hangServer.listen(0, '127.0.0.1', resolve));
  hangUrl = `http://127.0.0.1:${(hangServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => hangServer.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

function boot(llmUrl = 'http://127.0.0.1:1'): Omit<RunServeBoot, 'token'> {
  return {
    octopiHome: home,
    config: {
      agents: [],
      configPath,
      modelProviders: {
        fake: {
          api: 'openai-completions',
          baseUrl: llmUrl,
          apiKey: 'test-key',
          models: [{ id: 'test-model', name: 'test-model', contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    },
    agentDefinitions: [
      { id: 'probe-agent', model: { provider: 'fake', model: 'test-model' } },
    ],
  } as unknown as Omit<RunServeBoot, 'token'>;
}

async function spawnReal(llmUrl?: string): Promise<InstanceBackend> {
  return RemoteRunBackend.start(boot(llmUrl), {
    buildRef: BUILD_REF,
    onNotify: () => undefined,
  });
}

/** 消费 run 事件流到尽（run 失败也吞——演练关心路由与终态，不关心 run 结果） */
async function consumeRun(fleet: FleetRunBackend, sessionId: string): Promise<void> {
  try {
    for await (const _ of fleet.startRun({
      requestId: `req-${sessionId}-${Date.now()}`,
      triggers: [{ kind: 'user' }],
      agentId: 'probe-agent',
      sessionId,
      messages: [{ role: 'user', content: 'drill probe', timestamp: Date.now() }],
    } as never)) {
      void _;
    }
  } catch {
    // 流内 throw（无实例/单飞拒）也吞——断言方自行判断
  }
}

describe('演练 1：自救（坏版本 → 健康门拒 → 流量留旧 → 修好晋升 → drain）', () => {
  const spawned: InstanceBackend[] = [];

  afterAll(async () => {
    for (const backend of spawned) {
      await backend.stop().catch(() => undefined);
    }
  });

  it('keeps traffic on the old version while the bad build is rejected, then promotes the fixed one', async () => {
    const route = RouteConfig.seed({ versionPointer: 'v-good' });
    const fleet = new FleetRunBackend({ route });
    const registry = new InstanceRegistry();
    const ops = new FleetOps({
      fleet,
      registry,
      route,
      spawnInstance: async (version, buildRef) => {
        const backend =
          buildRef === badBuildRef
            ? await RemoteRunBackend.start(boot(), { buildRef, onNotify: () => undefined })
            : await spawnReal();
        spawned.push(backend);
        return backend;
      },
      probeOptions: () => ({ securityIntegrityConfigured: true }),
    });

    // ① v-good 1 副本就位
    const good = await ops.spawn('v-good', BUILD_REF, 1);
    expect(good.failed).toEqual([]);
    const goodId = good.ready[0]!.instanceId;
    await consumeRun(fleet, 's-user');
    expect(fleet.routeOf('s-user')).toBe(goodId);

    // ② 故意起坏版本 → 起不来，failed 终态、不入路由
    const bad = await ops.spawn('v-bad', badBuildRef, 1);
    expect(bad.ready).toHaveLength(0);
    expect(bad.failed).toHaveLength(1);
    expect(bad.failed[0]!.record.state).toBe('failed');
    expect(fleet.list().map((e) => e.record.version)).toEqual(['v-good']);

    // ③ 流量留旧版本：新会话仍进 v-good（versionPointer 未动）
    await consumeRun(fleet, 's-after-bad');
    expect(fleet.routeOf('s-after-bad')).toBe(goodId);

    // ④ 修好 → 过门 → promote → 新会话进 v-fixed
    const fixed = await ops.spawn('v-fixed', BUILD_REF, 1);
    expect(fixed.failed).toEqual([]);
    const fixedId = fixed.ready[0]!.instanceId;
    ops.promote('v-fixed');
    await consumeRun(fleet, 's-after-promote');
    expect(fleet.routeOf('s-after-promote')).toBe(fixedId);

    // ⑤ drain v-good：停机注销；fleet 只剩 v-fixed
    await ops.drain(goodId);
    expect(registry.get(goodId)).toBeUndefined();
    expect(fleet.list().map((e) => e.record.version)).toEqual(['v-fixed']);
    await consumeRun(fleet, 's-final');
    expect(fleet.routeOf('s-final')).toBe(fixedId);
  }, 90_000);
});

describe('演练 1b：健康门真负例（MIN-6：过门被拒，非 fork 失败）', () => {
  const spawned: InstanceBackend[] = [];

  afterAll(async () => {
    for (const backend of spawned) {
      await backend.stop().catch(() => undefined);
    }
  });

  it('rejects at the gate: boots fine but smoke fails (bad agent assembly)', async () => {
    const route = RouteConfig.seed({ versionPointer: 'v-badasm' });
    const fleet = new FleetRunBackend({ route });
    const registry = new InstanceRegistry();
    const ops = new FleetOps({
      fleet,
      registry,
      route,
      spawnInstance: async (_version, buildRef) => {
        // 能 boot（fork + 握手成功）但装配坏：model provider 不存在 →
        // 冒烟强制装配热路径时炸 → 健康门拒（走过 health/smoke/guard 三段的真拒）
        const backend = await RemoteRunBackend.start(
          {
            ...boot(),
            config: {
              ...boot().config,
              modelProviders: {},
            },
          } as never,
          { buildRef, onNotify: () => undefined },
        );
        spawned.push(backend);
        return backend;
      },
      probeOptions: () => ({ securityIntegrityConfigured: true }),
    });

    const outcome = await ops.spawn('v-badasm', BUILD_REF, 1);
    expect(outcome.ready).toHaveLength(0);
    expect(outcome.failed).toHaveLength(1);
    const failure = outcome.failed[0]!;
    expect(failure.record.state).toBe('failed');
    // 真负例核心：失败原因是**健康门 checks 拒**（smoke/guard），不是 spawn 抛错
    expect(failure.reason).toMatch(/smoke|securityGuard/);
    expect(fleet.list()).toHaveLength(0);
  }, 60_000);

  it('rejects at the gate: cross-version guard absent while config expects one', async () => {
    const route = RouteConfig.seed({ versionPointer: 'v-noguard' });
    const fleet = new FleetRunBackend({ route });
    const registry = new InstanceRegistry();
    const ops = new FleetOps({
      fleet,
      registry,
      route,
      spawnInstance: async (_version, buildRef) => {
        // 不给 configPath → 子进程无守卫（旧构建行为模拟）→ 配置期望有闸 → 健康门拒
        const bootNoGuard = boot();
        delete (bootNoGuard.config as { configPath?: string }).configPath;
        const backend = await RemoteRunBackend.start(bootNoGuard, {
          buildRef,
          onNotify: () => undefined,
        });
        spawned.push(backend);
        return backend;
      },
      probeOptions: () => ({ securityIntegrityConfigured: true }),
    });

    const outcome = await ops.spawn('v-noguard', BUILD_REF, 1);
    expect(outcome.ready).toHaveLength(0);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.reason).toContain('securityGuard');
  }, 60_000);
});

describe('演练 2：多活（2 副本两实例，两会话分实例，脉搏归属唯一）', () => {
  const spawned: InstanceBackend[] = [];

  afterAll(async () => {
    for (const backend of spawned) {
      await backend.stop().catch(() => undefined);
    }
  });

  it('splits two concurrent sessions onto different replicas and keeps every pulse single-owned', async () => {
    const route = RouteConfig.seed({ versionPointer: 'v2', replicasPerVersion: 2 });
    const fleet = new FleetRunBackend({ route });
    const registry = new InstanceRegistry();
    const ops = new FleetOps({
      fleet,
      registry,
      route,
      spawnInstance: async () => {
        const backend = await spawnReal(hangUrl);
        spawned.push(backend);
        return backend;
      },
      probeOptions: () => ({ securityIntegrityConfigured: true }),
    });

    const outcome = await ops.spawn('v2', BUILD_REF, 2);
    expect(outcome.failed).toEqual([]);
    expect(outcome.ready).toHaveLength(2);
    const [a, b] = outcome.ready.map((r) => r.instanceId);

    // 两会话并发 → sticky 分到不同实例（s1 先占 A，s2 因 A 在途而分 B）
    const p1 = consumeRun(fleet, 's-live-1');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const p2 = consumeRun(fleet, 's-live-2');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fleet.routeOf('s-live-1')).toBe(a);
    expect(fleet.routeOf('s-live-2')).toBe(b);

    // 清场：abort 两个在途 run
    await fleet.control({ type: 'abort', sessionId: 's-live-1', reason: 'drill done' } as never);
    await fleet.control({ type: 'abort', sessionId: 's-live-2', reason: 'drill done' } as never);
    await Promise.allSettled([p1, p2]);

    // 脉搏归属：同 key 双副本自述 → 全 fleet 唯一持有者；单发经归属实例
    const scheduler = new PulseScheduler({
      // 与 gateway 真实接线同构：FleetRunBackend 的 pulse 语义经 control op 转发
      fleet: {
        pulseInventory: () => fleet.pulseInventory(),
        pulse: async (key: string) => {
          const r = await fleet.control({ type: 'pulse', key });
          if (!r.ok) throw new Error(r.error.message);
        },
        setPulseOwner: (key: string, instanceId: string) => fleet.setPulseOwner(key, instanceId),
        resolvePulseOwner: (key: string) => fleet.resolvePulseOwner(key),
        clearPulseOwner: (key: string) => fleet.clearPulseOwner(key),
      },
    });
    await scheduler.resync();
    const inventory = await fleet.pulseInventory();
    expect(inventory.length).toBeGreaterThan(0);
    const keys = new Set(inventory.map((i) => i.spec.key));
    // 两实例自述同 key 集合（同版本同装配）
    const perInstance = new Map<string, Set<string>>();
    for (const { instanceId, spec } of inventory) {
      if (!perInstance.has(instanceId)) perInstance.set(instanceId, new Set());
      perInstance.get(instanceId)!.add(spec.key);
    }
    expect(perInstance.size).toBe(2);
    for (const keySet of perInstance.values()) {
      expect([...keySet].sort()).toEqual([...keys].sort());
    }
    // MIN-7：调度表结构断言——每 key 恰一个 timer（恰一次/周期的结构保证）；
    // 「fire 计数恒 1/周期」的时间语义在 pulse-scheduler 单测（fake timers 计数）覆盖
    expect(scheduler.activeKeys().length).toBe(keys.size);
    // 每 key 归属唯一且指向已注册实例；经归属实例打点应答 ok（恰一次执行路径）
    for (const key of keys) {
      const owner = fleet.resolvePulseOwner(key);
      expect(owner === a || owner === b).toBe(true);
      const res = await fleet.control({ type: 'pulse', key } as never);
      expect(res.ok).toBe(true);
    }
    scheduler.stop();
  }, 90_000);
});
