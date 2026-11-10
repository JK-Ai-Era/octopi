/**
 * InProcessRunBackend — RunBackend 进程内脚手架实现（P0a）
 *
 * 持有 run 侧全部运行时态：挂载槽、in-flight 计数、退役回收、会话锁。
 * gateway 触达 run 一律经 RunBackend 契约；本类是唯一进程内实现，
 * P0b（run 实例进程化）后由 RemoteRunBackend 取代并删除。
 *
 * 搬迁自 gateway.ts（行为冻结）：agentCache / retiredRunners / runnerInflight /
 * wrapInflightTracking（准入闸门 + in-flight）/ retireRunner / disposeRetiredRunner /
 * stop 时 Runner 回收。
 */

import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import { SessionRunnerDispatcher } from '@octopi-agent/engine/harness/activation/index.js';
import type {
  RunDispatcher,
  RunRequest,
  Trigger,
} from '@octopi-agent/engine/harness/activation/index.js';
import type {
  AdmissionGateResult,
  RunBackend,
  InProcessAgentHandle,
  RunBackendHealth,
  RunBackendMountSpec,
} from '@octopi-agent/engine/harness/activation/run-backend.js';
import type { SessionAwareRunner } from '@octopi-agent/engine/harness/run/runner.js';
import { InProcessSessionLock } from '@octopi-agent/engine/harness/run/concurrency/session-lease.js';
import type { SessionLease } from '@octopi-agent/engine/harness/run/concurrency/session-lease.js';
import type { CompactTransportOutcome } from '@octopi-agent/engine/harness/context/capabilities/compact/types.js';

export type { AdmissionGateResult } from '@octopi-agent/engine/harness/activation/run-backend.js';

export interface InProcessRunBackendOptions {
  /** inbox 未消费项的原 Trigger 重投路径（原 registerRuntimeAgent.redispatch） */
  redispatch: (
    trigger: Trigger,
    options?: { onEvent?: (event: AgentEvent) => void },
  ) => void | Promise<unknown>;
  /** run 起点准入闸门；返回结果 = 拒新 run（政策在 gateway，执行在 backend） */
  admissionGate?: (req: { agentId: string; sessionId: string }) => AdmissionGateResult | undefined;
  /** 共享会话锁（缺省自建进程内锁；所有 Runner 与控制面共用同一实例） */
  sessionLock?: SessionLease;
}

interface Mounted {
  handle: InProcessAgentHandle;
  runner: SessionAwareRunner;
}

export class InProcessRunBackend implements RunBackend {
  readonly sessionLock: SessionLease;
  private readonly opts: InProcessRunBackendOptions;
  private readonly mounted = new Map<string, Mounted>();
  private readonly retiredRunners: SessionAwareRunner[] = [];
  private readonly runnerInflight = new WeakMap<SessionAwareRunner, number>();

  constructor(options: InProcessRunBackendOptions) {
    this.opts = options;
    this.sessionLock = options.sessionLock ?? new InProcessSessionLock();
  }

  mount(spec: RunBackendMountSpec): InProcessAgentHandle {
    if (this.mounted.has(spec.agentId)) {
      // fail-loud：重复挂载说明调用方漏了 retire（旧 Runner 会泄漏 timer/订阅）
      throw new Error(`run_backend: agent "${spec.agentId}" already mounted (retire first)`);
    }
    const inner = new SessionRunnerDispatcher({
      runner: spec.runner,
      redispatch: (trigger, options) => this.opts.redispatch(trigger, options),
      // 不要把 agent 默认 model 写入 defaults：
      // RunConfig.model 只表示**消息级**覆盖；会话覆盖在 session.metadata.model
      runConfigDefaults: spec.runConfigDefaults,
    });
    const handle: InProcessAgentHandle = {
      agentId: spec.agentId,
      agent: spec.agent,
      ...(spec.contextEngine === undefined ? {} : { contextEngine: spec.contextEngine }),
      ...(spec.contextHealth === undefined ? {} : { contextHealth: spec.contextHealth }),
      registerTools: spec.registerTools,
      dispatcher: this.wrapInflightTracking(spec.runner, inner),
    };
    this.mounted.set(spec.agentId, { handle, runner: spec.runner });
    return handle;
  }

  get(agentId: string): InProcessAgentHandle | undefined {
    return this.mounted.get(agentId)?.handle;
  }

  handles(): InProcessAgentHandle[] {
    return [...this.mounted.values()].map((m) => m.handle);
  }

  mountedAgentIds(): string[] {
    return [...this.mounted.keys()];
  }

  execute(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const m = this.mounted.get(req.agentId);
    if (!m) {
      // fail-loud：未装载即调用方违例（须先 mount；不静默空转、不返回假成功）
      throw new Error(`run_backend: agent "${req.agentId}" not mounted`);
    }
    return m.handle.dispatcher.execute(req, signal);
  }

  compactSession(
    sessionId: string,
    agentId: string,
    options: Parameters<SessionAwareRunner['compactSession']>[2],
  ): Promise<CompactTransportOutcome> {
    const m = this.mounted.get(agentId);
    if (!m) {
      throw new Error(`run_backend: agent "${agentId}" not mounted`);
    }
    // D1：与 handle 共用 Runner session 锁（E4 键）；持久化走 Runner
    return m.runner.compactSession(sessionId, agentId, options);
  }

  retire(agentId: string): void {
    const m = this.mounted.get(agentId);
    if (!m) return;
    this.mounted.delete(agentId);
    this.retireRunner(m.runner);
  }

  async health(): Promise<RunBackendHealth> {
    let inFlightRuns = 0;
    for (const { runner } of this.mounted.values()) {
      inFlightRuns += this.runnerInflight.get(runner) ?? 0;
    }
    return {
      mountedAgents: this.mounted.size,
      inFlightRuns,
      retiredRunners: this.retiredRunners.length,
    };
  }

  disposeAll(): void {
    // 释放 Runner 后台 timer（BackfillTrigger / HealthProbe / SubsystemRuntime）
    for (const { runner } of this.mounted.values()) {
      try {
        runner.dispose();
      } catch {
        // stop 路径 fail-open，不阻断关闭
      }
    }
    this.mounted.clear();
    // 热失效退役 runner 兜底回收
    for (const runner of this.retiredRunners.splice(0)) {
      try {
        runner.dispose();
      } catch {
        // stop 路径 fail-open，不阻断关闭
      }
    }
  }

  /**
   * 退役 runner：in-flight 计数归零即 dispose；30min 长尾强制兜底（warn 后仍回收）。
   *
   * @param runner - 要退役的 runner
   */
  private retireRunner(runner: SessionAwareRunner): void {
    this.retiredRunners.push(runner);
    const tryDispose = (): void => {
      const inflight = this.runnerInflight.get(runner) ?? 0;
      if (inflight > 0) {
        // 仍有 run 在旧构建上跑完（拍板语义：不抢锁、不断流）——稍后重查
        const t = setTimeout(tryDispose, 5_000);
        t.unref?.();
        return;
      }
      this.disposeRetiredRunner(runner);
    };
    tryDispose();
    const force = setTimeout(() => {
      if (this.retiredRunners.includes(runner)) {
        // 文案保留 [Gateway] 前缀：与旧版告警/运维 grep 兼容（模块已迁 backend，勿改前缀）
        console.warn('[Gateway] retired runner force-disposed with runs possibly in-flight (>30min)');
        this.disposeRetiredRunner(runner);
      }
    }, 30 * 60_000);
    force.unref?.();
  }

  /**
   * 退役 runner 回收（幂等；stop 兜底也走这里）。
   *
   * @param runner - 要回收的 runner
   */
  private disposeRetiredRunner(runner: SessionAwareRunner): void {
    const idx = this.retiredRunners.indexOf(runner);
    if (idx < 0) return;
    this.retiredRunners.splice(idx, 1);
    this.runnerInflight.delete(runner);
    try {
      runner.dispose();
    } catch {
      // 退役回收 fail-open：dispose 只清后台 timer，失败不阻断
    }
  }

  /**
   * 包装 dispatcher：execute 前过 run 起点准入闸门（ops P2 三件套），
   * execute 期间维护 runner 的 in-flight run 计数（退役 dispose 判据）。
   *
   * @param runner - 计数/账本归属的 runner
   * @param inner - 原 dispatcher
   * @returns 包装后的 dispatcher（结构兼容 RunDispatcher）
   */
  private wrapInflightTracking(runner: SessionAwareRunner, inner: SessionRunnerDispatcher): RunDispatcher {
    const backend = this;
    return {
      inbox: inner.inbox,
      execute(req: RunRequest, signal?: AbortSignal) {
        // run 起点准入闸门（与安全配置漂移守卫同位）：
        // 被拒 run 不计入 in-flight（retireRunner 判据不受影响）。
        const gate = backend.opts.admissionGate?.({
          agentId: req.agentId,
          sessionId: req.sessionId,
        });
        if (gate) {
          // 三件套对齐（ops P2）：与 security_config_drift / kill_switch_active 同待遇——
          // 账本 + 观测 + run 通道报错。required 拒 run 是知识面故障下最响的事件，
          // 不得只留用户侧报错（监控盲区/审计缺口）。
          const origin = { agentId: req.agentId, sessionId: req.sessionId };
          runner.recordAdmissionRefusal(
            gate.event,
            {
              state: gate.state,
              action: 'refuse_new_run',
              reason: gate.error,
              origin,
            },
            origin,
          );
          return (async function* () {
            throw new Error(gate.error);
          })();
        }
        backend.runnerInflight.set(runner, (backend.runnerInflight.get(runner) ?? 0) + 1);
        const iter = inner.execute(req, signal);
        return (async function* () {
          try {
            yield* iter;
          } finally {
            // 完成 / 抛错 / 消费端提前 return 均收敛计数
            backend.runnerInflight.set(runner, (backend.runnerInflight.get(runner) ?? 1) - 1);
          }
        })();
      },
    };
  }
}
