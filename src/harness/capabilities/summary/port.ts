/**
 * createSummaryPort — SummaryPort 工厂
 *
 * @module harness/capabilities/summary/port
 */

import { executeSummary } from './executor.js';
import { mergeGate, shouldProcessUnit } from './gate.js';
import { createDefaultToolBindings, resolveToolBinding } from './registry.js';
import { buildPolicyRegistry, resolveKind, resolvePolicyForUnit, resolveSummaryModel } from './resolver.js';
import type {
  ContentUnit,
  CreateSummaryPortOptions,
  SummaryGateConfig,
  SummaryPolicy,
  SummaryPort,
  SummaryResult,
  ToolSummaryBinding,
} from './types.js';

/**
 * 创建 SummaryPort
 *
 * @param options - providers / levelMap / policy / gate / oversizedStrategy 等
 * @returns SummaryPort
 */
export function createSummaryPort(options: CreateSummaryPortOptions): SummaryPort {
  const registry = buildPolicyRegistry(options.policyOverrides);
  const gate = mergeGate(options.gate);
  /** 部署级 oversized.strategy 覆盖：在 resolve 后统一套用（policy 对象可仍带自己的 maxChunks 等） */
  const deployOversizedStrategy = options.oversizedStrategy;

  const resolveModel = (policyModel?: string, policyModelLevel?: string) =>
    resolveSummaryModel({
      providers: options.providers,
      levelMap: options.levelMap,
      fallbackProvider: options.fallbackProvider,
      legacySummaryModel: options.legacySummaryModel,
      explicitModel: options.model,
      modelLevel: options.modelLevel,
      policyModel,
      policyModelLevel,
    });

  const resolvePolicy = (unit: ContentUnit): SummaryPolicy => {
    const base = resolvePolicyForUnit(unit, registry);
    if (!deployOversizedStrategy) return base;
    return {
      ...base,
      oversized: { ...base.oversized, strategy: deployOversizedStrategy },
    };
  };

  return {
    shouldProcess(unit: ContentUnit, gateOverride?: SummaryGateConfig): boolean {
      const policy = resolvePolicy(unit);
      return shouldProcessUnit(unit, mergeGate(gate, gateOverride), policy.budget.maxInputTokens);
    },

    resolvePolicy(unit) {
      return resolvePolicy(unit);
    },

    async extract(unit, opts): Promise<SummaryResult> {
      const kind = resolveKind(unit);
      const policy = resolvePolicy(unit);
      const resolved = resolveModel(policy.model, policy.modelLevel);

      if (options.cacheEnabled && options.cache) {
        const key = cacheKey(unit, policy.id, resolved.model, unit.task);
        const hit = options.cache.get(key);
        if (hit) return { ...hit, skipReason: hit.skipReason ?? 'cache_hit' };
      }

      // 根因：预算必须吃 provider catalog 窗口，而不是永远 defaultInputBudgetTokens
      const modelName = resolved.model ?? resolved.provider.defaultModel ?? '';
      const modelInfo = modelName
        ? resolved.provider.getModelInfo?.(modelName) ?? null
        : null;

      const result = await executeSummary({
        text: unit.text,
        kind,
        policy,
        task: unit.task,
        provider: resolved.provider,
        model: resolved.model,
        contextWindow: modelInfo?.contextWindow,
        defaultInputBudgetTokens: options.defaultInputBudgetTokens,
        safetyMarginTokens: options.safetyMarginTokens,
        previousSummary: opts?.previousSummary,
        validator: options.structuredValidator,
        signal: opts?.signal,
      });

      // Summary LLM usage 归因到 UsageLedger
      if (result.usage && options.onUsage) {
        options.onUsage(result.usage);
      }

      if (options.cacheEnabled && options.cache && !result.structuredError) {
        const key = cacheKey(unit, policy.id, resolved.model, unit.task);
        options.cache.set(key, result, options.cacheTtlMs ?? 600_000);
      }
      return result;
    },
  };
}

function cacheKey(unit: ContentUnit, policyId: string, model: string | undefined, task?: string): string {
  const locator = unit.source.locator ?? '';
  const etag = unit.source.contentType ?? '';
  const contentHash = simpleHash(unit.text);
  return `${policyId}|${model ?? ''}|${task ?? ''}|${locator}|${etag}|${contentHash}`;
}

function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * 解析工具 binding（内置 + options.toolBindings）— 配置与 tools 的同一解析入口
 *
 * @param tool - 工具名
 * @param options - createSummaryPortOptions 中的 binding 覆盖
 * @returns binding
 */
export function getToolSummaryBinding(
  tool: string,
  options: Pick<CreateSummaryPortOptions, 'toolBindings' | 'maxReturnCharsDefault'>,
): ToolSummaryBinding {
  return resolveToolBinding(
    tool,
    createDefaultToolBindings(),
    options.toolBindings,
    options.maxReturnCharsDefault ?? 8000,
  );
}

/**
 * 构造注入 tools 的 ToolSummarySupport（port + 配置 binding 表）
 *
 * @param port - SummaryPort
 * @param options - 同 createSummaryPort 的 tools 覆盖
 * @returns ToolSummarySupport
 */
export function createToolSummarySupport(
  port: SummaryPort,
  options: Pick<CreateSummaryPortOptions, 'toolBindings' | 'maxReturnCharsDefault'>,
): import('./tool-binding.js').ToolSummarySupport {
  return {
    port,
    toolBindings: options.toolBindings,
    maxReturnCharsDefault: options.maxReturnCharsDefault,
  };
}
