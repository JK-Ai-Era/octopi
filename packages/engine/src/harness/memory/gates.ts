/**
 * Memory gates — 结构准入（立法之后的执法）
 *
 * 不做自然语言意图分类；拒绝必须带 reason code。
 *
 * @module harness/memory/gates
 */

import type { MemoryChannel, MemoryType } from './types.js';
import { MEMORY_TYPES } from './types.js';
import { hasQuoteEvidence } from './confidence.js';

export type GateRejectReason =
  | 'empty'
  | 'bad_type'
  | 'too_short'
  | 'too_long'
  | 'no_evidence'
  | 'synthetic_evidence'
  | 'statistical_summary'
  | 'activity_log'
  | 'meta_noise'
  | 'no_retrieval_anchor'
  | 'suspicious_instruction'
  | 'out_of_scope';

export type GateOutcome =
  | { ok: true; status?: 'active' | 'shadow' }
  | { ok: false; reason: GateRejectReason; message: string };

export interface GateCandidate {
  type: string;
  proposition: string;
  evidence?: string;
  futureUse?: string;
  anchors?: string[];
  channel?: MemoryChannel;
  tags?: string[];
}

export interface GateConfig {
  maxLength?: Partial<Record<MemoryType, number>>;
  minLength?: number;
  /** CJK 最短字符数（默认 6） */
  minLengthCjk?: number;
  /** user_directive 且有 quote 时允许无锚点 → shadow */
  allowShadowWithoutAnchor?: boolean;
}

const DEFAULT_MAX: Record<MemoryType, number> = {
  fact: 400,
  method: 500,
  norm: 300,
};

/** 统计句/元描述结构启发式（语言无关优先） */
const STAT_PATTERNS: RegExp[] = [
  /用户在会话中/i,
  /出现了?\s*\d+\s*次/,
  /\b\d+\s*(条|个|次|things|items|times)\b/i,
  /会话中形成/i,
  /memory extraction/i,
  /提取完成/i,
  /extraction completed/i,
];

const ACTIVITY_PATTERNS: RegExp[] = [
  /^(called|调用了?|ran|executed|执行了)\s/i,
  /^(tool_call|tool_success|tool_failure)$/i,
  /\[工具(调用|成功|失败)\]/,
];

const META_PATTERNS: RegExp[] = [
  /this session was/i,
  /memory extraction completed/i,
  /extraction completed/i,
  /提取完成/,
  /子系统注册/,
];

const SYNTHETIC_EVIDENCE = /^evt_\d+$/i;

const SUSPICIOUS = [
  /ignore (all )?(previous|prior) instructions/i,
  /忽略(之前|以上|所有)指令/,
  // 密钥「形态」而非禁词：避免误杀「不要把 API key 写入记忆」
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const ANCHOR_HINTS = [
  // 真实路径/文件，而非中文里的「表达/确认」这类斜杠
  /[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.-]+/,
  /\b[\w-]+\.(ts|js|json|md|yaml|yml|py|sql|db)\b/i,
  /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/,
  /\b[a-z]+_[a-z0-9_]+\b/,
  /https?:\/\//i,
  // 双引号/中文引号/反引号；避免英文所有格 user's / don't 误判
  /["“”][^"“”]{2,}["“”]/,
  /`[^`]+`/,
  /\bv?\d+\.\d+/,
];

function isMemoryType(t: string): t is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(t);
}

/** CJK 字符数 */
function countCjk(text: string): number {
  const m = text.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿]/g);
  return m ? m.length : 0;
}

/** 长度门：CJK 与 Latin 分档 */
function lengthGate(content: string, type: MemoryType, config?: GateConfig): GateOutcome | null {
  const cjk = countCjk(content);
  const latin = content.length - cjk;
  const minCjk = config?.minLengthCjk ?? 6;
  const minLatin = config?.minLength ?? 12;
  const maxDefault = DEFAULT_MAX[type];
  const maxLen = config?.maxLength?.[type] ?? maxDefault;
  if (cjk + latin < Math.min(minCjk, minLatin)) {
    return { ok: false, reason: 'too_short', message: `content too short (cjk=${cjk}, latin=${latin})` };
  }
  if (cjk < minCjk && latin < minLatin) {
    return { ok: false, reason: 'too_short', message: `content too short for script mix (cjk=${cjk}, latin=${latin})` };
  }
  if (content.length > maxLen) {
    return { ok: false, reason: 'too_long', message: `content length ${content.length} > ${maxLen}` };
  }
  return null;
}

function hasAnchorSignals(text: string, anchors?: string[]): boolean {
  if (anchors && anchors.length > 0) {
    return anchors.some((a) => a && a.trim().length >= 2);
  }
  return ANCHOR_HINTS.some((re) => re.test(text));
}

function hasFutureUse(futureUse?: string): boolean {
  if (!futureUse) return false;
  const t = futureUse.trim();
  return t.length >= 6;
}

/**
 * 结构门控
 */
export function evaluateGates(candidate: GateCandidate, config?: GateConfig): GateOutcome {
  const proposition = (candidate.proposition ?? '').trim();
  if (!proposition && !(candidate as { content?: string }).content) {
    return { ok: false, reason: 'empty', message: 'proposition is empty' };
  }
  const content = proposition || String((candidate as { content?: string }).content ?? '').trim();
  if (!content) {
    return { ok: false, reason: 'empty', message: 'proposition is empty' };
  }

  if (!isMemoryType(candidate.type)) {
    return { ok: false, reason: 'bad_type', message: `type must be fact|method|norm, got ${candidate.type}` };
  }

  const type = candidate.type;
  const lenFail = lengthGate(content, type, config);
  if (lenFail) return lenFail;

  const channel = candidate.channel ?? 'model_inference';
  const evidence = (candidate.evidence ?? '').trim();
  const isAuto = channel !== 'admin';

  if (isAuto) {
    if (!evidence) {
      return { ok: false, reason: 'no_evidence', message: 'auto write requires evidence' };
    }
    if (SYNTHETIC_EVIDENCE.test(evidence)) {
      return { ok: false, reason: 'synthetic_evidence', message: 'evidence must quote real text' };
    }
  }

  if (SUSPICIOUS.some((re) => re.test(content) || re.test(evidence))) {
    return { ok: false, reason: 'suspicious_instruction', message: 'content looks like instruction injection or secret pattern' };
  }

  if (STAT_PATTERNS.some((re) => re.test(content))) {
    // 强统计模板：仅允许「显式 anchors 数组 / future_use / 引语」放行；不用 content 启发式锚点
    const quoted = /["“”][^"“”]{3,}["“”]/.test(content) || /`[^`]{3,}`/.test(content);
    const explicitAnchors = (candidate.anchors ?? []).some((a) => a && a.trim().length >= 2);
    const usable = quoted || explicitAnchors || hasFutureUse(candidate.futureUse);
    if (!usable) {
      return { ok: false, reason: 'statistical_summary', message: 'statistical/meta summary without anchors/evidence is not a memory proposition' };
    }
  }

  if (ACTIVITY_PATTERNS.some((re) => re.test(content))) {
    return { ok: false, reason: 'activity_log', message: 'activity log is not a memory proposition' };
  }

  if (META_PATTERNS.some((re) => re.test(content)) && !hasAnchorSignals(content, candidate.anchors)) {
    return { ok: false, reason: 'meta_noise', message: 'meta/system noise without anchors' };
  }

  const anchorOk = hasAnchorSignals(content, candidate.anchors) || hasFutureUse(candidate.futureUse);
  if (!anchorOk) {
    // user_directive 无锚点：仅引语证据可 shadow 入库
    if (channel === 'user_directive' && hasQuoteEvidence(evidence) && (config?.allowShadowWithoutAnchor ?? true)) {
      return { ok: true, status: 'shadow' };
    }
    return {
      ok: false,
      reason: 'no_retrieval_anchor',
      message: 'need retrieval anchors or future_use condition',
    };
  }

  return { ok: true, status: 'active' };
}

export function mapLegacyType(t: string): MemoryType {
  switch (t) {
    case 'preference':
    case 'decision':
      return 'norm';
    case 'lesson':
      return 'method';
    case 'discovery':
    case 'context':
    case 'relationship':
    case 'fact':
      return 'fact';
    default:
      return isMemoryType(t) ? t : 'fact';
  }
}
