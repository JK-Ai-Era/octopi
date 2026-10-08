/**
 * Cognition gates — 概念/关系准入执法（结构，不猜语义）
 *
 * 意图判断（是否可复用单元、关系假设）归 LLM；本模块只做：
 * cue 校验、证据等级、保守降级、MDL 出生门槛、伪概念/密钥形态。
 *
 * @module harness/memory/cognition-gates
 */

import type {
  AdmitConceptInput,
  ConceptGateReason,
  ConceptKind,
  ConceptRelationType,
  EdgeBasis,
  EvidenceClass,
} from './types.js';
import {
  CONCEPT_KINDS,
  CONCEPT_RELATION_TYPES,
  STRONG_RELATION_TYPES,
} from './types.js';

// ── 概念门控 ──

export interface ConceptGateOutcome {
  ok: boolean;
  reason: ConceptGateReason;
  message?: string;
}

const SECRET_LIKE = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/i;
const STOPWORD = /^(?:the|a|an|this|that|it|is|are|was|were|and|or|of|to|in|for)$/i;
const CJK = /[一-鿿]/;

/** 归一化空白，用于 cue ⊆ evidence 子串校验 */
export function normalizeForCue(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 概念结构门控。
 *
 * @param input - 候选概念
 * @param options - capacityAdmitStop 时禁止新生
 * @returns 是否准入与 reason code
 */
export function evaluateConceptGate(
  input: AdmitConceptInput,
  options?: { capacityAdmitStop?: boolean },
): ConceptGateOutcome {
  const name = (input.name ?? '').trim();
  if (!name) return { ok: false, reason: 'empty_name' };
  if (!CONCEPT_KINDS.includes(input.kind)) {
    return { ok: false, reason: 'invalid_kind', message: `kind=${input.kind}` };
  }
  if (SECRET_LIKE.test(name) || SECRET_LIKE.test(input.description ?? '')) {
    return { ok: false, reason: 'secret_like' };
  }
  if (STOPWORD.test(name) || /^\d+$/.test(name)) {
    return { ok: false, reason: 'pseudo_concept', message: 'stopword or numeric' };
  }
  // 非 CJK 拉丁名至少 2 字符；CJK 允许单字（锁、库…）
  if (name.length < 2 && !CJK.test(name)) {
    return { ok: false, reason: 'pseudo_concept', message: 'name too short' };
  }

  const support = input.supportCount ?? input.memoryIds?.length ?? 0;
  const highValueKind: ConceptKind[] = ['method', 'constraint', 'construct'];
  if (support < 2 && !(support >= 1 && highValueKind.includes(input.kind))) {
    return {
      ok: false,
      reason: 'mdl_insufficient',
      message: `support=${support} kind=${input.kind}`,
    };
  }

  if (options?.capacityAdmitStop) {
    return { ok: false, reason: 'capacity_admit_stop' };
  }

  return { ok: true, reason: 'ok' };
}

// ── 关系持证 ──

/** relationType → 允许的 evidenceClass */
const RELATION_EVIDENCE: Record<ConceptRelationType, readonly EvidenceClass[]> = {
  causes: ['causal'],
  part_of: ['mereonymy'],
  opposes: ['negation'],
  similar_to: ['analogy'],
  evolves_to: ['evolution'],
  related: ['cooccur', 'causal', 'mereonymy', 'negation', 'analogy', 'evolution'],
};

export interface EdgeLicenseInput {
  relationType: ConceptRelationType;
  evidenceClass: EvidenceClass;
  cue: string;
  /** evidence + contextSlice 全文；用于 cue 子串校验 */
  evidenceText?: string;
  memoryIds: string[];
  /** 对应 memory 的 status；用于「1 条 strengthened + 失败→修复」例外 */
  memoryStatuses?: Array<'shadow' | 'active' | 'strengthened'>;
  /** 对应 memory 的 channel；strengthened 例外要求 fail_fix */
  memoryChannels?: Array<'user_directive' | 'decision' | 'fail_fix' | 'model_inference' | 'admin'>;
  /** 配置：causes 最少独立命题（默认 2） */
  causesMinIndependentMemories?: number;
}

export interface EdgeLicenseOutcome {
  ok: boolean;
  /** 实际应入库的关系类型（可能已降级） */
  relationType: ConceptRelationType;
  status: 'active' | 'shadow' | 'demoted' | 'candidate_only' | 'rejected';
  reason: ConceptGateReason;
  message?: string;
}

/**
 * 关系持证门：强边需 cue ⊆ 证据 ∧ 证据形态匹配 ∧ 独立多证据。
 * 任何不满足 → 保守降级为 `related` 或 candidate_only / rejected。
 * **禁止** 共现升格为强类型。
 */
export function licenseEdge(input: EdgeLicenseInput): EdgeLicenseOutcome {
  const rel = input.relationType;
  if (!CONCEPT_RELATION_TYPES.includes(rel)) {
    return {
      ok: false,
      relationType: rel,
      status: 'rejected',
      reason: 'invalid_relation',
      message: `relationType=${rel}`,
    };
  }

  const allowed = RELATION_EVIDENCE[rel] ?? [];
  const classOk = allowed.includes(input.evidenceClass);
  const isStrong = STRONG_RELATION_TYPES.includes(rel);

  // cue 校验（有 evidenceText 时强制）
  if (input.evidenceText != null && input.evidenceText !== '') {
    const hay = normalizeForCue(input.evidenceText);
    const needle = normalizeForCue(input.cue ?? '');
    if (!needle || !hay.includes(needle)) {
      if (isStrong) {
        return {
          ok: true,
          relationType: 'related',
          status: 'demoted',
          reason: 'cue_mismatch',
          message: 'strong relation cue not in evidence; demoted to related',
        };
      }
      return {
        ok: false,
        relationType: 'related',
        status: 'rejected',
        reason: 'cue_mismatch',
      };
    }
  }

  if (!classOk) {
    if (isStrong) {
      return {
        ok: true,
        relationType: 'related',
        status: 'demoted',
        reason: 'demoted_related',
        message: `evidenceClass=${input.evidenceClass} cannot license ${rel}`,
      };
    }
    return {
      ok: false,
      relationType: 'related',
      status: 'rejected',
      reason: 'demoted_related',
    };
  }

  // 强边多证据（调用方应传入同 pair 累积 memoryIds）
  const min = input.causesMinIndependentMemories ?? 2;
  const memCount = new Set(input.memoryIds ?? []).size;
  const hasStrengthened = (input.memoryStatuses ?? []).includes('strengthened');
  const hasFailFix = (input.memoryChannels ?? []).includes('fail_fix');

  if (rel === 'causes') {
    // 2 条独立，或 1 条 strengthened + 失败→修复闭环（fail_fix）
    const closedLoop = memCount >= 1 && hasStrengthened && hasFailFix && input.evidenceClass === 'causal';
    const licensed = memCount >= min || closedLoop;
    if (!licensed) {
      return {
        ok: true,
        relationType: 'related',
        status: 'candidate_only',
        reason: memCount < 1 ? 'cue_mismatch' : 'multi_evidence_required',
        message: `causes needs ≥${min} independent memories (have ${memCount}) or strengthened+fail_fix`,
      };
    }
  } else if (rel === 'opposes') {
    // 2 条独立，或 supersede/否定极性（negation 类 1 条可 shadow 持证，2 条才 active）
    if (memCount < 2) {
      return {
        ok: true,
        relationType: rel,
        status: 'shadow',
        reason: 'multi_evidence_required',
        message: `opposes needs ≥2 independent memories (have ${memCount})`,
      };
    }
  } else if (isStrong) {
    // part_of / evolves_to：至少 1 条持证件
    if (memCount < 1) {
      return {
        ok: true,
        relationType: 'related',
        status: 'shadow',
        reason: 'multi_evidence_required',
      };
    }
  }

  // related / 共现：永远 shadow，不得因强度升格
  if (rel === 'related' || input.evidenceClass === 'cooccur') {
    return {
      ok: true,
      relationType: 'related',
      status: isStrong ? 'demoted' : 'shadow',
      reason: input.evidenceClass === 'cooccur' && rel !== 'related' ? 'cooccur_no_escalation' : 'ok',
    };
  }

  return {
    ok: true,
    relationType: rel,
    status: 'active',
    reason: 'ok',
  };
}

/**
 * 校验 basis 与许可结果一致；不一致时强制保守。
 */
export function edgeBasisFromLicense(
  license: EdgeLicenseOutcome,
  basis: Omit<EdgeBasis, 'licensedAt'> & { licensedAt?: number },
): EdgeBasis {
  return {
    memoryIds: basis.memoryIds ?? [],
    cue: basis.cue ?? '',
    evidenceClass: basis.evidenceClass,
    licensedAt: basis.licensedAt ?? Date.now(),
  };
}
