/**
 * Memory confidence — 写入暂定 / band / 注入过滤
 *
 * 唯一公式源：memory 工具与 Steward 共用。
 * 不做自然语言意图识别；channel 由写者（LLM）结构化传入。
 *
 * @module harness/memory/confidence
 */

import type { MemoryChannel, MemoryEntry, MemoryStatus } from './types.js';

export interface ChannelPriors {
  user_directive: number;
  decision: number;
  fail_fix: number;
  model_inference: number;
  admin: number;
}

export const DEFAULT_CHANNEL_PRIORS: ChannelPriors = {
  user_directive: 0.9,
  decision: 0.75,
  fail_fix: 0.75,
  model_inference: 0.4,
  admin: 0.85,
};

export interface ConfidenceProfileConfig {
  channelPriors?: Partial<ChannelPriors>;
  /** Active 注入所需最低综合分（importance*confidence），默认 0.55 */
  injectMinScore?: number;
  /** 锚点上调步长（每个锚点），默认 0.03 */
  anchorBoostStep?: number;
  /** 锚点上调上限，默认 0.12 */
  anchorBoostMax?: number;
}

export interface ProvisionalInput {
  channel: MemoryChannel;
  evidence?: string;
  anchors?: string[];
  importance?: number;
  confidenceHint?: number;
  profile?: ConfidenceProfileConfig;
}

export interface ProvisionalResult {
  confidence: number;
  importance: number;
  status: MemoryStatus;
  score: number;
}

function clamp(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 是否像「原话引语」而非自由改写。
 * 结构判定：引号/反引号包裹、quote: 前缀；不把任意 evidence 字符串当成 quote。
 */
export function hasQuoteEvidence(evidence?: string): boolean {
  if (!evidence) return false;
  const t = evidence.trim();
  if (t.length < 4) return false;
  if (/^quote\s*:/i.test(t)) return true;
  if (/^["“”'‘’`][\s\S]+["“”'‘’`]$/.test(t)) return true;
  if (/(["“”'‘’])[\s\S]{3,}?\1/.test(t)) return true;
  if (/`[\s\S]{3,}?`/.test(t)) return true;
  return false;
}

/**
 * 写入时暂定置信度
 *
 * 不变量：`model_inference` 无引语证据 → 一律 shadow（可搜不可注入）。
 */
export function provisionalConfidence(input: ProvisionalInput): ProvisionalResult {
  const priors = { ...DEFAULT_CHANNEL_PRIORS, ...input.profile?.channelPriors };
  const base = priors[input.channel] ?? priors.model_inference;
  const anchorStep = input.profile?.anchorBoostStep ?? 0.03;
  const anchorMax = input.profile?.anchorBoostMax ?? 0.12;
  const anchorCount = Math.max(0, input.anchors?.length ?? 0);
  const anchorBoost = Math.min(anchorMax, anchorCount * anchorStep);
  const quoted = hasQuoteEvidence(input.evidence);
  const modelInference = input.channel === 'model_inference';

  let confidence: number;
  if (input.confidenceHint !== undefined) {
    confidence = clamp(input.confidenceHint);
  } else if (quoted) {
    confidence = clamp(base + anchorBoost);
  } else if (modelInference) {
    confidence = clamp(base);
  } else {
    confidence = clamp(base * 0.9 + anchorBoost * 0.5);
  }

  const importance =
    input.importance !== undefined
      ? clamp(input.importance)
      : input.channel === 'user_directive'
        ? 0.85
        : modelInference
          ? 0.5
          : 0.7;

  const injectMin = input.profile?.injectMinScore ?? 0.55;
  const score = importance * confidence;

  let status: MemoryStatus;
  if (modelInference && !quoted) {
    // 核心不变量：推断无引语 → shadow
    status = 'shadow';
  } else if (input.channel === 'user_directive') {
    status = 'active';
  } else if (quoted && score >= injectMin * 0.8) {
    status = 'active';
  } else if (score >= injectMin) {
    status = 'active';
  } else if (quoted) {
    // 有引语但分低：仍 active（有证据），由 injectFilter 决定是否进 system
    status = 'active';
  } else {
    status = 'shadow';
  }

  return { confidence, importance, status, score };
}

/**
 * 注入过滤：MemoryLayer 是否可注入该条
 */
export function injectFilter(
  entry: Pick<MemoryEntry, 'status' | 'deleted' | 'confidence' | 'importance'>,
  profile?: ConfidenceProfileConfig,
): boolean {
  if (entry.deleted) return false;
  const status = entry.status ?? 'active';
  if (status === 'shadow') return false;
  const injectMin = profile?.injectMinScore ?? 0.55;
  // active 仍需过分数地板；strengthened 宽松一档
  const floor = status === 'strengthened' ? injectMin * 0.4 : injectMin * 0.5;
  return entry.importance * entry.confidence >= floor;
}

/**
 * 检索过滤：search 是否返回该条（shadow 可见，deleted 不可见）
 */
export function searchFilter(entry: Pick<MemoryEntry, 'status' | 'deleted'>): boolean {
  return !entry.deleted;
}

export function emptyByType(): Record<import('./types.js').MemoryType, number> {
  return { fact: 0, method: 0, norm: 0 };
}

export type MemoryProfileName = 'personal_assistant' | 'embedded_interactive' | 'embedded_headless';

/** profile → ConfidenceProfileConfig（channel 先验 + 注入地板） */
export function profileToConfidenceConfig(
  profile?: MemoryProfileName,
  override?: ConfidenceProfileConfig,
): ConfidenceProfileConfig {
  const base: ConfidenceProfileConfig = { ...override };
  switch (profile) {
    case 'personal_assistant':
      base.channelPriors = {
        user_directive: 0.95,
        decision: 0.8,
        fail_fix: 0.8,
        model_inference: 0.45,
        admin: 0.9,
        ...override?.channelPriors,
      };
      base.injectMinScore = override?.injectMinScore ?? 0.5;
      break;
    case 'embedded_headless':
      base.channelPriors = {
        user_directive: 0.85,
        decision: 0.7,
        fail_fix: 0.7,
        model_inference: 0.3,
        admin: 0.8,
        ...override?.channelPriors,
      };
      base.injectMinScore = override?.injectMinScore ?? 0.65;
      break;
    case 'embedded_interactive':
    default:
      base.channelPriors = {
        ...DEFAULT_CHANNEL_PRIORS,
        ...override?.channelPriors,
      };
      base.injectMinScore = override?.injectMinScore ?? 0.55;
      break;
  }
  return base;
}
