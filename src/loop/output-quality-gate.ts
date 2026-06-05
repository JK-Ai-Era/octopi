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

/**
 * 语法碎片检测模式
 *
 * 检测不完整的代码块特征
 */
const SYNTAX_FRAGMENT_PATTERNS = [
  // 不完整的 catch/else 块
  /\}\s*catch\s*\(/gi,
  /\}\s*else\s*\{/gi,
  /\}\s*else\s*if\s*\(/gi,
  
  // 不完整的条件语句
  /if\s*\([^)]*\)\s*\{/gi,
  /if\s*\([^)]*\)\s*$/gi, // 悬空的 if
  
  // 不完整的箭头函数
  /=>\s*\{/gi,
  /=>\s*$/gi, // 悬空的 =>
  
  // 不完整的函数声明
  /function\s+\w*\s*\(/gi,
  /function\s*\(/gi,
  
  // 不完整的变量声明
  /const\s+\w*\s*=/gi,
  /let\s+\w*\s*=/gi,
  /var\s+\w*\s*=/gi,
  
  // 不完整的模板字符串
  /`[^`]*`\s*\+/gi,
  /\$\{[^}]*\}/gi, // 模板字符串插值
  
  // 不完整的对象/数组
  /\.\.\.\s*\}/gi,
  /\.\.\.\s*\]/gi,
  /\[\s*\.\.\./gi,
  
  // 不完整的调用
  /\w+\s*\(\s*\.\.\./gi,
  /\w+\s*\(\s*$\s*\)/gi,
  
  // 异常的括号组合
  /\}\s*\}\s*\}/gi, // 多重闭合
  /\{\s*\{\s*\{/gi, // 多重开启
  /\}\s*\{/gi, // 无意义的括号对
];

/**
 * 崩溃特征模式
 *
 * 检测典型的崩溃输出特征
 */
const COLLAPSE_PATTERNS = [
  // 代码注释混杂
  /\/\/.*?\n.*?\/\/.*?\n.*?\/\/.*?\n/gi,
  
  // 中英混杂的代码片段
  /[\u4e00-\u9fa5]+\s*\{[\u4e00-\u9fa5]+\s*:/gi,
  /[\u4e00-\u9fa5]+\s*=>[\u4e00-\u9fa5]+/gi,
  
  // 无意义的字符组合
  /\w+\s*\?\s*\w+\s*\|\|/gi, // 异常的条件表达式
  /\w+\s*\|\|\s*\w+\s*::/gi, // 异常的类型表达式
  
  // 异常的标记组合
  /```.*?```.*?```.*?```/gi, // 多个不完整代码块
];

/**
 * 计算字符熵值
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
 * 检测重复片段
 *
 * 检测文本中的重复模式
 */
function detectRepetition(text: string): number {
  if (text.length < 50) return 0;
  
  // 检测连续重复的片段（至少20字符）
  const minRepeatLen = 20;
  let repeatCount = 0;
  
  // 滑动窗口检测
  for (let len = minRepeatLen; len <= Math.min(100, text.length / 3); len++) {
    for (let i = 0; i < text.length - len * 2; i++) {
      const fragment = text.slice(i, i + len);
      const nextFragment = text.slice(i + len, i + len * 2);
      if (fragment === nextFragment) {
        repeatCount++;
        break; // 找到一个就跳出
      }
    }
  }
  
  // 检测模式重复（相似的句子结构）
  const sentences = text.split(/[。！？.\n]/).filter(s => s.trim().length > 10);
  if (sentences.length > 3) {
    const uniqueSentences = new Set(sentences.map(s => s.trim().slice(0, 30)));
    const repetitionRatio = 1 - (uniqueSentences.size / sentences.length);
    return Math.max(repeatCount * 0.1, repetitionRatio);
  }
  
  return repeatCount * 0.1;
}

/**
 * 计算语法碎片密度
 *
 * 每100字符的语法碎片数量
 */
function calculateSyntaxFragmentDensity(text: string): number {
  if (text.length === 0) return 0;
  
  let fragmentCount = 0;
  const matchedPatterns: string[] = [];
  
  for (const pattern of SYNTAX_FRAGMENT_PATTERNS) {
    const matches = text.match(pattern) ?? [];
    fragmentCount += matches.length;
    if (matches.length > 0 && matches[0]) {
      matchedPatterns.push(matches[0]);
    }
  }
  
  // 密度 = 碎片数 / (文本长度 / 100)
  return fragmentCount / (text.length / 100);
}

/**
 * 检测崩溃特征
 *
 * 返回崩溃提示列表
 */
function detectCollapseFeatures(text: string): AnomalyHint[] {
  const hints: AnomalyHint[] = [];
  
  for (const pattern of COLLAPSE_PATTERNS) {
    const matches = text.match(pattern) ?? [];
    if (matches.length > 0) {
      hints.push({
        type: 'model_collapse',
        confidence: matches.length * 0.3,
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
  
  // 熵值惩罚
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
  checkTextOutput(text: string, config: QualityGateConfig): QualityCheckResult {
    if (!config.enabled) {
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
        confidence: syntaxFragmentDensity * 0.5,
        evidence: `High syntax fragment density: ${syntaxFragmentDensity.toFixed(2)}`,
      });
    }
    
    if (entropy < config.entropyThreshold) {
      anomalyHints.push({
        type: 'model_collapse',
        confidence: (config.entropyThreshold - entropy) * 0.3,
        evidence: `Low entropy: ${entropy.toFixed(2)}`,
      });
    }
    
    if (repetitionRatio > 0.3) {
      anomalyHints.push({
        type: 'repetition_loop',
        confidence: repetitionRatio,
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
    chunk: string,
    accumulated: string,
    config: QualityGateConfig
  ): QualityCheckResult {
    // 累积文本足够长才开始检测（至少500字符）
    if (accumulated.length < 500) {
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