/**
 * 错误分类器 — LLM 协议层能力
 *
 * 职责：将原始错误分类为结构化的 ClassifiedError。
 * 包含 HTTP 状态码提取、Retry-After 解析、消息文本匹配。
 *
 * 分层：类型合同（ErrorReason / ClassifiedError）在 Core `error-strategy.ts`；
 * **分类实现在 Loop**（协议边界）；决策策略在 Harness ErrorStrategy。
 * Core 不持有 HTTP/provider 模式匹配。
 */

import type { ClassifiedError, ErrorReason } from './types.js';

/**
 * 分类错误
 *
 * 优先检查 HTTP 状态码（结构化信息），回退到消息文本匹配。
 * 文本匹配会拼接 `message` / `cause` / `code`，覆盖 undici 的
 * `TypeError: terminated`（cause: other side closed）一类被包装的断连错误。
 */
export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = collectErrorText(err);

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
    else if (isConnectionDropText(lower)) reason = 'network';
    else if (lower.includes('network') || lower.includes('fetch') || lower.includes('econnrefused')) reason = 'network';
    else if (lower.includes('500') || lower.includes('502') || lower.includes('503')) reason = 'server';
  }

  // 3. 提取 retry-after
  const retryAfterMs = extractRetryAfter(err);

  return { reason, message, originalError: err, retryAfterMs };
}

/**
 * 拼接错误对象的 message / cause / code，供文本分类使用。
 *
 * undici 会把底层 socket 错误包进 `cause`，只看 message 会把
 * `TypeError: terminated` 误判成 unknown。
 */
function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (value == null || depth > 3 || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) {
      parts.push(value.message);
      const code = (value as { code?: unknown }).code;
      if (typeof code === 'string') parts.push(code);
      visit(value.cause, depth + 1);
      return;
    }
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value === 'object') {
      const code = (value as { code?: unknown }).code;
      if (typeof code === 'string') parts.push(code);
      const message = (value as { message?: unknown }).message;
      if (typeof message === 'string') parts.push(message);
    }
  };

  visit(err, 0);
  return parts.join(' ').toLowerCase();
}

/**
 * 对端断连 / socket 中断特征（undici fetch、Node http）。
 *
 * 这些错误在重试后经常自愈，必须归到 network（可重试），不能落到 unknown。
 */
function isConnectionDropText(lower: string): boolean {
  return (
    lower.includes('terminated') ||
    lower.includes('other side closed') ||
    lower.includes('socket hang up') ||
    lower.includes('socket disconnected') ||
    lower.includes('econnreset') ||
    lower.includes('econnaborted') ||
    lower.includes('connection reset') ||
    lower.includes('connection closed') ||
    lower.includes('premature close') ||
    lower.includes('und_err_socket') ||
    lower.includes('und_err_body') ||
    lower.includes('socketerror')
  );
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
