/**
 * Security Module — 安全层统一导出
 *
 * Phase 3a: Shell 解析器 + 风险评估引擎 + 降级策略
 * Phase 3b: 安全守卫 DistributedAgentSpec
 */

// ── Types ──
export type {
  ParsedCommand,
  ParsedSegment,
  Redirect,
  Connector,
  RiskLevel,
  RiskFactor,
  SafeAlternative,
  RiskDecision,
  PathRisk,
  ToolCategory,
} from './risk-types.js';

// ── Shell Parser ──
export {
  parseShellCommand,
  getCommandNames,
  getRedirectTargets,
  hasCommand,
} from './shell-parser.js';

// ── Risk Evaluator ──
export { evaluateRisk, evaluateShellCommand } from './risk-evaluator.js';

// ── Degradation ──
export { suggestDegradation } from './degradation.js';

// ── ToolCallRiskPolicy ──
export type { ToolCallRiskPolicy } from '../../core/security-guard.js';
export type { DefaultToolCallRiskPolicyConfig } from './default-risk-policy.js';
export { DefaultToolCallRiskPolicy } from './default-risk-policy.js';

// ── Safety Agent Spec ──
export { buildSafetyGuardSpec, SAFETY_GUARD_SPEC } from './safety-agent-spec.js';

// ── Existing exports ──
export { CapabilityEnforcer, PluginTrustLevel } from './capability-enforcer.js';
export { SecurityPresets, getSecurityPolicy } from './policy.js';
export type { Environment } from './policy.js';
