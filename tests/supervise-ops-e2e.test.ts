/**
 * P0c-3 e2e（真进程）：单版本 spawn → 健康门（health + smoke + 守卫在位）→ drain → 停。
 * 验收（设计稿 §7 P0c-3）：「单版本 spawn/probe/drain e2e」。
 *
 * buildRef 直指当前构建的 gateway dist（版本化 spawn §4.4 的同构建形态）；
 * spawnInstance 注入 RemoteRunBackend.start——与 gateway 自举同一条 fork 路径。
 * configPath 随 boot 给出 → 子进程自建守卫（v0.107.3 修复面）→ 守卫在位核查 armed。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteRunBackend } from '../packages/gateway/src/gateway/remote-run-backend.js';
import { FleetRunBackend, type InstanceBackend } from '../packages/gateway/src/gateway/supervise/fleet-backend.js';
import { InstanceRegistry, RouteConfig } from '../packages/gateway/src/gateway/supervise/registry.js';
import { FleetOps } from '../packages/gateway/src/gateway/supervise/ops.js';
import type { RunServeBoot } from '../packages/gateway/src/gateway/run-serve-child.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_REF = join(REPO_ROOT, 'packages/gateway/dist/gateway');

let home: string;
let configPath: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'octopi-supervise-e2e-'));
  configPath = join(home, 'octopi.json');
  writeFileSync(configPath, JSON.stringify({ agents: [] }));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function boot(): Omit<RunServeBoot, 'token'> {
  return {
    octopiHome: home,
    config: {
      agents: [],
      configPath,
      modelProviders: {
        fake: {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1',
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

describe('P0c-3 e2e: spawn → probe (health gate) → drain', () => {
  const spawned: InstanceBackend[] = [];

  afterAll(async () => {
    for (const backend of spawned) {
      await backend.stop().catch(() => undefined);
    }
  });

  it('gates a real instance through health + smoke + guard, then drains it', async () => {
    const fleet = new FleetRunBackend();
    const registry = new InstanceRegistry();
    const route = RouteConfig.seed({ versionPointer: 'self' });
    const ops = new FleetOps({
      fleet,
      registry,
      route,
      spawnInstance: async (_version, buildRef, _instanceId) => {
        const backend = await RemoteRunBackend.start(boot(), {
          buildRef,
          onNotify: () => undefined,
        });
        spawned.push(backend);
        return backend;
      },
      probeOptions: () => ({ securityIntegrityConfigured: true }),
    });

    const outcome = await ops.spawn('self', BUILD_REF, 1);
    expect(outcome.failed).toEqual([]);
    expect(outcome.ready).toHaveLength(1);
    const record = outcome.ready[0]!;
    expect(record.state).toBe('ready');
    expect(fleet.list()).toHaveLength(1);

    // 健康门复检过（真 health + 真 smoke + 守卫在位）
    const reprobe = await ops.probe(record.instanceId);
    expect(reprobe.ok).toBe(true);
    expect(reprobe.checks.map((c) => c.name)).toEqual(['health', 'smoke', 'securityGuard']);
    expect(reprobe.checks.find((c) => c.name === 'securityGuard')!.detail).toBe('armed');

    // smoke 报告面：装配热路径自检有内容（工具面 + no-LLM 应答）
    const entry = fleet.list()[0]!;
    const report = await entry.backend.smoke();
    expect(report.ok).toBe(true);
    expect(report.agents.length).toBeGreaterThan(0);
    expect(report.agents[0]!.toolCount).toBeGreaterThan(0);
    expect(report.agents[0]!.checks.some((c) => c.name === 'contextHealth')).toBe(true);

    // drain：停机 + 注销
    await ops.drain(record.instanceId);
    expect(registry.get(record.instanceId)).toBeUndefined();
    expect(fleet.list()).toHaveLength(0);
  }, 60_000);

  it('failed spawn (bad buildRef) never enters routing (traffic stays on old)', async () => {
    const fleet = new FleetRunBackend();
    const registry = new InstanceRegistry();
    const route = RouteConfig.seed({ versionPointer: 'self' });
    const ops = new FleetOps({
      fleet,
      registry,
      route,
      spawnInstance: async (_version, buildRef, _instanceId) => {
        // 坏版本：指向不存在的构建产物（fork 即败）
        const backend = await RemoteRunBackend.start(boot(), {
          buildRef: join(buildRef, 'no-such-build'),
          onNotify: () => undefined,
        });
        spawned.push(backend);
        return backend;
      },
      probeOptions: () => ({ securityIntegrityConfigured: true }),
    });

    const outcome = await ops.spawn('v-bad', BUILD_REF, 1);
    expect(outcome.ready).toHaveLength(0);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.record.state).toBe('failed');
    expect(fleet.list()).toHaveLength(0);
    // 流量留旧版本：RouteConfig 不动
    expect(route.versionPointer).toBe('self');
  }, 60_000);
});
