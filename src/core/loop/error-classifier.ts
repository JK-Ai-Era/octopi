/**
 * 错误分类器 — LLM 协议层能力
 *
 * 职责：将原始错误分类为结构化的 ClassifiedError。
 * 包含 HTTP 状态码提取、Retry-After 解析、消息文本匹配。
 *
 * 这是协议层知识，留在 Core 层，每个 engine 消费者都需要。
 */

import type { ClassifiedError, ErrorReason } from './types.js';

/**
 * 分类错误
 *
 * 优先检查 HTTP 状态码（结构化信息），回退到消息文本匹配。
 */
export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // 1. 优先从 error 对象提取 HTTP 状态码
  const statusCode = extractStatusCode(err);
  let reason: ErrorReason = 'unknown';

  if (statusCode) {
    reason = classifyByStatusCode(statusCode);
  }

  // 2. 回退到消息文本匹配
  if (reason === 'unknown') {
    if (lower.includes('rate') && lower.includes('limit')) reason = 'rate_limit';
    else if (lower.includes('context') && lower.includes('length')) reason = 'context_length';
    else if (lower.includes('auth') || lower.includes('401')) reason = 'auth';
    else if (lower.includes('billing') || lower.includes('429')) reason = 'rate_limit';
    else if (lower.includes('timeout') || lower.includes('abort')) reason = 'timeout';
    else if (lower.includes('network') || lower.includes('fetch') || lower.includes('econnrefused')) reason = 'network';
    else if (lower.includes('500') || lower.includes('502') || lower.includes('503')) reason = 'server';
  }

  // 3. 提取 retry-after
  const retryAfterMs = extractRetryAfter(err);

  return { reason, message, originalError: err, retryAfterMs };
}

/**
 * 从 error 对象提取 HTTP 状态码
 */
function extractStatusCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'code', 'httpStatus']) {
    const val = e[key];
    if (typeof val === 'number' && val >= 100 && val < 600) return val;
    if (typeof val === 'string') {
      const n = parseInt(val, 10);
      if (n >= 100 && n < 600) return n;
    }
  }
  if (e.response && typeof e.response === 'object') {
    const resp = e.response as Record<string, unknown>;
    if (typeof resp.status === 'number') return resp.status;
  }
  return null;
}

/**
 * 根据 HTTP 状态码分类错误
 */
function classifyByStatusCode(status: number): ErrorReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  if (status === 400) return 'context_length'; // 400 常见于 context_length_exceeded
  return 'unknown';
}

/**
 * 提取 Retry-After 头部（毫秒）
 */
function extractRetryAfter(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  for (const key of ['retryAfter', 'retry-after', 'retryAfterMs']) {
    const val = e[key];
    if (typeof val === 'number' && val > 0) return val;
    if (typeof val === 'string') {
      const n = parseInt(val, 10);
      if (n > 0) return n * 1000;
    }
  }
  if (e.headers && typeof e.headers === 'object') {
    const headers = e.headers as Record<string, unknown>;
    const ra = headers['retry-after'] ?? headers['Retry-After'];
    if (typeof ra === 'string') {
      const n = parseInt(ra, 10);
      if (!isNaN(n)) return n * 1000;
    }
  }
  return undefined;
}
