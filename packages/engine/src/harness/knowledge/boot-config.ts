/**
 * octopi.json `knowledge.*` 调参面 → Knowledge Service boot 调参块（唯一映射点）
 *
 * 背景：v0.51 Gateway 直连 knowledge.db 时这些键全量贯通；v0.60 拆独立 Service
 * 后传递线丢失（配了不生效，见 arch/config-key-audit-2026-11-01.md §1a/§2）。
 * v0.98.11 起经 boot 文件传入 Service——schema 形状（knowledge.embed / index /
 * load / keywordWeight / autoInject / hint）到消费侧形状（KnowledgeIngestOptions /
 * KnowledgeRetrieverOptions）的转换只发生在这里。
 *
 * @module harness/knowledge/boot-config
 */
import type { KnowledgeRuntimeConfig } from '../../config.js';
import type { KnowledgeFileLimitsInput } from './file-limits.js';

/** Phase B 向量化调参（KnowledgeIngestOptions embed 子集 + 启用开关） */
export interface KnowledgeBootEmbed {
  /** false = 纯关键词索引（不外发 embed）；缺省 true */
  enabled?: boolean;
  embedBatch?: number;
  embedMinIntervalMs?: number;
  embedConcurrency?: number;
  embedSecretPolicy?: 'allow' | 'redact' | 'skip';
}

/** Ingest 调参（KnowledgeIngestOptions 子集） */
export interface KnowledgeBootIngest {
  parseConcurrency?: number;
  /** fs watch debounce ms */
  debounceMs?: number;
  /** 队列深度上限（超出只报警，不丢任务） */
  maxQueueDepth?: number;
  diskWatermarkAlert?: boolean;
  fileLimits?: KnowledgeFileLimitsInput;
}

/** 检索调参（KnowledgeRetrieverOptions 子集） */
export interface KnowledgeBootRetriever {
  hybridKeyword?: boolean;
  keywordWeight?: number;
  injectMinScore?: number;
  hintMinScore?: number;
  minCoverage?: number;
}

/** boot 文件里的调参块 */
export interface KnowledgeBootTuning {
  embed?: KnowledgeBootEmbed;
  ingest?: KnowledgeBootIngest;
  retriever?: KnowledgeBootRetriever;
  /** false = 索引稳定后不自动生成 generatedDescription（catalog.autoDescribe；仅 manageLocal） */
  autoDescribe?: boolean;
}

/** 去掉值为 undefined 的键，保证输出只含显式配置（可安全展开进选项对象） */
function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * 把 `knowledge.*` 配置映射为 Service boot 调参块。
 *
 * @param kn - octopi.json 的 knowledge 段（undefined = 全默认）
 * @returns 调参三块；未配置的键不出现在输出中（消费侧用各自默认值）
 */
export function knowledgeTuningFromConfig(
  kn?: KnowledgeRuntimeConfig | null,
): KnowledgeBootTuning {
  if (!kn) return {};
  const tuning: KnowledgeBootTuning = {};

  const embed = definedOnly({
    enabled: kn.embed?.enabled,
    embedBatch: kn.embed?.embedBatch,
    embedMinIntervalMs: kn.embed?.embedMinIntervalMs,
    embedConcurrency: kn.embed?.embedConcurrency,
    embedSecretPolicy: kn.embed?.embedSecretPolicy,
  });
  if (Object.keys(embed).length > 0) tuning.embed = embed;

  const ingest = definedOnly({
    parseConcurrency: kn.load?.parseConcurrency,
    debounceMs: kn.load?.debounceMs,
    maxQueueDepth: kn.index?.queue?.maxDepth,
    diskWatermarkAlert: kn.load?.diskWatermarkAlert,
    fileLimits: kn.index?.files,
  });
  if (Object.keys(ingest).length > 0) tuning.ingest = ingest;

  const retriever = definedOnly({
    hybridKeyword: kn.index?.hybridKeyword,
    keywordWeight: kn.keywordWeight,
    injectMinScore: kn.autoInject?.minScore,
    hintMinScore: kn.hint?.minScore,
    minCoverage: kn.autoInject?.minCoverage,
  });
  if (Object.keys(retriever).length > 0) tuning.retriever = retriever;

  if (kn.catalog?.autoDescribe !== undefined) tuning.autoDescribe = kn.catalog.autoDescribe;

  return tuning;
}
