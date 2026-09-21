/**
 * Provider usage → Core TokenUsage（cache-aware）
 *
 * @module integration/providers/usage
 */

import type { TokenUsage } from '../../core/types/turn.js';

const empty = (): TokenUsage => ({
  outputTokens: 0,
  inputUncachedTokens: 0,
  inputCachedTokens: 0,
  inputCacheWriteTokens: 0,
  cacheAware: false,
});

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * OpenAI / OpenAI-compatible usage
 *
 * @param usage - raw usage object
 * @returns TokenUsage
 */
export function tokenUsageFromOpenAi(usage: unknown): TokenUsage {
  if (!usage || typeof usage !== 'object') return empty();
  const u = usage as Record<string, unknown>;
  const prompt = toNum(u.prompt_tokens);
  const completion = toNum(u.completion_tokens);
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = toNum(details?.cached_tokens);
  const cacheAware = cached > 0 || (details != null && 'cached_tokens' in details);
  // cacheAware=false 时：不编造 cache 分项，uncached ≈ provider 报告的 prompt
  return {
    outputTokens: completion,
    inputUncachedTokens: cacheAware ? Math.max(0, prompt - cached) : prompt,
    inputCachedTokens: cacheAware ? cached : 0,
    inputCacheWriteTokens: 0,
    inputReportedTokens: prompt,
    cacheAware,
    raw: u as Record<string, unknown>,
  };
}

/**
 * Anthropic usage（含 cache_read / cache_creation）
 *
 * @param usage - raw usage object
 * @returns TokenUsage
 */
export function tokenUsageFromAnthropic(usage: unknown): TokenUsage {
  if (!usage || typeof usage !== 'object') return empty();
  const u = usage as Record<string, unknown>;
  const input = toNum(u.input_tokens);
  const output = toNum(u.output_tokens);
  const cacheRead = toNum(u.cache_read_input_tokens);
  const cacheWrite = toNum(u.cache_creation_input_tokens);
  const hasCacheField =
    'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u;
  const cacheAware = hasCacheField || cacheRead > 0 || cacheWrite > 0;
  // Anthropic input_tokens 通常不含 cache read/write（以文档为准；缺字段时按 reported=input+read+write）
  const reported = cacheAware ? input + cacheRead + cacheWrite : input;
  return {
    outputTokens: output,
    inputUncachedTokens: input,  // Anthropic input_tokens 已是 uncached 部分
    inputCachedTokens: cacheRead,
    inputCacheWriteTokens: cacheWrite,
    inputReportedTokens: reported,
    cacheAware,
    raw: u as Record<string, unknown>,
  };
}
