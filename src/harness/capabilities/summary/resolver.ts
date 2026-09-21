/**
 * Policy / 模型解析链
 *
 * @module harness/capabilities/summary/resolver
 */

import type { ModelProvider } from '../../../core/interfaces/model-provider.js';
import { createDefaultSummaryPolicies } from './policies.js';
import {
  defaultKindForTool,
  defaultPolicyIdForKind,
  kindFromContentType,
  kindFromExtension,
} from './registry.js';
import type {
  ContentKind,
  ContentUnit,
  ResolveSummaryModelInput,
  ResolvedSummaryModel,
  SummaryPolicy,
} from './types.js';

/**
 * 解析 ContentUnit 的 kind（channel 与 kind 分维）
 *
 * @param unit - 内容单元
 * @returns 解析后的 kind（永不 auto 时返回 opaque 仅当显式无法路由且需要 policy）
 */
export function resolveKind(unit: ContentUnit): ContentKind {
  if (unit.kind && unit.kind !== 'auto') return unit.kind;
  if (unit.source.contentType) {
    const k = kindFromContentType(unit.source.contentType);
    if (k !== 'auto') return k;
  }
  if (unit.source.extension) {
    const k = kindFromExtension(unit.source.extension);
    if (k !== 'auto') return k;
  }
  if (unit.source.tool) {
    const k = defaultKindForTool(unit.source.tool);
    if (k !== 'auto') return k;
  }
  return 'opaque';
}

/**
 * 解析最终 SummaryPolicy（§3.7 链）
 *
 * @param unit - 内容单元
 * @param registry - id → policy（已含整策略覆盖）
 * @returns 完整 policy
 */
export function resolvePolicyForUnit(
  unit: ContentUnit,
  registry: Record<string, SummaryPolicy>,
): SummaryPolicy {
  if (unit.policy && typeof unit.policy === 'object') return unit.policy;
  if (typeof unit.policy === 'string' && registry[unit.policy]) return registry[unit.policy];

  const kind = resolveKind(unit);
  const kindPolicyId = defaultPolicyIdForKind(kind);
  if (registry[kindPolicyId]) return registry[kindPolicyId];
  return registry['opaque_generic'] ?? Object.values(registry)[0] ?? fallbackPolicy();
}

/**
 * 合并策略注册表：内置 + 配置整策略替换
 *
 * @param overrides - 配置里的 policies（同 id 全量替换）
 * @returns 注册表
 */
export function buildPolicyRegistry(overrides?: Record<string, SummaryPolicy>): Record<string, SummaryPolicy> {
  return { ...createDefaultSummaryPolicies(), ...(overrides ?? {}) };
}

function fallbackPolicy(): SummaryPolicy {
  return {
    id: 'opaque_generic',
    contentKind: 'opaque',
    extract: { include: ['useful facts'], exclude: [] },
    preserve: [],
    budget: { maxInputTokens: 12000, maxOutputTokens: 1200 },
    output: 'text',
    oversized: { strategy: 'window', maxChunks: 4, onPartial: 'mark' },
  };
}

function parseProviderModel(ref: string): { provider: string; model: string } | null {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/**
 * 解析摘要用 ModelProvider（priority: policy.model → policy.modelLevel → explicit → level.summary → legacy → mini → standard → fallback）
 *
 * @param input - providers / levelMap / 显式与兼容配置
 * @returns 解析结果
 */
export function resolveSummaryModel(input: ResolveSummaryModelInput): ResolvedSummaryModel {
  const pickLevel = (levelName: string): ResolvedSummaryModel | null => {
    const primary = input.levelMap?.[levelName]?.primary;
    if (!primary) return null;
    const parsed = parseProviderModel(primary);
    if (!parsed) return null;
    const provider = input.providers.get(parsed.provider);
    if (!provider) return null;
    return { provider, model: parsed.model, from: levelName === 'summary' ? 'level.summary' : (levelName as ResolvedSummaryModel['from']) };
  };

  const tryModelRef = (ref: string, from: ResolvedSummaryModel['from']): ResolvedSummaryModel | null => {
    const parsed = parseProviderModel(ref);
    if (parsed) {
      const provider = input.providers.get(parsed.provider);
      if (provider) return { provider, model: parsed.model, from };
      return null;
    }
    // bare model name on fallback provider
    if (input.fallbackProvider) return { provider: input.fallbackProvider, model: ref, from };
    return null;
  };

  if (input.policyModel) {
    const r = tryModelRef(input.policyModel, 'policy.model');
    if (r) return r;
  }
  if (input.policyModelLevel) {
    const r = pickLevel(input.policyModelLevel);
    if (r) return { ...r, from: 'policy.modelLevel' };
  }
  if (input.explicitModel) {
    const r = tryModelRef(input.explicitModel, 'explicit');
    if (r) return r;
  }

  const levelName = input.modelLevel ?? 'summary';
  const summaryLevel = pickLevel(levelName);
  if (summaryLevel) return { ...summaryLevel, from: 'level.summary' };

  if (input.legacySummaryModel) {
    const r = tryModelRef(input.legacySummaryModel, 'legacy');
    if (r) return r;
  }

  const mini = pickLevel('mini');
  if (mini) return { ...mini, from: 'mini' };
  const standard = pickLevel('standard');
  if (standard) return { ...standard, from: 'standard' };

  return {
    provider: input.fallbackProvider ?? ({ name: 'missing', defaultModel: 'missing', chat: async () => ({ content: '', model: 'missing', finishReason: 'stop' as const }), stream: async function* () { yield { type: 'done' as const }; }, isAvailable: async () => false, getModelInfo: () => null, getModelInfos: () => [] } as unknown as ModelProvider),
    model: undefined,
    from: 'fallback',
  };
}
