/**
 * Wisdom formation — 炼制解析、场景匹配、注入排版
 *
 * LLM 判「是不是范式、适用域」；本模块做结构解析 + admit 门控 + 关键词场景匹配。
 * 禁止 session 全文 ETL。规范：arch/wisdom-layer-formation.md §6 / §9。
 *
 * @module harness/memory/wisdom-formation
 */

import type {
  AdmitWisdomInput,
  AdmitWisdomResult,
  WisdomEntry,
  WisdomInjectPick,
  WisdomKind,
  WisdomStore,
} from './types.js';
import { WISDOM_KINDS } from './types.js';
import { wisdomInjectScore } from './wisdom-policy.js';
import { evaluateWisdomGate } from './wisdom-gates.js';

// ── LLM 输出解析 ──

export interface RawWisdomFormationOutput {
  items?: unknown;
  droppedNotes?: unknown;
}

export interface ParsedWisdomItem {
  statement: string;
  rationale?: string;
  problemTypes: string[];
  signals?: string[];
  antiScenarios?: string[];
  questions?: string[];
  biases?: string[];
  posture?: string;
  memoryIds: string[];
  conceptIds?: string[];
  exceptions?: string[];
  kind: WisdomKind;
}

export interface ParsedWisdomFormation {
  items: ParsedWisdomItem[];
  droppedNotes: string[];
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x)).filter(Boolean);
}

function parseKind(v: unknown): WisdomKind | null {
  const s = asString(v) as WisdomKind;
  return WISDOM_KINDS.includes(s) ? s : null;
}

/**
 * 从 LLM 文本提取 `{items, droppedNotes}`。
 *
 * @param text - LLM 输出
 * @returns 解析结果或 null
 */
export function parseWisdomFormationJson(text: string): RawWisdomFormationOutput | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  if (end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    return obj as RawWisdomFormationOutput;
  } catch {
    return null;
  }
}

/**
 * 归一化 raw → 严格 Parsed（丢弃残缺项，不半写）。
 *
 * @param raw - 解析后的 JSON
 * @returns 有效 items 与丢弃说明
 */
export function normalizeWisdomFormation(
  raw: RawWisdomFormationOutput,
): ParsedWisdomFormation {
  const items: ParsedWisdomItem[] = [];
  const droppedNotes = asStringArray(raw.droppedNotes);
  const list = Array.isArray(raw.items) ? raw.items : [];
  for (const it of list) {
    if (!it || typeof it !== 'object') {
      droppedNotes.push('non_object_item');
      continue;
    }
    const o = it as Record<string, unknown>;
    const statement = asString(o.statement);
    const scenarioObj =
      typeof o.scenario === 'object' && o.scenario && !Array.isArray(o.scenario)
        ? (o.scenario as Record<string, unknown>)
        : {};
    const pts = asStringArray(o.problemTypes).length
      ? asStringArray(o.problemTypes)
      : asStringArray(scenarioObj.problemTypes);
    const signals = asStringArray(o.signals ?? scenarioObj.signals);
    const antiScenarios = asStringArray(o.antiScenarios ?? scenarioObj.antiScenarios);
    const effect = (typeof o.effect === 'object' && o.effect ? o.effect : o) as Record<string, unknown>;
    const questions = asStringArray(effect.questions ?? o.questions);
    const biases = asStringArray(effect.biases ?? o.biases);
    const posture = asString(effect.posture ?? o.posture);
    const derived = (typeof o.derivedFrom === 'object' && o.derivedFrom
      ? o.derivedFrom
      : o) as Record<string, unknown>;
    const memoryIds = asStringArray(derived.memoryIds ?? o.memoryIds);
    const conceptIds = asStringArray(derived.conceptIds ?? o.conceptIds);
    const kind = parseKind(o.kind);

    if (!statement || pts.length === 0) {
      droppedNotes.push(`incomplete:${statement.slice(0, 24) || 'empty'}`);
      continue;
    }
    if (!questions.length && !biases.length && !posture) {
      droppedNotes.push(`no_effect:${statement.slice(0, 24)}`);
      continue;
    }
    if (memoryIds.length === 0 && conceptIds.length === 0) {
      droppedNotes.push(`no_derived:${statement.slice(0, 24)}`);
      continue;
    }
    if (!kind) {
      droppedNotes.push(`invalid_kind:${asString(o.kind).slice(0, 16)}`);
      continue;
    }

    items.push({
      statement,
      rationale: asString(o.rationale) || undefined,
      problemTypes: pts,
      signals: signals.length ? signals : undefined,
      antiScenarios: antiScenarios.length ? antiScenarios : undefined,
      questions: questions.length ? questions : undefined,
      biases: biases.length ? biases : undefined,
      posture: posture || undefined,
      memoryIds,
      conceptIds: conceptIds.length ? conceptIds : undefined,
      exceptions: asStringArray(o.exceptions).length
        ? asStringArray(o.exceptions)
        : undefined,
      kind,
    });
  }
  return { items, droppedNotes };
}

/**
 * Parsed → AdmitWisdomInput（distilled 默认）。
 *
 * @param item - 已归一项
 * @param options - origin / supersedesId
 * @returns admit 入参
 */
export function toAdmitWisdomInput(
  item: ParsedWisdomItem,
  options?: { origin?: AdmitWisdomInput['origin']; supersedesId?: string },
): AdmitWisdomInput {
  return {
    statement: item.statement,
    rationale: item.rationale,
    scenario: {
      problemTypes: item.problemTypes,
      signals: item.signals,
      antiScenarios: item.antiScenarios,
    },
    effect: {
      questions: item.questions,
      biases: item.biases,
      posture: item.posture,
    },
    derivedFrom: {
      memoryIds: item.memoryIds,
      conceptIds: item.conceptIds,
    },
    kind: item.kind,
    origin: options?.origin ?? 'distilled',
    exceptions: item.exceptions,
    supersedesId: options?.supersedesId,
  };
}

/**
 * 炼制解析并逐条 admit。
 *
 * @param llmText - LLM 原文
 * @param store - WisdomStore
 * @param options - origin / maxItems
 * @returns admit 结果与丢弃笔记
 */
export async function formAndAdmit(
  llmText: string,
  store: WisdomStore,
  options?: {
    origin?: AdmitWisdomInput['origin'];
    maxItems?: number;
    allowedMemoryIds?: ReadonlySet<string>;
    dryRun?: boolean;
  },
): Promise<{ results: AdmitWisdomResult[]; droppedNotes: string[] }> {
  const raw = parseWisdomFormationJson(llmText);
  if (!raw) {
    return {
      results: [{ action: 'rejected', reason: 'empty_statement', message: 'parse_failed' }],
      droppedNotes: ['parse_failed'],
    };
  }
  const { items, droppedNotes } = normalizeWisdomFormation(raw);
  const maxItems = options?.maxItems ?? 3;
  const results: AdmitWisdomResult[] = [];
  for (const item of items.slice(0, maxItems)) {
    const input = toAdmitWisdomInput(item, { origin: options?.origin });
    if (options?.dryRun) {
      const gate = evaluateWisdomGate(input, {
        allowedMemoryIds: options.allowedMemoryIds,
      });
      results.push(
        gate.ok
          ? { action: 'created', message: 'dry_run' }
          : { action: 'rejected', reason: gate.reason, message: gate.message },
      );
      continue;
    }
    results.push(await store.admit(input, { allowedMemoryIds: options?.allowedMemoryIds }));
  }
  return { results, droppedNotes };
}

// ── 场景匹配（P0 keyword；embedding/llm 留给后续，不假装已实现） ──

/**
 * 关键词/字面场景匹配分。
 *
 * @param entry - 条目
 * @param text - 本轮查询/任务文本
 * @returns [0,1]；无命中为 0
 */
export function scenarioMatchScore(entry: WisdomEntry, text: string): number {
  const q = text.toLowerCase();
  if (!q.trim()) return 0;
  const anti = (entry.scenario.antiScenarios ?? []).map((s) => s.toLowerCase());
  if (anti.some((a) => a && q.includes(a))) return 0;

  const types = entry.scenario.problemTypes.map((s) => s.toLowerCase());
  const signals = (entry.scenario.signals ?? []).map((s) => s.toLowerCase());
  const words = types.concat(signals);
  if (words.length === 0) return 0;

  let hit = 0;
  for (const w of words) {
    if (!w) continue;
    if (q.includes(w)) hit += 2;
    else if (overlapChars(q, w)) hit += 1;
  }
  if (hit === 0) return 0;
  return Math.min(1, hit / (words.length * 2));
}

function overlapChars(q: string, w: string): boolean {
  // CJK 友好：词全字面出现在 q 已由 includes 覆盖；此处做 2-gram 弱重叠
  if (w.length < 2) return false;
  for (let i = 0; i < w.length - 1; i++) {
    const g = w.slice(i, i + 2);
    if (q.includes(g)) return true;
  }
  return false;
}

/**
 * 选择注入集：小核心 + 场景匹配。
 *
 * @param entries - 可注入条目（store 已滤状态）
 * @param text - 本轮文本
 * @param options - 条数硬顶
 * @returns 排序后的注入选择
 */
export function pickForInjection(
  entries: WisdomEntry[],
  text: string,
  options?: {
    coreMaxItems?: number;
    scenarioMaxItems?: number;
    includeTrial?: boolean;
  },
): WisdomInjectPick[] {
  const coreMax = options?.coreMaxItems ?? 8;
  const scenarioMax = options?.scenarioMaxItems ?? 8;
  const includeTrial = options?.includeTrial ?? false;

  const usable = entries.filter((e) => {
    if (e.status === 'retired' || e.status === 'superseded' || e.status === 'candidate') return false;
    if (e.status === 'contested') return false;
    if (e.status === 'trial' && !includeTrial) return false;
    return true;
  });

  const scored = usable.map((e) => ({
    entry: e,
    match: scenarioMatchScore(e, text),
    score: wisdomInjectScore(e, 1),
    scenarioScore: wisdomInjectScore(e, scenarioMatchScore(e, text)),
  }));

  // core：宽覆盖（多 problemTypes 或 strengthened/factory）优先
  const coreCandidates = scored
    .filter((s) => s.entry.origin === 'factory' || s.entry.status === 'strengthened' || s.entry.scenario.problemTypes.length >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, coreMax)
    .map((s) => ({ entry: s.entry, bucket: 'core' as const, score: 1 }));

  const coreIds = new Set(coreCandidates.map((c) => c.entry.id));
  const scenario = scored
    .filter((s) => s.match > 0 && !coreIds.has(s.entry.id))
    .sort((a, b) => b.scenarioScore - a.scenarioScore)
    .slice(0, scenarioMax)
    .map((s) => ({ entry: s.entry, bucket: 'scenario' as const, score: s.match }));

  return [...coreCandidates, ...scenario];
}

// ── 注入排版 ──

/**
 * 按 problemTypes 分组渲染 system 片段（不含 # 思维框架 头，由 WisdomLayer 加）。
 *
 * @param picks - 注入选择
 * @returns 正文
 */
export function formatWisdomBody(picks: WisdomInjectPick[]): string {
  if (picks.length === 0) return '';
  const byType = new Map<string, WisdomEntry[]>();
  for (const p of picks) {
    const key = p.entry.scenario.problemTypes[0] ?? '通用';
    const list = byType.get(key) ?? [];
    list.push(p.entry);
    byType.set(key, list);
  }
  const blocks: string[] = [];
  for (const [type, list] of byType) {
    const lines = list.map((e) => formatWisdomBullet(e));
    blocks.push(`## 面对「${type}」\n\n${lines.join('\n\n')}`);
  }
  return blocks.join('\n\n');
}

function formatWisdomBullet(e: WisdomEntry): string {
  const parts = [`- ${e.statement}`];
  const effectBits: string[] = [];
  if (e.effect.posture) effectBits.push(`推理姿态：${e.effect.posture}`);
  if (e.effect.questions?.length) effectBits.push(`先问：${e.effect.questions.join('；')}`);
  if (effectBits.length) parts.push(`  ${effectBits.join('。')}。`);
  const anti = e.scenario.antiScenarios?.[0];
  if (anti) parts.push(`  不适用：${anti}`);
  return parts.join('\n');
}
