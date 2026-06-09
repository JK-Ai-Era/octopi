/**
 * 常见模型的默认 ModelInfo
 *
 * 当 Provider 配置中没有为某个模型指定 contextWindow/maxOutputTokens 时，
 * 提供合理的默认值。用户配置的 ModelInfo 优先级更高。
 *
 * 维护原则：只收录主流模型，不追求全覆盖。
 * 用户可以通过 Provider 配置覆盖或补充。
 */

import type { ModelInfo } from './core/types.js';

/**
 * 内置模型信息表
 *
 * key = 模型名称（支持前缀匹配的精确名称）
 */
const BUILTIN_MODEL_INFO: Record<string, Omit<ModelInfo, 'name'>> = {
  // ── OpenAI ──
  'gpt-5.5':         { contextWindow: 256000, maxOutputTokens: 32768 },
  'gpt-5.5-mini':    { contextWindow: 128000, maxOutputTokens: 16384 },
  'gpt-4o':          { contextWindow: 128000, maxOutputTokens: 16384 },
  'gpt-4o-mini':     { contextWindow: 128000, maxOutputTokens: 16384 },
  'gpt-4-turbo':     { contextWindow: 128000, maxOutputTokens: 4096 },
  'o1':              { contextWindow: 200000, maxOutputTokens: 100000 },
  'o1-mini':         { contextWindow: 128000, maxOutputTokens: 65536 },
  'o3':              { contextWindow: 200000, maxOutputTokens: 100000 },
  'o3-mini':         { contextWindow: 200000, maxOutputTokens: 100000 },
  'o4-mini':         { contextWindow: 200000, maxOutputTokens: 100000 },

  // ── Anthropic ──
  'claude-opus-4-6':    { contextWindow: 200000, maxOutputTokens: 32000 },
  'claude-sonnet-4-6':  { contextWindow: 200000, maxOutputTokens: 16000 },
  'claude-haiku-4-5':   { contextWindow: 200000, maxOutputTokens: 8192 },
  'claude-3.5-sonnet':  { contextWindow: 200000, maxOutputTokens: 8192 },
  'claude-3.5-haiku':   { contextWindow: 200000, maxOutputTokens: 8192 },
  'claude-3-opus':      { contextWindow: 200000, maxOutputTokens: 4096 },

  // ── Google ──
  'gemini-2.5-pro':    { contextWindow: 1000000, maxOutputTokens: 65536 },
  'gemini-2.5-flash':  { contextWindow: 1000000, maxOutputTokens: 65536 },
  'gemini-2.0-pro':    { contextWindow: 2000000, maxOutputTokens: 8192 },
  'gemini-2.0-flash':  { contextWindow: 1000000, maxOutputTokens: 8192 },

  // ── DeepSeek ──
  'deepseek-chat':     { contextWindow: 64000, maxOutputTokens: 8192 },
  'deepseek-reasoner': { contextWindow: 64000, maxOutputTokens: 8192 },

  // ── Qwen ──
  'qwen-max':          { contextWindow: 32000, maxOutputTokens: 8192 },
  'qwen-plus':         { contextWindow: 131072, maxOutputTokens: 8192 },
  'qwen-turbo':        { contextWindow: 131072, maxOutputTokens: 8192 },
};

/**
 * 查询内置模型信息
 *
 * @param modelName - 模型名称
 * @returns ModelInfo 或 null（未收录）
 */
export function getBuiltinModelInfo(modelName: string): ModelInfo | null {
  const info = BUILTIN_MODEL_INFO[modelName];
  if (!info) return null;
  return { name: modelName, ...info };
}

/**
 * 将内置默认值合并到用户配置的 ModelInfo 中
 *
 * 用户配置优先：如果用户已设置某字段，不覆盖。
 * 用于 Provider 构造时补全缺失的字段。
 *
 * @param modelName - 模型名称
 * @param userDefined - 用户配置的 ModelInfo（可能部分字段缺失）
 * @returns 合并后的 ModelInfo，或 null（用户未配置且无内置默认值）
 */
export function mergeWithBuiltinInfo(
  modelName: string,
  userDefined?: ModelInfo,
): ModelInfo | null {
  const builtin = BUILTIN_MODEL_INFO[modelName];
  if (!builtin && !userDefined) return null;
  if (!builtin) return userDefined ?? null;
  if (!userDefined) return { name: modelName, ...builtin };

  return {
    name: modelName,
    contextWindow: userDefined.contextWindow ?? builtin.contextWindow,
    maxOutputTokens: userDefined.maxOutputTokens ?? builtin.maxOutputTokens,
  };
}
