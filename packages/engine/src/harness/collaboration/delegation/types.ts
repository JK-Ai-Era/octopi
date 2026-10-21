/**
 * Delegation — 委派契约类型（L2 委派契约层）
 *
 * @layer harness/collaboration/delegation — 多 Agent 委派产品契约，非 Core Kernel。
 * 设计权威：`arch/delegation.md`。
 *
 * 设计不变量（`arch/delegation.md` §3）：
 * - D1 委派契约是**纯 JSON 消息**，不传 JS 对象引用（跨进程可序列化）
 * - D5 结果只含可序列化字段（output / artifacts / usage / error）
 * - D10 委派单状态机独立，不与 SessionTask / Workflow 共用
 *
 * 因此本文件的**所有**类型必须可 `JSON.stringify` 无损往返；
 * 不得出现 `AbortSignal` / `Agent` 实例 / 函数 / class 实例等非序列化值。
 */

import type { TokenUsage } from '@octopi-agent/core/types/turn.js';
import type { SessionRights } from '../../governance/session-acl/types.js';

// ── 消息 schema 版本 ──

/**
 * 委派消息 schema 版本（D1/⑤：跨进程契约必须版本化）。
 * 破坏性变更时 +1；transport 与 service 据此做兼容判断。
 */
export const DELEGATION_SCHEMA_VERSION = 1;

// ── 状态机 ──

/** 委派单状态 */
export type DelegationStatus =
  | 'queued'      // 已建单，子 Run 未起
  | 'running'     // 子 Run 执行中
  | 'completed'   // 成功产出 output
  | 'failed'      // 子 Run 抛错 / depth 超限 / 目标不可达
  | 'cancelled'   // 显式取消（D4）
  | 'timeout';    // 超 deadlineAt（D4）

/** 终态集合：进入后不可复用（对齐 AgentProcess 旧语义，但状态机独立 D10） */
export const DELEGATION_TERMINAL_STATUSES: readonly DelegationStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'timeout',
];

/**
 * 判断委派单是否已到终态
 *
 * @param status - 委派单状态
 * @returns 是否终态
 */
export function isTerminalDelegationStatus(status: DelegationStatus): boolean {
  return DELEGATION_TERMINAL_STATUSES.includes(status);
}

/** 未闭合状态集合（queued + running） */
export const DELEGATION_ACTIVE_STATUSES: readonly DelegationStatus[] = ['queued', 'running'];

/**
 * 判断委派单是否仍未闭合
 *
 * @param status - 委派单状态
 * @returns 是否活跃
 */
export function isActiveDelegationStatus(status: DelegationStatus): boolean {
  return DELEGATION_ACTIVE_STATUSES.includes(status);
}

// ── 寻址（D2） ──

/**
 * 委派目标寻址。
 *
 * 二选一：`agentId` 显式指定；或 `capability` 交 `AgentRegistry` 解析。
 * **不得**传对象引用（D1/②）。
 */
export interface DelegationTarget {
  /** 目标 agentId（与 trait 二选一，agentId 优先） */
  agentId?: string;
  /** 特质标签（无显式 agentId 时按特质发现） */
  trait?: string;
}

// ── 预算（§8） ──

/**
 * 委派预算。
 *
 * 子的 Guard/Budget **独立生效**（防子失控）；usage 归集到父的 run 账（决策 C2）。
 * `timeoutMs` 是相对时长，service 起子 Run 时换算为 `deadlineAt`（D4）。
 */
export interface DelegationBudget {
  /** 子 Run 最大轮次 */
  maxTurns?: number;
  /** 子 Run 最大 token */
  maxTokens?: number;
  /** 委派超时（毫秒）；换算为 deadlineAt */
  timeoutMs?: number;
}

// ── 委派单（§6.1） ──

/**
 * 父 Run 身份（D2：字符串寻址，不含对象引用）
 */
export interface DelegationParentRef {
  agentId: string;
  sessionId: string;
  runId: string;
}

/**
 * 委派单 —— 一次委派的全程记录
 *
 * 持久化在 `DelegationStore`（唯一写入口），是 notify / poll 两通道的共同数据源。
 */
export interface Delegation {
  id: string;

  /** 父 Run 身份 */
  parent: DelegationParentRef;

  /** 目标寻址（D2） */
  target: DelegationTarget;
  /** 解析后的目标 agentId（service 解析后回填；未解析时 undefined） */
  resolvedAgentId?: string;

  /** 任务描述（进子的 user 消息） */
  task: string;
  /** 显式输入（不传父上下文，D6/⑥） */
  input: string;
  /** 上下文传递模式（默认 clean） */
  context: DelegationContextMode;

  status: DelegationStatus;

  /** 子 Session 关联（D7：独立 Session + 显式父子关联） */
  childSessionId?: string;
  childRunId?: string;

  /** 子的最后一轮 assistant 文本 = 结论（D5） */
  output?: string;
  /** 子产出的文件路径（D5/D6：不共享文件系统，显式声明） */
  artifacts?: string[];
  /** 子 Run 的 token 消耗（归集到父的 run 账，决策 C2） */
  usage?: TokenUsage;
  /** 失败原因（failed / timeout / cancelled 时有值） */
  error?: string;

  /** 委派深度（根委派 = 1）；超 maxDepth 直接 failed（§10.4） */
  depth: number;

  /** 生效预算（请求 ∩ 目标上限，D3 只收紧）；落库可审计 */
  budget?: DelegationBudget;

  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** 绝对截止时刻（D4：数据化，非 AbortSignal） */
  deadlineAt?: number;
  /** 是否允许取消（D4） */
  cancelable: boolean;

  /** 是否父亡子亡（决策 C1：默认 false = 子继续跑） */
  cascade: boolean;

  /**
   * 结果是否已送达父（§7.3 提示去重）：notify 投递成功或父经 delegate_get
   * 全文取回（markSurfaced）后置位；dispatch 被丢时回滚（markUndelivered）。
   * 字段名沿用 notified（历史契约），语义是 surfaced（详见 tools summary）。
   */
  notified: boolean;

  schemaVersion: number;
}

/** 上下文传递模式 */
export type DelegationContextMode = 'clean' | 'fork';

// ── 调用消息（§6.3） ──

/**
 * 父 → 子的调用消息（D1：纯 JSON schema）
 *
 * **不得**携带 `AbortSignal` / `Agent` / `Message[]` 之外的活对象。
 * `parentMessages` 仅 `context: 'fork'` 时有（D5：Message 本身可序列化）。
 */
export interface DelegateRequest {
  delegationId: string;
  from: DelegationParentRef;
  to: DelegationTarget;

  /**
   * 子 Session / Run ID（D7）。
   *
   * 由**服务方在起子 Run 之前生成并落库**，而不是由子 Run 结束时回填——
   * 否则子 agent 运行期间发起的孙代委派查不到 `childSessionId`，
   * 递归深度闸（§10.4）会失效。
   */
  childSessionId: string;
  childRunId: string;

  task: string;
  input: string;

  /** 上下文传递模式 */
  context: DelegationContextMode;
  /**
   * 父消息历史（仅 context='fork' 时携带）。
   *
   * 调用方必须传**快照**（不是活数组引用）——父 run 在子起跑后仍会 append，
   * 传引用会让 fork 内容随时间漂移（D1：契约是纯消息，不是活对象）。
   */
  parentMessages?: import('@octopi-agent/core/types.js').Message[];

  /** 权利天花板（D3：子只能收紧不能放宽） */
  rightsCeiling?: SessionRights;
  /** 预算（§8） */
  budget?: DelegationBudget;

  /** 绝对截止时刻（D4） */
  deadlineAt?: number;
  /** 是否允许取消（D4：可取消性随消息传播，不靠本地句柄） */
  cancelable?: boolean;

  schemaVersion: number;
}

/**
 * 子 → 父的结果消息（D5：只含可序列化字段）
 */
export interface DelegateResult {
  delegationId: string;
  status: Extract<DelegationStatus, 'completed' | 'failed' | 'cancelled' | 'timeout'>;

  /** 子 Session / Run ID（回显用；服务方已在起 Run 前落库） */
  childSessionId?: string;
  childRunId?: string;

  output?: string;
  artifacts?: string[];
  usage?: TokenUsage;
  error?: string;

  schemaVersion: number;
}

// ── AgentHandle（§4） ──

/**
 * 目标 agent 的解析结果（D2）。
 *
 * 进程内实现携带 `run` 入口；跨进程实现只携带可序列化字段，
 * 由 `DelegateTransport` 负责把远端 agent 当作本地 handle 调用。
 */
export interface AgentHandle {
  /** 解析出的 agentId */
  agentId: string;
  /** 特质标签（供调用方核对是否命中意图） */
  traits: string[];
  /** 被委派时的权利天花板（D3：只能收紧） */
  rightsCeiling?: SessionRights;
  /** 委派预算上限（service 取请求预算 ∩ 此上限） */
  budget?: DelegationBudget;
  /** 递归上限（§10.4；undefined = 默认 1） */
  maxDepth?: number;
  /** 是否可被委派（registry 解析时已过滤 callable=false） */
  callable: true;
}

// ── 事件（§7） ──

/**
 * 委派事件常量。
 *
 * notify 通道（§7.1）消费 `COMPLETED` / `FAILED` / `CANCELLED` / `TIMEOUT`，
 * 转 `emitAgentSignal` 唤醒父 AgentRuntime。
 */
export const DelegationEvents = {
  /** 委派单创建 */
  CREATED: 'delegation.created',
  /** 子 Run 启动 */
  STARTED: 'delegation.started',
  /** 终态：completed */
  COMPLETED: 'delegation.completed',
  /** 终态：failed */
  FAILED: 'delegation.failed',
  /** 终态：cancelled */
  CANCELLED: 'delegation.cancelled',
  /** 终态：timeout */
  TIMEOUT: 'delegation.timeout',
  /** notify 已投递到父 session */
  NOTIFIED: 'delegation.notified',
} as const;

/** 委派事件类型字面量 */
export type DelegationEventType = (typeof DelegationEvents)[keyof typeof DelegationEvents];
