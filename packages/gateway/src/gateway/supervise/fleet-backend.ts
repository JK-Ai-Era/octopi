/**
 * supervise/fleet-backend — FleetRunBackend（arch/service-topology-p0c.md §4.2）。
 *
 * 对 gateway 其余部分呈现与 RemoteRunBackend 相同的契约面（startRun / control / health），
 * 内部把 N 个 run 实例当一个服务路由（§2.2：run 服务=实例池，一实例一进程一端口）。
 *
 * 路由规则（§4.2 + 2026-11-11 securityIntegrity 修复对齐）：
 * - `startRun`：sticky（sessionId → instanceId，会话亲和 §7.1）+ per-session 单飞闸门
 *   （§5.1 run lease 近似：同会话第二个并发 run 直拒）；新会话选 ready 且 inFlight 最低实例。
 * - `control`：session-scoped（op 带 sessionId）→ sticky 实例；fleet-wide 维护 op
 *   （retireAgent/reloadAgent/setClientTools/reattestSecurity/probeAgent）→ fan-out 全部实例
 *   （每实例都持有全量装配，必须逐实例应用）；`pulse` → pulse 归属实例单发。
 * - `health`：聚合（inFlightRuns/retiredRunners 求和；mountedAgents 取 max——同一批 agent
 *   的多副本）；不可达实例进 `unreachableInstances`（fail-loud 可见）。
 *
 * pulse lease（§5.2）：归属表 key → instanceId 由本类持有（单一事实源），归属**决策**
 * 归 PulseScheduler（首见分配 / 持有者消失转移）；本类只按表定向。
 *
 * @module gateway/supervise/fleet-backend
 */

import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type { RunBackendHealth } from '@octopi-agent/engine/harness/activation/run-backend.js';
import type {
  RunControlOp,
  RunControlResponse,
  PulseSpec,
  RunSmokeReport,
} from '@octopi-agent/engine/harness/activation/run-protocol.js';
import type { RunRequest } from '@octopi-agent/engine/harness/activation/index.js';
import type { InstanceRecord, RouteConfig } from './registry.js';

/** 实例级契约面（RemoteRunBackend 即其实现） */
export interface InstanceBackend {
  startRun(req: RunRequest): AsyncIterable<AgentEvent>;
  control(op: RunControlOp): Promise<RunControlResponse>;
  health(): Promise<RunBackendHealth>;
  /** 冒烟（健康门 §4.3）：装配热路径自检，不是 run */
  smoke(): Promise<RunSmokeReport>;
  /** 停止实例（drain 收摊用；幂等） */
  stop(): Promise<void>;
}

/** 注册条目：事实（record）+ 执行面（backend） */
export interface FleetEntry {
  record: InstanceRecord;
  backend: InstanceBackend;
}

/** fleet-wide 维护 op：每实例都持有全量装配，必须 fan-out 应用 */
const FLEET_WIDE_OPS = new Set([
  'retireAgent',
  'reloadAgent',
  'setClientTools',
  'reattestSecurity',
]);

export interface FleetRunBackendOptions {
  /**
   * 路由期望状态（§5.1，与 FleetOps 共享同一对象）：新会话只进
   * versionPointer 版本的 ready 副本（§4.2）。
   */
  route: RouteConfig;
}

export class FleetRunBackend {
  private readonly entries = new Map<string, FleetEntry>();
  /** 会话亲和（§7.1）：sticky sessionId → instanceId */
  private readonly sticky = new Map<string, string>();
  /** 单飞闸门（§5.1 run lease 近似）：同会话至多一个活动 run */
  private readonly inFlightSessions = new Set<string>();
  /** pulse lease 归属表（§5.2）：key → 持有 instanceId */
  private readonly pulseOwner = new Map<string, string>();
  /** 回执路由表：notify 的 callId/approvalId/askId → 源实例（点对点回执第三类 op） */
  private readonly replyRoute = new Map<string, string>();
  private readonly route: RouteConfig;

  /**
   * @param options - route（期望状态，与 FleetOps 共享同一对象；新会话按 versionPointer 定版本）
   */
  constructor(options: FleetRunBackendOptions) {
    this.route = options.route;
  }

  /**
   * 注册实例（重复 instanceId fail-loud）。
   * @param entry - 实例记录 + 执行面
   * @returns void
   */
  register(entry: FleetEntry): void {
    if (this.entries.has(entry.record.instanceId)) {
      throw new Error(`supervise: instance "${entry.record.instanceId}" already registered`);
    }
    this.entries.set(entry.record.instanceId, entry);
  }

  /**
   * 注销实例：sticky 与 pulse 归属随之失效（下次路由/调度时重分配）。
   * @param instanceId - 实例标识
   * @returns 是否存在并移除
   */
  unregister(instanceId: string): boolean {
    const removed = this.entries.delete(instanceId);
    for (const [sessionId, id] of [...this.sticky]) {
      if (id === instanceId) this.sticky.delete(sessionId);
    }
    for (const [key, id] of [...this.pulseOwner]) {
      if (id === instanceId) this.pulseOwner.delete(key);
    }
    return removed;
  }

  /**
   * @returns 全部注册条目快照
   */
  list(): FleetEntry[] {
    return [...this.entries.values()];
  }

  /**
   * run 派发：sticky + 单飞 + 最少负载分配（§4.2）。错误经事件流抛（契约错误面两形态之一）。
   * @param req - run 请求（纯数据）
   * @returns 协议事件流
   */
  startRun(req: RunRequest): AsyncIterable<AgentEvent> {
    const self = this;
    return (async function* () {
      if (self.inFlightSessions.has(req.sessionId)) {
        throw new Error(
          `supervise: session "${req.sessionId}" already has an in-flight run (single-flight)`,
        );
      }
      const target = self.resolveForRun(req.sessionId);
      self.inFlightSessions.add(req.sessionId);
      self.sticky.set(req.sessionId, target.record.instanceId);
      target.record.load.inFlightRuns += 1;
      try {
        yield* target.backend.startRun(req);
      } finally {
        self.inFlightSessions.delete(req.sessionId);
        target.record.load.inFlightRuns = Math.max(0, target.record.load.inFlightRuns - 1);
      }
    })();
  }

  /**
   * 控制派发：session-scoped → sticky 实例；fleet-wide → fan-out；pulse → 归属实例。
   * 未知 op 形态 fail-loud（不静默吞）。
   * @param op - 纯数据控制 op
   * @returns 执行结果（ok:false 不抛——调用方裁决）
   */
  async control(op: RunControlOp): Promise<RunControlResponse> {
    if (op.type === 'pulse') {
      const owner = this.pulseOwner.get(op.key);
      if (!owner) {
        return {
          ok: false,
          error: { message: `supervise: no pulse owner for key "${op.key}"` },
        };
      }
      const entry = this.entries.get(owner);
      if (!entry) {
        return {
          ok: false,
          error: { message: `supervise: pulse owner "${owner}" for key "${op.key}" is gone` },
        };
      }
      return entry.backend.control(op);
    }

    // 点对点回执（实现期暴露的第三类 op）：notify 出处已登记源实例，按回执键定向；
    // 一问一答，成功即拆除路由（callId/approvalId/askId 实例内唯一）
    const replyKey =
      op.type === 'approvalReply'
        ? `approval:${op.approvalId}`
        : op.type === 'clientToolResult'
          ? `clientTool:${op.callId}`
          : op.type === 'askUserReply'
            ? `askUser:${op.askId}`
            : undefined;
    if (replyKey) {
      const owner = this.replyRoute.get(replyKey);
      if (!owner) {
        return { ok: false, error: { message: `supervise: no reply route for "${replyKey}"` } };
      }
      const entry = this.entries.get(owner);
      if (!entry) {
        return { ok: false, error: { message: `supervise: reply target "${owner}" for "${replyKey}" is gone` } };
      }
      const res = await entry.backend.control(op);
      if (res.ok) this.replyRoute.delete(replyKey);
      return res;
    }

    if (FLEET_WIDE_OPS.has(op.type)) {
      const targets = [...this.entries.values()];
      if (targets.length === 0) {
        return { ok: false, error: { message: `supervise: no instances for fleet-wide op "${op.type}"` } };
      }
      const results = await Promise.allSettled(
        targets.map((entry) => entry.backend.control(op)),
      );
      const failed: string[] = [];
      for (const [i, result] of results.entries()) {
        const instanceId = targets[i].record.instanceId;
        if (result.status === 'rejected') {
          failed.push(`${instanceId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        } else if (!result.value.ok) {
          failed.push(`${instanceId}: ${result.value.error.message}`);
        }
      }
      if (failed.length > 0) {
        return {
          ok: false,
          error: { message: `supervise: fleet-wide "${op.type}" failed on ${failed.length}/${targets.length}: ${failed.join('; ')}` },
        };
      }
      return { ok: true, result: { appliedOn: targets.map((t) => t.record.instanceId) } };
    }

    if ('sessionId' in op && typeof op.sessionId === 'string') {
      const entry = this.resolveForSession(op.sessionId);
      return entry.backend.control(op);
    }

    return {
      ok: false,
      error: { message: `supervise: unrouteable control op "${op.type}" (no sessionId, not fleet-wide, not pulse)` },
    };
  }

  /**
   * 健康聚合（§4.2）：求和 inFlight/retired、max mountedAgents、pulses 按 key 去重；
   * 不可达实例列名可见（fail-loud，不静默丢）。
   * @returns 聚合健康报告
   */
  async health(): Promise<RunBackendHealth> {
    const targets = [...this.entries.values()];
    const results = await Promise.allSettled(targets.map((entry) => entry.backend.health()));
    let mountedAgents = 0;
    let inFlightRuns = 0;
    let retiredRunners = 0;
    const pulses = new Map<string, PulseSpec>();
    const unreachableInstances: string[] = [];
    for (const [i, result] of results.entries()) {
      const instanceId = targets[i].record.instanceId;
      if (result.status === 'rejected') {
        unreachableInstances.push(instanceId);
        continue;
      }
      const h = result.value;
      mountedAgents = Math.max(mountedAgents, h.mountedAgents);
      inFlightRuns += h.inFlightRuns;
      retiredRunners += h.retiredRunners;
      for (const spec of h.pulses ?? []) {
        if (!pulses.has(spec.key)) pulses.set(spec.key, spec);
      }
    }
    return {
      mountedAgents,
      inFlightRuns,
      retiredRunners,
      pulses: [...pulses.values()],
      ...(unreachableInstances.length > 0 ? { unreachableInstances } : {}),
    };
  }

  // ── pulse lease 面（决策归 PulseScheduler，本类持表定向）──

  /**
   * 脉搏自述清单（带来源实例；PulseScheduler 归属决策的输入）。
   * @returns 实例 × PulseSpec 清单（不可达实例跳过）
   */
  async pulseInventory(): Promise<Array<{ instanceId: string; spec: PulseSpec }>> {
    const targets = [...this.entries.values()];
    const results = await Promise.allSettled(targets.map((entry) => entry.backend.health()));
    const inventory: Array<{ instanceId: string; spec: PulseSpec }> = [];
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') continue;
      for (const spec of result.value.pulses ?? []) {
        inventory.push({ instanceId: targets[i].record.instanceId, spec });
      }
    }
    return inventory;
  }

  /**
   * @param key - 脉搏键
   * @returns 持有实例 id（无归属则 undefined）
   */
  resolvePulseOwner(key: string): string | undefined {
    return this.pulseOwner.get(key);
  }

  /**
   * 写入 pulse 归属（幂等；实例必须已注册——fail-loud）。
   * @param key - 脉搏键
   * @param instanceId - 持有实例
   * @returns void
   */
  setPulseOwner(key: string, instanceId: string): void {
    if (!this.entries.has(instanceId)) {
      throw new Error(`supervise: cannot assign pulse "${key}" to unregistered instance "${instanceId}"`);
    }
    this.pulseOwner.set(key, instanceId);
  }

  /**
   * 拆除 pulse 归属（key 消失时由调度器清理）。
   * @param key - 脉搏键
   * @returns void
   */
  clearPulseOwner(key: string): void {
    this.pulseOwner.delete(key);
  }

  // ── 诊断 ──

  /**
   * 登记回执路由（notify 出处登记 callId/approvalId/askId → 源实例；回执类 control 按此定向）。
   * @param key - 回执键（调用方拼 `approval:<id>` / `clientTool:<id>` / `askUser:<id>`）
   * @param instanceId - 源实例
   * @returns void
   */
  setReplyRoute(key: string, instanceId: string): void {
    if (!this.entries.has(instanceId)) {
      throw new Error(`supervise: cannot route reply "${key}" to unregistered instance "${instanceId}"`);
    }
    this.replyRoute.set(key, instanceId);
  }

  /**
   * @param sessionId - 会话 id
   * @returns 当前 sticky 目标（未分配则 undefined）
   */
  routeOf(sessionId: string): string | undefined {
    return this.sticky.get(sessionId);
  }

  /**
   * @param sessionId - 会话 id
   * @returns 该会话是否有活动 run（单飞闸门状态）
   */
  isInFlight(sessionId: string): boolean {
    return this.inFlightSessions.has(sessionId);
  }

  // ── 内部路由 ──

  private resolveForSession(sessionId: string): FleetEntry {
    const stickyId = this.sticky.get(sessionId);
    if (stickyId) {
      const entry = this.entries.get(stickyId);
      // failed 实例的亲和失效（换实例）；draining 保持亲和（会话亲和优先 §7.1）
      if (entry && entry.record.state !== 'failed') return entry;
      this.sticky.delete(sessionId);
    }
    return this.pickLeastLoaded();
  }

  private resolveForRun(sessionId: string): FleetEntry {
    return this.resolveForSession(sessionId);
  }

  private pickLeastLoaded(): FleetEntry {
    // 新会话只进 versionPointer 版本的 ready 副本（§4.2/§4.5：按 RouteConfig 定版本；
    // draining 不接新会话，其 sticky 亲和在 resolveForSession 已保）
    const pointer = this.route.versionPointer;
    const candidates = this.list().filter(
      (e) => e.record.state === 'ready' && e.record.version === pointer,
    );
    if (candidates.length === 0) {
      throw new Error(`supervise: no ready run instance for version pointer "${pointer}"`);
    }
    let best = candidates[0];
    for (const entry of candidates) {
      if (entry.record.load.inFlightRuns < best.record.load.inFlightRuns) best = entry;
    }
    return best;
  }
}
