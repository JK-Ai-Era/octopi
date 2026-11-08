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
import { isCannedRefusalText, isContentFilterError } from './canned-refusal.js';

/**
 * 判定是否已是分类结果
 *
 * `Loop` 把 `ClassifiedError` 交给 `onError`，Harness 侧若再分类一次，
 * `message` 会被 `String(obj)` 抹成 `[object Object]`（日志与用户可见提示失真）。
 * 分类必须幂等。
 *
 * @param err - 任意错误值
 * @returns 是否已是 `ClassifiedError`
 */
function isClassifiedError(err: unknown): err is ClassifiedError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return typeof e.reason === 'string' && typeof e.message === 'string' && 'originalError' in e;
}

/**
 * 长度类错误文本特征（F 类命门，arch/overflow-redesign.md T2①）。
 *
 * 400 是混杂状态码（长度超限 / 参数非法 / 限流变体），**只有**携带长度类
 * 特征文本的才允许归 `context_length` 进收敛路径——rate_limit/invalid 的 400
 * 一旦误入会「乱砍」上下文（红线 4）。跨 provider 措辞：
 * OpenAI "maximum context length is …"、Anthropic "prompt is too long: … > … maximum"、
 * Gemini "input token count … exceeds the maximum number of tokens allowed"。
 */
export function isContextLengthErrorText(text: string): boolean {
  return (
    /context[ _-]?(length|window|limit)|input[ _-]?length|prompt is too long|prompt too long|maximum context|too many tokens|exceeds the (max|context)|token limit|tokens? exceed|more than the maximum allowed|input too long|request too large|too large for (the )?model|reduce the (length|size) of the (messages|prompt|input)|maximum allowed (tokens|length)/i.test(
      text,
    )
  );
}

/**
 * 从长度类错误文本提取 provider 报告的窗口上限（真值回填，T2②）。
 *
 * 只认「上限」措辞的数字，不认请求体量数字（如 OpenAI 后半句
 * "your messages resulted in N tokens" 是请求大小，不是窗口）。提取不到
 * 返回 undefined（走 T2③ 收缩上界），不做猜测。
 *
 * 邻域约束（防语义错抓）：`tokens > N maximum` 这类无主语模式要求邻近
 * 出现 context/prompt/input 语义，且邻近出现 `output` 时拒绝——否则
 * "25000 tokens > 4096 maximum output tokens" 会把输出上限当窗口写进
 * 进程级真值表（无 TTL，误抓即永久削窗）。
 *
 * @param text - 错误文本（消息原文）
 * @returns 窗口上限 tokens；无法提取时 undefined
 */
export function extractContextWindowLimit(text: string): number | undefined {
  const patterns: RegExp[] = [
    /maximum context (?:length|window) (?:is|of) (\d[\d,]*)/i, // OpenAI
    /\d[\d,]* tokens? > (\d[\d,]*) maximum/i, // Anthropic "… tokens > N maximum"
    /exceed context limit: [\s\S]*?> (\d[\d,]*)/i, // Anthropic "… + … > N"
    /maximum number of tokens allowed \(?(\d[\d,]*)\)?/i, // Gemini
    /maximum allowed (?:tokens|length)[: ]+(\d[\d,]*)/i, // 变体：maximum allowed tokens: N
    /more than the maximum allowed (\d[\d,]*)/i, // 变体：… more than the maximum allowed N
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    // 合理性护栏：拒绝 regex 误抓的垃圾数字（窗口不可能小于 1k 或大于 10M）
    if (!Number.isFinite(n) || n < 1000 || n > 10_000_000) continue;
    // 邻域约束（防语义错抓）：
    // a) 邻近出现 output → 是输出上限而非窗口上限，无条件拒绝
    //    （如 "context length exceeded: 25000 tokens > 4096 maximum output tokens"）
    // b) 无 context/window 主语的模式，邻近须有长度语义（prompt/input/messages/tokens）
    const near = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 60);
    if (/output/i.test(near)) continue;
    if (
      !/context|window/i.test(nearestClause(text, m.index)) &&
      !/prompt|input|messages?|tokens?/i.test(near)
    ) {
      continue;
    }
    return n;
  }
  return undefined;
}

/** 取 match 所在句（`>` 前最近的句读分隔），供主语判定 */
function nearestClause(text: string, index: number): string {
  const start = Math.max(0, ...['.', ';', '\n'].map((d) => text.lastIndexOf(d, index)));
  return text.slice(start, Math.min(text.length, index + 120));
}

/**
 * 分类错误
 *
 * 优先检查 HTTP 状态码（结构化信息），回退到消息文本匹配。
 * 文本匹配会拼接 `message` / `cause` / `code`，覆盖 undici 的
 * `TypeError: terminated`（cause: other side closed）一类被包装的断连错误。
 * 已是分类结果时原样返回（幂等）。
 */
export function classifyError(err: unknown): ClassifiedError {
  if (isClassifiedError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  const lower = collectErrorText(err);

  // 0. 内容过滤拒答：显式错误类型优先（name 稳定，跨包装可辨）
  if (isContentFilterError(err)) {
    return { reason: 'content_filter', message, originalError: err };
  }

  // 1. 优先从 error 对象提取 HTTP 状态码
  const statusCode = extractStatusCode(err);
  let reason: ErrorReason = 'unknown';

  if (statusCode) {
    reason = classifyByStatusCode(statusCode);
  }

  // 2. 回退到消息文本匹配
  if (reason === 'unknown') {
    if (isCannedRefusalText(message)) reason = 'content_filter';
    // 顺序即优先级（红线 4）：rate_limit 文本先于长度类判——混杂文本的 400
    // 宁可走限流重试也不乱砍上下文
    else if (lower.includes('rate') && lower.includes('limit')) reason = 'rate_limit';
    else if (isContextLengthErrorText(lower)) reason = 'context_length';
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
export function collectErrorText(err: unknown): string {
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
 * 根据 HTTP 状态码分类错误。
 *
 * 400 是混杂状态码，**不在此处直接归类**（返回 unknown 交给文本细分）：
 * 长度超限 / 参数非法 / 限流变体共用 400，无条件归 context_length 会让
 * invalid/rate_limit 的 400 误入收敛路径乱砍（红线 4）。
 */
function classifyByStatusCode(status: number): ErrorReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
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
