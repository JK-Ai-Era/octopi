/**
 * Output Quality Gate 类型定义
 *
 * 用于检测 LLM 输出的质量问题（崩溃、截断、重复等）
 */

// ================================================================
// 异常类型
// ================================================================

/**
 * 异常输出类型
 */
export type AnomalyType =
  | 'model_collapse'    // token 序列崩溃（代码碎片混杂）
  | 'truncation'        // 输出截断
  | 'repetition_loop'   // 重复循环
  | 'format_error'      // 格式错误
  | 'unknown';          // 未识别

/**
 * 异常严重程度
 */
export type AnomalySeverity = 'minor' | 'moderate' | 'severe';

/**
 * 恢复策略类型
 */
export type RecoveryStrategyType =
  | 'retry'     // 重试
  | 'fallback'  // 切换备用模型
  | 'abort'     // 报错终止
  | 'degrade';  // 降级模式

// ================================================================
// 检测结果
// ================================================================

/**
 * 异常提示（供分类器使用）
 */
export interface AnomalyHint {
  /** 异常类型 */
  type: AnomalyType;
  /** 置信度 (0-1) */
  confidence: number;
  /** 具体证据片段 */
  evidence: string;
}

/**
 * 检测详情
 */
export interface QualityCheckDetails {
  /** 代码语法碎片密度（每100字符的碎片数） */
  syntaxFragmentDensity: number;
  /** 重复片段比例 */
  repetitionRatio: number;
  /** 字符熵值（过低表示异常） */
  entropy: number;
  /** 平均句子长度（异常低表示碎片化） */
  avgSentenceLength: number;
}

/**
 * 输出质量检测结果
 */
export interface QualityCheckResult {
  /** 是否检测到异常 */
  isAnomalous: boolean;
  /** 质量评分 (0-1, 越低越异常) */
  qualityScore: number;
  /** 异常类型提示 */
  anomalyHints: AnomalyHint[];
  /** 检测详情 */
  details: QualityCheckDetails;
}

// ================================================================
// 配置
// ================================================================

/**
 * 检测级别
 */
export type CheckLevel = 'basic' | 'strict' | 'semantic';

/**
 * 输出质量检测配置
 */
export interface QualityGateConfig {
  /** 是否启用检测 */
  enabled: boolean;
  /** 检测级别 */
  checkLevel: CheckLevel;
  /** 异常阈值（低于此值判定为异常） */
  anomalyThreshold: number;
  /** 语法碎片密度阈值 */
  syntaxFragmentThreshold: number;
  /** 熵值阈值（过低表示异常） */
  entropyThreshold: number;
}

/**
 * 默认配置
 */
export const DEFAULT_QUALITY_GATE_CONFIG: QualityGateConfig = {
  enabled: true,
  checkLevel: 'basic',
  anomalyThreshold: 0.6,
  syntaxFragmentThreshold: 0.3,
  entropyThreshold: 3.0,
};

// ================================================================
// 异常分类
// ================================================================

/**
 * 异常分类结果
 */
export interface ErrorClassification {
  /** 异常类型 */
  type: AnomalyType;
  /** 分类置信度 */
  confidence: number;
  /** 严重程度 */
  severity: AnomalySeverity;
  /** 推荐恢复策略 */
  recommendedStrategy: RecoveryStrategyType;
  /** 分类依据 */
  evidence: string[];
}

/**
 * 分类上下文
 */
export interface ClassificationContext {
  /** LLM finish_reason */
  finishReason?: string;
  /** 工具调用列表 */
  toolCalls?: unknown[];
  /** 当前迭代次数 */
  iterationCount: number;
  /** 之前的错误分类 */
  previousErrors: ErrorClassification[];
}

// ================================================================
// 恢复配置
// ================================================================

/**
 * 恢复策略配置
 */
export interface RecoveryConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 备用模型列表（按优先级） */
  fallbackModels: string[];
  /** 策略优先级配置 */
  strategyPriority: Partial<Record<AnomalyType, RecoveryStrategyType[]>>;
  /** 降级模式配置 */
  degradeConfig: {
    disableTools: boolean;
    maxTokens?: number;
  };
}

/**
 * 默认恢复配置
 */
export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
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

/**
 * 恢复执行结果
 */
export interface RecoveryResult {
  /** 是否成功恢复 */
  success: boolean;
  /** 使用的策略 */
  strategyUsed: RecoveryStrategyType;
  /** 重试次数 */
  retryCount: number;
  /** 最终输出（如果成功） */
  finalOutput?: unknown;
  /** 错误信息（如果失败） */
  error?: Error;
}

/**
 * 恢复上下文
 */
export interface RecoveryContext {
  /** 原始请求 */
  request: unknown;
  /** 当前模型 */
  currentModel: string;
  /** Agent 配置 */
  agentConfig: unknown;
  /** 会话上下文 */
  sessionContext: unknown;
}