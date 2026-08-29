/**
 * Core 层统一导出（Layer 1）
 *
 * 机制原语 + 接口契约 + 核心类型
 * 不包含任何策略实现。
 */

// ── 接口契约 ──
export * from './interfaces/index.js';

// ── 基础设施原语 ──
export * from './primitives/index.js';
export type { AgentEvent as EventBusAgentEvent } from './primitives/event-bus.js';

// ── 安全守卫 ──
export { isValidSecurityGuard, severityToAction } from './security-guard.js';
export type { SecurityGuard, SecurityCheckResult, SecurityViolation, SecurityViolationType, SecurityAction, BehaviorContext, SecurityGuardConfig, ToolCallRiskPolicy } from './interfaces/security-guard.js';

// ── 核心类型 ──
export * from './types/index.js';
export { getTextContent, hasMediaContent } from './types/messages.js';

// ── Loop 层 re-export（公共 API） ──
export { agentLoop, Agent, callModel, classifyError } from '../loop/index.js';
export type { AgentOptions, AgentContext, AgentTool, LoopToolResult, AgentLoopConfig, AgentLoopEvent, LoopObserver, ClassifiedError as LoopClassifiedError } from '../loop/index.js';

// ── Harness 策略 re-export（公共 API） ──
