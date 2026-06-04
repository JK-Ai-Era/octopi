/**
 * Error Classifier — 错误分类器
 *
 * 将 LLM 调用错误分类为可操作的类别，用于：
 * - 决定是否重试
 * - 选择重试策略（backoff / provider fallback / 压缩上下文）
 * - 生成用户友好的错误信息
 *
 * 基于 hermes-agent 的 classify_api_error 设计。
 */

import type { ClassifiedError, ErrorReason } from '../core/types.js';

/**
 * 错误分类函数
 *
 * @param error - 捕获的错误对象
 * @param provider - Provider 名称（可选，用于日志）
 * @param model - 模型名称（可选，用于日志）
 * @returns 分类后的错误
 */
export function classifyError(
  error: unknown,
  provider?: string,
  model?: string,
): ClassifiedError {
  const err = error as any;
  const statusCode: number | undefined = err?.status ?? err?.statusCode ?? err?.response?.status;
  const message: string =
    err?.message ?? err?.error?.message ?? String(error);

  // ── HTTP 状态码分类 ──

  // 429: Rate Limited
  if (statusCode === 429) {
    return {
      reason: 'rate_limit',
      provider,
      model,
      statusCode,
      retryAfterMs: parseRetryAfter(err),
      message,
      originalError: error,
    };
  }

  // 401/403: Auth
  if (statusCode === 401 || statusCode === 403) {
    return {
      reason: 'auth',
      provider,
      model,
      statusCode,
      message,
      originalError: error,
    };
  }

  // 402: Billing
  if (statusCode === 402) {
    return {
      reason: 'billing',
      provider,
      model,
      statusCode,
      message,
      originalError: error,
    };
  }

  // 413 or context_length_exceeded
  if (statusCode === 413 || /context.?length.?exceeded/i.test(message)) {
    return {
      reason: 'context_length',
      provider,
      model,
      statusCode,
      message,
      originalError: error,
    };
  }

  // 408: Timeout
  if (statusCode === 408 || /timeout/i.test(message)) {
    return {
      reason: 'timeout',
      provider,
      model,
      statusCode,
      message,
      originalError: error,
    };
  }

  // 5xx: Server error
  if (statusCode && statusCode >= 500) {
    return {
      reason: 'server',
      provider,
      model,
      statusCode,
      message,
      originalError: error,
    };
  }

  // ── 非 HTTP 错误分类 ──

  // Network errors
  if (
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|network.?error|connection.?lost|connection.?reset|connection.?closed/i.test(
      message,
    )
  ) {
    return {
      reason: 'network',
      provider,
      model,
      message,
      originalError: error,
    };
  }

  // Timeout (non-HTTP)
  if (/timeout|timed.?out/i.test(message)) {
    return {
      reason: 'timeout',
      provider,
      model,
      message,
      originalError: error,
    };
  }

  // ── 默认 ──
  return {
    reason: 'unknown',
    provider,
    model,
    statusCode,
    message,
    originalError: error,
  };
}

/**
 * 判断错误是否可重试
 */
export function isRetryable(error: ClassifiedError): boolean {
  switch (error.reason) {
    case 'rate_limit':
    case 'network':
    case 'timeout':
    case 'server':
      return true;
    case 'context_length':
      // context_length 需要压缩后重试，不是简单的 backoff 重试
      return false;
    case 'auth':
    case 'billing':
    case 'unknown':
      return false;
  }
}

/**
 * 从 error 对象中解析 Retry-After 头
 */
function parseRetryAfter(err: any): number | undefined {
  const headers = err?.response?.headers;
  if (!headers) return undefined;

  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (!isNaN(seconds)) {
    return Math.min(seconds * 1000, 120_000); // cap at 2 minutes
  }

  return undefined;
}

/**
 * 带 jitter 的 exponential backoff
 *
 * @param attempt - 当前重试次数（从 0 开始）
 * @param baseDelayMs - 基础延迟
 * @param maxDelayMs - 最大延迟
 * @returns 等待时间（毫秒）
 */
export function jitteredBackoff(
  attempt: number,
  baseDelayMs: number = 2000,
  maxDelayMs: number = 60_000,
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  // 加 0~25% 的随机抖动，防止 thundering herd
  const jitter = capped * (0.75 + Math.random() * 0.25);
  return Math.round(jitter);
}
