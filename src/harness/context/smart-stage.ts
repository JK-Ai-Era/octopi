/**
 * SmartStage — 嵌入 LLM 决策点的上下文阶段
 *
 * 在 ContextPipeline 中嵌入独立的 LLM 逻辑，
 * 让上下文组装不再是纯确定性逻辑，而是可以"思考"的。
 *
 * 使用场景：
 * - 智能摘要：用 LLM 决定哪些历史消息值得保留
 * - 优先级排序：用 LLM 评估哪些上下文最相关
 * - 动态裁剪：用 LLM 决定在 token 有限时保留什么
 * - 上下文增强：用 LLM 生成补充信息
 *
 * 设计原则：
 * - LLM 调用是可选的，有 fallback 逻辑
 * - 不阻塞主链 — LLM 调用有超时
 * - 结果可缓存 — 避免重复调用
 * - 可观测 — 所有 LLM 调用通过 EventBus 事件追踪
 */

import type { Message } from '../../core/types.js';
import type { ModelProvider, LLMRequest } from '../../core/interfaces/model-provider.js';
import type { EventBus } from '../../core/event-bus.js';
import type { ContextStage, StageContext } from './pipeline.js';

// ── 配置 ──

/** SmartStage 配置 */
export interface SmartStageConfig {
  /** Stage 名称 */
  name: string;
  /** ModelProvider 实例 */
  model: ModelProvider;
  /** 使用的模型名 */
  modelName?: string;
  /** LLM 系统提示词 */
  systemPrompt: string;
  /** 生成决策 prompt 的函数 */
  buildPrompt: (ctx: StageContext) => string;
  /** 解析 LLM 响应并应用到上下文的函数 */
  applyDecision: (response: string, ctx: StageContext) => Promise<StageContext>;
  /** LLM 调用超时（毫秒，默认 5000） */
  timeoutMs?: number;
  /** 温度 */
  temperature?: number;
  /** 最大 token */
  maxTokens?: number;
  /** EventBus（可选，用于可观测性） */
  events?: EventBus;
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** Fallback 逻辑（LLM 调用失败时使用） */
  fallback?: (ctx: StageContext) => Promise<StageContext>;
}

// ── SmartStage ──

/**
 * SmartStage — 带 LLM 决策能力的上下文阶段
 *
 * 用法：
 * ```ts
 * const smartFilter = new SmartStage({
 *   name: 'smart-filter',
 *   model: myProvider,
 *   systemPrompt: '你是上下文过滤专家...',
 *   buildPrompt: (ctx) => `分析以下消息，决定哪些与当前任务相关...`,
 *   applyDecision: async (response, ctx) => {
 *     // 解析 LLM 响应，过滤消息
 *     return { ...ctx, messages: filteredMessages };
 *   },
 * });
 *
 * pipeline.addStage(smartFilter);
 * ```
 */
export class SmartStage implements ContextStage {
  readonly name: string;

  private _model: ModelProvider;
  private _modelName?: string;
  private _systemPrompt: string;
  private _buildPrompt: (ctx: StageContext) => string;
  private _applyDecision: (response: string, ctx: StageContext) => Promise<StageContext>;
  private _timeoutMs: number;
  private _temperature: number;
  private _maxTokens: number;
  private _events?: EventBus;
  private _enabled: boolean;
  private _fallback?: (ctx: StageContext) => Promise<StageContext>;

  // 缓存
  private _cache = new Map<string, { result: StageContext; timestamp: number }>();
  private _cacheTtlMs = 30_000; // 30 秒缓存

  constructor(config: SmartStageConfig) {
    this.name = config.name;
    this._model = config.model;
    this._modelName = config.modelName;
    this._systemPrompt = config.systemPrompt;
    this._buildPrompt = config.buildPrompt;
    this._applyDecision = config.applyDecision;
    this._timeoutMs = config.timeoutMs ?? 5000;
    this._temperature = config.temperature ?? 0.3;
    this._maxTokens = config.maxTokens ?? 1000;
    this._events = config.events;
    this._enabled = config.enabled ?? true;
    this._fallback = config.fallback;
  }

  async process(ctx: StageContext): Promise<StageContext> {
    if (!this._enabled) {
      return ctx;
    }

    // 检查缓存
    const cacheKey = this._buildCacheKey(ctx);
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this._cacheTtlMs) {
      return cached.result;
    }

    // 构建 prompt
    const prompt = this._buildPrompt(ctx);

    try {
      // 调用 LLM（带超时）
      const response = await this._callLLM(prompt);

      // 应用决策
      const result = await this._applyDecision(response, ctx);

      // 缓存结果
      this._cache.set(cacheKey, { result, timestamp: Date.now() });

      return result;
    } catch (err) {
      // LLM 调用失败，使用 fallback 或返回原始上下文
      this._emit('smart_stage.fallback', {
        name: this.name,
        error: err instanceof Error ? err.message : String(err),
      });

      if (this._fallback) {
        return this._fallback(ctx);
      }

      return ctx;
    }
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this._cache.clear();
  }

  /**
   * 设置缓存 TTL
   */
  setCacheTtl(ms: number): void {
    this._cacheTtlMs = ms;
  }

  /**
   * 启用/禁用
   */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  // ── 内部方法 ──

  private async _callLLM(prompt: string): Promise<string> {
    const request: LLMRequest = {
      messages: [
        { role: 'system', content: this._systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: this._temperature,
      maxTokens: this._maxTokens,
      model: this._modelName,
    };

    // 带超时的 LLM 调用
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`SmartStage LLM timeout after ${this._timeoutMs}ms`)), this._timeoutMs);
    });

    const llmPromise = this._model.chat(request);

    const response = await Promise.race([llmPromise, timeoutPromise]);
    return response.content;
  }

  private _buildCacheKey(ctx: StageContext): string {
    // 基于最后一条消息内容和消息数量构建缓存键
    const lastMsg = ctx.messages[ctx.messages.length - 1];
    const lastContent = lastMsg ? JSON.stringify(lastMsg.content).slice(0, 100) : '';
    return `${ctx.messages.length}:${lastContent}`;
  }

  private _emit(type: string, data?: Record<string, unknown>): void {
    if (this._events) {
      this._events.emit({
        type,
        timestamp: Date.now(),
        data,
      });
    }
  }
}

// ── 内置 SmartStage 工厂 ──

/**
 * 创建智能摘要 Stage
 *
 * 用 LLM 决定如何压缩长对话历史。
 */
export function createSmartSummarizer(
  model: ModelProvider,
  options?: {
    maxSummaryTokens?: number;
    events?: EventBus;
  },
): SmartStage {
  return new SmartStage({
    name: 'smart-summarizer',
    model,
    systemPrompt: `你是一个对话摘要专家。你的任务是将长对话历史压缩为简洁的摘要，保留关键信息：用户意图、重要决策、未完成的任务、关键上下文。`,
    buildPrompt: (ctx) => {
      const conversation = ctx.messages
        .map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
        .join('\n');
      return `请将以下对话压缩为简洁摘要（不超过 ${options?.maxSummaryTokens ?? 500} token）：\n\n${conversation}`;
    },
    applyDecision: async (response, ctx) => {
      // 用摘要替换历史消息，保留最后几条
      const recentMessages = ctx.messages.slice(-3);
      return {
        ...ctx,
        messages: [
          { role: 'system', content: `[对话摘要] ${response}`, timestamp: Date.now() },
          ...recentMessages,
        ],
      };
    },
    timeoutMs: 8000,
    events: options?.events,
  });
}

/**
 * 创建智能相关性过滤 Stage
 *
 * 用 LLM 决定哪些消息与当前任务最相关。
 */
export function createSmartRelevanceFilter(
  model: ModelProvider,
  options?: {
    keepRatio?: number;
    events?: EventBus;
  },
): SmartStage {
  const keepRatio = options?.keepRatio ?? 0.5;

  return new SmartStage({
    name: 'smart-relevance-filter',
    model,
    systemPrompt: `你是一个上下文相关性分析专家。分析每条消息与最新用户消息的相关性，返回需要保留的消息索引（JSON 数组）。`,
    buildPrompt: (ctx) => {
      const lastUserMsg = ctx.messages.filter(m => m.role === 'user').pop();
      const currentTask = lastUserMsg ? JSON.stringify(lastUserMsg.content) : '未知任务';

      const messageList = ctx.messages
        .map((m, i) => `[${i}][${m.role}]: ${typeof m.content === 'string' ? m.content.slice(0, 100) : '[structured]'}`)
        .join('\n');

      const keepCount = Math.max(2, Math.floor(ctx.messages.length * keepRatio));

      return `当前任务：${currentTask}\n\n消息列表：\n${messageList}\n\n请返回与当前任务最相关的 ${keepCount} 条消息的索引数组（JSON 格式，如 [0, 3, 5, 7]）。只返回 JSON，不要其他文字。`;
    },
    applyDecision: async (response, ctx) => {
      try {
        const jsonMatch = response.match(/\[[\d\s,]*\]/);
        if (!jsonMatch) return ctx;

        const indices = JSON.parse(jsonMatch[0]) as number[];
        const filtered = indices
          .filter(i => i >= 0 && i < ctx.messages.length)
          .sort((a, b) => a - b)
          .map(i => ctx.messages[i]);

        return { ...ctx, messages: filtered.length > 0 ? filtered : ctx.messages };
      } catch {
        return ctx;
      }
    },
    timeoutMs: 5000,
    events: options?.events,
  });
}
