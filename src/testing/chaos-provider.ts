/**
 * Chaos Provider — 故障注入
 *
 * 包装真实 ModelProvider，按规则注入故障：
 * - empty-response: 返回空内容
 * - timeout: 延迟后超时
 * - malformed: 返回畸形响应
 * - rate-limit: 模拟限流
 * - error: 直接抛错
 *
 * 用于测试框架的容错能力。
 */

import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '../core/interfaces/model-provider.js';
import type { ModelInfo } from '../core/types.js';

// ── 故障规则 ──

export type ChaosRule =
  | EmptyResponseRule
  | TimeoutRule
  | MalformedResponseRule
  | RateLimitRule
  | ErrorRule
  | TruncatedResponseRule
  | PartialToolCallRule;

export interface EmptyResponseRule {
  type: 'empty-response';
  /** 触发概率 0-1 */
  probability?: number;
  /** 第 N 次调用后触发（优先于 probability） */
  after?: number;
}

export interface TimeoutRule {
  type: 'timeout';
  /** 触发概率 0-1 */
  probability?: number;
  /** 超时延迟（ms） */
  delayMs?: number;
}

export interface MalformedResponseRule {
  type: 'malformed';
  /** 畸形类型 */
  variant: 'empty-json' | 'invalid-json' | 'missing-content' | 'null-fields';
  /** 触发概率 */
  probability?: number;
}

export interface RateLimitRule {
  type: 'rate-limit';
  /** 第 N 次调用后触发限流 */
  after: number;
  /** Retry-After 头部值（ms） */
  retryAfterMs?: number;
}

export interface ErrorRule {
  type: 'error';
  /** 错误消息 */
  message?: string;
  /** 触发概率 */
  probability?: number;
  /** HTTP 状态码 */
  status?: number;
}

export interface TruncatedResponseRule {
  type: 'truncated';
  /** 截断到前 N 个字符 */
  maxLength?: number;
  /** 触发概率 */
  probability?: number;
}

export interface PartialToolCallRule {
  type: 'partial-tool-call';
  /** 工具调用参数截断概率 */
  probability?: number;
}

// ── ChaosProvider ──

export interface ChaosProviderConfig {
  /** 故障规则列表 */
  rules: ChaosRule[];
  /** 是否记录注入历史 */
  logInjections?: boolean;
}

/**
 * ChaosProvider — 故障注入 Provider
 */
export class ChaosProvider implements ModelProvider {
  readonly name: string;
  private inner: ModelProvider;
  private rules: ChaosRule[];
  private logInjections: boolean;
  private callCount = 0;
  private injectionLog: Array<{ ts: number; callIndex: number; rule: string; detail?: string }> = [];

  constructor(inner: ModelProvider, config: ChaosProviderConfig) {
    this.inner = inner;
    this.name = `chaos(${inner.name})`;
    this.rules = config.rules;
    this.logInjections = config.logInjections ?? true;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const callIndex = this.callCount++;
    const rule = this.shouldInject(callIndex);

    if (rule) {
      this.logInjection(callIndex, rule);
      return this.injectFault(rule, request);
    }

    return this.inner.chat(request);
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    const callIndex = this.callCount++;
    const rule = this.shouldInject(callIndex);

    if (rule) {
      this.logInjection(callIndex, rule);
      yield* this.injectStreamFault(rule, request);
      return;
    }

    yield* this.inner.stream(request);
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  getModelInfo(modelName: string): ModelInfo | null {
    return this.inner.getModelInfo(modelName);
  }

  /**
   * 获取注入历史
   */
  getInjectionLog() {
    return [...this.injectionLog];
  }

  /**
   * 获取注入次数
   */
  getInjectionCount(): number {
    return this.injectionLog.length;
  }

  /**
   * 重置调用计数和日志
   */
  reset(): void {
    this.callCount = 0;
    this.injectionLog = [];
  }

  // ── 内部方法 ──

  private shouldInject(callIndex: number): ChaosRule | null {
    for (const rule of this.rules) {
      switch (rule.type) {
        case 'empty-response':
          if (rule.after !== undefined && callIndex >= rule.after) return rule;
          if (rule.probability !== undefined && Math.random() < rule.probability) return rule;
          break;

        case 'timeout':
          if (rule.probability !== undefined && Math.random() < rule.probability) return rule;
          break;

        case 'malformed':
          if (rule.probability !== undefined && Math.random() < rule.probability) return rule;
          break;

        case 'rate-limit':
          if (callIndex >= rule.after) return rule;
          break;

        case 'error':
          if (rule.probability !== undefined && Math.random() < rule.probability) return rule;
          break;

        case 'truncated':
          if (rule.probability !== undefined && Math.random() < rule.probability) return rule;
          break;

        case 'partial-tool-call':
          if (rule.probability !== undefined && Math.random() < rule.probability) return rule;
          break;
      }
    }
    return null;
  }

  private logInjection(callIndex: number, rule: ChaosRule): void {
    if (this.logInjections) {
      this.injectionLog.push({
        ts: Date.now(),
        callIndex,
        rule: rule.type,
      });
    }
  }

  private injectFault(rule: ChaosRule, request: LLMRequest): LLMResponse {
    switch (rule.type) {
      case 'empty-response':
        return { content: '', model: 'chaos', finishReason: 'stop' };

      case 'timeout': {
        const delay = (rule as TimeoutRule).delayMs ?? 30000;
        // 同步阻塞（模拟超时）
        const start = Date.now();
        while (Date.now() - start < delay) { /* busy wait */ }
        throw new Error('LLM request timed out (chaos)');
      }

      case 'malformed':
        return this.createMalformedResponse(rule.variant);

      case 'rate-limit': {
        const err = new Error(`Rate limited. Retry after ${rule.retryAfterMs ?? 2000}ms`);
        (err as any).status = 429;
        (err as any).retryAfterMs = rule.retryAfterMs ?? 2000;
        throw err;
      }

      case 'error': {
        const err = new Error(rule.message ?? 'Chaos error injected');
        if (rule.status) (err as any).status = rule.status;
        throw err;
      }

      case 'truncated': {
        const maxLen = rule.maxLength ?? 10;
        return { content: 'x'.repeat(maxLen), model: 'chaos', finishReason: 'stop' };
      }

      case 'partial-tool-call':
        return {
          content: '',
          toolCalls: [{ id: 'chaos-tc', name: '', arguments: {} }],
          model: 'chaos',
          finishReason: 'tool_calls',
        };

      default:
        return { content: '', model: 'chaos', finishReason: 'stop' };
    }
  }

  private async *injectStreamFault(rule: ChaosRule, request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
    switch (rule.type) {
      case 'empty-response':
        yield { type: 'content', content: '' };
        yield { type: 'done' };
        break;

      case 'timeout': {
        const delay = (rule as TimeoutRule).delayMs ?? 30000;
        await new Promise((_, reject) => setTimeout(() => reject(new Error('Stream timeout (chaos)')), delay));
        break;
      }

      case 'rate-limit': {
        const err = new Error(`Rate limited. Retry after ${rule.retryAfterMs ?? 2000}ms`);
        (err as any).status = 429;
        (err as any).retryAfterMs = rule.retryAfterMs ?? 2000;
        throw err;
      }

      case 'error':
        throw new Error(rule.message ?? 'Chaos stream error');

      case 'malformed':
        yield { type: 'content', content: '{"broken' };
        yield { type: 'done' };
        break;

      case 'truncated': {
        const maxLen = rule.maxLength ?? 10;
        yield { type: 'content', content: 'x'.repeat(maxLen) };
        // 不发 done chunk，模拟流中断
        break;
      }

      default:
        yield { type: 'content', content: '' };
        yield { type: 'done' };
    }
  }

  private createMalformedResponse(variant: string): LLMResponse {
    switch (variant) {
      case 'empty-json':
        return {} as LLMResponse;
      case 'invalid-json':
        return { content: '{"broken', model: 'chaos', finishReason: 'stop' };
      case 'missing-content':
        return { model: 'chaos', finishReason: 'stop' } as LLMResponse;
      case 'null-fields':
        return { content: null as any, model: null as any, finishReason: null as any };
      default:
        return { content: '', model: 'chaos', finishReason: 'stop' };
    }
  }
}
