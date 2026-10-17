/**
 * DelegateService — 委派编排
 *
 * @layer harness/collaboration/delegation
 * 设计权威：`arch/delegation.md` §7 / §8 / §10。
 *
 * 职责：
 * - 建单（`DelegationStore.create`，唯一写入口）
 * - 解析目标（`AgentRegistry`：agentId 优先，capability 兜底，D2）
 * - 递归深度闸（§10.4）
 * - 失控防护 `maxActiveDelegationsPerSession`（§8：**不是并发闸**，并发硬闸只在 SessionGate 一处，D9）
 * - 经 `DelegateTransport` 起子 Run、收结果（D1/D5）
 * - 归集 usage 到父的 run 账（决策 C2）
 * - 终态投递 notify（§7.1，投递由 P3 的 notifier 实现，本层只负责触发）
 *
 * **非阻塞**（§7）：`dispatch()` 建单后立即返回 `delegationId`，不等子 Run 结束。
 */

import { randomUUID } from 'node:crypto';
import type { TokenUsage } from '@octopi-agent/core/types/turn.js';
import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { AgentRegistry } from './registry-types.js';
import type {
  AgentHandle,
  Delegation,
  DelegationParentRef,
  DelegationStatus,
  DelegationTarget,
} from './types.js';
import type { DelegateRequest, DelegateResult } from './types.js';
import { DELEGATION_SCHEMA_VERSION, DelegationEvents, isTerminalDelegationStatus } from './types.js';
import type { DelegationBudget, DelegationContextMode } from './types.js';
import type { DelegationListFilter, DelegationStore } from './store.js';
import type { DelegateTransport } from './transport.js';
import { tightenSessionRights } from '../../governance/session-acl/rights.js';
import { effectiveDelegationPolicy } from './registry-types.js';

// ── 入参 ──

/** dispatch 入参 */
export interface DispatchDelegationInput {
  parent: DelegationParentRef;
  /**
   * 父所在委派链的深度（父未被委派 = 0）。
   * 服务据此算 `depth = parentDepth + 1`，再比对父 agent 的 `maxDepth`（§10.4）。
   */
  parentDepth?: number;
  target: DelegationTarget;
  /**
   * 发起方的**有效** session rights（D3：权限随调用传播）。
   *
   * 服务方把它与目标 agent 的 `delegation.rightsCeiling` 取交集后
   * 写入 `DelegateRequest.rightsCeiling`，使子只能在父的权限内行事。
   * 缺省 = 不叠加父约束（仅用目标自身天花板）。
   */
  parentRights?: import('../../governance/session-acl/types.js').SessionRights;
  task: string;
  input: string;
  context?: DelegationContextMode;
  /** 父消息历史（仅 context='fork' 时携带） */
  parentMessages?: import('@octopi-agent/core/types.js').Message[];
  budget?: DelegationBudget;
  /** 相对超时（毫秒）；与 `deadlineAt` 二选一 */
  timeoutMs?: number;
  /** 绝对截止时刻（D4） */
  deadlineAt?: number;
  cancelable?: boolean;
  /** 父亡子亡（决策 C1：默认 false = 子继续跑） */
  cascade?: boolean;
}

/** dispatch 结果（非阻塞：不含 output） */
export interface DispatchResult {
  delegation: Delegation;
  /** 已解析的目标 agentId */
  resolvedAgentId: string;
}

/** 服务配置 */
export interface DelegateServiceConfig {
  /**
   * 单个父 session 可同时挂载的未闭合委派上限（失控防护，§8）。
   *
   * **这不是并发闸**（并发硬闸只在 SessionGate，D9）。
   * 缺省 = {@link DEFAULT_MAX_ACTIVE_DELEGATIONS}（委派默认开启，必须有上限）。
   */
  maxActiveDelegationsPerSession?: number;
  /**
   * notify 投递器（P3 接 `emitAgentSignal`）。
   * 缺省 = 不投递，委派单仍可通过 poll（`get`/`list`）取回。
   */
  notifier?: DelegationNotifier;
  /**
   * 解析父 session 所在的委派链深度（父未被委派 = 0）。
   *
   * 工具路径下 `DispatchDelegationInput.parentDepth` 不便携带时由服务回调取得，
   * 使 §10.4 的递归深度闸在工具路径同样生效。
   * 缺省 = 0（父视为根 agent）。
   */
  resolveParentDepth?: (sessionId: string) => number | undefined;
}

/**
 * notify 投递器（§7.1）
 *
 * @param delegation - 终态委派单
 */
export type DelegationNotifier = (delegation: Delegation) => Promise<void> | void;

/** 目标不可达 / 策略拒绝的分类错误 */
/** 可用委派目标概要（解析失败时回传，供调用方自愈） */
export interface ResolutionAvailability {
  /** 全部已登记 trait */
  traits: string[];
  /** 全部已登记 agent 概要 */
  agents: Array<{ id: string; traits: string[]; callable: boolean }>;
}

export class DelegateResolutionError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_found' | 'not_callable' | 'forbidden' | 'depth_exceeded' | 'too_many_active',
    /** 解析失败时的可用目标（可选；让调用方不必瞎猜） */
    readonly available?: ResolutionAvailability,
  ) {
    super(message);
    this.name = 'DelegateResolutionError';
  }
}

/** 缺省失控防护：单父 session 同时挂载的未闭合委派上限 */
export const DEFAULT_MAX_ACTIVE_DELEGATIONS = 8;

function now(): number {
  return Date.now();
}

/** 日志用的短摘要 */
function truncateForLog(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`;
}

/** 生成子 Session ID（D7；格式稳定可读，便于检索与审计） */
function makeChildSessionId(delegationId: string, agentId: string): string {
  return `cs-${delegationId.replace(/^del-/, '')}-${agentId}-${randomUUID().slice(0, 6)}`;
}

/** 生成子 Run ID */
function makeChildRunId(): string {
  return `run-${randomUUID().slice(0, 8)}`;
}

/**
 * 合并预算：请求预算 ∩ agent 上限（取更严的一侧）
 *
 * @param requested - 请求里的预算
 * @param ceiling - agent 声明的预算上限
 * @returns 生效预算
 */
export function intersectBudget(
  requested: DelegationBudget | undefined,
  ceiling: DelegationBudget | undefined,
): DelegationBudget | undefined {
  if (!requested && !ceiling) return undefined;
  const pick = (a?: number, b?: number): number | undefined => {
    if (a == null) return b;
    if (b == null) return a;
    return Math.min(a, b);
  };
  return {
    maxTurns: pick(requested?.maxTurns, ceiling?.maxTurns),
    maxTokens: pick(requested?.maxTokens, ceiling?.maxTokens),
    timeoutMs: pick(requested?.timeoutMs, ceiling?.timeoutMs),
  };
}

/**
 * DelegateService — 委派编排
 */
export class DelegateService {
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    private readonly store: DelegationStore,
    private readonly registry: AgentRegistry,
    private readonly transport: DelegateTransport,
    private readonly config: DelegateServiceConfig = {},
  ) {}

  /**
   * 非阻塞派发：建单并起子 Run，立即返回（§7）
   *
   * @param input - 派发入参
   * @returns 委派单（status = queued 或 running）与解析出的目标
   * @throws 目标不可达 / 不可被委派 / 深度超限 / 未闭合委派过多
   */
  async dispatch(input: DispatchDelegationInput): Promise<DispatchResult> {
    // 1. 解析目标（D2）
    const handle = this.resolveTarget(input.target, input.parent.agentId);

    // 2. 递归深度闸（§10.4）
    const parentDepth =
      input.parentDepth ?? this.config.resolveParentDepth?.(input.parent.sessionId) ?? 0;
    const depth = parentDepth + 1;
    const maxDepth = handle.maxDepth ?? 1;
    if (depth > maxDepth) {
      throw new DelegateResolutionError(
        `delegation depth exceeded: ${depth} > ${maxDepth} (${handle.agentId})`,
        'depth_exceeded',
      );
    }

    // 3. 失控防护（§8）；缺省有上限（委派默认开启，不能不限）
    const limit =
      this.config.maxActiveDelegationsPerSession ?? DEFAULT_MAX_ACTIVE_DELEGATIONS;
    if (limit != null) {
      const active = this.store.list({
        parentSessionId: input.parent.sessionId,
        activeOnly: true,
      }).length;
      if (active >= limit) {
        throw new DelegateResolutionError(
          `too many active delegations for session ${input.parent.sessionId}: ${active} >= ${limit}`,
          'too_many_active',
        );
      }
    }

    // 4. 预算：请求 ∩ agent 上限（D3 只收紧）
    const budget = intersectBudget(input.budget, handle.budget);

    // 4b. 权利天花板：父有效权限 ∩ 目标自身天花板（D3 只收紧，不得借委派提权）
    const rightsCeiling = tightenSessionRights(input.parentRights, handle.rightsCeiling);

    // 5. deadlineAt（D4：数据化）
    //    `input.timeoutMs` 与 `budget.timeoutMs` 都要生效——任选其一，前者优先。
    const deadlineAt =
      input.deadlineAt ??
      this.deadlineFromBudget(budget) ??
      (input.timeoutMs != null ? now() + input.timeoutMs : undefined);

    // 6. 建单（唯一写入口）
    const delegation = this.store.create({
      parent: input.parent,
      target: input.target,
      task: input.task,
      input: input.input,
      context: input.context,
      budget,
      deadlineAt,
      cancelable: input.cancelable,
      cascade: input.cascade,
      depth,
    });

    // 6b. 子身份在起 Run **之前**生成并落库（D7）：
    //     子 Run 期间发起的孙代委派要能经 findDepthByChildSession 查到深度（§10.4）。
    const childSessionId = makeChildSessionId(delegation.id, handle.agentId);
    const childRunId = makeChildRunId();
    this.store.update(delegation.id, {
      resolvedAgentId: handle.agentId,
      childSessionId,
      childRunId,
    });

    // 7. 起子 Run（非阻塞：不 await 终态）
    const controller = new AbortController();
    this.inflight.set(delegation.id, controller);
    void this.runChild(
      delegation.id,
      handle,
      input,
      budget,
      rightsCeiling,
      deadlineAt,
      controller,
      childSessionId,
      childRunId,
    );

    return { delegation: this.store.get(delegation.id)!, resolvedAgentId: handle.agentId };
  }

  /**
   * 读取委派单
   *
   * @param delegationId - 委派单 ID
   * @returns 委派单；不存在返回 undefined
   */
  get(delegationId: string): Delegation | undefined {
    return this.store.get(delegationId);
  }

  /**
   * 列出委派单（poll 通道，§7）
   *
   * @param filter - 过滤条件
   * @returns 匹配的委派单
   */
  list(filter?: DelegationListFilter): Delegation[] {
    return this.store.list(filter);
  }

  /**
   * 取消委派（D4）
   *
   * @param delegationId - 委派单 ID
   * @returns 取消后的委派单
   * @throws 委派单不存在，或已终态 / 不可取消
   */
  cancel(delegationId: string, reason = 'cancelled by parent'): Delegation {
    const record = this.store.get(delegationId);
    if (!record) {
      throw new Error(`Delegation not found: ${delegationId}`);
    }
    if (isTerminalDelegationStatus(record.status)) {
      throw new Error(`Delegation already terminal: ${record.status} (${delegationId})`);
    }
    if (!record.cancelable) {
      throw new Error(`Delegation not cancelable: ${delegationId}`);
    }

    this.inflight.get(delegationId)?.abort();
    this.inflight.delete(delegationId);

    return this.store.update(delegationId, {
      status: 'cancelled',
      error: reason,
    });
  }

  /**
   * 级联中止：父 session 消亡时中止其所有 `cascade: true` 的在途委派（决策 C1）
   *
   * 默认（`cascade: false`）子 Run **继续跑**，父结束不影响；
   * 只有父显式声明 `cascade: true` 的委派会被中止。
   *
   * 调用时机由宿主决定（Gateway / 嵌入方在父 run 或父 session 终止时调用）。
   *
   * @param parentSessionId - 父 session ID
   * @param reason - 中止原因（写入 error 字段）
   * @returns 被中止的委派单 ID 列表
   */
  abortChildren(parentSessionId: string, reason = 'parent terminated (cascade)'): string[] {
    const aborted: string[] = [];
    const active = this.store.list({ parentSessionId, activeOnly: true });
    for (const record of active) {
      if (!record.cascade) continue;
      try {
        this.cancel(record.id, reason);
        aborted.push(record.id);
      } catch {
        // 并发下可能已被其他路径落到终态；跳过即可，状态机已保证不重复迁移
      }
    }
    return aborted;
  }

  /**
   * 渲染父 session 的委派状态提示（§7.3，供 `getSteeringMessages` 用）
   *
   * @param parentSessionId - 父 session ID
   * @returns 状态提示文本；无未闭合且无未读终态时返回空串
   */
  renderStatusHint(parentSessionId: string): string {
    const counts = this.store.countByStatus(parentSessionId);
    const active = counts.queued + counts.running;
    const doneUnnotified = this.store
      .list({ parentSessionId, unnotifiedOnly: true })
      .filter((d) => isTerminalDelegationStatus(d.status));

    if (active === 0 && doneUnnotified.length === 0) return '';

    const parts: string[] = [];
    if (counts.completed > 0) parts.push(`${counts.completed} completed`);
    if (counts.failed > 0) parts.push(`${counts.failed} failed`);
    if (counts.timeout > 0) parts.push(`${counts.timeout} timeout`);
    if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
    if (counts.queued > 0) parts.push(`${counts.queued} queued`);
    if (counts.running > 0) parts.push(`${counts.running} running`);

    return `<delegation_status>${parts.join(', ')}</delegation_status>`;
  }

  // ── 内部 ──

  /**
   * 解析目标（D2）：agentId 优先，capability 兜底
   *
   * @param target - 目标寻址
   * @param callerAgentId - 调用方 agentId（校验 callableBy）
   * @returns 解析出的 AgentHandle
   * @throws 目标不可达 / 不可被委派 / 策略拒绝
   */
  private resolveTarget(target: DelegationTarget, callerAgentId: string): AgentHandle {
    if (target.agentId) {
      const info = this.registry.get(target.agentId);
      if (!info) {
        throw new DelegateResolutionError(
          `delegate target not found: ${target.agentId}`,
          'not_found',
          this.describeTargets(),
        );
      }
      return this.toHandle(info, callerAgentId);
    }

    if (target.trait) {
      // 先验后挑：不可委派的候选要过滤掉，而不是挑中再抛错
      //（否则第一个不可委派的命中会让整次委派失败，而不是落到下一个可用候选）
      const candidates = this.registry
        .findByTrait(target.trait)
        .filter((info) => effectiveDelegationPolicy(info.delegation).callable)
        .filter((info) => this.isCallableBy(info, callerAgentId));
      const picked = candidates[0];
      if (!picked) {
        // 失败时回传**可用目标**，让调用方（LLM）一次就能改对，而不是瞎猜
        throw new DelegateResolutionError(
          `no callable agent for trait: ${target.trait}`,
          'not_found',
          this.describeTargets(),
        );
      }
      return this.toHandle(picked, callerAgentId);
    }

    throw new DelegateResolutionError(
      'delegate target must set agentId or trait',
      'not_found',
      this.describeTargets(),
    );
  }

  /**
   * 列出**可用委派目标**（失败时回传，供调用方自愈）
   *
   * @returns 可用 traits 与 agent 概要
   */
  private describeTargets(): ResolutionAvailability {
    return {
      traits: [...new Set(this.registry.list().flatMap((a) => a.traits))].sort(),
      agents: this.registry.list().map((a) => ({
        id: a.id,
        traits: [...a.traits],
        callable: effectiveDelegationPolicy(a.delegation).callable,
      })),
    };
  }

  /** 校验委派策略并转 AgentHandle */
  private toHandle(
    info: import('./registry-types.js').AgentInfo,
    callerAgentId: string,
  ): AgentHandle {
    const policy = effectiveDelegationPolicy(info.delegation);
    if (!policy.callable) {
      throw new DelegateResolutionError(
        `agent not callable for delegation: ${info.id}`,
        'not_callable',
      );
    }
    if (!this.isCallableBy(info, callerAgentId)) {
      throw new DelegateResolutionError(
        `agent ${info.id} forbids delegation from ${callerAgentId}`,
        'forbidden',
      );
    }
    return {
      agentId: info.id,
      traits: info.traits,
      rightsCeiling: policy.rightsCeiling,
      budget: policy.budget,
      maxDepth: policy.maxDepth,
      callable: true,
    };
  }

  /** callableBy 白名单校验（缺省 = 任意） */
  private isCallableBy(
    info: import('./registry-types.js').AgentInfo,
    callerAgentId: string,
  ): boolean {
    const allowed = effectiveDelegationPolicy(info.delegation).callableBy;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(callerAgentId);
  }

  /** budget.timeoutMs → deadlineAt */
  private deadlineFromBudget(budget: DelegationBudget | undefined): number | undefined {
    if (budget?.timeoutMs == null) return undefined;
    return now() + budget.timeoutMs;
  }

  /** 起子 Run、收结果、落终态（非阻塞入口） */
  private async runChild(
    delegationId: string,
    handle: AgentHandle,
    input: DispatchDelegationInput,
    budget: DelegationBudget | undefined,
    rightsCeiling: import('../../governance/session-acl/types.js').SessionRights | undefined,
    deadlineAt: number | undefined,
    controller: AbortController,
    childSessionId: string,
    childRunId: string,
  ): Promise<void> {
    const request: DelegateRequest = {
      delegationId,
      from: input.parent,
      to: input.target,
      childSessionId,
      childRunId,
      task: input.task,
      input: input.input,
      context: input.context ?? 'clean',
      parentMessages: input.context === 'fork' ? input.parentMessages : undefined,
      rightsCeiling,
      budget,
      deadlineAt,
      cancelable: input.cancelable ?? true,
      schemaVersion: DELEGATION_SCHEMA_VERSION,
    };

    // deadline 定时器（D4）：到点中止本地执行并落 timeout 终态
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (deadlineAt != null) {
      const delay = Math.max(0, deadlineAt - now());
      deadlineTimer = setTimeout(() => {
        controller.abort();
        if (!isTerminalDelegationStatus(this.store.get(delegationId)?.status ?? 'queued')) {
          this.store.update(delegationId, {
            status: 'timeout',
            error: `delegation timeout at deadline ${deadlineAt}`,
          });
          void this.notify(delegationId);
        }
      }, delay);
    }

    try {
      this.store.update(delegationId, { status: 'running', startedAt: now() });

      const result: DelegateResult = await this.transport.call(request, controller.signal);
      this.settleWithResult(delegationId, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.settleWithFailure(delegationId, controller.signal.aborted, message);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.inflight.delete(delegationId);
      void this.notify(delegationId);
    }
  }

  /**
   * 落成功终态。
   *
   * 若委派单已被 deadline / cancel 抢先落到终态，**不得覆盖**，但必须留痕——
   * 否则子跑完的结果会无声无息消失（审查 P1-2）。
   */
  private settleWithResult(delegationId: string, result: DelegateResult): void {
    const record = this.store.get(delegationId);
    const current = record?.status;
    if (current && isTerminalDelegationStatus(current)) {
      this.noteLateOutcome(delegationId, current, result.output, undefined);
      return;
    }
    // 归集 usage 到父的 run 账（决策 C2）：写入委派单，由调用方/Runner 汇总
    this.store.update(delegationId, {
      status: result.status,
      childSessionId: result.childSessionId,
      childRunId: result.childRunId,
      output: result.output,
      artifacts: result.artifacts,
      usage: result.usage,
      error: result.error,
    });
  }

  /**
   * 落失败终态。
   *
   * 已终态时**保留原 error**（如用户的取消原因），绝不让状态机内部文案
   * 「Invalid delegation transition: …」污染对外可见面（审查 P1-2）。
   */
  private settleWithFailure(delegationId: string, aborted: boolean, message: string): void {
    const record = this.store.get(delegationId);
    const current = record?.status;
    if (current && isTerminalDelegationStatus(current)) {
      this.noteLateOutcome(delegationId, current, undefined, message);
      return;
    }
    this.store.update(delegationId, {
      status: aborted ? 'cancelled' : 'failed',
      error: message,
    });
  }

  /**
   * 迟到结果/失败留痕：保留原 error，追加一行说明，并打 warn。
   *
   * @param delegationId - 委派单 ID
   * @param current - 已落入的终态
   * @param lateOutput - 迟到的子产出（若有）
   * @param lateError - 迟到的失败原因（若有）
   */
  private noteLateOutcome(
    delegationId: string,
    current: DelegationStatus,
    lateOutput: string | undefined,
    lateError: string | undefined,
  ): void {
    const detail = lateError ?? (lateOutput ? `output=${truncateForLog(lateOutput)}` : '(no output)');
    const note = `late result dropped (delegation already ${current}): ${detail}`;
    console.warn(`[Delegation] ${delegationId}: ${note}`);
    const existing = this.store.get(delegationId)?.error;
    this.store.update(delegationId, {
      error: existing ? `${existing} | ${note}` : note,
    });
  }

  /** notify 通道触发点（§7.1）；投递器缺省时仅发本地事件 */
  private async notify(delegationId: string): Promise<void> {
    const record = this.store.get(delegationId);
    if (!record || !isTerminalDelegationStatus(record.status)) return;
    // 去重（审查 P1-1）：先同步占位再投递，避免并发下同一委派单投两次
    if (record.notified) return;
    this.store.markNotified(delegationId);

    try {
      await this.config.notifier?.(record);
    } catch {
      // notify 失败不得影响委派单终态（poll 通道兜底）；
      // 这里吞掉投递异常：委派单已是终态，重试交由上层/分布式议题（O5）。
    }
  }
}

export { DelegationEvents };
