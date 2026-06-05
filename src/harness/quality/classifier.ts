/**
 * Output Error Classifier - 异常分类器
 *
 * 根据质量检测结果和上下文信息，分类异常类型并推荐恢复策略
 */

import type {
  QualityCheckResult,
  ErrorClassification,
  ClassificationContext,
  AnomalyType,
  AnomalySeverity,
  RecoveryStrategyType,
  RecoveryConfig,
} from './types.js';

// ================================================================
// 辅助函数
// ================================================================

/**
 * 验证质量检测结果
 */
function validateQualityResult(result: unknown): result is QualityCheckResult {
  if (typeof result !== 'object' || result === null) {
    return false;
  }
  
  const r = result as Record<string, unknown>;
  
  return (
    typeof r.isAnomalous === 'boolean' &&
    typeof r.qualityScore === 'number' &&
    Array.isArray(r.anomalyHints) &&
    typeof r.details === 'object' && r.details !== null
  );
}

/**
 * 验证分类上下文
 */
function validateContext(context: unknown): context is ClassificationContext {
  if (typeof context !== 'object' || context === null) {
    return false;
  }
  
  const c = context as Record<string, unknown>;
  
  if (typeof c.iterationCount !== 'number' || c.iterationCount < 0) {
    return false;
  }
  
  if (!Array.isArray(c.previousErrors)) {
    return false;
  }
  
  return true;
}

/**
 * 创建默认分类结果
 */
function createDefaultClassification(): ErrorClassification {
  return {
    type: 'unknown',
    confidence: 0,
    severity: 'minor',
    recommendedStrategy: 'retry',
    evidence: ['Invalid input'],
  };
}

// ================================================================
// 核心分类函数
// ================================================================

/**
 * 判断异常严重程度
 *
 * 基于质量评分和异常提示数量
 */
function determineSeverity(
  qualityScore: number,
  anomalyHints: QualityCheckResult['anomalyHints']
): AnomalySeverity {
  // 评分极低或多个崩溃提示 → severe
  if (qualityScore < 0.3 || anomalyHints.filter(h => h.type === 'model_collapse').length >= 2) {
    return 'severe';
  }
  
  // 评分中等或有崩溃提示 → moderate
  if (qualityScore < 0.5 || anomalyHints.some(h => h.type === 'model_collapse')) {
    return 'moderate';
  }
  
  // 其他 → minor
  return 'minor';
}

/**
 * 根据异常提示确定主要异常类型
 */
function determineAnomalyType(
  anomalyHints: QualityCheckResult['anomalyHints'],
  finishReason?: string
): AnomalyType {
  // finish_reason 为 length → truncation
  if (finishReason === 'length') {
    return 'truncation';
  }
  
  // 按置信度排序异常提示
  const sortedHints = [...anomalyHints].sort((a, b) => b.confidence - a.confidence);
  
  // 最高置信度的提示类型
  if (sortedHints.length > 0) {
    const topHint = sortedHints[0];
    if (topHint && topHint.confidence >= 0.5) {
      return topHint.type;
    }
  }
  
  // 默认未知
  return 'unknown';
}

/**
 * 推荐恢复策略
 *
 * 基于异常类型和严重程度
 */
function recommendStrategy(
  type: AnomalyType,
  severity: AnomalySeverity,
  config: RecoveryConfig,
  previousErrors: ErrorClassification[]
): RecoveryStrategyType {
  // 获取策略优先级配置
  const priorityList = config.strategyPriority[type] ?? ['retry', 'abort'];
  
  // 如果之前已经多次失败，直接 abort 或 degrade
  const sameTypeErrors = previousErrors.filter(e => e.type === type);
  if (sameTypeErrors.length >= config.maxRetries) {
    return severity === 'severe' ? 'abort' : 'degrade';
  }
  
  // 根据严重程度调整策略
  if (severity === 'severe') {
    // 严重崩溃优先 fallback 或 abort
    if (priorityList.includes('fallback') && config.fallbackModels.length > 0) {
      return 'fallback';
    }
    return 'abort';
  }
  
  // moderate 崩溃：如果有 fallback 模型，优先 fallback
  if (severity === 'moderate' && 
      priorityList.includes('fallback') && 
      config.fallbackModels.length > 0) {
    return 'fallback';
  }
  
  // 其他情况按优先级选择
  return priorityList[0] ?? 'retry';
}

/**
 * 收集分类依据
 */
function collectEvidence(
  qualityResult: QualityCheckResult,
  context: ClassificationContext
): string[] {
  const evidence: string[] = [];
  
  // 质量评分
  evidence.push(`Quality score: ${qualityResult.qualityScore.toFixed(2)}`);
  
  // 检测详情
  if (qualityResult.details.syntaxFragmentDensity > 0) {
    evidence.push(`Syntax fragment density: ${qualityResult.details.syntaxFragmentDensity.toFixed(2)}`);
  }
  if (qualityResult.details.entropy > 0) {
    evidence.push(`Entropy: ${qualityResult.details.entropy.toFixed(2)}`);
  }
  if (qualityResult.details.repetitionRatio > 0) {
    evidence.push(`Repetition ratio: ${qualityResult.details.repetitionRatio.toFixed(2)}`);
  }
  
  // 异常提示
  for (const hint of qualityResult.anomalyHints) {
    if (hint.evidence) {
      evidence.push(`[${hint.type}] ${hint.evidence.slice(0, 50)}`);
    }
  }
  
  // finish_reason
  if (context.finishReason) {
    evidence.push(`Finish reason: ${context.finishReason}`);
  }
  
  // 工具调用
  if (context.toolCalls && context.toolCalls.length > 0) {
    evidence.push(`Tool calls: ${context.toolCalls.length}`);
  }
  
  // 迭代次数
  evidence.push(`Iteration: ${context.iterationCount}`);
  
  // 之前的错误
  if (context.previousErrors.length > 0) {
    evidence.push(`Previous errors: ${context.previousErrors.length}`);
  }
  
  return evidence;
}

// ================================================================
// ErrorClassifier 实现
// ================================================================

/**
 * Output 异常分类器
 */
export class OutputErrorClassifier {
  private config: RecoveryConfig;
  
  constructor(config?: RecoveryConfig) {
    this.config = config ?? {
      maxRetries: 2,
      fallbackModels: [],
      strategyPriority: {
        model_collapse: ['fallback', 'retry', 'abort'],
        truncation: ['retry', 'abort'],
        repetition_loop: ['retry', 'fallback', 'degrade'],
        format_error: ['retry', 'abort'],
      },
      degradeConfig: {
        disableTools: true,
        maxTokens: 500,
      },
    };
  }
  
  /**
   * 分类异常
   */
  classify(
    qualityResult: unknown,
    context: unknown
  ): ErrorClassification {
    // 输入验证
    if (!validateQualityResult(qualityResult)) {
      return createDefaultClassification();
    }
    
    if (!validateContext(context)) {
      return createDefaultClassification();
    }
    
    // 如果不是异常，返回默认分类
    if (!qualityResult.isAnomalous) {
      return {
        type: 'unknown',
        confidence: 0,
        severity: 'minor',
        recommendedStrategy: 'retry',
        evidence: collectEvidence(qualityResult, context),
      };
    }
    
    // 确定异常类型
    const type = determineAnomalyType(qualityResult.anomalyHints, context.finishReason);
    
    // 确定严重程度
    const severity = determineSeverity(qualityResult.qualityScore, qualityResult.anomalyHints);
    
    // 计算置信度（基于异常提示和评分）
    let confidence = 1 - qualityResult.qualityScore;
    if (qualityResult.anomalyHints.length > 0) {
      const maxHintConfidence = Math.max(...qualityResult.anomalyHints.map(h => h.confidence));
      confidence = Math.max(confidence, maxHintConfidence);
    }
    
    // 推荐恢复策略
    const recommendedStrategy = recommendStrategy(
      type,
      severity,
      this.config,
      context.previousErrors
    );
    
    // 收集依据
    const evidence = collectEvidence(qualityResult, context);
    
    return {
      type,
      confidence: Math.min(1, confidence),
      severity,
      recommendedStrategy,
      evidence,
    };
  }
}

// ================================================================
// 工厂函数
// ================================================================

/**
 * 创建 Output 异常分类器
 */
export function createOutputErrorClassifier(config?: RecoveryConfig): OutputErrorClassifier {
  return new OutputErrorClassifier(config);
}
