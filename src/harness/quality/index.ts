/**
 * Output Quality — 输出质量检测
 *
 * 从旧 loop/ 迁移到 Harness 层。
 * 通过 AgentEngine 的 afterModelCall 回调槽集成。
 */

export { OutputQualityGate, createOutputQualityGate } from './gate.js';
export { OutputErrorClassifier, createOutputErrorClassifier } from './classifier.js';
export type {
  QualityCheckResult,
  QualityGateConfig,
  AnomalyHint,
  QualityCheckDetails,
  AnomalyType,
  AnomalySeverity,
  RecoveryStrategyType,
  ErrorClassification,
  RecoveryConfig,
  RecoveryResult,
} from './types.js';
