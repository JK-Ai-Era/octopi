/**
 * LLMReflector — LLM 驱动的反思器
 *
 * 用 LLM 评估执行质量，识别模式，提取经验教训。
 */

import { randomUUID } from 'node:crypto';
import type {
  Reflector,
  Assessment,
  Pattern,
  ExecutionRecord,
} from '../supervisor/types.js';
import type { ModelProvider, LLMRequest } from '../../../core/interfaces/model-provider.js';
import type { KnowledgeStore, KnowledgeEntry } from '../knowledge/types.js';

// ── 配置 ──

export interface LLMReflectorConfig {
  /** ModelProvider 实例 */
  model: ModelProvider;
  /** 使用的模型名 */
  modelName?: string;
  /** 知识存储（可选，用于自动存储经验） */
  knowledgeStore?: KnowledgeStore;
  /** 温度 */
  temperature?: number;
}

// ── LLMReflector ──

/**
 * LLM 驱动的反思器
 */
export class LLMReflector implements Reflector {
  readonly name = 'llm-reflector';
  private _model: ModelProvider;
  private _modelName?: string;
  private _knowledgeStore?: KnowledgeStore;
  private _temperature: number;

  constructor(config: LLMReflectorConfig) {
    this._model = config.model;
    this._modelName = config.modelName;
    this._knowledgeStore = config.knowledgeStore;
    this._temperature = config.temperature ?? 0.3;
  }

  /**
   * 评估一次执行的质量
   */
  async assess(record: ExecutionRecord): Promise<Assessment> {
    const prompt = `评估以下 Agent 执行的质量。

## 触发事件
类型: ${record.trigger.type}
内容: ${JSON.stringify(record.trigger.data ?? {}).slice(0, 500)}

## 执行结果
成功: ${record.result.success}
输出: ${JSON.stringify(record.result.output ?? '').slice(0, 500)}
错误: ${record.result.error ?? '无'}
耗时: ${record.result.durationMs}ms

返回 JSON:
{
  "quality": 0.0-1.0,
  "success": true/false,
  "issues": ["问题描述"],
  "suggestions": ["改进建议"]
}

只返回 JSON。`;

    const response = await this._callLLM(prompt);
    return this._parseAssessment(response, record.result.success);
  }

  /**
   * 从多次执行中识别模式
   */
  async detectPatterns(history: ExecutionRecord[]): Promise<Pattern[]> {
    if (history.length < 2) return [];

    const summary = history.map((r, i) =>
      `${i + 1}. [${r.trigger.type}] success=${r.result.success} duration=${r.result.durationMs}ms${r.result.error ? ` error=${r.result.error}` : ''}`
    ).join('\n');

    const prompt = `分析以下 Agent 执行历史，识别模式。

## 执行记录
${summary}

返回 JSON:
{
  "patterns": [
    {
      "type": "recurring_error | performance_degradation | user_preference | efficiency",
      "description": "模式描述",
      "confidence": 0.0-1.0
    }
  ]
}

如果没有明显模式，返回空 patterns 数组。
只返回 JSON。`;

    const response = await this._callLLM(prompt);
    const patterns = this._parsePatterns(response);

    // 自动存储高置信度的经验教训
    if (this._knowledgeStore) {
      for (const pattern of patterns) {
        if (pattern.confidence >= 0.7) {
          await this._knowledgeStore.store({
            type: pattern.type === 'recurring_error' ? 'lesson' : 'pattern',
            content: pattern.description,
            source: 'reflector',
            confidence: pattern.confidence,
            tags: [pattern.type],
          });
        }
      }
    }

    return patterns;
  }

  // ── 内部方法 ──

  private async _callLLM(prompt: string): Promise<string> {
    const request: LLMRequest = {
      messages: [
        { role: 'system', content: '你是一个执行质量分析器。返回结构化 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: this._temperature,
      maxTokens: 1000,
      model: this._modelName,
    };
    const response = await this._model.chat(request);
    return response.content;
  }

  private _parseAssessment(response: string, fallbackSuccess: boolean): Assessment {
    try {
      const json = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
      return {
        quality: typeof json.quality === 'number' ? json.quality : 0.5,
        success: typeof json.success === 'boolean' ? json.success : fallbackSuccess,
        issues: Array.isArray(json.issues) ? json.issues : [],
        suggestions: Array.isArray(json.suggestions) ? json.suggestions : [],
      };
    } catch {
      return { quality: 0.5, success: fallbackSuccess };
    }
  }

  private _parsePatterns(response: string): Pattern[] {
    try {
      const json = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
      const patterns = json.patterns ?? [];
      return patterns.map((p: Record<string, unknown>) => ({
        type: this._validatePatternType(p.type as string),
        description: (p.description as string) ?? '',
        confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
        relatedExecutionIds: [],
      }));
    } catch {
      return [];
    }
  }

  private _validatePatternType(type: string): Pattern['type'] {
    const valid: Pattern['type'][] = ['recurring_error', 'performance_degradation', 'user_preference', 'efficiency'];
    return valid.includes(type as Pattern['type']) ? (type as Pattern['type']) : 'efficiency';
  }
}
