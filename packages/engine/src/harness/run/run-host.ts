/**
 * RunHost — run 实例侧执行宿主（arch/service-topology.md §4「P0b 落地形态」）。
 *
 * 持有 run 侧全部运行时态：挂载槽、in-flight 计数、退役回收、会话锁、准入闸门执行、
 * 审批/客户端工具跨通道配对、compact 解析（P0a 迁移注记清偿：控制面只传键，
 * systemPrompt/tools/摘要绑定在此从 run 侧自身状态解析）。
 *
 * 内核自 gateway 的 InProcessRunBackend 搬入（行为冻结；原搬迁自 gateway.ts 的
 * agentCache/retiredRunners/runnerInflight/wrapInflightTracking/retireRunner 语义不变）。
 * gateway 脚手架以子类形态过渡到 P0b 步骤 5 删除；远程实现（run-serve-child）直接
 * 以本类为执行核。
 *
 * 语义边界（触发面/执行面分离，§5.4）：本类只做执行面；触发面（AgentRuntime /
 * TriggerSource）永远在 gateway 进程。inbox 重投等需要触发面的动作经
 * `notify('redispatch')` 回 gateway，本类不内嵌任何常驻触发器。
 */

import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type { Message, RegisteredTool, ToolExecutionContext } from '@octopi-agent/core/types.js';
import type {
  LLMMessage,
  LLMToolDefinition,
  ModelProvider,
} from '@octopi-agent/core/interfaces/model-provider.js';
import { randomUUID } from 'node:crypto';
import { SessionRunnerDispatcher } from '../activation/index.js';
import type { RunDispatcher, RunRequest, Trigger } from '../activation/index.js';
import type { RunSmokeReport } from '../activation/run-protocol.js';
import type {
  AdmissionGateResult,
  RunBackend,
  RunBackendHealth,
} from '../activation/run-backend.js';
import type {
  AgentDefinitionWire,
  ClientToolVisibilitySnapshot,
  ClientToolWireSpec,
  KnowledgeStateWire,
  RunControlOp,
  RunControlResponse,
  RunHostNotify,
} from '../activation/run-protocol.js';
import type { RunApprovalRequestInput } from '../activation/run-protocol.js';
import type { HitlAskResult } from '../governance/human-in-the-loop/decision-cache.js';
import type { SessionAwareRunner, RunConfig } from './runner.js';
import type { Agent } from './agent/index.js';
import type { ContextEngine } from '../context/types.js';
import type { ContextLayerHealth } from '../context/layer-health.js';
import type { SessionData } from '../session/types.js';
import type { DiscardFileEffectsResult } from '../extension/execution-environment/undo-log.js';
import { isTurnAnchor } from '../context/layer-types.js';
import { isTurnStartContent } from '../context/turn-envelope.js';
import { InProcessSessionLock } from './concurrency/session-lease.js';
import type { SessionLease } from './concurrency/session-lease.js';
import type {
  CompactOutcome,
  CompactTransportOutcome,
  SummarizeFunction,
} from '../context/capabilities/compact/types.js';
import type { ContextCompactSnapshot } from '../context/types.js';
import { registeredToolToAgentTool } from '../agent/registered-tool-adapter.js';

/** Runner compactSession 的选项形状（搬移解析的目标类型，禁手抄） */
type CompactSessionOptions = Parameters<SessionAwareRunner['compactSession']>[2];

/** compact 进度事件形状（ContextEmitFn 同式；双缝出口见 onCompactEvent） */
interface CompactEmitEvent {
  type: string;
  sessionId?: string;
  reason?: string;
  fallback?: string;
  cached?: boolean;
}

/**
 * ContextEngine 结构压缩扩展面（gateway.ts 原内联类型，随 compact 解析搬入；
 * ContextEngine 接口不声明 compactStructural——结构性能力按需结构化探测）。
 */
type StructuralEngine = {
  compactStructural?: (input: {
    sessionId: string;
    agentId?: string;
    messages: Message[];
    summarize?: (messages: LLMMessage[], opts?: { maxTokens?: number }) => Promise<string>;
    compactTargetTokens?: number;
    taskSnapshot?: string;
    /** 请求口径计量原料（2026-11-08 B1）：与会话下一请求同源的 system/tools */
    systemPrompt?: string;
    tools?: LLMToolDefinition[];
    contextWindow?: number;
    maxOutputTokens?: number;
    /** 旧压缩快照读口（迁移输入） */
    loadCompactState?: (sessionId: string) => Promise<ContextCompactSnapshot | undefined> | ContextCompactSnapshot | undefined;
    /** F22：cache-miss 旁路事件出口（ContextEmitFn 形状，经 observerHub 直采进 timeline） */
    emit?: (event: CompactEmitEvent) => void;
  }) => Promise<CompactOutcome>;
};

export interface RunHostOptions {
  /** inbox 未消费项的原 Trigger 重投路径（remote 形态：RunHostNotify.redispatch 回 gateway） */
  redispatch: (
    trigger: Trigger,
    options?: { onEvent?: (event: AgentEvent) => void },
  ) => void | Promise<unknown>;
  /** run 起点准入闸门；返回结果 = 拒新 run（政策在 gateway，执行在 backend） */
  admissionGate?: (req: { agentId: string; sessionId: string }) => AdmissionGateResult | undefined;
  /** 共享会话锁（缺省自建进程内锁；所有 Runner 与控制面共用同一实例） */
  sessionLock?: SessionLease;

  // ── 宿主接线（compact / client tool / 审批 / 热重建路径用；缺省命中即 fail-loud） ──

  /** 宿主通知出口（remote: fork IPC；shim: 直连 gateway 处理器） */
  notify?: (notify: RunHostNotify) => void;
  /** compact 摘要模型解析的 provider 映射 */
  providers?: ReadonlyMap<string, ModelProvider>;
  /** agent 默认模型绑定（会话模型缺失时的 compact 摘要回退） */
  resolveDefaultModel?: (agentId: string) => { provider: string; model: string } | undefined;
  /** 会话 metadata 读取（compact 模型绑定来自 session.metadata.model） */
  loadSessionMetadata?: (sessionId: string) => Promise<Record<string, unknown> | undefined>;
  /** 请求口径计量（config.context.contextAssembler.compactTargetTokens） */
  compactTargetTokens?: number;
  /** compact 进度双缝出口（Hub timeline + gatewayBus→WS；remote 形态转 notify('session_event')） */
  onCompactEvent?: (event: CompactEmitEvent) => void;
  /** 热重建：新定义 → 新挂载 spec（本类负责退役+重挂；并发单飞在调用方） */
  buildMountSpec?: (agentId: string, definition: AgentDefinitionWire) => Promise<RunBackendMountSpec>;
  /**
   * 会话写口（控制面写路径 op 用：append/truncate；写者单点 = run 节点，§3）。
   * 缺省命中即 fail-loud。discardFileUndo 带宿主的 memoryRestorer 与 sessionsDir 解析。
   */
  sessionWriter?: {
    load(sessionId: string): Promise<SessionData | undefined>;
    save(sessionId: string, session: SessionData): Promise<void>;
    patchMetadata(sessionId: string, updater: (meta: Record<string, unknown>) => void): Promise<void>;
    discardFileUndo(sessionId: string, agentId: string): Promise<DiscardFileEffectsResult>;
  };
  /**
   * console 受控写后重锚定安全指纹（ops P2 §8.4；boot 纯数据自建守卫的同步缝）。
   * 缺省命中 reattestSecurity op 即 fail-loud（守卫漂移拒 run 不变）。
   */
  reattestSecurity?: (options: {
    expectHash: string;
    allowedChanged: string[];
  }) => { previousFingerprint: string; fingerprint: string; changed: string[] };
}

interface Mounted {
  handle: InProcessAgentHandle;
  runner: SessionAwareRunner;
}

/** 会话 metadata 的模型绑定读取（与 gateway.readSessionModelId 同式，禁手抄） */
function readSessionModelId(metadata: Record<string, unknown> | undefined): string | null {
  const raw = metadata?.model;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object') {
    const obj = raw as { provider?: unknown; model?: unknown };
    if (typeof obj.model === 'string' && obj.model) {
      return typeof obj.provider === 'string' && obj.provider
        ? `${obj.provider}/${obj.model}`
        : obj.model;
    }
  }
  return null;
}

/**
 * 中止标记锚点 = 某 turn 的用户输入：开轮信封（含 wake 等机器输入），或定形前的裸用户输入
 * （自 gateway.isTurnInput 迁入；view 与写路径同口径，单一来源）。
 */
export function isTurnInput(msg: Message | undefined): boolean {
  return (
    !!msg &&
    msg.role === 'user' &&
    (isTurnStartContent(msg.content) || isTurnAnchor(msg))
  );
}

/**
 * mount 输入：构建工厂（run-assembly）产出的执行体（P1-1b 契约拆分自
 * activation/run-backend 迁入：装配是 RunHost 自身面，不是 gateway 消费面）。
 *
 * @param agentId - agent id（挂载槽位键）
 * @param agent - 构建好的 Agent 实例
 * @param runner - 会话感知执行器（实现细节，句柄不外泄）
 * @param contextEngine - 上下文引擎（compact 控制面用）
 * @param contextHealth - 七层健康探针
 * @param registerTools - 动态工具注册口
 * @param runConfigDefaults - 执行腿缺省（agentId/contextWindow/systemPrompt；不含消息级 model 覆盖）
 */
export interface RunBackendMountSpec {
  agentId: string;
  agent: Agent;
  runner: SessionAwareRunner;
  contextEngine?: ContextEngine;
  contextHealth?: (agentId?: string) => Promise<ContextLayerHealth>;
  registerTools: (tools: RegisteredTool[]) => void;
  runConfigDefaults: Partial<RunConfig>;
  /**
   * 脉搏注册表（P0c A′）：该执行体声明的周期任务（key 实例内唯一）。
   * RunHost 聚合到 `health().pulses` 自述；`control {type:'pulse'}` 按 key 驱动。
   */
  pulses?: Array<{
    spec: import('../activation/run-protocol.js').PulseSpec;
    fire: () => Promise<unknown>;
  }>;
}

/**
 * mount 返回：RunHost 域内句柄（进程内活引用，P1-1b 自 RunBackend 契约迁入）。
 *
 * 命名即边界：`InProcess` 声明这些是**进程内活引用**（Agent 实例、闭包），跨不了进程
 * 边界。远程契约面是纯数据 `control` 消息，不是句柄的 RPC stub；勿在本类型上追加方法
 * 当作契约扩展点。
 */
export interface InProcessAgentHandle {
  agentId: string;
  agent: Agent;
  contextEngine?: ContextEngine;
  contextHealth?: (agentId?: string) => Promise<ContextLayerHealth>;
  registerTools: (tools: RegisteredTool[]) => void;
  /** 注册进 AgentRuntime 的执行腿（已含准入闸门 + in-flight 计数包装） */
  dispatcher: RunDispatcher;
}

export class RunHost implements RunBackend {
  readonly sessionLock: SessionLease;
  protected readonly opts: RunHostOptions;
  private readonly mounted = new Map<string, Mounted>();
  /** 脉搏注册表（P0c A′）：key → 进程内驱动入口 + 自述元数据（gateway 单发驱动） */
  private readonly pulseFire = new Map<string, () => Promise<unknown>>();
  private readonly pulseSpecs = new Map<string, import('../activation/run-protocol.js').PulseSpec>();
  private readonly buildInFlight = new Map<string, Promise<InProcessAgentHandle>>();
  private readonly retiredRunners: SessionAwareRunner[] = [];
  private readonly runnerInflight = new WeakMap<SessionAwareRunner, number>();
  private readonly activeRuns = new Map<string, Set<AbortController>>();
  private readonly pendingApprovals = new Map<string, (result: HitlAskResult) => void>();
  private readonly pendingClientCalls = new Map<
    string,
    (outcome: { ok: true; result: unknown } | { ok: false; error: { message: string; name?: string } }) => void
  >();
  private visibilitySnapshot: ClientToolVisibilitySnapshot = {
    installed: [],
    live: [],
    // 初始即过期：未收到首个快照前客户端工具一律不可见（fail-safe，宁缺勿滥）
    expiresAt: 0,
  };
  /** 客户端工具现况注册表（B3：mount 晚于 setClientTools 时重放；add 同名覆盖） */
  private readonly clientToolRegistry = new Map<string, RegisteredTool>();
  private knowledgeState: KnowledgeStateWire = 'starting';

  constructor(options: RunHostOptions) {
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
    // 脉搏注册（P0c A′）：重复 key = 装配 bug，fail-loud
    for (const p of spec.pulses ?? []) {
      if (this.pulseFire.has(p.spec.key)) {
        throw new Error(`run_backend: duplicate pulse key "${p.spec.key}"`);
      }
      this.pulseFire.set(p.spec.key, p.fire);
      this.pulseSpecs.set(p.spec.key, p.spec);
    }
    // B3：客户端工具重放——setClientTools 可能早于首个 mount（WS 注册工具后用户才发
    // 首条消息）。注册表现况补挂进新 agent；谓词对非注册工具恒放行，不影响常规工具面。
    if (this.clientToolRegistry.size > 0) {
      this.applyClientTools(
        [...this.clientToolRegistry.values()].map((tool) => ({ op: 'add' as const, tool })),
        this.buildVisibilityPredicate(),
      );
    } else {
      // 可选调用：测试桩/最小 agent 面可不实现可见性过滤（谓词缺省=全放行等价）
      spec.agent.setToolVisibilityFilter?.(this.buildVisibilityPredicate());
    }
    return handle;
  }

  get(agentId: string): InProcessAgentHandle | undefined {
    return this.mounted.get(agentId)?.handle;
  }

  /**
   * 消息路径 get-or-mount（gateway.getOrMountHandle 同语义）：未挂载则经
   * buildMountSpec 钩子构建+挂载；同 agent 并发首建单飞合流。
   *
   * 语义基线（B1）：并发请求全部成功；竞态败者回收自己的构建产物、复用胜者句柄；
   * 其余 mount 错误如实上抛（fail-loud）。
   *
   * @param agentId - agent id
   * @param definition - agent 定义（纯数据；透传构建钩子）
   * @returns 句柄（保证已挂载）
   */
  ensureMounted(agentId: string, definition: AgentDefinitionWire): Promise<InProcessAgentHandle> {
    const existing = this.mounted.get(agentId);
    if (existing) return Promise.resolve(existing.handle);
    const inFlight = this.buildInFlight.get(agentId);
    if (inFlight) return inFlight;
    const build = this.opts.buildMountSpec;
    if (!build) {
      return Promise.reject(
        new Error('not_implemented: run_host buildMountSpec not wired (ensureMounted)'),
      );
    }
    const task = (async () => {
      const spec = await build(agentId, definition);
      try {
        return this.mount(spec);
      } catch (err) {
        // mount 失败回收构建产物（防后台 timer 泄漏）；竞态败者复用胜者，其余错误照抛
        try {
          spec.runner.dispose();
        } catch {
          // 回收失败不掩盖原始错误
        }
        const winner = this.mounted.get(agentId);
        if (winner) return winner.handle;
        throw err;
      }
    })();
    this.buildInFlight.set(agentId, task);
    const clear = (): void => {
      if (this.buildInFlight.get(agentId) === task) this.buildInFlight.delete(agentId);
    };
    void task.then(clear, clear);
    return task;
  }

  handles(): InProcessAgentHandle[] {
    return [...this.mounted.values()].map((m) => m.handle);
  }

  mountedAgentIds(): string[] {
    return [...this.mounted.keys()];
  }

  retire(agentId: string): void {
    const m = this.mounted.get(agentId);
    if (!m) return;
    this.mounted.delete(agentId);
    // 该执行体的脉搏随退役拆除（key 带 agentId 前缀）
    for (const key of [...this.pulseFire.keys()]) {
      if (key.startsWith(`${agentId}:`)) {
        this.pulseFire.delete(key);
        this.pulseSpecs.delete(key);
      }
    }
    this.retireRunner(m.runner);
  }

  execute(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const m = this.mounted.get(req.agentId);
    if (!m) {
      // fail-loud：未装载即调用方违例（须先 mount；不静默空转、不返回假成功）
      throw new Error(`run_backend: agent "${req.agentId}" not mounted`);
    }
    return m.handle.dispatcher.execute(req, signal);
  }

  /**
   * 契约执行入口（§4）：execute + 按会话登记 AbortController（control 'abort' 的目标）。
   * 并发同会话调用不在此拦（E1/E2 互斥由 sessionLock 排队语义承接；abort 作用于该
   * 会话全部在途 controller）。
   *
   * @param req - run 请求（纯数据）
   * @param signal - 外部中止信号（委派子 run 的 D4 本地投影；合流到本 run 的 controller）
   * @returns 协议事件流
   */
  startRun(req: RunRequest, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const controller = new AbortController();
    let set = this.activeRuns.get(req.sessionId);
    if (!set) {
      set = new Set<AbortController>();
      this.activeRuns.set(req.sessionId, set);
    }
    set.add(controller);
    const onExternalAbort = (): void => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let iter: AsyncIterable<AgentEvent>;
    try {
      iter = this.execute(req, controller.signal);
    } catch (err) {
      // 同步错（未挂载等）：摘外部监听 + 摘在途登记再上抛（否则按失败请求累积泄漏）；
      // 保持同步抛 = 契约错误表面「未装载等同步错直接 4xx」不变
      signal?.removeEventListener('abort', onExternalAbort);
      set.delete(controller);
      if (set.size === 0) this.activeRuns.delete(req.sessionId);
      throw err;
    }
    const self = this;
    return (async function* () {
      try {
        yield* iter;
      } finally {
        signal?.removeEventListener('abort', onExternalAbort);
        const s = self.activeRuns.get(req.sessionId);
        s?.delete(controller);
        if (s && s.size === 0) self.activeRuns.delete(req.sessionId);
      }
    })();
  }

  /**
   * 控制 op 统一入口（契约 `control` 的 run 侧执行面）。
   * 错误表面：失败一律进 `RunControlResponse` 的 `ok:false`（远程层映射 HTTP 4xx），
   * 不静默吞。
   *
   * @param op - 纯数据控制 op
   * @returns 执行结果
   */
  async handleControl(op: RunControlOp): Promise<RunControlResponse> {
    try {
      switch (op.type) {
        case 'abort': {
          const set = this.activeRuns.get(op.sessionId);
          if (set) {
            for (const controller of set) {
              controller.abort(op.reason ?? 'aborted');
            }
          }
          // 幂等：无在途 run 也成功（stop 按钮连点语义）
          return { ok: true };
        }
        case 'sessionAppendMessage': {
          // 与 Runner.handle 共 sessionLock（E1/E2）：无锁写入会被下一次增量同步判为
          // 「漂移」而整包抹掉（2026-11-04 定位的语义，随写路径迁入）
          const writer = this.requireSessionWriter();
          const release = await this.sessionLock.acquire(op.sessionId);
          try {
            const session = await writer.load(op.sessionId);
            if (!session) return { ok: true };
            session.messages.push(op.message);
            session.meta.updatedAt = Date.now();
            await writer.save(op.sessionId, session);
            return { ok: true };
          } finally {
            release();
          }
        }
        case 'truncateMessagesFrom': {
          return await this.truncateMessagesFrom(op.sessionId, op.fromIndex);
        }
        case 'askUserReply': {
          const pending = this.pendingAsks.get(op.askId);
          if (!pending) {
            return { ok: false, error: { message: `run_host: unknown askId "${op.askId}"` } };
          }
          this.pendingAsks.delete(op.askId);
          if (op.outcome.ok) pending.resolve(op.outcome.answer);
          else pending.reject(new Error(op.outcome.error.message));
          return { ok: true };
        }
        case 'approvalReply': {
          const resolve = this.pendingApprovals.get(op.approvalId);
          if (!resolve) {
            return { ok: false, error: { message: `run_host: unknown approvalId "${op.approvalId}"` } };
          }
          this.pendingApprovals.delete(op.approvalId);
          resolve(op.result);
          return { ok: true };
        }
        case 'clientToolResult': {
          const resolve = this.pendingClientCalls.get(op.callId);
          if (!resolve) {
            return { ok: false, error: { message: `run_host: unknown callId "${op.callId}"` } };
          }
          this.pendingClientCalls.delete(op.callId);
          resolve(op.outcome);
          return { ok: true };
        }
        case 'compact': {
          const result = await this.compactSession(op.sessionId, op.agentId);
          return { ok: true, result };
        }
        case 'reloadAgent': {
          const build = this.requireBuildMountSpec();
          this.retire(op.agentId);
          const spec = await build(op.agentId, op.definition);
          this.mount(spec);
          return { ok: true };
        }
        case 'retireAgent': {
          this.retire(op.agentId);
          return { ok: true };
        }
        case 'setClientTools': {
          this.visibilitySnapshot = op.visibility;
          const ops = op.ops.map((o) =>
            o.op === 'add'
              ? ({ op: 'add' as const, tool: this.materializeClientTool(o.tool) })
              : ({ op: 'remove' as const, name: o.name }),
          );
          // B3：注册表现况登记（mount 晚于本 op 时按表重放）
          for (const change of ops) {
            if (change.op === 'add') {
              this.clientToolRegistry.set(change.tool.definition.name, change.tool);
            } else {
              this.clientToolRegistry.delete(change.name);
            }
          }
          this.applyClientTools(ops, this.buildVisibilityPredicate());
          return { ok: true };
        }
        case 'syncKnowledgeState': {
          this.knowledgeState = op.state;
          return { ok: true };
        }
        case 'inboxOffer': {
          // 协调面「插话」跨进程入口：目标 agent 未挂载 = 本实例无活跃 Run 可接
          //（get-or-mount 语义下未挂载即无会话活跃面）→ 'dispatched'，调用方照常
          // dispatch 新 Run。挂载了则 offer 进其 SessionInbox（原 Trigger 随行，
          // Run 关闭未消费时由 inbox 回调 redispatch 重投）。
          const m = this.mounted.get(op.agentId);
          const inbox = m?.handle.dispatcher.inbox;
          if (!inbox) {
            return { ok: true, result: { delivery: 'dispatched' } };
          }
          const delivery = inbox.offer({
            agentId: op.agentId,
            sessionId: op.sessionId,
            entryId: op.entryId,
            human: op.human,
            triggerType: op.triggerType as never,
            modelOverride: op.modelOverride,
            modelProvider: op.modelProvider,
            message: op.message,
            trigger: op.trigger,
          });
          return { ok: true, result: { delivery: await delivery } };
        }
        case 'contextHealth': {
          const m = op.agentId ? this.mounted.get(op.agentId) : undefined;
          if (op.agentId && !m) {
            return { ok: false, error: { message: `run_backend: agent "${op.agentId}" not mounted` } };
          }
          const probe = m?.handle.contextHealth;
          if (!probe) {
            return { ok: false, error: { message: 'run_host: context health probe not available' } };
          }
          return { ok: true, result: await probe(op.agentId) };
        }
        case 'reattestSecurity': {
          if (!this.opts.reattestSecurity) {
            return {
              ok: false,
              error: { message: 'run_host: reattestSecurity not wired (security guard missing)' },
            };
          }
          const result = this.opts.reattestSecurity({
            expectHash: op.expectHash,
            allowedChanged: op.allowedChanged,
          });
          return { ok: true, result };
        }
        case 'pulse': {
          // 脉搏单发（P0c A′）：gateway 调度器驱动一次声明式 tick；未知 key fail-loud
          const fire = this.pulseFire.get(op.key);
          if (!fire) {
            return { ok: false, error: { message: `run_host: unknown pulse key "${op.key}"` } };
          }
          await fire();
          return { ok: true, result: { pulsed: op.key } };
        }
      }
      // 未识别 op：fail-loud（静默吞会让调用方误以为已执行）
      return {
        ok: false,
        error: { message: `run_host: unknown control op "${(op as { type: string }).type}"` },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error && err.name ? { name: err.name } : {}),
        },
      };
    }
  }

  /**
   * 审批请求（pluginManager approval sink 与装配 requestApproval 的远程形态入口）：
   * 注册配对并经 notify 出港；回执由 control 'approvalReply' 解配对。
   *
   * @param input - 审批请求载荷（RunApprovalRequestInput 形状）
   * @returns 审批结果
   */
  askApproval(input: RunApprovalRequestInput): Promise<HitlAskResult> {
    const approvalId = `ap-${randomUUID()}`;
    return new Promise<HitlAskResult>((resolve, reject) => {
      this.pendingApprovals.set(approvalId, resolve);
      try {
        this.notify({ type: 'approval_request', approvalId, input });
      } catch (err) {
        this.pendingApprovals.delete(approvalId);
        reject(err);
      }
    });
  }

  /** ask_user 跨通道配对（问句经 notify 出港，作答经 control 'askUserReply' 解配对） */
  private readonly pendingAsks = new Map<
    string,
    { resolve: (answer: string) => void; reject: (err: Error) => void }
  >();

  /**
   * ask_user 提问（AskUserCallback 的远程形态入口）：注册配对并经 notify 出港。
   * 回执 ok:false 时拒接 → 工具调用抛错（fail-loud，不吞失败）。
   *
   * @param input - 问句载荷
   * @returns 用户作答
   */
  askQuestion(input: {
    sessionId: string;
    agentId: string;
    question: string;
    options?: string[];
  }): Promise<string> {
    const askId = `ask-${randomUUID()}`;
    return new Promise<string>((resolve, reject) => {
      this.pendingAsks.set(askId, { resolve, reject });
      try {
        this.notify({
          type: 'ask_user_request',
          askId,
          sessionId: input.sessionId,
          agentId: input.agentId,
          question: input.question,
          ...(input.options === undefined ? {} : { options: input.options }),
        });
      } catch (err) {
        this.pendingAsks.delete(askId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * 把动态 client tool 同步进已 build 的 Agent（E5 下同 session 串行，无需锁 tool 列表）。
   * handleControl('setClientTools') 与 in-process 直连路径共用本核心。
   *
   * @param ops - 工具增删（RegisteredTool 已就位）
   * @param visibility - 会话 tool 面可见性谓词
   */
  applyClientTools(
    ops: Array<{ op: 'add'; tool: RegisteredTool } | { op: 'remove'; name: string }>,
    visibility: (sessionId: string, toolName: string) => boolean,
  ): void {
    for (const { handle } of this.mounted.values()) {
      handle.agent.setToolVisibilityFilter(visibility);
      if (ops.length === 0) continue;
      const current = handle.agent.tools;
      let next = [...current];
      for (const op of ops) {
        if (op.op === 'add') {
          next = next.filter((t) => t.name !== op.tool.definition.name);
          next.push(registeredToolToAgentTool(op.tool));
        } else {
          next = next.filter((t) => t.name !== op.name);
        }
      }
      handle.agent.setTools(next);
    }
  }

  compactSession(sessionId: string, agentId: string): Promise<CompactTransportOutcome> {
    const m = this.mounted.get(agentId);
    if (!m) {
      // fail-loud **同步抛**（契约错误表面两形态之一）：未装载即调用方违例。
      // 前置检查必须留在非 async 方法里——async 化会把同步抛降级为异步拒斥。
      throw new Error(`run_backend: agent "${agentId}" not mounted`);
    }
    return this.resolveAndCompact(sessionId, agentId, m);
  }

  /**
   * 截断会话消息（编辑重发唯一写路径；自 gateway.truncateMessagesFrom 迁入，行为冻结）。
   * 校验：仅最后一轮中止、锚点为该 turn 用户输入；随后截断 + 租约下标收缩 +
   * abortedTurn 清理 + 本轮文件效应逆放（用户手改保留）。
   *
   * @param sessionId - 会话 id
   * @param fromIndex - 截断锚点（须等于 abortedTurn.userMessageIndex）
   * @returns 控制响应（result = 消息数 + 文件效应逆放结果）
   */
  private async truncateMessagesFrom(
    sessionId: string,
    fromIndex: number,
  ): Promise<RunControlResponse> {
    const writer = this.requireSessionWriter();
    const release = await this.sessionLock.acquire(sessionId);
    try {
      const session = await writer.load(sessionId);
      if (!session) {
        throw new Error(`Session "${sessionId}" not found`);
      }
      // 仅服务「最后一轮进行中 → 回到本轮起点」；效应是整轮 discard，不是按 index 定点回滚
      const aborted = session.metadata?.abortedTurn as
        | { userMessageIndex?: number }
        | undefined;
      const allowed = aborted && typeof aborted.userMessageIndex === 'number'
        ? aborted.userMessageIndex
        : undefined;
      if (allowed === undefined || fromIndex !== allowed) {
        throw new Error(
          `edit_resend_only_last_aborted_turn: fromIndex must equal abortedTurn.userMessageIndex`,
        );
      }
      if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex > session.messages.length) {
        throw new Error(`fromIndex out of range: ${fromIndex}`);
      }
      // 与 view 同口径的写路径守卫：截断锚点必须是该 turn 的用户输入。
      // legacy/损坏的 abortedTurn 元数据可能指向引擎载体/notify，切在错误位置会把
      // 真正的中止残片留在历史里，重发叠出重复用户轮
      const anchor = session.messages[fromIndex];
      if (!isTurnInput(anchor)) {
        throw new Error(
          `edit_resend_only_last_aborted_turn: abortedTurn anchor is not a turn user message`,
        );
      }
      session.messages = session.messages.slice(0, fromIndex);
      // 租约下标必须随 messages 重写收缩，否则下一轮 LLM 窗口被裁空
      if (typeof session.contextDetachIndex === 'number') {
        session.contextDetachIndex = Math.min(session.contextDetachIndex, fromIndex);
      }
      session.meta.updatedAt = Date.now();
      // abortedTurn 是 metadata 键：save 浅合并删不掉，必须 updateMetadata
      await writer.save(sessionId, session);
      await writer.patchMetadata(sessionId, (meta) => {
        delete meta.abortedTurn;
      });
      // L3: edit-resend reverses this turn's agent file effects (user hand-edits survive)
      const fileEffects = await writer.discardFileUndo(
        sessionId,
        session.primaryAgentId ?? session.agentId,
      );
      return { ok: true, result: { messageCount: session.messages.length, fileEffects } };
    } catch (err) {
      return {
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error && err.name ? { name: err.name } : {}),
        },
      };
    } finally {
      release();
    }
  }

  /**
   * 冒烟（健康门 §4.3，`POST /smoke`）：逐 agent 装配热路径自检——工具面枚举 +
   * 一次 no-LLM 应答（contextHealth）。**不是 run，不占 run 语义**。
   *
   * @returns 冒烟报告（逐项如实入 checks；聚合 ok = 有 agent 且全部通过）
   */
  async smoke(): Promise<RunSmokeReport> {
    const agents: RunSmokeReport['agents'] = [];
    for (const [agentId, m] of this.mounted) {
      const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
      const toolNames = m.handle.agent.tools.map((t) => t.name);
      const toolCount = toolNames.length;
      checks.push(
        toolCount > 0
          ? { name: 'tools', ok: true, detail: toolNames.join(',') }
          : { name: 'tools', ok: false, detail: 'empty tool surface' },
      );
      if (m.handle.contextHealth) {
        try {
          await m.handle.contextHealth(agentId);
          checks.push({ name: 'contextHealth', ok: true });
        } catch (err) {
          checks.push({
            name: 'contextHealth',
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // NIT-3：无 context engine 的 agent 没走到装配热路径——如实记 skipped，不算验证过
        checks.push({
          name: 'contextHealth',
          ok: true,
          detail: 'skipped: no context engine (assembly path not exercised on this agent)',
        });
      }
      agents.push({ agentId, toolCount, checks });
    }
    return { ok: agents.length > 0 && agents.every((a) => a.checks.every((c) => c.ok)), agents };
  }

  async health(): Promise<RunBackendHealth> {
    let inFlightRuns = 0;
    for (const { runner } of this.mounted.values()) {
      inFlightRuns += this.runnerInflight.get(runner) ?? 0;
    }
    return {
      pulses: [...this.pulseSpecs.values()],
      mountedAgents: this.mounted.size,
      inFlightRuns,
      retiredRunners: this.retiredRunners.length,
    };
  }

  disposeAll(): void {
    // F2：先中止在途 run 再收摊——否则 /runs 流拖到兜底硬杀，消费端经 m1 把
    // 正常停机误报成截断失败。abort 让执行流走正常终态收束（aborted）。
    for (const controllers of this.activeRuns.values()) {
      for (const controller of controllers) {
        try {
          controller.abort(new Error('run_backend: host disposing'));
        } catch {
          // stop 路径 fail-open，不阻断关闭
        }
      }
    }
    this.activeRuns.clear();
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
   * compact 解析（P0a 迁移注记清偿）：systemPrompt/tools/摘要绑定/进度双缝全部从
   * run 侧自身状态解析，控制面只传键。搬移自 gateway.ts 手动压缩调用点（行为冻结）。
   *
   * @param sessionId - 会话 id
   * @param agentId - compact 视图归属 agent（E4 键，调用方已消歧）
   * @returns 压缩结果
   */
  private async resolveAndCompact(sessionId: string, agentId: string, m: Mounted): Promise<CompactTransportOutcome> {
    const structural = m.handle.contextEngine as StructuralEngine | undefined;
    if (!structural?.compactStructural) {
      return {
        ok: false,
        compacted: false,
        reason: 'context engine does not support structural compact',
        tokensBefore: 0,
        summarizeAttempted: false,
      };
    }
    const providers = this.opts.providers;
    if (!providers) {
      throw new Error('not_implemented: run_host providers not wired (compact)');
    }

    const metadata = await this.opts.loadSessionMetadata?.(sessionId);
    const modelRef = readSessionModelId(metadata);
    const defModel = this.opts.resolveDefaultModel?.(agentId);
    const { createProviderSummarize } = await import('../context/summarize.js');
    const { resolveModelRef } = await import('./model/index.js');

    let summarize: SummarizeFunction | undefined;
    const bound = modelRef
      ? resolveModelRef(modelRef, {
          providers,
          defaultProvider: defModel?.provider,
          isOverride: true,
        })
      : defModel
        ? resolveModelRef(`${defModel.provider}/${defModel.model}`, {
            providers,
            isOverride: false,
          })
        : null;
    if (bound) {
      // 会话模型绑定（评审 F6）：摘要必须走当前会话模型——丢了 modelName 会走 provider 默认
      // 模型，既违背「走当前会话模型」拍板，也让同形前缀缓存（per provider+model）彻底失效
      summarize = createProviderSummarize(bound.provider, {
        model: bound.modelName,
        maxOutputTokens: bound.maxOutputTokens,
      });
    }

    // 请求口径计量原料（评审 B1，2026-11-08）与摘要请求工具面（2026-11-12）：manual 压缩的
    // before/after 与摘要前缀都必须与会话下一请求同源。工具面解析收口到 Runner
    // （`resolveSessionLlmTools`：toolsForSession ∩ agentToolPolicy ∩ session ACL），
    // 与 run 内 `runContext.tools` 同一漏斗——禁在此手抄，手抄会漂移成两份工具面，
    // 摘要请求 tools 与原请求不同字节 → 前缀缓存从第一字节断开（评审 MAJ-3）。
    const manualTools: LLMToolDefinition[] = await m.runner.resolveSessionLlmTools(sessionId, agentId);

    // D1：与 handle 共用 Runner session 锁（E4 键）；持久化走 Runner
    return m.runner.compactSession(sessionId, agentId, {
      systemPrompt: m.handle.agent.context.systemPrompt,
      tools: manualTools,
      compactStructural: (input) =>
        structural.compactStructural!({
          sessionId: input.sessionId,
          agentId: input.agentId,
          messages: input.messages,
          summarize: input.summarize,
          compactTargetTokens: input.compactTargetTokens,
          taskSnapshot: input.taskSnapshot,
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          loadCompactState: input.loadCompactState,
          // 摘要请求窗口护栏（评审 F5）：窗口/输出上限随会话模型绑定注入，防最满时压缩被 400
          contextWindow: bound?.contextWindow,
          maxOutputTokens: bound?.maxOutputTokens,
          // F22：manual 路 cache-miss 旁路事件直采（Builder 合同是**双缝**：Hub timeline +
          // gatewayBus→WS/store）；onCompactEvent 由宿主接线该双缝（remote 形态转 notify）。
          emit: (e) => {
            this.opts.onCompactEvent?.({ ...e, sessionId: e.sessionId ?? sessionId });
          },
        }),
      summarize,
      compactTargetTokens: this.opts.compactTargetTokens,
    });
  }

  /**
   * 退役 runner：in-flight 计数归零即 dispose；30min 长尾强制兜底（warn 后仍回收）。
   *
   * @param runner - 要退役的 runner
   */
  protected retireRunner(runner: SessionAwareRunner): void {
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

  /**
   * 客户端工具桥：wire spec → RegisteredTool（handler 跨通道配对执行）。
   * 请求经 notify('client_tool_call') 出港，结果由 control 'clientToolResult' 解配对。
   *
   * @param spec - 线上工具形状（definition + source）
   * @returns run 侧可执行工具
   */
  private materializeClientTool(spec: ClientToolWireSpec): RegisteredTool {
    return {
      definition: spec.definition,
      ...(spec.source === undefined ? {} : { source: spec.source }),
      handler: (args: Record<string, unknown>, context: ToolExecutionContext) => {
        // 方案 A 配套：工具面粘滞保留 schema，因此这里必须响亮拒绝「确认离线」的调用，
        // 而不是挂到 TTL 超时（模型拿到可读错误即可换路，代价远小于重建前缀缓存）。
        if (this.isClientToolConfirmedOffline(context.sessionId, spec.definition.name)) {
          return Promise.resolve({
            error: 'client_unavailable',
            hint: `客户端工具 "${spec.definition.name}" 当前没有在线连接；该端重新连接后可重试`,
          });
        }
        const callId = `ct-${randomUUID()}`;
        return new Promise<unknown>((resolve, reject) => {
          const abortSignal = context.abortSignal;
          let settled = false;
          const onAbort = (): void => {
            if (settled) return;
            settled = true;
            this.pendingClientCalls.delete(callId);
            // run 侧中止即通知 gateway 收掉执行腿（否则其 pending 挂到 TTL 过期）；
            // 通知失败不改写本地结局——中止已发生，gateway 侧由 TTL 兜底
            try {
              this.notify({ type: 'client_tool_cancel', callId, reason: 'run aborted' });
            } catch {
              // swallow：中止路径没有更上层消费者可回告，结局由下方 resolve 表达
            }
            // 与 createClientTool 中止语义一致：LLM 可见 error 形结局，不静默悬挂
            resolve({ error: 'cancelled', hint: 'run aborted while waiting for client tool' });
          };
          if (abortSignal?.aborted) {
            onAbort();
            return;
          }
          abortSignal?.addEventListener('abort', onAbort, { once: true });
          this.pendingClientCalls.set(callId, (outcome) => {
            if (settled) return;
            settled = true;
            abortSignal?.removeEventListener('abort', onAbort);
            if (outcome.ok) resolve(outcome.result);
            else reject(new Error(outcome.error.message));
          });
          try {
            this.notify({
              type: 'client_tool_call',
              callId,
              sessionId: context.sessionId,
              agentId: context.agentId,
              toolName: spec.definition.name,
              args,
              messages: context.messages,
            });
          } catch (err) {
            if (settled) return;
            settled = true;
            this.pendingClientCalls.delete(callId);
            abortSignal?.removeEventListener('abort', onAbort);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    };
  }

  /** 可见性谓词（快照求值；宿主 onBuilt 在构建期装到 agent 上） */
  buildVisibilityPredicate(): (sessionId: string, toolName: string) => boolean {
    const snapshot = this.visibilitySnapshot;
    // 方案 A（工具面粘滞）：已安装的客户端工具对某会话**见过即永久可见**。
    // liveness 抖动绝不改变 LLM 可见的 tools schema——`tools` 位于缓存前缀最前，
    // 一次增删会让整段历史前缀失效（生产实测 70k–124k token 全价重算/次）。
    // 客户端真的不在线时，由调用期返回 `client_unavailable`（响亮、可重试）。
    // 快照过期同样不收缩工具面；过期只让调用期校验退化为「照常派发」。
    const sticky = snapshot.everLive ?? snapshot.live;
    return (sessionId, toolName) => {
      if (!snapshot.installed.includes(toolName)) return true;
      return sticky.some((e) => e.sessionId === sessionId && e.toolName === toolName);
    };
  }

  /**
   * 调用期 liveness 校验（方案 A 的配套）：工具留在 schema 里，但真的没有 live
   * provider 时立刻响亮失败，而不是挂到 TTL 超时。
   *
   * 快照过期 = liveness 未知 → 不阻断（交调用自身 TTL 兜底），避免误拒。
   *
   * @param sessionId - 会话 id
   * @param toolName - 客户端工具名
   * @returns true = 可信地不在线（拒绝调用）
   */
  private isClientToolConfirmedOffline(sessionId: string, toolName: string): boolean {
    const snapshot = this.visibilitySnapshot;
    if (Date.now() > snapshot.expiresAt) return false;
    if (!snapshot.installed.includes(toolName)) return false;
    return !snapshot.live.some((e) => e.sessionId === sessionId && e.toolName === toolName);
  }

  private requireSessionWriter(): NonNullable<RunHostOptions['sessionWriter']> {
    if (!this.opts.sessionWriter) {
      throw new Error('not_implemented: run_host sessionWriter not wired (session write ops)');
    }
    return this.opts.sessionWriter;
  }

  private requireBuildMountSpec(): NonNullable<RunHostOptions['buildMountSpec']> {
    if (!this.opts.buildMountSpec) {
      throw new Error('not_implemented: run_host buildMountSpec not wired (reloadAgent)');
    }
    return this.opts.buildMountSpec;
  }

  private notify(n: RunHostNotify): void {
    if (!this.opts.notify) {
      throw new Error(`not_implemented: run_host notify not wired (${n.type})`);
    }
    this.opts.notify(n);
  }
}
