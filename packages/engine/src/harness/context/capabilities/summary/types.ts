/**
 * Summary 公用能力 — 类型契约
 *
 * @module harness/context/capabilities/summary/types
 */

import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';

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

/**
 * L1 硬顶截断的保留策略
 *
 * - `head`：保留开头（缺省，向后兼容）——适合「后续可用 offset 续读」的场景（file_read）
 * - `tail`：保留结尾——适合「结论在末尾」的场景（测试汇总、退出信息、日志尾）
 * - `both`：保头 + 保尾 + 中间省略——适合「开头是上下文、末尾是结论」的混合输出
 *
 * 缺省 `head`：不改变任何既有工具的行为，只在声明的工具上生效。
 */
export type L1KeepMode = 'head' | 'tail' | 'both';

export interface ToolSummaryBinding {
  tool: string;
  mode: ToolSummaryMode;
  gate?: SummaryGateConfig;
  maxReturnChars: number;
  /**
   * L1 截断保留策略（缺省 `head`）
   *
   * 由**工具定义方**声明（不是 LLM 参数）：工具作者知道自己的输出哪一端承载结论。
   */
  l1Keep?: L1KeepMode;
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
  usage?: import('@octopi-agent/core/types/step.js').TokenUsage;
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
  /** config.summary.model 显式 */
  explicitModel?: string;
  /** config.summary.modelLevel，默认 'mini' */
  modelLevel?: string;
  /** policy.modelLevel / policy.model */
  policyModelLevel?: string;
  policyModel?: string;
}

export interface ResolvedSummaryModel {
  provider: ModelProvider;
  model?: string;
  from: 'policy.model' | 'policy.modelLevel' | 'explicit' | 'level' | 'mini' | 'standard' | 'fallback';
}

export interface CreateSummaryPortOptions {
  providers: Map<string, ModelProvider>;
  levelMap?: Record<string, { primary: string; fallback?: string[] }>;
  fallbackProvider: ModelProvider;
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
  onUsage?: (usage: import('@octopi-agent/core/types/step.js').TokenUsage) => void;
}
