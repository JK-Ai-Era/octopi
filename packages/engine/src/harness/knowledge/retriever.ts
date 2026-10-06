/**
 * KnowledgeRetriever — hybrid 检索 + auto-ground 降级（P3）
 */

import type { EmbeddingProvider } from '../memory/sqlite/embedding.js';
import type { ChunkHit, KnowledgeIndexStore } from './index-store.js';
import type { KnowledgeSourceStore } from './source-store.js';

export type GroundingMode = 'inject' | 'hint' | 'none';
export type KnowledgeRecallMode = 'off' | 'hint' | 'hybrid' | 'inject';

export interface HybridSearchOptions {
  agentId: string;
  sessionId?: string;
  limit?: number;
  /** 仅关键词（跳过 embedding query） */
  keywordOnly?: boolean;
  /** 跨 Gateway 隔离：registered_by ∪ public */
  tenantId?: string;
  gatewayId?: string;
  /**
   * 可选源过滤（与可见集求交，禁止越权）。
   * `sourceIds` 精确 id；`source` 为 displayName/id 模糊（单源）。
   */
  sourceIds?: string[];
  source?: string;
}

export interface HybridSearchResult {
  hits: ChunkHit[];
  usedVector: boolean;
  keywordHits: number;
  vectorHits: number;
  /** 0–1：索引文件覆盖粗度（P2）× 向量覆盖（有 provider 时） */
  coverage: number;
  sourceIds: import('./types.js').KnowledgeSourceId[];
  /** 向量后端（百万级应为 sqlite-vec） */
  vectorBackend?: 'sqlite-vec' | 'js-bucket' | 'disabled';
}

export interface AutoGroundDecision {
  mode: GroundingMode;
  hits: ChunkHit[];
  hint?: string;
  reason: string;
  coverage: number;
  scoreFloor: number;
}

export interface KnowledgeRetrieverOptions {
  sourceStore: KnowledgeSourceStore;
  indexStore: KnowledgeIndexStore;
  embeddingProvider?: EmbeddingProvider | null;
  /** hybrid 权重：keyword 相对（默认 0.45） */
  keywordWeight?: number;
  /** auto-inject 最低分（默认 0.78，语义分归一后） */
  injectMinScore?: number;
  /** hint 最低分（默认 0.55） */
  hintMinScore?: number;
  /** coverage 低于此值时抬高地板（默认 0.5） */
  minCoverage?: number;
  maxChunks?: number;
  /** 是否启用关键词腿（默认 true；false 时仅向量） */
  hybridKeyword?: boolean;
  /**
   * 内容召回模式（Agent 级；默认 hybrid）
   * off→none；hint→禁止 inject；inject→更积极；hybrid→标准
   */
  recall?: KnowledgeRecallMode;
}

/**
 * 检索门面：可见集 → keyword + vector → 融合
 */
export class KnowledgeRetriever {
  private readonly sources: KnowledgeSourceStore;
  private readonly index: KnowledgeIndexStore;
  private readonly embedding: EmbeddingProvider | null;
  private readonly keywordWeight: number;
  private readonly injectMinScore: number;
  private readonly hintMinScore: number;
  private readonly minCoverage: number;
  private readonly maxChunks: number;
  private readonly recall: KnowledgeRecallMode;
  private readonly hybridKeyword: boolean;

  constructor(options: KnowledgeRetrieverOptions) {
    this.sources = options.sourceStore;
    this.index = options.indexStore;
    this.embedding = options.embeddingProvider ?? null;
    this.keywordWeight = options.keywordWeight ?? 0.45;
    this.injectMinScore = options.injectMinScore ?? 0.78;
    this.hintMinScore = options.hintMinScore ?? 0.55;
    this.minCoverage = options.minCoverage ?? 0.5;
    this.maxChunks = options.maxChunks ?? 4;
    this.recall = options.recall ?? 'hybrid';
    this.hybridKeyword = options.hybridKeyword !== false;
  }

  /**
   * 可见 sourceId 列表
   */
  visibleSourceIds(
    agentId: string,
    sessionId?: string,
    identity?: { tenantId?: string; gatewayId?: string },
  ): import('./types.js').KnowledgeSourceId[] {
    return this.sources
      .listVisible(agentId, sessionId)
      .filter((s) => this.sources.isGatewayVisible(s, identity))
      .map((s) => s.id);
  }

  /** 可见集 ∩ 请求过滤；无过滤时原样返回可见集 */
  private filterSourceIds(
    visible: import('./types.js').KnowledgeSourceId[],
    opts: HybridSearchOptions,
  ): import('./types.js').KnowledgeSourceId[] {
    const requested = opts.sourceIds?.map((s) => s.trim()).filter(Boolean) ?? [];
    const name = opts.source?.trim();
    if (requested.length === 0 && !name) return visible;

    const visibleSet = new Set(visible);
    let allowed: Set<string> | null = null;

    if (requested.length > 0) {
      allowed = new Set(requested.filter((id) => visibleSet.has(id as never)));
    }
    if (name) {
      const lower = name.toLowerCase();
      const matched = visible.filter((id) => {
        const src = this.sources.get(id);
        if (!src) return false;
        return (
          src.id.toLowerCase() === lower ||
          src.displayName.toLowerCase() === lower ||
          src.displayName.toLowerCase().includes(lower) ||
          src.id.toLowerCase().includes(lower)
        );
      });
      if (allowed) {
        allowed = new Set(matched.filter((id) => allowed!.has(id)));
      } else {
        allowed = new Set(matched);
      }
    }
    return visible.filter((id) => allowed?.has(id) ?? true);
  }

  /**
   * hybrid 检索
   */
  async search(query: string, opts: HybridSearchOptions): Promise<HybridSearchResult> {
    const visible = this.visibleSourceIds(opts.agentId, opts.sessionId, {
      tenantId: opts.tenantId,
      gatewayId: opts.gatewayId,
    });
    const sourceIds = this.filterSourceIds(visible, opts);
    const limit = opts.limit ?? 8;

    const vectorBackend = this.index.vectorBackend();
    // 百万级：无 KNN / 配置强制时走关键词腿（闸门看结果而非 flag）
    const preferKeyword =
      this.hybridKeyword ||
      vectorBackend === 'js-bucket' ||
      vectorBackend === 'disabled';

    let vectorHits: ChunkHit[] = [];
    let usedVector = false;

    if (this.embedding && !opts.keywordOnly) {
      try {
        const qEmb = await this.embedding.embed(query);
        vectorHits = this.index.vectorSearch(qEmb, { sourceIds, limit: limit * 2 });
        usedVector = vectorHits.length > 0;
      } catch {
        usedVector = false;
        vectorHits = [];
      }
    }

    const forceKeyword = preferKeyword || !usedVector;
    const keywordHits = forceKeyword
      ? this.index.search(query, { sourceIds, limit: limit * 2 })
      : [];

    const useKw = forceKeyword || !usedVector;
    const kwW = !useKw ? 0 : usedVector ? this.keywordWeight : 1;
    const vecW = usedVector ? (useKw ? 1 - this.keywordWeight : 1) : 0;
    const fused = fuseHits(keywordHits, vectorHits, {
      keywordWeight: kwW,
      vectorWeight: vecW,
    });

    const coverage = this.coverageFor(sourceIds);
    return {
      hits: fused.slice(0, limit),
      usedVector,
      keywordHits: keywordHits.length,
      vectorHits: vectorHits.length,
      coverage,
      sourceIds,
      vectorBackend,
    };
  }

  /**
   * auto-ground 分档（高分注入 / 中分 hint / 低分忽略）；coverage 低时抬地板
   * 受 recall 模式约束：off/hint 会压制 inject
   */
  async autoGround(query: string, opts: HybridSearchOptions): Promise<AutoGroundDecision> {
    if (this.recall === 'off') {
      return {
        mode: 'none',
        hits: [],
        reason: 'recall_off',
        coverage: 1,
        scoreFloor: 1,
      };
    }

    const result = await this.search(query, { ...opts, limit: Math.max(opts.limit ?? 8, this.maxChunks * 2) });
    const lowCoverage = result.coverage < this.minCoverage;
    // inject 模式更积极；hint/hybrid 维持默认地板
    const baseFloor =
      this.recall === 'inject'
        ? Math.max(0.15, this.injectMinScore - 0.15)
        : this.injectMinScore;
    const scoreFloor = lowCoverage
      ? Math.min(0.95, baseFloor + 0.12)
      : baseFloor;

    const injectable = result.hits.filter((h) => h.score >= scoreFloor).slice(0, this.maxChunks);
    if (injectable.length > 0 && this.recall !== 'hint') {
      return {
        mode: 'inject',
        hits: injectable,
        reason: lowCoverage ? 'inject_low_coverage_raised_floor' : 'inject',
        coverage: result.coverage,
        scoreFloor,
      };
    }

    const hintable = result.hits.filter((h) => h.score >= this.hintMinScore);
    if (hintable.length > 0) {
      const titles = [...new Set(hintable.slice(0, 3).map((h) => h.path))].join(', ');
      return {
        mode: 'hint',
        hits: [],
        hint: `存在与本问相关的材料（${hintable.length} 处）：${titles}`,
        reason:
          this.recall === 'hint' && injectable.length > 0
            ? 'hint_suppress_inject'
            : lowCoverage
              ? 'hint_low_coverage'
              : 'hint',
        coverage: result.coverage,
        scoreFloor,
      };
    }

    return {
      mode: 'none',
      hits: [],
      reason: result.hits.length === 0 ? 'no_hit' : 'below_hint_floor',
      coverage: result.coverage,
      scoreFloor,
    };
  }

  private coverageFor(sourceIds: string[]): number {
    if (sourceIds.length === 0) return 0;
    let files = 0;
    let emb = 0;
    for (const id of sourceIds) {
      const st = this.index.sourceStats(id);
      files += st.files;
      emb += this.index.embeddingCoverage(id) * Math.max(st.chunks, 0);
    }
    // 无 embedding 时 coverage = 有文件即算 partial 可用；有 provider 时混入向量覆盖
    if (!this.embedding) return files > 0 ? 1 : 0;
    const chunkTotal = sourceIds.reduce((n, id) => n + this.index.sourceStats(id).chunks, 0);
    if (chunkTotal === 0) return files > 0 ? 0.6 : 0;
    return Math.min(1, emb / chunkTotal);
  }
}

function fuseHits(
  keyword: ChunkHit[],
  vector: ChunkHit[],
  weights: { keywordWeight: number; vectorWeight: number },
): ChunkHit[] {
  const byId = new Map<string, ChunkHit>();
  const kMax = Math.max(...keyword.map((h) => h.score), 1);
  const useKw = weights.keywordWeight > 0;
  const useVec = weights.vectorWeight > 0;

  for (const h of keyword) {
    if (!useKw) continue;
    // 关键词：列表内相对分（0–1）
    const score = h.score / kMax;
    const prev = byId.get(h.chunkId);
    byId.set(h.chunkId, { ...h, score: (prev?.score ?? 0) + score });
  }
  for (const h of vector) {
    if (!useVec) continue;
    // 向量：用原始 cosine（勿 min-max，否则单条命中恒为 1.0）
    const score = Math.max(0, Math.min(1, h.score));
    const prev = byId.get(h.chunkId);
    if (prev) {
      byId.set(h.chunkId, { ...prev, score: prev.score + score });
    } else {
      byId.set(h.chunkId, { ...h, score });
    }
  }

  const kwIds = new Set(keyword.map((k) => k.chunkId));
  const vecIds = new Set(vector.map((v) => v.chunkId));
  return [...byId.values()]
    .map((h) => {
      const dual = kwIds.has(h.chunkId) && vecIds.has(h.chunkId);
      return { ...h, score: Math.min(1, dual ? h.score * 0.85 + 0.15 : h.score) };
    })
    .sort((a, b) => b.score - a.score);
}
