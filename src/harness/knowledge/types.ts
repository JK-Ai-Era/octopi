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
};

export type KnowledgeSourcePatch = Partial<
  Pick<
    KnowledgeSource,
    | 'location'
    | 'sync'
    | 'displayName'
    | 'description'
    | 'catalogPriority'
    | 'hiddenFromCatalog'
    | 'status'
    | 'coverage'
    | 'errors'
  >
> & {
  scopeRef?: KnowledgeScopeRef;
  /** 传 null 可清除自动描述 */
  generatedDescription?: string | null;
};
