/**
 * supervise/ops — 生命周期 ops 原语（arch/service-topology-p0c.md §4.4/§4.5，§5.2）。
 *
 * `spawn / probe / scale / promote / rollback / drain`——supervise 门面，零产品逻辑。
 * 实例进程的拉起由宿主注入（gateway：RemoteRunBackend.start 带 buildRef；测试：假体）。
 * rollback = 旧构建起**新实例** + promote（§6 拍板 #6：不复活旧进程）。
 *
 * @module gateway/supervise/ops
 */

import type { FleetRunBackend, InstanceBackend } from './fleet-backend.js';
import { InstanceRegistry, type InstanceRecord, type RouteConfig } from './registry.js';
import { probeInstance, type ProbeOptions, type ProbeResult } from './probe.js';

export interface FleetOpsDeps {
  fleet: FleetRunBackend;
  registry: InstanceRegistry;
  route: RouteConfig;
  /**
   * 拉起一个实例进程（宿主注入）。失败即抛——spawn 判失败转 failed 记录。
   * @param version - 版本标识
   * @param buildRef - 该版本构建产物根
   * @param instanceId - 分配的实例 id
   * @returns 实例执行面
   */
  spawnInstance(version: string, buildRef: string, instanceId: string): Promise<InstanceBackend>;
  /** 健康门参数（配置锚定面） */
  probeOptions(): ProbeOptions;
}

export interface SpawnOutcome {
  ready: InstanceRecord[];
  failed: Array<{ record: InstanceRecord; reason: string }>;
}

export class FleetOps {
  private seq = 0;

  /**
   * @param deps - registry/route/fleet + 宿主注入的 spawnInstance
   */
  constructor(private readonly deps: FleetOpsDeps) {}

  /**
   * spawn(version, n)（§5.2）：拉起 n 个实例，逐个过健康门。
   * 过门 → ready + 入路由；不过门 → failed（终态）+ 收摊，**不入路由**（流量留旧版本）。
   *
   * @param version - 版本标识
   * @param buildRef - 构建产物根
   * @param n - 副本数（缺省 1）
   * @returns 过门/失败清单
   */
  async spawn(version: string, buildRef: string, n = 1): Promise<SpawnOutcome> {
    const outcome: SpawnOutcome = { ready: [], failed: [] };
    for (let i = 0; i < n; i += 1) {
      this.seq += 1;
      const instanceId = `${version}#${this.seq}`;
      const record: InstanceRecord = {
        instanceId,
        version,
        buildRef,
        port: 0,
        pid: -1,
        state: 'starting',
        startedAt: Date.now(),
        load: { inFlightRuns: 0, queued: 0 },
      };
      this.deps.registry.add(record);
      let backend: InstanceBackend;
      try {
        backend = await this.deps.spawnInstance(version, buildRef, instanceId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.deps.registry.setState(record.instanceId, 'failed');
        outcome.failed.push({ record, reason });
        continue;
      }
      if (backend.info) {
        record.port = backend.info.port;
        record.pid = backend.info.pid;
      }
      const result = await this.gate(backend);
      if (result.ok) {
        this.deps.registry.setState(record.instanceId, 'ready');
        this.deps.fleet.register({ record, backend });
        outcome.ready.push(record);
      } else {
        this.deps.registry.setState(record.instanceId, 'failed');
        outcome.failed.push({
          record,
          reason: result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? 'failed'}`).join('; '),
        });
        await backend.stop().catch(() => undefined);
      }
    }
    return outcome;
  }

  /**
   * 健康门复检（§5.2 probe）：ready/draining 实例复检；拒 → failed（终态）+ 移出路由。
   *
   * @param instanceId - 实例标识
   * @returns 探测结果
   */
  async probe(instanceId: string): Promise<ProbeResult> {
    const record = this.deps.registry.get(instanceId);
    if (!record) {
      throw new Error(`supervise: instance "${instanceId}" not registered`);
    }
    const entry = this.deps.fleet.list().find((e) => e.record.instanceId === instanceId);
    if (!entry) {
      return {
        ok: false,
        checks: [{ name: 'fleet', ok: false, detail: 'not in routing (failed or never gated)' }],
      };
    }
    const result = await this.gate(entry.backend);
    record.lastProbe = Date.now();
    if (!result.ok) {
      this.deps.registry.setState(record.instanceId, 'failed');
      this.deps.fleet.unregister(instanceId);
      await entry.backend.stop().catch(() => undefined);
    }
    return result;
  }

  /**
   * scale(version, n)：该版本非 failed 实例数对齐 n（少补 spawn、多退 drain）。
   *
   * @param version - 版本标识
   * @param buildRef - 构建产物根（补齐时用）
   * @param n - 目标副本数
   * @returns 本次 spawn 结果
   */
  async scale(version: string, buildRef: string, n: number): Promise<SpawnOutcome> {
    const alive = this.deps.registry
      .list()
      .filter((r) => r.version === version && r.state !== 'failed');
    if (alive.length > n) {
      for (const extra of alive.slice(n)) {
        await this.drain(extra.instanceId);
      }
      return { ready: [], failed: [] };
    }
    return this.spawn(version, buildRef, n - alive.length);
  }

  /**
   * promote(version)：versionPointer 前移 + 权重复位（运行态；Q3=A 不落盘，重启回落 config）。
   *
   * @param version - 目标版本
   * @returns void
   */
  promote(version: string): void {
    this.deps.route.versionPointer = version;
    this.deps.route.weights = new Map([[version, 100]]);
  }

  /**
   * rollback(version)（§6 拍板 #6）：旧构建起**新实例** + promote，不复活旧进程。
   *
   * @param version - 回滚目标版本
   * @param buildRef - 该版本构建产物根
   * @param n - 副本数（缺省取 route.replicasPerVersion）
   * @returns spawn 结果（全部过门才 promote——半败不切流量）
   */
  async rollback(version: string, buildRef: string, n?: number): Promise<SpawnOutcome> {
    const outcome = await this.spawn(version, buildRef, n ?? this.deps.route.replicasPerVersion);
    if (outcome.failed.length === 0 && outcome.ready.length > 0) {
      this.promote(version);
    }
    return outcome;
  }

  /**
   * drain(instanceId)（§4.5）：不接新会话（sticky 亲和保持）→ 在途 run 跑完 → stop → 注销。
   * 幂等：对 failed/draining 重复调用返回已知状态，fail-loud 不静默。
   *
   * @param instanceId - 实例标识
   * @param options - drainTimeoutMs（缺省 60s，超时 fail-loud 不强杀）
   * @returns void
   */
  async drain(instanceId: string, options?: { drainTimeoutMs?: number }): Promise<void> {
    const record = this.deps.registry.get(instanceId);
    if (!record) {
      throw new Error(`supervise: instance "${instanceId}" not registered`);
    }
    if (record.state === 'failed') {
      throw new Error(`supervise: instance "${instanceId}" is failed (terminal); nothing to drain`);
    }
    if (record.state !== 'draining') {
      this.deps.registry.setState(record.instanceId, 'draining');
    }
    // MAJ-5/MIN-10：开始即疏散（sticky 迁走 + pulse 归属转移触发）；幂等，重试再调无害。
    // 重入语义=继续等到 idle（上轮超时后重试不得假成功）。
    this.deps.fleet.evacuate(instanceId);

    const deadline = Date.now() + (options?.drainTimeoutMs ?? 60_000);
    while (record.load.inFlightRuns > 0) {
      if (Date.now() > deadline) {
        throw new Error(
          `supervise: drain of "${instanceId}" timed out with ${record.load.inFlightRuns} in-flight run(s)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const entry = this.deps.fleet.list().find((e) => e.record.instanceId === instanceId);
    this.deps.fleet.unregister(instanceId);
    if (entry) {
      await entry.backend.stop().catch((err: unknown) => {
        console.warn(
          `[supervise] stop of "${instanceId}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    this.deps.registry.remove(instanceId);
  }

  private async gate(backend: InstanceBackend): Promise<ProbeResult> {
    return probeInstance(backend, this.deps.probeOptions());
  }
}
