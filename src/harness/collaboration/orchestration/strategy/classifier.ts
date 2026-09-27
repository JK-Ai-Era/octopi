/**
 * RuleTaskClassifier — 规则驱动的任务分类器
 *
 * 用关键词和规则快速分类，不需要 LLM 调用。
 */

import type { TaskClassifier, TaskClassification, TaskCategory, TaskComplexity } from './types.js';

/** 关键词 → 类型映射 */
const CATEGORY_KEYWORDS: Record<TaskCategory, string[]> = {
  question: ['什么', '怎么', '如何', '为什么', '吗', '?', '？', 'what', 'how', 'why', 'is', 'are', 'do', 'does'],
  lookup: ['查', '搜索', '找', 'search', 'find', 'look up', '查询', '告诉我'],
  analysis: ['分析', '评估', '对比', '比较', 'analyze', 'evaluate', 'compare', '审查', 'review'],
  creation: ['写', '生成', '创作', '设计', '写一个', 'create', 'generate', 'write', 'design', '帮我写'],
  coding: ['代码', '函数', 'bug', '重构', '实现', 'code', 'function', 'refactor', 'implement', 'debug', '修复', 'fix'],
  planning: ['计划', '规划', '安排', '拆解', '分解', 'plan', 'schedule', 'break down', '步骤'],
  conversation: ['你好', 'hi', 'hello', '谢谢', 'thanks', '好的', 'ok', '嗯'],
  unknown: [],
};

/** 复杂度信号 */
const COMPLEXITY_SIGNALS = {
  simple: {
    maxWords: 20,
    keywords: ['谢谢', '好的', 'ok', 'hi', 'hello', '是', '不是', '对', '不对', '你好', '嗨', '吗', '呢', '嗯', '哈哈', '早上好', '晚安', '怎么样', '是什么', '多少', '几天'],
  },
  complex: {
    keywords: ['重构', '设计', '架构', '系统', '完整', '全面', '详细', 'refactor', 'design', 'architecture', 'system', '所有'],
    minWords: 30,
  },
};

export class RuleTaskClassifier implements TaskClassifier {
  readonly name = 'rule-classifier';

  async classify(input: string, context?: Record<string, unknown>): Promise<TaskClassification> {
    const lower = input.toLowerCase();
    const words = input.split(/\s+/).length;

    // 分类
    const category = this._classifyCategory(lower);

    // 复杂度
    const complexity = this._classifyComplexity(lower, words);

    // 是否需要工具
    const needsTools = category === 'lookup' || category === 'coding' || lower.includes('文件') || lower.includes('file');

    // 是否需要规划
    const needsPlanning = complexity === 'complex' && (category === 'planning' || category === 'coding' || category === 'creation');

    // 置信度
    const confidence = category === 'unknown' ? 0.3 : (complexity === 'moderate' ? 0.6 : 0.8);

    return {
      category,
      complexity,
      confidence,
      needsTools,
      needsPlanning,
    };
  }

  private _classifyCategory(input: string): TaskCategory {
    let bestCategory: TaskCategory = 'unknown';
    let bestScore = 0;

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      const score = keywords.filter(kw => input.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestCategory = category as TaskCategory;
      }
    }

    return bestCategory;
  }

  private _classifyComplexity(input: string, words: number): TaskComplexity {
    const charCount = input.length;
    // 短问题（<=30字符）且有问号 → simple
    if (charCount <= 30 && (input.includes('?') || input.includes('？') || input.includes('吗') || input.includes('呢'))) {
      return 'simple';
    }
    // 简单关键词命中 → simple
    if (charCount <= 50) {
      const simpleHits = COMPLEXITY_SIGNALS.simple.keywords.filter(kw => input.includes(kw)).length;
      if (simpleHits > 0) return 'simple';
    }

    // 复杂信号
    const complexHits = COMPLEXITY_SIGNALS.complex.keywords.filter(kw => input.includes(kw)).length;
    if (complexHits >= 2 || words >= COMPLEXITY_SIGNALS.complex.minWords) return 'complex';

    return 'moderate';
  }
}
