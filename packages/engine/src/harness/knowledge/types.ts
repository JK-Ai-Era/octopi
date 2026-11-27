/**
 * Knowledge 源模型 — 外生语料登记（arch/knowledge-layer.md）
 *
 * Scope：Global（默认可见可屏蔽）/ Project（显式挂载）/ Session（临时）。
 * 无 Agent 级源。此处是源类型与可见性契约；Index 投影在 index-store/db。
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

/** generatedDescription 生成方（信任分级 human > llm > heuristic） */
export type KnowledgeGeneratedDescriptionSource = 'heuristic' | 'llm' | 'blocked_secret';

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
  /** 自动描述生成方（信任分级：llm 优于 heuristic；blocked_secret=抽样含密钥形态，未外发） */
  generatedDescriptionSource?: KnowledgeGeneratedDescriptionSource;
  catalogPriority?: number;
  hiddenFromCatalog?: boolean;
  /** 归属租户域（写归属打标；读侧租户闸执法列） */
  tenantId?: string;
  /**
   * R5 围栏豁免标记（评审 MAJOR-3a，2026-11-28 拍板）：行指向运行时内部态但经 host 面/
   * 平台 admin 豁免登记（或宿主管线如附件检索）。ingest 读取复判按此标记放行。
   * 派生式单源：`fenceExempt = !无豁免围栏判定通过`（writer-service 落库口推导，勿手传）。
   */
  fenceExempt?: boolean;
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
  generatedDescriptionSource?: KnowledgeGeneratedDescriptionSource;
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
    | 'fenceExempt'
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
  /** 传 null 可清除（与 generatedDescription 同清） */
  generatedDescriptionSource?: KnowledgeGeneratedDescriptionSource | null;
  authRef?: string | null;
  network?: KnowledgeSourceNetwork | null;
  discover?: KnowledgeSourceDiscover | null;
  lastPolledAt?: number;
};

/** 会话可见视图 overlay 的目标（资产归属不变） */
export type KnowledgeVisibilityTargetType = 'project' | 'source';
export type KnowledgeVisibilityOp = 'include' | 'exclude';

export interface KnowledgeSessionVisibilityItem {
  sessionId: string;
  targetType: KnowledgeVisibilityTargetType;
  targetId: string;
  op: KnowledgeVisibilityOp;
  createdAt: number;
}

export interface KnowledgeSessionVisibilityInput {
  targetType: KnowledgeVisibilityTargetType;
  targetId: string;
  op: KnowledgeVisibilityOp;
}
