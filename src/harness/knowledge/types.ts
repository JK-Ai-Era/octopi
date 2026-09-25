/**
 * Knowledge 源模型 — 外生语料登记（arch/knowledge-layer.md）
 *
 * Scope：Global（默认可见可屏蔽）/ Project（显式挂载）/ Session（临时）。
 * 无 Agent 级源。Index 不在本模块（P2+）；此处是权威注册表与可见性。
 */

/** 不透明 branded id（跨边界防混用；AGENTS：Brand opaque IDs） */
export type Branded<T, B extends string> = T & { readonly __brand: B };

export type KnowledgeSourceId = Branded<string, 'KnowledgeSource'>;
export type KnowledgeChunkId = Branded<string, 'KnowledgeChunk'>;

/** 从外部输入收窄为 SourceId（仅边界处使用） */
export function asSourceId(id: string): KnowledgeSourceId {
  return id as KnowledgeSourceId;
}

/** 从外部输入收窄为 ChunkId（仅边界处使用） */
export function asChunkId(id: string): KnowledgeChunkId {
  return id as KnowledgeChunkId;
}

export type KnowledgeScopeLevel = 'global' | 'project' | 'session';

export interface KnowledgeScopeRef {
  level: KnowledgeScopeLevel;
  /** global: 'global'；project: projectKey；session: sessionId */
  key: string;
}

export type KnowledgeSourceStatus =
  | 'pending'
  | 'discovering'
  | 'partial'
  | 'ready'
  | 'error'
  | 'disabled'
  | 'removed';

export type KnowledgeSourceKind =
  | 'workspace'
  | 'directory'
  | 'file'
  | 'url'
  | 'connector';

export interface KnowledgeSourceSync {
  strategy: 'watch' | 'poll' | 'manual';
  debounceMs?: number;
  intervalMs?: number;
  enabled: boolean;
}

/** 出站网络策略（外源 ingest） */
export interface KnowledgeSourceNetwork {
  /** 放行私网/环回（默认 false；内网文档源显式开） */
  allowPrivateNetwork?: boolean;
  /** 单响应字节上限（默认 5MB） */
  maxResponseBytes?: number;
  /** 单请求超时 ms（默认 30s） */
  timeoutMs?: number;
  /** 重定向上限（默认 5） */
  maxRedirects?: number;
}

/** URL 源发现策略（U3 多页） */
export interface KnowledgeSourceDiscover {
  /** single：location 即文档；sitemap：解析 sitemap；crawl：同域有限 BFS */
  mode: 'single' | 'sitemap' | 'crawl';
  /** crawl/sitemap 最大文档数（默认 50） */
  maxPages?: number;
  /** crawl 最大深度（默认 3；0 = 仅入口） */
  maxDepth?: number;
  /** 发现阶段累计下载字节预算（默认 20MB） */
  maxBytes?: number;
  /** sitemapindex 嵌套深度（默认 2） */
  sitemapMaxDepth?: number;
}

export interface KnowledgeSourceError {
  path?: string;
  message: string;
  at: number;
}

export interface KnowledgeSource {
  id: KnowledgeSourceId;
  kind: KnowledgeSourceKind;
  location: string;
  scopeRef: KnowledgeScopeRef;
  sync: KnowledgeSourceSync;
  status: KnowledgeSourceStatus;
  /** 0–1 索引完备度（渐进可用；P2 起有意义） */
  coverage?: number;
  errors?: KnowledgeSourceError[];
  displayName: string;
  /** 人工描述，权威 */
  description?: string;
  /** 自动描述（可被 description 覆盖） */
  generatedDescription?: string;
  catalogPriority?: number;
  hiddenFromCatalog?: boolean;
  /** CredentialStore 凭证名（密钥不进本库） */
  authRef?: string;
  /** 外源网络策略 */
  network?: KnowledgeSourceNetwork;
  /** URL 发现策略（缺省 single） */
  discover?: KnowledgeSourceDiscover;
  /** 最近一次 poll 完成时间（ms） */
  lastPolledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type KnowledgeSourceInput = {
  id?: string;
  kind: KnowledgeSourceKind;
  location: string;
  scopeRef: KnowledgeScopeRef;
  sync?: Partial<KnowledgeSourceSync>;
  displayName?: string;
  description?: string;
  generatedDescription?: string;
  catalogPriority?: number;
  hiddenFromCatalog?: boolean;
  status?: KnowledgeSourceStatus;
  authRef?: string;
  network?: KnowledgeSourceNetwork;
  discover?: KnowledgeSourceDiscover;
};

export type KnowledgeSourcePatch = Partial<
  Pick<
    KnowledgeSource,
    | 'location'
    | 'sync'
    | 'catalogPriority'
    | 'hiddenFromCatalog'
    | 'status'
    | 'coverage'
    | 'errors'
  >
> & {
  scopeRef?: KnowledgeScopeRef;
  /** 传 null 可清除 */
  displayName?: string | null;
  description?: string | null;
  generatedDescription?: string | null;
  authRef?: string | null;
  network?: KnowledgeSourceNetwork | null;
  discover?: KnowledgeSourceDiscover | null;
  lastPolledAt?: number;
};
