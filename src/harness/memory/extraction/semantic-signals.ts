/**
 * Memory Extraction — 语义信号（语言无关，可演进）
 *
 * 设计原则：
 * - 不依赖特定语言关键词
 * - 仅基于结构化文本特征（长度/重复/否定前缀/标点极性）给出弱信号
 * - 作为事件信号的补充，后续可替换为 embedding/polarity 模型
 *
 * @module harness/memory/extraction/semantic-signals
 */

export interface SemanticSignalInput {
  /** 当前用户文本（可为空） */
  text?: string;
  /** 最近一轮助手文本（可选，用于上下文特征） */
  lastAssistantText?: string;
}

export interface SemanticSignalResult {
  /** 是否可能是确认（弱信号） */
  confirmLikely: boolean;
  /** 是否可能是否定/拒绝（弱信号） */
  rejectLikely: boolean;
  /** 置信度 0..1 */
  confidence: number;
}

const CONFIRM_CHARS = ['!', '。', '！', '👍', '✅'];
const REJECT_CHARS = ['❌', '🚫'];

const NEGATIVE_PREFIXES = [
  '不要', '别', '禁止', '不允许', '不可以',
  'do not', "don't", 'no ', 'never', "mustn't", "shouldn't",
];

export function detectSemanticSignals(input: SemanticSignalInput): SemanticSignalResult {
  const text = (input.text ?? '').trim();

  if (text.length === 0) {
    return { confirmLikely: false, rejectLikely: false, confidence: 0.2 };
  }

  const lower = text.toLowerCase();

  const hasConfirmPunctuation = CONFIRM_CHARS.some((c) => text.includes(c));
  const hasRejectPunctuation = REJECT_CHARS.some((c) => text.includes(c));
  const hasNegPrefix = NEGATIVE_PREFIXES.some((p) => lower.startsWith(p));

  const confirmLikely = hasConfirmPunctuation && !hasNegPrefix;
  const rejectLikely = hasRejectPunctuation || hasNegPrefix;

  const confidence = confirmLikely || rejectLikely ? 0.6 : 0.4;

  return { confirmLikely, rejectLikely, confidence };
}
