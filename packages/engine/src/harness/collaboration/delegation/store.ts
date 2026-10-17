/**
 * DelegationStore — 委派单唯一写入口
 *
 * @layer harness/collaboration/delegation
 * 设计权威：`arch/delegation.md` §4 / §6.2 / D10。
 *
 * 职责：
 * - 读写 `Delegation`（委派单）
 * - **状态机校验**（D10：独立状态机，不与 SessionTask / Workflow 共用）
 * - 发射 `delegation.*` 事件（notify 通道的共同数据源，§7.1）
 *
 * 与 `SessionTaskService` 同构但**独立**：
 * `docs/task-system.md` A2 明令 SessionTask 不做执行原语、不与执行件共状态机，
 * 委派单不塞进 SessionTask。
 *
 * 持久化：v1 提供内存实现；跨进程持久化留待分布式议题（`arch/delegation.md` O5）。
 * 但接口形状按可持久化设计（`Delegation` 全字段可序列化，D1/D5）。
 */

import { randomUUID } from 'node:crypto';
import type { EventBus, AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import type {
  Delegation,
  DelegationBudget,
  DelegationContextMode,
  DelegationParentRef,
  DelegationStatus,
  DelegationTarget,
} from './types.js';
import {
  DELEGATION_SCHEMA_VERSION,
  DelegationEvents,
  isTerminalDelegationStatus,
} from './types.js';

// ── 写入入参 ──

/** 建单入参（服务端生成 id / 时间戳 / 初始状态） */
export interface CreateDelegationInput {
  parent: DelegationParentRef;
  target: DelegationTarget;
  task: string;
  input: string;
  context?: DelegationContextMode;
  budget?: DelegationBudget;
  /** 绝对截止时刻（D4）；由 budget.timeoutMs 换算或调用方直接给 */
  deadlineAt?: number;
  cancelable?: boolean;
  cascade?: boolean;
  /** 委派深度（根委派 = 1） */
  depth?: number;
}

/** 可更新字段（不含 id / parent / createdAt 等不可变字段） */
export interface UpdateDelegationPatch {
  resolvedAgentId?: string;
  status?: DelegationStatus;
  childSessionId?: string;
  childRunId?: string;
  output?: string;
  artifacts?: string[];
  usage?: Delegation['usage'];
  error?: string;
  startedAt?: number;
  completedAt?: number;
  deadlineAt?: number;
  notified?: boolean;
}

/** list 过滤 */
export interface DelegationListFilter {
  parentSessionId?: string;
  parentAgentId?: string;
  status?: DelegationStatus | DelegationStatus[];
  /** 仅未闭合（queued + running） */
  activeOnly?: boolean;
  /** 仅未投递 notify 的（§7.3 状态提示去重） */
  unnotifiedOnly?: boolean;
}

function now(): number {
  return Date.now();
}

/**
 * 校验状态迁移是否合法（D10 独立状态机）
 *
 * 合法迁移：
 * - queued → running | failed | cancelled | timeout
 * - running → completed | failed | cancelled | timeout
 * - 终态 → 不可再迁（不可复用）
 *
 * @param from - 当前状态
 * @param to - 目标状态
 * @returns 是否合法
 */
export function canTransitionDelegation(from: DelegationStatus, to: DelegationStatus): boolean {
  if (from === to) return true;
  if (isTerminalDelegationStatus(from)) return false;
  if (from === 'queued') {
    return to === 'running' || isTerminalDelegationStatus(to);
  }
  if (from === 'running') {
    return isTerminalDelegationStatus(to);
  }
  return false;
}

/**
 * DelegationStore — 委派单唯一写入口
 */
export class DelegationStore {
  private readonly records = new Map<string, Delegation>();

  constructor(private readonly events?: EventBus) {}

  /**
   * 建单（status 固定为 `queued`）
   *
   * @param input - 委派单入参
   * @returns 新建的委派单
   */
  create(input: CreateDelegationInput): Delegation {
    const record: Delegation = {
      id: `del-${randomUUID().slice(0, 8)}`,
      parent: { ...input.parent },
      target: { ...input.target },
      task: input.task,
      input: input.input,
      context: input.context ?? 'clean',
      status: 'queued',
      depth: input.depth ?? 1,
      budget: input.budget ? { ...input.budget } : undefined,
      createdAt: now(),
      deadlineAt: input.deadlineAt,
      cancelable: input.cancelable ?? true,
      cascade: input.cascade ?? false,
      notified: false,
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    };

    this.records.set(record.id, record);
    this.emit(DelegationEvents.CREATED, record);
    return { ...record };
  }

  /**
   * 读取委派单
   *
   * @param delegationId - 委派单 ID
   * @returns 委派单；不存在返回 undefined
   */
  get(delegationId: string): Delegation | undefined {
    const record = this.records.get(delegationId);
    return record ? { ...record } : undefined;
  }

  /**
   * 更新委派单（含状态机校验）
   *
   * @param delegationId - 委派单 ID
   * @param patch - 变更字段
   * @returns 更新后的委派单
   * @throws 委派单不存在，或状态迁移非法
   */
  update(delegationId: string, patch: UpdateDelegationPatch): Delegation {
    const record = this.records.get(delegationId);
    if (!record) {
      throw new Error(`Delegation not found: ${delegationId}`);
    }

    if (patch.status && !canTransitionDelegation(record.status, patch.status)) {
      throw new Error(
        `Invalid delegation transition: ${record.status} -> ${patch.status} (${delegationId})`,
      );
    }

    const before = record.status;

    if (patch.resolvedAgentId !== undefined) record.resolvedAgentId = patch.resolvedAgentId;
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.childSessionId !== undefined) record.childSessionId = patch.childSessionId;
    if (patch.childRunId !== undefined) record.childRunId = patch.childRunId;
    if (patch.output !== undefined) record.output = patch.output;
    if (patch.artifacts !== undefined) record.artifacts = [...patch.artifacts];
    if (patch.usage !== undefined) record.usage = { ...patch.usage };
    if (patch.error !== undefined) record.error = patch.error;
    if (patch.startedAt !== undefined) record.startedAt = patch.startedAt;
    if (patch.completedAt !== undefined) record.completedAt = patch.completedAt;
    if (patch.deadlineAt !== undefined) record.deadlineAt = patch.deadlineAt;
    if (patch.notified !== undefined) record.notified = patch.notified;

    // 进入终态时补 completedAt（若调用方未给）
    if (patch.status && isTerminalDelegationStatus(patch.status) && record.completedAt == null) {
      record.completedAt = now();
    }

    if (patch.status !== undefined && patch.status !== before) {
      this.emit(this.eventForStatus(patch.status), record);
    }

    return { ...record };
  }

  /**
   * 列出委派单
   *
   * @param filter - 过滤条件
   * @returns 匹配的委派单（按 createdAt 升序）
   */
  list(filter?: DelegationListFilter): Delegation[] {
    let results = Array.from(this.records.values());

    if (filter?.parentSessionId !== undefined) {
      results = results.filter((r) => r.parent.sessionId === filter.parentSessionId);
    }
    if (filter?.parentAgentId !== undefined) {
      results = results.filter((r) => r.parent.agentId === filter.parentAgentId);
    }
    if (filter?.status !== undefined) {
      const wanted = Array.isArray(filter.status) ? filter.status : [filter.status];
      results = results.filter((r) => wanted.includes(r.status));
    }
    if (filter?.activeOnly) {
      results = results.filter((r) => !isTerminalDelegationStatus(r.status));
    }
    if (filter?.unnotifiedOnly) {
      results = results.filter((r) => !r.notified);
    }

    return results.sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ ...r }));
  }

  /**
   * 统计父 session 下各状态数量（§7.3 状态提示渲染用）
   *
   * @param parentSessionId - 父 session ID
   * @returns 状态 → 数量
   */
  countByStatus(parentSessionId: string): Record<DelegationStatus, number> {
    const counts: Record<DelegationStatus, number> = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timeout: 0,
    };
    for (const record of this.records.values()) {
      if (record.parent.sessionId === parentSessionId) {
        counts[record.status] += 1;
      }
    }
    return counts;
  }

  /**
   * 查子 session 所在的委派链深度（§10.4 递归深度闸）
   *
   * 子 session 的深度 = 创建它的那张委派单的 `depth`。
   * 查不到表示该 session 非委派产生，视作根（返回 undefined，调用方按 0 处理）。
   *
   * @param childSessionId - 子 session ID
   * @returns 委派链深度；非委派 session 返回 undefined
   */
  findDepthByChildSession(childSessionId: string): number | undefined {
    for (const record of this.records.values()) {
      if (record.childSessionId === childSessionId) return record.depth;
    }
    return undefined;
  }

  /**
   * 标记 notify 已投递（§7.3 去重）
   *
   * @param delegationId - 委派单 ID
   * @returns 更新后的委派单
   */
  markNotified(delegationId: string): Delegation {
    return this.update(delegationId, { notified: true });
  }

  private eventForStatus(status: DelegationStatus): string {
    switch (status) {
      case 'running':
        return DelegationEvents.STARTED;
      case 'completed':
        return DelegationEvents.COMPLETED;
      case 'failed':
        return DelegationEvents.FAILED;
      case 'cancelled':
        return DelegationEvents.CANCELLED;
      case 'timeout':
        return DelegationEvents.TIMEOUT;
      default:
        return DelegationEvents.CREATED;
    }
  }

  private emit(type: string, record: Delegation): void {
    if (!this.events) return;
    const event: AgentEvent = {
      type,
      timestamp: now(),
      agentId: record.parent.agentId,
      sessionId: record.parent.sessionId,
      data: { delegation: { ...record } },
    };
    this.events.emit(event);
  }
}
