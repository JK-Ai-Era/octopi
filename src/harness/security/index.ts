/**
 * Harness 安全守卫
 *
 * DefaultSecurityGuard 是 Harness 层策略实现。
 * SecurityGuard 接口定义在 Core 层。
 */

// ── DefaultSecurityGuard 实现（canonical 位置） ──
export { DefaultSecurityGuard } from './default-security-guard.js';

// ── Core 接口 re-export（方便 harness 消费者） ──
export { isValidSecurityGuard, severityToAction } from '../../core/security-guard.js';
export type {
  SecurityGuard,
  SecurityCheckResult,
  SecurityViolation,
  SecurityViolationType,
  SecurityAction,
  BehaviorContext,
  SecurityGuardConfig,
} from '../../core/interfaces/security-guard.js';
export type { ToolCallRiskPolicy } from '../../core/interfaces/security-guard.js';
