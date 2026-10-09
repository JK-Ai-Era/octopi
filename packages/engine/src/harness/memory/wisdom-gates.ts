/**
 * Wisdom gates — 范式准入执法（结构，不猜语义）
 *
 * 意图判断（是不是思维范式、适用域）归 LLM；本模块只做：
 * 结构完整性、W2 多源、密钥形态、人格/宪法改写句、容量、对立冲突启发。
 *
 * @module harness/memory/wisdom-gates
 */

import type {
  AdmitWisdomInput,
  WisdomEntry,
  WisdomGateOutcome,
  WisdomOrigin,
  WisdomStatus,
} from './types.js';
import { WISDOM_KINDS, WISDOM_ORIGINS, WISDOM_STATUSES } from './types.js';

const SECRET_LIKE = /(?:api[_-]?key|secret|password|token|credential)\s*[:=]\s*\S{8,}/i;
/** 人格/宪法改写句：禁止用 Wisdom 覆盖身份或安全边界 */
const PERSONA_OVERWRITE =
  /(?:你必须|我是|本人是|改写(?:身份|人格|安全)|忽略(?:安全|宪法|政策)|disable\s+(?:safety|guard))/i;
const STATEMENT_MAX_LEN = 240;

export const WISDOM_DEFAULT_MIN_SUPPORT = 2;

/**
 * 结构 + W2 出生门控。
 *
 * @param input - 候选 maxim
 * @param options - capacityAdmitStop / minSupport / allowedMemoryIds / 与库内条目的冲突样本
 * @returns 是否准入与 reason code
 */
export function evaluateWisdomGate(
  input: AdmitWisdomInput,
  options?: {
    capacityAdmitStop?: boolean;
    minSupport?: number;
    /**
     * 允许的 memoryId 白名单（炼制证据包）。
     * 提供时 derivedFrom 中出现未知 id 即拒（防 LLM 幻觉溯源）。
     */
    allowedMemoryIds?: ReadonlySet<string>;
    /** 库内已条目（查重与对立）；缺省跳过冲突启发 */
    existing?: Pick<WisdomEntry, 'id' | 'statement' | 'status' | 'kind'>[];
  },
): WisdomGateOutcome {
  const statement = (input.statement ?? '').trim();
  if (!statement) return { ok: false, reason: 'empty_statement' };
  if (statement.length > STATEMENT_MAX_LEN) {
    return {
      ok: false,
      reason: 'statement_too_long',
      message: `len=${statement.length} max=${STATEMENT_MAX_LEN}`,
    };
  }
  if (SECRET_LIKE.test(statement) || SECRET_LIKE.test(input.rationale ?? '')) {
    return { ok: false, reason: 'secret_like' };
  }
  if (PERSONA_OVERWRITE.test(statement)) {
    return { ok: false, reason: 'persona_overwrite' };
  }

  const problemTypes = (input.scenario?.problemTypes ?? []).map((s) => s.trim()).filter(Boolean);
  if (problemTypes.length === 0) {
    return { ok: false, reason: 'empty_problem_types' };
  }

  const effect = input.effect ?? {};
  const hasEffect =
    (effect.questions?.some((q) => q.trim())) ||
    (effect.biases?.some((b) => b.trim())) ||
    Boolean(effect.posture?.trim());
  if (!hasEffect) {
    return { ok: false, reason: 'empty_effect', message: 'need questions|biases|posture' };
  }

  if (!WISDOM_KINDS.includes(input.kind)) {
    return { ok: false, reason: 'invalid_kind', message: `kind=${input.kind}` };
  }

  const origin: WisdomOrigin = input.origin ?? 'distilled';
  if (!WISDOM_ORIGINS.includes(origin)) {
    return { ok: false, reason: 'invalid_origin', message: `origin=${origin}` };
  }
  if (input.initialStatus) {
    if (!WISDOM_STATUSES.includes(input.initialStatus)) {
      return { ok: false, reason: 'invalid_status', message: `status=${input.initialStatus}` };
    }
    // 出生不得 strengthened / contested / retired / superseded
    const allowedInitial = ['candidate', 'trial', 'active'] as const;
    if (!(allowedInitial as readonly string[]).includes(input.initialStatus)) {
      return {
        ok: false,
        reason: 'invalid_status',
        message: `initialStatus=${input.initialStatus} not in ${allowedInitial.join('|')}`,
      };
    }
    // distilled 一律不得直达 active（挣得 confidence）
    if (origin === 'distilled' && input.initialStatus === 'active') {
      return {
        ok: false,
        reason: 'invalid_status',
        message: 'distilled must start at trial',
      };
    }
  }

  const memoryIds = input.derivedFrom?.memoryIds ?? [];
  const supportCount =
    memoryIds.length +
    (input.derivedFrom?.conceptIds?.length ?? 0) +
    (input.derivedFrom?.communityId ? 1 : 0);
  const minSupport = options?.minSupport ?? WISDOM_DEFAULT_MIN_SUPPORT;
  // factory 可零源（出厂预设）；显式取代允许单源；distilled 坚持 MDL 多源
  const supportFloor = origin === 'factory' ? 0 : input.supersedesId ? 1 : minSupport;
  if (supportCount < supportFloor) {
    return {
      ok: false,
      reason: 'insufficient_support',
      message: `support=${supportCount} min=${supportFloor} origin=${origin}`,
    };
  }
  if (supportCount === 0 && origin !== 'factory') {
    return { ok: false, reason: 'missing_derived_from' };
  }
  // 溯源必须落在证据包内（防 LLM 幻觉 id）
  if (options?.allowedMemoryIds) {
    const unknown = memoryIds.filter((id) => !options.allowedMemoryIds!.has(id));
    if (unknown.length > 0) {
      return {
        ok: false,
        reason: 'unknown_derived_id',
        message: `unknown=${unknown.slice(0, 5).join(',')}`,
      };
    }
  }

  if (options?.capacityAdmitStop && origin !== 'factory' && !input.supersedesId) {
    return { ok: false, reason: 'capacity_admit_stop' };
  }

  if (options?.existing?.length) {
    const norm = normalizeStatement(statement);
    for (const ex of options.existing) {
      // 只与已站稳的范式冲突检测；candidate/trial 不挡新条
      if (ex.status !== 'active' && ex.status !== 'strengthened') continue;
      const exNorm = normalizeStatement(ex.statement);
      if (exNorm === norm && !input.supersedesId) {
        return {
          ok: false,
          reason: 'duplicate_statement',
          message: `dup_of=${ex.id}`,
        };
      }
      // 字面-语义对立启发：同一宾语 + 互斥谓词（不做全文 NLI）
      if (!input.supersedesId && looksOpposed(statement, ex.statement)) {
        return {
          ok: false,
          reason: 'semantic_conflict',
          message: `conflict_with=${ex.id}`,
        };
      }
    }
  }

  return { ok: true, reason: 'ok' };
}

/**
 * resolve 初始状态。
 *
 * distilled 一律 trial（挣得 confidence）；factory 可 active；agent_write 可 trial|active。
 * initialStatus 不得把 distilled 送进 active（门控已拦，此处兜底）。
 */
export function resolveInitialWisdomStatus(input: AdmitWisdomInput): WisdomStatus {
  const origin = input.origin ?? 'distilled';
  if (input.initialStatus) {
    if (origin === 'distilled' && input.initialStatus === 'active') return 'trial';
    return input.initialStatus;
  }
  if (origin === 'factory') return 'active';
  return 'trial';
}

/**
 * 归一化陈述用于查重。
 *
 * @param s - 原文
 * @returns 去标点空白的小写串
 */
export function normalizeStatement(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

const OPPOSITE_PAIRS: Array<[RegExp, RegExp]> = [
  [/(必须|应该|应当)/, /(禁止|不得|不要|不应)/],
  [/(禁止|不得|不要|不应)/, /(必须|应该|应当)/],
  [/(优先|先)/, /(禁止|不得)/],
];

/**
 * 保守对立启发：同主题词重叠 + 互斥义务词。宁可漏拦，不可误杀。
 *
 * @param a - 新陈述
 * @param b - 既有陈述
 * @returns 是否疑似对立
 */
export function looksOpposed(a: string, b: string): boolean {
  const pair = OPPOSITE_PAIRS.find(([pos, neg]) => (pos.test(a) && neg.test(b)) || (neg.test(a) && pos.test(b)));
  if (!pair) return false;
  // 需要足够共享字面，避免「必须备份」vs「禁止提交密钥」误报
  return sharedBigramRatio(a, b) >= 0.22;
}

function sharedBigramRatio(a: string, b: string): number {
  const na = normalizeStatement(a);
  const nb = normalizeStatement(b);
  if (!na || !nb) return 0;
  const setA = bigrams(na);
  const setB = bigrams(nb);
  if (setA.size === 0 || setB.size === 0) return 0;
  let hit = 0;
  for (const g of setA) if (setB.has(g)) hit++;
  return hit / Math.min(setA.size, setB.size);
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
