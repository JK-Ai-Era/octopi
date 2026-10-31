/**
 * Delegation 模块统一导出
 *
 * @layer harness/collaboration/delegation
 * 设计权威：`arch/delegation.md`。
 *
 * L2 委派契约层：`DelegateRequest` / `DelegateResult`（纯 JSON，D1/D5）
 * + `AgentHandle`（D2 寻址）+ `DelegateTransport`（唯一分布式缝）。
 */

// ── 类型 ──
export type {
  Delegation,
  DelegationBudget,
  DelegationContextMode,
  DelegationEventType,
  DelegationParentRef,
  DelegationStatus,
  DelegationTarget,
  DelegateRequest,
  DelegateResult,
  AgentHandle,
} from './types.js';
export {
  DELEGATION_SCHEMA_VERSION,
  DELEGATION_TERMINAL_STATUSES,
  DELEGATION_ACTIVE_STATUSES,
  DelegationEvents,
  isTerminalDelegationStatus,
  isActiveDelegationStatus,
} from './types.js';

// ── Registry 契约 ──
export type {
  AgentRegistry,
  AgentInfo,
  AgentQuery,
  AgentRelation,
  AgentRelationType,
  AgentDelegationPolicy,
} from './registry-types.js';
export { AgentRegistryEvents } from './registry-types.js';

// ── Registry 实现 ──
export { DefaultAgentRegistry } from './registry.js';

// ── Store ──
export { DelegationStore, canTransitionDelegation } from './store.js';
export type {
  CreateDelegationInput,
  UpdateDelegationPatch,
  DelegationListFilter,
} from './store.js';

// ── Transport ──
export { InProcessTransport, assertCompatibleSchema } from './transport.js';
export type { DelegateTransport, LocalDelegateExecutor } from './transport.js';

// ── Child Run（子 Run 执行端口，D7/D8/D9） ──
export {
  RunnerChildRunPort,
  createChildRunExecutor,
  buildChildSystemPrompt,
  DEFAULT_DELEGATION_DIRECTIVE,
} from './child-run.js';
export type {
  ChildRunPort,
  ChildRunInput,
  ChildRunOutput,
  ChildRunTarget,
  RunnerChildRunPortConfig,
  DelegationPromptOptions,
} from './child-run.js';

// ── Service ──
export { DelegateService, DelegateResolutionError, intersectBudget } from './service.js';
export type {
  DispatchDelegationInput,
  DispatchResult,
  DelegateServiceConfig,
  DelegationNotifier,
} from './service.js';

// ── notify 通道（§7.1） ──
export {
  createDelegationNotifier,
  renderDelegationNotice,
  delegationReason,
} from './notifier.js';
export type { DelegationNotifierConfig } from './notifier.js';

// ── 生产接线 ──
export { wireDelegation, createDelegationRuntime } from './wiring.js';
export type {
  DelegatableAgent,
  DelegationRuntimeOptions,
  DelegationRuntime,
} from './wiring.js';
