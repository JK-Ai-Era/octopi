/**
 * Memory Extractor Subsystem — Handler
 *
 * 定义文件驱动的子系统 handler。支持两种模式：
 * - code（纯规则）：规则提取 → 去重 → 阈值 → 入库
 * - hybrid（规则+LLM）：规则提取 → LLM 语义增强 → 合并 → 去重 → 阈值 → 入库
 *
 * 配置通过注入依赖 `__subsystem_config__` 传入（由 SubsystemRuntime 从 spec.metadata.config 自动注入）。
 * 无模块级状态，支持多实例隔离。
 *
 * @module subsystems/memory-extractor/handler
 */

import type { SubsystemInput, SubsystemOutput, InjectedDependencies } from '../../harness/autonomous-subsystem/types.js';
import type { MemoryStore, MemoryType } from '../../harness/memory/types.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type {
  SessionExtractBundle,
  SessionExtractEvent,
  SessionExtractEventType,
  MemoryCandidate,
} from './contracts/bundle.js';
import { MemoryDeduplicator } from './policies/dedup.js';
import { defaultThresholdPolicy, type ThresholdPolicyInput } from './policies/threshold.js';
import { enrichWithLLM } from './llm-enrichment.js';
import type { MemoryExtractorConfig } from './types.js';
import { DEP_MEMORY_STORE, DEP_MODEL_PROVIDER, DEP_CONFIG, DEFAULT_CONFIG } from './types.js';

// ── 规则信号函数（语言无关） ──

function countEvents(bundle: SessionExtractBundle, type: SessionExtractEventType): number {
  return bundle.events.filter((e) => e.type === type).length;
}

function uniqueTurnIds(events: SessionExtractEvent[]): string[] {
  return [...new Set(events.map((e) => e.turnId).filter(Boolean))] as string[];
}

// ── 规则提取器 ──

export function extractCandidates(bundle: SessionExtractBundle): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];

  // 1) preference（用户约束/确认）
  const constraintCount = countEvents(bundle, 'constraint_set') + countEvents(bundle, 'user_confirm');
  if (constraintCount >= 1) {
    const turnIds = uniqueTurnIds(bundle.events.filter((e) => e.type === 'constraint_set' || e.type === 'user_confirm'));
    candidates.push({
      type: 'preference',
      content: `用户在会话中明确表达/确认了 ${constraintCount} 条约束或偏好`,
      source: `session:${bundle.sessionId};turns:${turnIds.join(',') || 'unknown'}`,
      evidence: bundle.events.filter((e) => e.type === 'constraint_set' || e.type === 'user_confirm').map((_, i) => `evt_${i}`),
      confidence: Math.min(1, 0.6 + constraintCount * 0.1),
      importance: 0.7,
      tags: ['preference', 'human'],
    });
  }

  // 2) decision（决策点）
  const decisionCount = countEvents(bundle, 'decision_made') + countEvents(bundle, 'decision_override');
  if (decisionCount >= 1) {
    const turnIds = uniqueTurnIds(bundle.events.filter((e) => e.type === 'decision_made' || e.type === 'decision_override'));
    candidates.push({
      type: 'decision',
      content: `会话中形成/覆盖了 ${decisionCount} 个关键决策`,
      source: `session:${bundle.sessionId};turns:${turnIds.join(',') || 'unknown'}`,
      evidence: bundle.events.filter((e) => e.type === 'decision_made' || e.type === 'decision_override').map((_, i) => `dec_${i}`),
      confidence: 0.8,
      importance: 0.8,
      tags: ['decision'],
    });
  }

  // 3) lesson（失败→修复）
  const failureCount = countEvents(bundle, 'tool_failure') + countEvents(bundle, 'error');
  const fixCount = countEvents(bundle, 'fix_applied');
  if (failureCount >= 2 && fixCount >= 1) {
    candidates.push({
      type: 'lesson',
      content: `出现 ${failureCount} 次失败并在后续修复 ${fixCount} 次，形成可复用经验`,
      source: `session:${bundle.sessionId}`,
      evidence: ['failure_count', 'fix_count'],
      confidence: 0.78,
      importance: 0.85,
      tags: ['lesson', 'reliability'],
    });
  }

  // 4) discovery（总结型发现）
  const summaryCount = countEvents(bundle, 'assistant_summary');
  if (summaryCount >= 1) {
    candidates.push({
      type: 'discovery',
      content: `助手在会话中给出了 ${summaryCount} 次关键总结/发现`,
      source: `session:${bundle.sessionId}`,
      evidence: ['assistant_summary'],
      confidence: 0.66,
      importance: 0.7,
      tags: ['discovery'],
    });
  }

  return candidates;
}

// ── 配置解析（无状态） ──

function resolveConfig(deps?: InjectedDependencies): MemoryExtractorConfig {
  const injected = (deps?.[DEP_CONFIG] ?? undefined) as MemoryExtractorConfig | undefined;
  return { ...DEFAULT_CONFIG, ...injected };
}

// ── 核心 Handler ──

/**
 * memory-extractor 子系统的核心执行函数
 *
 * @param input - 子系统输入（payload 中携带 SessionExtractBundle）
 * @param deps - 注入依赖（memoryStore、可选 modelProvider、可选 __subsystem_config__）
 */
async function handler(input: SubsystemInput, deps?: InjectedDependencies): Promise<SubsystemOutput> {
  const config = resolveConfig(deps);
  const memoryStore = (deps?.[DEP_MEMORY_STORE] ?? undefined) as MemoryStore | undefined;
  if (!memoryStore) {
    return {
      signals: [{
        action: 'alert',
        reason: 'memory-extractor: memoryStore not injected, skipping extraction',
        confidence: 1,
      }],
    };
  }

  // 从 payload 中获取 bundle
  const payloadBundle = (input.payload?.sessionExtractBundle ?? undefined) as SessionExtractBundle | undefined;
  const bundle = (payloadBundle ?? {
    sessionId: input.sessionMetadata?.sessionId ?? 'unknown',
    agentId: input.sessionMetadata?.agentId ?? 'unknown',
    startAt: Date.now(),
    events: [],
    condensedTurns: [],
    runSummary: { totalTurns: 0, totalToolCalls: 0, failureRate: 0, majorErrors: [], resolvedErrors: [] },
  }) as SessionExtractBundle;

  // ── Step 1: 规则提取 ──
  const ruleCandidates = extractCandidates(bundle);

  // ── Step 2: LLM 语义增强（hybrid 模式，可选） ──
  let llmCandidates: MemoryCandidate[] = [];
  const modelProvider = (deps?.[DEP_MODEL_PROVIDER] ?? undefined) as ModelProvider | undefined;
  if (modelProvider && config.llmEnrichment) {
    // 优先使用运行时解析的实际模型名（来自 ModelResolver），降级到配置中的级别名
    const resolvedModel = (deps?.['__resolved_model__'] as string | undefined) ?? config.llmEnrichment.model;
    llmCandidates = await enrichWithLLM(modelProvider, bundle, ruleCandidates, { ...config.llmEnrichment, model: resolvedModel });
  }

  // ── Step 3: 合并候选 ──
  const allCandidates = [...ruleCandidates, ...llmCandidates];

  // ── Step 4: 去重与升级 ──
  const deduper = new MemoryDeduplicator(memoryStore);
  const deduped = await deduper.filterAndUpgrade(allCandidates);

  // ── Step 5: 动态阈值过滤 ──
  const policyInput: ThresholdPolicyInput = {
    runSummary: bundle.runSummary,
    eventCount: bundle.events.length,
    agentProfile: config.agentProfile,
  };
  const dynamic = (config.thresholdPolicy ?? defaultThresholdPolicy)(policyInput);
  const minConf = dynamic.minConfidence ?? config.minConfidence ?? 0.6;
  const minImp = dynamic.minImportance ?? config.minImportance ?? 0.6;
  const accepted = deduped.filter((c) => c.confidence >= minConf && c.importance >= minImp);
  const gated = deduped.length - accepted.length;

  // ── Step 6: 入库 ──
  for (const c of accepted) {
    await memoryStore.store({
      type: c.type,
      content: c.content,
      source: c.source,
      confidence: c.confidence,
      importance: c.importance,
      tags: c.tags,
    });
  }

  // ── Step 7: 返回信号 ──
  const mode = modelProvider && config.llmEnrichment ? 'hybrid' : 'code';
  return {
    act: {
      mode: 'inject',
      status: 'success',
      target: 'memory-store',
      messages: [
        {
          role: 'system',
          content: `memory.extracted [${mode}] accepted=${accepted.length} candidates=${allCandidates.length} (rule=${ruleCandidates.length}, llm=${llmCandidates.length})`,
        },
      ],
    },
    signals: [
      {
        action: 'suggest',
        reason: `Memory extraction completed [${mode}] (accepted=${accepted.length}, rule=${ruleCandidates.length}, llm=${llmCandidates.length})`,
        confidence: 0.9,
        data: {
          mode,
          extractedCount: accepted.length,
          rawCandidateCount: allCandidates.length,
          ruleCandidateCount: ruleCandidates.length,
          llmCandidateCount: llmCandidates.length,
          dedupedCount: deduped.length,
          gatedCount: gated,
          bundleSessionId: bundle.sessionId,
        },
      },
    ],
  };
}

// ── 便捷调用入口（供测试和直接使用） ──

/**
 * 直接调用 handler 的便捷函数
 *
 * 绕过 SubsystemRuntime，手动组装 deps。
 * 适用于测试和嵌入式场景。
 *
 * @param input - 子系统输入
 * @param memoryStore - 记忆存储
 * @param options - 可选配置（config、modelProvider）
 */
export async function callHandler(
  input: SubsystemInput,
  memoryStore: MemoryStore,
  options?: { config?: Partial<MemoryExtractorConfig>; modelProvider?: ModelProvider },
): Promise<SubsystemOutput> {
  const deps: InjectedDependencies = {
    [DEP_MEMORY_STORE]: memoryStore,
    [DEP_CONFIG]: { ...DEFAULT_CONFIG, ...options?.config },
  };
  if (options?.modelProvider) {
    deps[DEP_MODEL_PROVIDER] = options.modelProvider;
  }
  return handler(input, deps);
}

// ── 标准契约导出 ──

export default {
  handler,
  contract: {
    input: 'SessionExtractBundle',
    output: 'ExtractionResult',
  },
  dependencies: [DEP_MEMORY_STORE, DEP_MODEL_PROVIDER],
};

// 传统导出（向后兼容）
export { handler };

// 重导出公共 API
export type { MemoryCandidate, SessionExtractBundle } from './contracts/bundle.js';
