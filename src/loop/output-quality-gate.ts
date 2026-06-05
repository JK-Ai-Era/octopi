/**
 * Output Quality Gate - 输出质量检测
 *
 * 检测 LLM 输出的质量问题：
 * - 模型崩溃（token 序列混乱）
 * - 截断
 * - 重复循环
 * - 格式错误
 */

import type {
  QualityCheckResult,
  QualityGateConfig,
  AnomalyHint,
  QualityCheckDetails,
} from './output-quality-types.js';

// ================================================================
// 辅助函数
// ================================================================

/**
 * 检测文本语言
 */
function detectLanguage(text: string): 'en' | 'zh' {
  const chineseChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  return chineseChars / text.length > 0.3 ? 'zh' : 'en';
}

/**
 * 简单哈希函数（用于 Rabin-Karp）
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// ================================================================
// 语法碎片检测模式（重构：只检测真正的碎片）
// ================================================================

/**
 * 语法碎片检测模式
 *
 * 检测不完整的代码块特征（真正的碎片，不是完整语法）
 */
const SYNTAX_FRAGMENT_PATTERNS = [
  // 悬空的 if（没有闭合括号或代码块）
  /if\s*\([^)]*$/gm,
  
  // 悬空的箭头函数（没有函数体）
  /=>\s*\{[^}]*$/gm,
  /=>\s*$/gm,
  
  // 不完整的函数声明（没有闭合）
  /function\s+\w*\s*\([^)]*\)\s*\{[^}]*$/gm,
  
  // 不完整的模板字符串（没有闭合反引号）
  /`[^`]*$/gm,
  
  // 不完整的对象/数组字面量
  /\{[^}]*$/gm,
  /\[[^\]]*$/gm,
  
  // 不完整的字符串（没有闭合引号）
  /"[^"]*$/gm,
  /'[^']*$/gm,
  
  // 不完整的注释
  /\/\*[^*]*\*([^/]|$)/gm,
  /\/\/[^\n]*$/gm,
  
  // 异常的括号组合（不匹配）
  /\([^)]*\)/g,  // 用于计数，实际检查在函数中
];

/**
 * 崩溃特征模式
 *
 * 检测典型的崩溃输出特征
 */
const COLLAPSE_PATTERNS = [
  // 中英混杂的代码片段（真正的崩溃特征）
  /[\u4e00-\u9fa5]+\s*\{[\u4e00-\u9fa5]+\s*:/gi,
  /[\u4e00-\u9fa5]+\s*=>[\u4e00-\u9fa5]+/gi,
  
  // 无意义的字符组合
  /\w+\s*\?\s*\w+\s*\|\|/gi, // 异常的条件表达式
  /\w+\s*\|\|\s*\w+\s*::/gi, // 异常的类型表达式
  
  // 异常的标记组合
  /```.*?```.*?```.*?```/gi, // 多个不完整代码块
];

// ================================================================
// 核心检测函数
// ================================================================

/**
 * 计算字符熵值（语言感知版本）
 *
 * 过低的熵值表示输出异常（字符分布过于集中）
 */
function calculateEntropy(text: string): number {
  if (text.length === 0) return 0;
  
  const charFreq = new Map<string, number>();
  for (const char of text) {
    charFreq.set(char, (charFreq.get(char) ?? 0) + 1);
  }
  
  let entropy = 0;
  const len = text.length;
  for (const [, freq] of charFreq) {
    const p = freq / len;
    entropy -= p * Math.log2(p);
  }
  
  return entropy;
}

/**
 * 计算相对熵值（考虑语言特性）
 *
 * 返回 0-1 之间的值，越低越异常
 */
function calculateRelativeEntropy(text: string): number {
  if (text.length === 0) return 1;
  
  const entropy = calculateEntropy(text);
  const lang = detectLanguage(text);
  
  // 中文文本熵值通常在 3-4 之间，英文在 4-5 之间
  const expectedEntropy = lang === 'zh' ? 3.5 : 4.5;
  
  // 相对熵 = 实际熵 / 期望熵
  return Math.min(1, entropy / expectedEntropy);
}

/**
 * 检测重复片段（优化版本 - Rabin-Karp 算法）
 *
 * 检测文本中的重复模式
 */
function detectRepetition(text: string): number {
  if (text.length < 50) return 0;
  
  // 对于超长文本，采样检测
  const maxSampleSize = 10000;
  const sampleText = text.length > maxSampleSize 
    ? text.slice(0, maxSampleSize / 2) + text.slice(text.length - maxSampleSize / 2)
    : text;
  
  const windowSize = 20;
  const seen = new Map<number, number>();
  let repeatCount = 0;
  
  // 使用 Rabin-Karp 算法检测重复
  for (let i = 0; i <= sampleText.length - windowSize; i++) {
    const hash = simpleHash(sampleText.slice(i, i + windowSize));
    const lastSeen = seen.get(hash);
    
    if (lastSeen !== undefined && i - lastSeen < windowSize * 2) {
      repeatCount++;
    }
    seen.set(hash, i);
  }
  
  // 检测模式重复（相似的句子结构）
  const sentences = sampleText.split(/[。！？.\n]/).filter(s => s.trim().length > 10);
  if (sentences.length > 3) {
    const uniqueSentences = new Set(sentences.map(s => s.trim().slice(0, 30)));
    const repetitionRatio = 1 - (uniqueSentences.size / sentences.length);
    return Math.max(repeatCount * 0.1, repetitionRatio);
  }
  
  return Math.min(1, repeatCount * 0.1);
}

/**
 * 移除 Markdown 代码块
 *
 * 代码块中的语法结构不应该被误判为碎片
 */
function removeCodeBlocks(text: string): string {
  // 移除围栏代码块 (```...```)
  let result = text.replace(/```[\s\S]*?```/g, '');
  
  // 移除行内代码 (`...`)
  result = result.replace(/`[^`]+`/g, '');
  
  return result;
}

/**
 * 计算语法碎片密度
 *
 * 每100字符的语法碎片数量
 */
function calculateSyntaxFragmentDensity(text: string): number {
  if (text.length === 0) return 0;
  
  // 移除代码块（代码块中的语法不应被检测）
  const cleanedText = removeCodeBlocks(text);
  
  // 对于超长文本，采样检测
  const maxSampleSize = 5000;
  const sampleText = cleanedText.length > maxSampleSize 
    ? cleanedText.slice(0, maxSampleSize / 2) + cleanedText.slice(cleanedText.length - maxSampleSize / 2)
    : cleanedText;
  
  // 如果清理后的文本太短，返回 0
  if (sampleText.length < 10) return 0;
  
  let fragmentCount = 0;
  
  // 检测悬空的语法结构
  const danglingPatterns = [
    /if\s*\([^)]*$/gm,           // 悬空的 if
    /=>\s*\{[^}]*$/gm,          // 悬空的箭头函数
    /=>\s*$/gm,                 // 悬空的 =>
    /function\s+\w*\s*\([^)]*\)\s*\{[^}]*$/gm,  // 不完整的函数
    /`[^`]*$/gm,                // 不完整的模板字符串
    /"[^"]*$/gm,                // 不完整的字符串
    /'[^']*$/gm,                // 不完整的字符串
  ];
  
  for (const pattern of danglingPatterns) {
    const matches = sampleText.match(pattern) ?? [];
    fragmentCount += matches.length;
  }
  
  // 检测括号不匹配
  const openBraces = (sampleText.match(/\{/g) ?? []).length;
  const closeBraces = (sampleText.match(/\}/g) ?? []).length;
  const openParens = (sampleText.match(/\(/g) ?? []).length;
  const closeParens = (sampleText.match(/\)/g) ?? []).length;
  const openBrackets = (sampleText.match(/\[/g) ?? []).length;
  const closeBrackets = (sampleText.match(/\]/g) ?? []).length;
  
  // 括号不匹配也视为碎片
  const braceMismatch = Math.abs(openBraces - closeBraces);
  const parenMismatch = Math.abs(openParens - closeParens);
  const bracketMismatch = Math.abs(openBrackets - closeBrackets);
  
  fragmentCount += braceMismatch + parenMismatch + bracketMismatch;
  
  // 密度 = 碎片数 / (文本长度 / 100)
  return fragmentCount / (sampleText.length / 100);
}

/**
 * 检测崩溃特征
 *
 * 返回崩溃提示列表
 */
function detectCollapseFeatures(text: string): AnomalyHint[] {
  const hints: AnomalyHint[] = [];
  
  // 对于超长文本，采样检测
  const maxSampleSize = 5000;
  const sampleText = text.length > maxSampleSize 
    ? text.slice(0, maxSampleSize / 2) + text.slice(text.length - maxSampleSize / 2)
    : text;
  
  for (const pattern of COLLAPSE_PATTERNS) {
    const matches = sampleText.match(pattern) ?? [];
    if (matches.length > 0) {
      hints.push({
        type: 'model_collapse',
        confidence: Math.min(1, matches.length * 0.3),
        evidence: matches[0]?.slice(0, 100) ?? 'unknown',
      });
    }
  }
  
  return hints;
}

/**
 * 计算平均句子长度
 */
function calculateAvgSentenceLength(text: string): number {
  const sentences = text.split(/[。！？.!?\n]/).filter(s => s.trim().length > 0);
  if (sentences.length === 0) return text.length;
  
  const totalLen = sentences.reduce((sum, s) => sum + s.length, 0);
  return totalLen / sentences.length;
}

/**
 * 综合质量评分计算
 */
function calculateQualityScore(
  details: QualityCheckDetails,
  config: QualityGateConfig
): number {
  // 基础评分 = 1.0
  let score = 1.0;
  
  // 语法碎片密度惩罚
  if (details.syntaxFragmentDensity > config.syntaxFragmentThreshold) {
    const penalty = (details.syntaxFragmentDensity - config.syntaxFragmentThreshold) * 0.5;
    score -= Math.min(penalty, 0.4);
  }
  
  // 熵值惩罚（使用相对熵）
  if (details.entropy < config.entropyThreshold) {
    const penalty = (config.entropyThreshold - details.entropy) * 0.1;
    score -= Math.min(penalty, 0.3);
  }
  
  // 重复惩罚
  score -= details.repetitionRatio * 0.3;
  
  // 平均句子长度惩罚（异常短表示碎片化）
  if (details.avgSentenceLength < 10 && details.avgSentenceLength > 0) {
    score -= 0.2;
  }
  
  return Math.max(0, Math.min(1, score));
}

/**
 * 验证配置参数
 */
function validateConfig(config: unknown): config is QualityGateConfig {
  if (typeof config !== 'object' || config === null) {
    return false;
  }
  
  const c = config as Record<string, unknown>;
  
  // 检查必需字段
  if (typeof c.enabled !== 'boolean') return false;
  if (typeof c.anomalyThreshold !== 'number') return false;
  if (typeof c.syntaxFragmentThreshold !== 'number') return false;
  if (typeof c.entropyThreshold !== 'number') return false;
  
  // 检查数值范围
  if (c.anomalyThreshold < 0 || c.anomalyThreshold > 1) return false;
  if (c.syntaxFragmentThreshold < 0) return false;
  if (c.entropyThreshold < 0) return false;
  
  return true;
}

/**
 * 创建默认结果
 */
function createDefaultResult(): QualityCheckResult {
  return {
    isAnomalous: false,
    qualityScore: 1.0,
    anomalyHints: [],
    details: {
      syntaxFragmentDensity: 0,
      repetitionRatio: 0,
      entropy: 0,
      avgSentenceLength: 0,
    },
  };
}

// ================================================================
// OutputQualityGate 实现
// ================================================================

/**
 * 输出质量检测器
 */
export class OutputQualityGate {
  /**
   * 检测文本输出质量
   */
  checkTextOutput(text: unknown, config: unknown): QualityCheckResult {
    // 输入验证
    if (typeof text !== 'string') {
      return createDefaultResult();
    }
    
    if (!validateConfig(config)) {
      throw new TypeError('Invalid QualityGateConfig: must have enabled (boolean), anomalyThreshold (0-1), syntaxFragmentThreshold (number), entropyThreshold (number)');
    }
    
    if (!config.enabled) {
      return createDefaultResult();
    }
    
    // 空字符串返回默认结果
    if (text.length === 0) {
      return createDefaultResult();
    }
    
    // 计算各项指标
    const syntaxFragmentDensity = calculateSyntaxFragmentDensity(text);
    const entropy = calculateEntropy(text);
    const repetitionRatio = detectRepetition(text);
    const avgSentenceLength = calculateAvgSentenceLength(text);
    
    const details: QualityCheckDetails = {
      syntaxFragmentDensity,
      entropy,
      repetitionRatio,
      avgSentenceLength,
    };
    
    // 检测崩溃特征
    const collapseHints = detectCollapseFeatures(text);
    
    // 综合评分
    const qualityScore = calculateQualityScore(details, config);
    
    // 判断是否异常
    const isAnomalous = qualityScore < config.anomalyThreshold || collapseHints.length > 0;
    
    // 构建异常提示
    const anomalyHints: AnomalyHint[] = [...collapseHints];
    
    // 根据各项指标添加提示
    if (syntaxFragmentDensity > config.syntaxFragmentThreshold) {
      anomalyHints.push({
        type: 'model_collapse',
        confidence: Math.min(1, syntaxFragmentDensity * 0.5),
        evidence: `High syntax fragment density: ${syntaxFragmentDensity.toFixed(2)}`,
      });
    }
    
    if (entropy < config.entropyThreshold) {
      anomalyHints.push({
        type: 'model_collapse',
        confidence: Math.min(1, (config.entropyThreshold - entropy) * 0.3),
        evidence: `Low entropy: ${entropy.toFixed(2)}`,
      });
    }
    
    if (repetitionRatio > 0.3) {
      anomalyHints.push({
        type: 'repetition_loop',
        confidence: Math.min(1, repetitionRatio),
        evidence: `High repetition ratio: ${repetitionRatio.toFixed(2)}`,
      });
    }
    
    return {
      isAnomalous,
      qualityScore,
      anomalyHints,
      details,
    };
  }
  
  /**
   * 检测流式 chunk 质量（增量检测）
   *
   * 当累积文本较长时开始检测，避免误判正常输出
   */
  checkStreamChunk(
    chunk: unknown,
    accumulated: unknown,
    config: unknown
  ): QualityCheckResult {
    // 输入验证
    if (typeof chunk !== 'string' || typeof accumulated !== 'string') {
      return createDefaultResult();
    }
    
    if (!validateConfig(config)) {
      throw new TypeError('Invalid QualityGateConfig');
    }
    
    // 累积文本足够长才开始检测（至少500字符）
    if (accumulated.length < 500) {
      return createDefaultResult();
    }
    
    return this.checkTextOutput(accumulated, config);
  }
}

// ================================================================
// 工厂函数
// ================================================================

/**
 * 创建输出质量检测器
 */
export function createOutputQualityGate(): OutputQualityGate {
  return new OutputQualityGate();
}
