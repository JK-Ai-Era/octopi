/**
 * Memory Steward — shared policy package
 * 补录提取对接、门控/置信度、治理软删策略（一次到位，无分期）。
 */

import type { MemoryChannel, MemoryEntry, MemoryType, SoftDeleteReason } from '../../../harness/memory/types.js';
import { provisionalConfidence } from '../../../harness/memory/confidence.js';
import { evaluateGates } from '../../../harness/memory/gates.js';
import type { MemoryStore } from '../../../harness/memory/types.js';

export interface StewardCandidate {
  type: string;
  proposition: string;
  evidence?: string;
  future_use?: string;
  anchors?: string[];
  channel?: MemoryChannel;
  importance?: number;
  tags?: string[];
}

export interface SoftDeletePolicyConfig {
  protectWindowMs?: number;
  shadowTtlMs?: number;
  shadowIdleMs?: number;
  shadowMinAccess?: number;
  decayScoreFloor?: number;
  decayIdleMs?: number;
  strengthenedIdleMs?: number;
  userDirectMinConfidence?: number;
  normProtectConfidence?: number;
  duplicateSimilarity?: number;
  capacity?: Partial<Record<MemoryType, number>>;
  protectTags?: string[];
  dryRun?: boolean;
}

export const DEFAULT_SOFT_DELETE_POLICY: Required<Omit<SoftDeletePolicyConfig, 'capacity' | 'protectTags'>> & {
  capacity: Record<MemoryType, number>;
  protectTags: string[];
} = {
  protectWindowMs: 86_400_000,
  shadowTtlMs: 1_209_600_000,
  shadowIdleMs: 1_209_600_000,
  shadowMinAccess: 1,
  decayScoreFloor: 0.25,
  decayIdleMs: 7_776_000_000,
  strengthenedIdleMs: 2_592_000_000,
  userDirectMinConfidence: 0.85,
  normProtectConfidence: 0.8,
  duplicateSimilarity: 0.92,
  capacity: { fact: 200, method: 100, norm: 150 },
  protectTags: ['env', 'security'],
  dryRun: false,
};

export function resolvePolicy(cfg?: SoftDeletePolicyConfig) {
  return {
    ...DEFAULT_SOFT_DELETE_POLICY,
    ...cfg,
    capacity: { ...DEFAULT_SOFT_DELETE_POLICY.capacity, ...cfg?.capacity },
    protectTags: cfg?.protectTags ?? DEFAULT_SOFT_DELETE_POLICY.protectTags,
  };
}

export function scoreOf(e: MemoryEntry): number {
  return e.importance * e.confidence * (e.decayFactor ?? 1);
}

export function isProtected(e: MemoryEntry, policy: ReturnType<typeof resolvePolicy>, now = Date.now()): boolean {
  if (e.deleted) return true;
  if (now - e.createdAt < policy.protectWindowMs) return true;
  if (e.channel === 'user_directive' && e.confidence >= policy.userDirectMinConfidence) return true;
  if ((e.status ?? 'active') === 'strengthened' && now - e.lastAccessedAt < policy.strengthenedIdleMs) return true;
  // 仅高置信 norm 受保护，避免所有 decision/fact 默认锁死治理
  if (e.type === 'norm' && e.confidence >= policy.normProtectConfidence && (e.channel === 'user_directive' || e.channel === 'decision')) {
    return true;
  }
  if (e.tags?.some((t) => policy.protectTags.includes(t))) return true;
  return false;
}

export function normalizedProposition(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[「」“”"'`]/g, '')
    .replace(/[。！？!?.;；,，]/g, '')
    .trim();
}

/** 字符 3-gram Jaccard 相似度（用于近重复 supersede） */
export function charTrigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.replace(/\s+/g, '');
    const set = new Set<string>();
    if (t.length < 3) {
      if (t) set.add(t);
      return set;
    }
    for (let i = 0; i <= t.length - 3; i++) set.add(t.slice(i, i + 3));
    return set;
  };
  const sa = grams(a);
  const sb = grams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface GovernPlanItem {
  id: string;
  ruleId: SoftDeleteReason;
  winnerId?: string;
  reason: string;
}

export function planSoftDeletes(
  entries: MemoryEntry[],
  cfg?: SoftDeletePolicyConfig,
  now = Date.now(),
): GovernPlanItem[] {
  const policy = resolvePolicy(cfg);
  const plan: GovernPlanItem[] = [];
  const live = entries.filter((e) => !e.deleted);

  for (const e of live) {
    if (isProtected(e, policy, now)) continue;

    // T1 junk recheck：结构门控复检（统计句/无锚点等漏网）
    const recheck = evaluateGates({
      type: e.type,
      proposition: e.content,
      evidence: e.evidence,
      futureUse: e.futureUse,
      anchors: e.anchors,
      channel: e.channel ?? 'model_inference',
    });
    if (!recheck.ok) {
      plan.push({ id: e.id, ruleId: 'junk_recheck', reason: recheck.reason });
      continue;
    }

    // T4 shadow expiry
    if ((e.status ?? 'active') === 'shadow') {
      const age = now - e.createdAt;
      const idle = now - e.lastAccessedAt;
      if (age >= policy.shadowTtlMs && idle >= policy.shadowIdleMs && e.accessCount < policy.shadowMinAccess) {
        plan.push({ id: e.id, ruleId: 'shadow_expired', reason: 'shadow TTL without reinforcement' });
        continue;
      }
    }

    // T5 decay unused
    const idle = now - e.lastAccessedAt;
    if (scoreOf(e) < policy.decayScoreFloor && idle >= policy.decayIdleMs) {
      const stricter = e.type !== 'fact';
      if (!stricter || idle >= policy.decayIdleMs * 2) {
        plan.push({ id: e.id, ruleId: 'decay_unused', reason: `score ${scoreOf(e).toFixed(3)} idle ${idle}` });
        continue;
      }
    }
  }

  const candidates = live.filter((e) => !plan.some((p) => p.id === e.id));

  // T3 supersede：**仅**当同 type + 归一化命题高度近似（≥ duplicateSimilarity 字符级）
  // 且文本不完全相同 —— 不做「前缀主题」启发式，避免误删互补事实
  const byType = new Map<MemoryType, MemoryEntry[]>();
  for (const e of candidates) {
    if (plan.some((p) => p.id === e.id)) continue;
    if (isProtected(e, policy, now)) continue;
    const list = byType.get(e.type) ?? [];
    list.push(e);
    byType.set(e.type, list);
  }
  for (const group of byType.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const na = normalizedProposition(a.content);
        const nb = normalizedProposition(b.content);
        if (na === nb) continue; // 等同 → duplicate 规则处理
        const sim = charTrigramSimilarity(na, nb);
        if (sim < policy.duplicateSimilarity) continue;
        const sorted = [a, b].sort((x, y) => scoreOf(y) - scoreOf(x) || y.createdAt - x.createdAt);
        const winner = sorted[0];
        const loser = sorted[1];
        if (isProtected(loser, policy, now)) continue;
        if (plan.some((p) => p.id === loser.id)) continue;
        plan.push({
          id: loser.id,
          ruleId: 'superseded',
          winnerId: winner.id,
          reason: `near-duplicate proposition (sim=${sim.toFixed(2)}) superseded`,
        });
      }
    }
  }

  // T2 duplicates (simple normalized equality)
  const byNorm = new Map<string, MemoryEntry[]>();
  const dedupPool = live.filter((e) => !plan.some((p) => p.id === e.id));
  for (const e of dedupPool) {
    if (isProtected(e, policy, now)) continue;
    const key = `${e.type}:${normalizedProposition(e.content)}`;
    const list = byNorm.get(key) ?? [];
    list.push(e);
    byNorm.set(key, list);
  }
  for (const group of byNorm.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => scoreOf(b) - scoreOf(a) || b.createdAt - a.createdAt);
    const winner = sorted[0];
    for (const loser of sorted.slice(1)) {
      if (isProtected(loser, policy, now)) continue;
      plan.push({
        id: loser.id,
        ruleId: 'duplicate_loser',
        winnerId: winner.id,
        reason: 'duplicate proposition',
      });
    }
  }

  // T6 capacity
  const deletedIds = new Set(plan.map((p) => p.id));
  for (const type of ['fact', 'method', 'norm'] as MemoryType[]) {
    const cap = policy.capacity[type];
    let bucket = candidates.filter((e) => e.type === type && !deletedIds.has(e.id));
    if (bucket.length <= cap) continue;
    bucket = [...bucket].sort((a, b) => {
      const aShadow = (a.status ?? 'active') === 'shadow' ? 0 : 1;
      const bShadow = (b.status ?? 'active') === 'shadow' ? 0 : 1;
      return aShadow - bShadow || scoreOf(a) - scoreOf(b);
    });
    const overflow = bucket.length - cap;
    for (let i = 0; i < overflow; i++) {
      const e = bucket[i];
      if (isProtected(e, policy, now)) continue;
      if (deletedIds.has(e.id)) continue;
      plan.push({ id: e.id, ruleId: 'capacity', reason: `${type} over capacity ${cap}` });
      deletedIds.add(e.id);
    }
  }

  return plan;
}

export async function applySoftDeletes(
  store: MemoryStore,
  plan: GovernPlanItem[],
  dryRun?: boolean,
): Promise<{ applied: number; skipped: number; plan: GovernPlanItem[] }> {
  if (dryRun) {
    return { applied: 0, skipped: plan.length, plan };
  }
  let applied = 0;
  for (const item of plan) {
    await store.softDelete(item.id, {
      by: 'memory.steward.govern',
      reason: item.ruleId,
      winnerId: item.winnerId,
    });
    applied++;
  }
  return { applied, skipped: 0, plan };
}

/** 将 LLM/规则候选经门控+置信度写入 store；返回接受与拒绝明细 */
export async function admitCandidates(
  store: MemoryStore,
  candidates: StewardCandidate[],
  source: string,
): Promise<{ accepted: Array<{ id: string; type: MemoryType; status: string }>; rejected: Array<{ reason: string; proposition: string }> }> {
  const accepted: Array<{ id: string; type: MemoryType; status: string }> = [];
  const rejected: Array<{ reason: string; proposition: string }> = [];

  for (const c of candidates) {
    const gate = evaluateGates({
      type: c.type,
      proposition: c.proposition,
      evidence: c.evidence,
      futureUse: c.future_use,
      anchors: c.anchors,
      channel: c.channel ?? 'model_inference',
    });
    if (!gate.ok) {
      rejected.push({ reason: gate.reason, proposition: c.proposition });
      continue;
    }
    const conf = provisionalConfidence({
      channel: c.channel ?? 'model_inference',
      evidence: c.evidence,
      anchors: c.anchors,
      importance: c.importance,
    });
    const status = gate.status === 'shadow' ? 'shadow' : conf.status;
    const type = c.type as MemoryType;
    const id = await store.store({
      type,
      content: c.proposition,
      source,
      confidence: conf.confidence,
      importance: conf.importance,
      tags: [...new Set([...(c.tags ?? []), type, c.channel ?? 'model_inference'])],
      channel: c.channel ?? 'model_inference',
      status,
      futureUse: c.future_use,
      anchors: c.anchors,
      evidence: c.evidence,
    });
    accepted.push({ id, type, status });
  }

  return { accepted, rejected };
}
