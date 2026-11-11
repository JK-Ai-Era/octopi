/**
 * RunBackend — gateway ↔ run 侧契约缝（arch/service-topology.md §4）
 *
 * 语义边界（触发面/执行面分离，§5.4）：
 * - 触发面（AgentRuntime / TriggerSource / 准入政策）归 gateway；
 * - 执行面（Runner 构建/执行/退役/会话锁）一律经本契约触达，gateway 不得直摸 Runner。
 *
 * 实现分期（§4 单实现决策）：
 * - P0a：InProcessRunBackend（gateway 包内，进程内脚手架，P0b 后删除）；
 * - P0b 起：RemoteRunBackend（进程间唯一实现）。
 *
 * P0b 迁移注记：compactSession 的函数型参数（compactStructural / summarize）已数据化
 * 清偿（2026-11-10，解析入 engine RunHost）——控制面只传键，实现在 run 侧解析。
 * 本契约禁止再引入函数型参数。
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import type { RunDispatcher } from './types.js';
import type { SessionLease } from '../run/concurrency/session-lease.js';
import type { SessionAwareRunner, RunConfig } from '../run/runner.js';
import type { Agent } from '../run/agent/index.js';
import type { ContextEngine } from '../context/types.js';
import type { ContextLayerHealth } from '../context/layer-health.js';
import type { CompactTransportOutcome } from '../context/capabilities/compact/types.js';
import type { OpsAuditEvent } from '../extension/execution-environment/ops-audit.js';

/**
 * run 起点准入闸门结果（三件套：账本 event + state + run 通道错误，ops P2）。
 * 政策面（gateway）↔ 执行面（backend）的握手类型；远程化时须可传输（state 保持
 * 原样序列化，不在此收窄——闸门可为 knowledge/drift/kill-switch 等多种政策复用）。
 */
export interface AdmissionGateResult {
  /** 账本事件名（联合类型，如 ops.knowledge.run_refused） */
  event: OpsAuditEvent;
  /** run 通道错误文案（也是账本 reason） */
  error: string;
  /** 账本 state 载荷（如 knowledge 运行状态） */
  state: unknown;
}

/**
 * mount 输入：构建工厂（P0a 在 gateway、P0b 迁至 run 实例）产出的执行体。
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
    spec: import('./run-protocol.js').PulseSpec;
    fire: () => Promise<unknown>;
  }>;
}

/**
 * mount 返回：gateway 侧可见句柄（不含 Runner——Runner 是 backend 实现细节）。
 *
 * 命名即边界：`InProcess` 声明这些是**进程内活引用**（Agent 实例、闭包），跨不了进程
 * 边界，因此本类型是脚手架面——P0b 实例进程化时随 InProcessRunBackend 一起删除。
 * 远程契约面是纯数据 `control` 消息，不是句柄的 RPC stub；勿在本类型上追加方法
 * 当作扩展点（每加一个方法就多一块 P0b 的死重）。
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

/** 运行面健康快照 */
export interface RunBackendHealth {
  mountedAgents: number;
  inFlightRuns: number;
  retiredRunners: number;
  /**
   * 脉搏自述（P0c A′）：装配产物声明的全部 PulseSpec。gateway 脉搏调度器据此
   * 单发驱动；也是「无 self-arm 定时器」结构性断言的自证面（清单有、定时器无）。
   */
  pulses?: import('../activation/run-protocol.js').PulseSpec[];
  /** fleet 聚合时的不可达实例清单（单实例恒空；fail-loud 可见性，§4.2） */
  unreachableInstances?: string[];
}

/**
 * RunBackend —— run 托管契约（单一 remote 实现为终态；InProcess 仅 P0a 脚手架）。
 *
 * 错误表面（fail-loud，两形态）：未装载时 `execute`/`compactSession` **同步抛错**；
 * 准入闸门拒 run 是**异步事件流内抛错**（消费方经 for-await 收到）。远程实现须把
 * 两者映射为明确的失败事件，不得静默吞（§4 契约纪律）。
 *
 * `execute`（继承自 RunDispatcher）是契约统一执行入口（测试与未来 startRun 通道
 * 使用）；in-process 生产链路当前经 AgentRuntime → handle.dispatcher 直达同一包装，
 * 两条路汇聚于同一执行腿，无第二执行语义。
 */
export interface RunBackend extends RunDispatcher {
  /** 会话执行互斥（宪法 E1/E2；run lease 前身，P1 分布式化） */
  readonly sessionLock: SessionLease;

  /**
   * 装载一个 agent 执行体。同 agentId 已装载时抛错（fail-loud；
   * 调用方须先 retire 旧体，防止旧 Runner 泄漏）。
   *
   * @param spec - 构建产物 + 执行腿缺省
   * @returns gateway 侧句柄
   */
  mount(spec: RunBackendMountSpec): InProcessAgentHandle;

  /**
   * 取已装载句柄。
   *
   * @param agentId - agent id
   * @returns 句柄；未装载返回 undefined
   */
  get(agentId: string): InProcessAgentHandle | undefined;

  /** 全部句柄（遍历已装载 Agent 用） */
  handles(): InProcessAgentHandle[];

  /** 已装载 agent id 列表（热失效遍历用） */
  mountedAgentIds(): string[];

  /**
   * 退役一个 agent 执行体（in-flight 跑完后回收，不抢单不断流；未装载为 no-op）。
   *
   * @param agentId - agent id
   */
  retire(agentId: string): void;

  /**
   * 会话压缩（控制面 op；与 run 共用 sessionLock 排队）。
   * 纯数据签名：systemPrompt/tools/摘要绑定由实现侧（RunHost）从 run 状态解析。
   *
   * @param sessionId - 会话 id
   * @param agentId - compact 视图归属 agent
   * @returns 压缩结果
   */
  compactSession(sessionId: string, agentId: string): Promise<CompactTransportOutcome>;

  /**
   * 运行面健康（supervise 健康门的进程内形态）。
   * 计数口径注记：inFlightRuns 只计**在挂**执行体；热失效退役中仍有 in-flight 的
   * runner 不计入（retiredRunners 只报个数）。P0c 接健康门时须先补退役侧计数，
   * 否则会低估负载（见 arch/service-topology.md §5）。
   */
  health(): Promise<RunBackendHealth>;

  /** 全量回收（停机路径，fail-open） */
  disposeAll(): void;
}
