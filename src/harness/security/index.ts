/**
 * @canonical 从 src/core/security-guard.ts 重新导出
 * @deprecated 原始文件仍在 core/，此模块建立 harness 规范路径
 */
export {
  DefaultSecurityGuard,
  isValidSecurityGuard,
  severityToAction,
} from '../../core/security-guard.js';
export type {
  SecurityGuard,
  SecurityCheckResult,
  SecurityViolation,
  SecurityViolationType,
  SecurityAction,
  BehaviorContext,
  SecurityGuardConfig,
} from '../../core/security-guard.js';
