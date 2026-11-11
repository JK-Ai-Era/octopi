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
  /**
   * fleet 聚合时的不可达实例清单（单实例恒空；fail-loud 可见性，§4.2）。
   * 现状：生产消费者仅 fleetStatus 诊断面（DOC-5 标注：诊断预留，非控制信号）。
   */
  unreachableInstances?: string[];
  /**
   * 守卫在位状态（§4.3 健康门跨版本核查）：'armed'=实例按 configPath 自建了
   * securityIntegrity 守卫；'absent'=未自建（旧版 run-serve-child 或未配）。
   * 配置含 securityIntegrity 而实例报 absent → 健康门拒（防跨版本漂移闸 fail-open）。
   */
  securityGuard?: 'armed' | 'absent';
}

/**
 * RunBackend —— run 托管契约（单一 remote 实现为终态）。
 *
 * 契约拆分（P1-1b，OP-P0B-1 ③）：P0a 脚手架面（mount/get/handles/
 * mountedAgentIds/retire + InProcessAgentHandle/RunBackendMountSpec）已归
 * RunHost 域（harness/run/run-host.ts）——执行体装配是 run 服务自身面，
 * 不是 gateway 消费面。本契约只保留 gateway 侧消费面。
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
