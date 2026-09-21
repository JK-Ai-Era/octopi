/**
 * Summary 公用能力 — 类型契约
 *
 * @module harness/capabilities/summary/types
 */

import type { ModelProvider } from '../../../core/interfaces/model-provider.js';

/** 内容进入 SummaryPort 的通道（不是 ContentKind） */
export type ContentChannel = 'tool' | 'pipeline' | 'subsystem' | 'direct';

/**
 * 内容形态 — Policy 选择主键。
 * `tool_output` 刻意不存在：工具结果用 channel=tool + kind。
 */
export type ContentKind =
  | 'web_page'
  | 'file_text'
  | 'document'
  | 'code'
  | 'api_json'
  | 'log'
  | 'conversation'
  | 'opaque'
  | 'auto';

export type ContentFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';

export interface ContentSourceMeta {
  tool?: string;
  locator?: string;
  contentType?: string;
  extension?: string;
  sizeBytes?: number;
}

export interface ContentUnit {
  text: string;
  structured?: unknown;
  channel: ContentChannel;
  source: ContentSourceMeta;
  kind?: ContentKind;
  task?: string;
  policy?: SummaryPolicy | string;
}

export interface SummaryExtractRules {
  include: string[];
  exclude: string[];
  fields?: string[];
}

export interface OversizedPolicy {
  strategy: 'map_reduce' | 'window' | 'truncate_fallback' | 'fail';
  maxChunks?: number;
  chunkOverlapTokens?: number;
  onPartial?: 'accept' | 'mark' | 'reject';
}

export interface SummaryPolicy {
  id: string;
  contentKind: ContentKind | ContentKind[];
  modelLevel?: string;
  model?: string;
  goalHint?: string;
  extract: SummaryExtractRules;
  preserve: string[];
  budget: {
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  output: 'text' | 'structured_json';
  /** structured_json 契约字段；声明后必做 L1 轻量校验 */
  fields?: string[];
  fieldTypes?: Record<string, ContentFieldType>;
  /** 完整 JSON Schema（可选；需注入 StructuredValidator） */
  schema?: Record<string, unknown>;
  oversized: OversizedPolicy;
  temperature?: number;
  systemPromptTemplate?: string;
}

export interface SummaryGateConfig {
  minTokens?: number;
  minBytes?: number;
  respectPolicyBudget?: boolean;
}

export type ToolSummaryMode = 'auto' | 'over_threshold' | 'always' | 'never' | 'kind_sensitive';

export interface ToolSummaryBinding {
  tool: string;
  mode: ToolSummaryMode;
  gate?: SummaryGateConfig;
  maxReturnChars: number;
  defaultPolicyId?: string;
  kindFromSource?: boolean;
  informationalKinds?: ContentKind[];
  onFail?: 'truncate_l1' | 'error';
  agentParams?: {
    summarize?: string;
    policy?: string;
    kind?: string;
    task?: string;
  };
}

export type SummaryCoverage = 'full' | 'partial' | 'windowed' | 'truncated';

export interface SummaryResult {
  text: string;
  structured?: unknown;
  structuredError?: string;
  coverage: SummaryCoverage;
  tokensIn: number;
  tokensOut: number;
  /** Provider 上报的完整 usage（含 cache 分项），用于 UsageLedger 归因 */
  usage?: import('../../../core/types/turn.js').TokenUsage;
  truncatedInput?: boolean;
  chunks?: { total: number; processed: number };
  policyId: string;
  kind: ContentKind;
  model?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface SummaryPort {
  shouldProcess(unit: ContentUnit, gate?: SummaryGateConfig): boolean;
  extract(
    unit: ContentUnit,
    opts?: { signal?: AbortSignal; previousSummary?: string },
  ): Promise<SummaryResult>;
  resolvePolicy(unit: ContentUnit): SummaryPolicy;
}

export interface StructuredValidator {
  validate(value: unknown, schema: Record<string, unknown>): { ok: boolean; error?: string };
}

export interface SummaryCachePort {
  get(key: string): SummaryResult | undefined;
  set(key: string, value: SummaryResult, ttlMs: number): void;
}

export interface ResolveSummaryModelInput {
  providers: Map<string, ModelProvider>;
  levelMap?: Record<string, { primary: string; fallback?: string[] }>;
  fallbackProvider?: ModelProvider;
  /** config.contextEngine.summaryModel 兼容键 */
  legacySummaryModel?: string;
  /** config.summary.model 显式 */
  explicitModel?: string;
  /** config.summary.modelLevel，默认 'summary' */
  modelLevel?: string;
  /** policy.modelLevel / policy.model */
  policyModelLevel?: string;
  policyModel?: string;
}

export interface ResolvedSummaryModel {
  provider: ModelProvider;
  model?: string;
  from: 'policy.model' | 'policy.modelLevel' | 'explicit' | 'level.summary' | 'legacy' | 'mini' | 'standard' | 'fallback';
}

export interface CreateSummaryPortOptions {
  providers: Map<string, ModelProvider>;
  levelMap?: Record<string, { primary: string; fallback?: string[] }>;
  fallbackProvider: ModelProvider;
  legacySummaryModel?: string;
  model?: string;
  modelLevel?: string;
  /** 整策略替换（同 id 全量覆盖） */
  policyOverrides?: Record<string, SummaryPolicy>;
  gate?: SummaryGateConfig;
  defaultInputBudgetTokens?: number;
  safetyMarginTokens?: number;
  oversizedStrategy?: OversizedPolicy['strategy'];
  structuredValidator?: StructuredValidator;
  cache?: SummaryCachePort;
  cacheTtlMs?: number;
  cacheEnabled?: boolean;
  toolBindings?: Record<string, Partial<ToolSummaryBinding>>;
  maxReturnCharsDefault?: number;
  /** Summary LLM 调用的 usage 回调（用于 UsageLedger 归因） */
  onUsage?: (usage: import('../../../core/types/turn.js').TokenUsage) => void;
}
