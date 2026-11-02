/**
 * KnowledgeWriteService — 唯一写者端口（API 线程不得直接摸 SQLite）
 *
 * 生产：Writer Worker 持有 knowledge.db + ingest；API 经 RPC 调用。
 * 测试 / :memory:：LocalKnowledgeWriteService 同进程实现（同一接口）。
 */

import type { KnowledgeDatabase } from './db.js';
import { KnowledgeSourceStore } from './source-store.js';
import { KnowledgeIndexStore } from './index-store.js';
import { MembershipStore } from './membership-store.js';
import { KnowledgeIngest, type IngestProgressEvent } from './ingest.js';
import {
  generateKnowledgeDescription,
  normalizeGeneratedDescription,
  type KnowledgeDescribeResult,
} from './describe.js';
import { assembleDescribeSample, DESCRIBE_SAMPLE_MAX_CHARS } from './describe-sample.js';
import { scanSecretShapes } from './secret-scan.js';
import type { KnowledgeSource, KnowledgeSourceInput } from './types.js';
import type { KnowledgeJobControlState } from './job-control-state.js';
import type { DocumentCapabilityConfig } from '../capabilities/document/factory.js';
import type {
  KnowledgeBootEmbed,
  KnowledgeBootIngest,
} from './boot-config.js';
import type { EmbeddingProvider } from '../memory/sqlite/embedding.js';

export interface WriteIdentity {
  tenantId: string;
  gatewayId: string;
}

export interface WriteAbortStats {
  cancelledQueued: number;
  abortedRunning: number;
  runningJobs: number;
}

export interface WriteResumeStats {
  restoredCancelled: number;
  embedQueued: number;
}

export interface WriteRegisterResult extends KnowledgeSource {
  registeredBy: string;
}

export interface WriteDescribeResult {
  generatedDescription: string;
  source: string;
}

/** gateway 代生成（B 方案）的抽样出 Service 边界形态：密钥扫描在此把关 */
export type WriteDescribeSampleResult =
  | {
      blocked: false;
      meta: { displayName: string; kind: string; location: string };
      sample: string;
    }
  | { blocked: true; secretHits: string[] };

/** describe 写入口（gateway 回写 LLM 描述） */
export interface WriteDescribeInput {
  description: string;
  /** 缺省 'llm'（写入口的调用方是 gateway 的 LLM describe 流程） */
  source?: 'llm' | 'heuristic';
}

export interface WriteReprocessResult {
  queued: number;
  alreadyActive: number;
  cleanedNonFiles: number;
  resumed: boolean;
  rejected: number;
}

/** API → Writer 的变更面。读走 KnowledgeQueryService。 */
export interface KnowledgeWriteService {
  upsertPrincipal(
    identity: WriteIdentity,
    agentId: string,
    body: { displayName?: string; status?: string },
  ): Promise<void>;
  /** autoRegister=true 且缺失则写入；否则缺失抛 principal_not_registered */
  ensurePrincipal(identity: WriteIdentity, agentId: string, autoRegister: boolean): Promise<void>;
  assertOwnPrincipal(identity: WriteIdentity, agentId: string): Promise<void>;

  createProject(
    identity: WriteIdentity,
    input: { projectKey: string; displayName?: string; visibility?: string },
  ): Promise<{
    projectKey: string;
    displayName: string | null;
    registeredBy: string;
    visibility: 'public' | 'private';
  }>;
  removeProject(
    identity: WriteIdentity,
    projectKey: string,
  ): Promise<{ projectKey: string; removed: boolean }>;

  registerSource(
    identity: WriteIdentity,
    input: Record<string, unknown>,
  ): Promise<WriteRegisterResult>;
  updateSource(
    identity: WriteIdentity,
    sourceId: string,
    patch: Record<string, unknown>,
  ): Promise<KnowledgeSource | null>;
  removeSource(
    identity: WriteIdentity,
    sourceId: string,
  ): Promise<{ id: string; purgedFiles: number }>;
  describeSource(
    identity: WriteIdentity,
    sourceId: string,
    input?: WriteDescribeInput,
  ): Promise<WriteDescribeResult | null>;
  /** 抽样出 Service 边界（gateway 代生成取素材）；密钥命中即封锁不外发 */
  describeSample(identity: WriteIdentity, sourceId: string): Promise<WriteDescribeSampleResult | null>;
  /** 待 LLM 升级的源（heuristic/legacy 归因且无人工描述），供 gateway boot sweep */
  listDescribePending(identity: WriteIdentity): Promise<string[]>;

  reindexSource(sourceId: string): Promise<void>;
  /** 按路径强制重解析（中止态自动 resume） */
  reprocessFiles(sourceId: string, paths: string[]): Promise<WriteReprocessResult>;
  reprocessByFilter(
    sourceId: string,
    filter?: { status?: string; ext?: string; q?: string },
  ): Promise<WriteReprocessResult>;
  abortSource(sourceId: string): Promise<WriteAbortStats & KnowledgeJobControlState>;
  resumeSource(sourceId: string): Promise<KnowledgeJobControlState>;
  abortAllOwned(identity: WriteIdentity): Promise<WriteAbortStats>;
  resumeAllOwned(identity: WriteIdentity): Promise<WriteResumeStats>;

  assignProject(identity: WriteIdentity, agentId: string, projectKey: string): Promise<void>;
  unassignProject(identity: WriteIdentity, agentId: string, projectKey: string): Promise<void>;
  hideSource(identity: WriteIdentity, agentId: string, sourceId: string): Promise<void>;
  unhideSource(identity: WriteIdentity, agentId: string, sourceId: string): Promise<void>;
  replaceSessionVisibility(
    identity: WriteIdentity,
    agentId: string,
    sessionId: string,
    items: Array<{ targetType: string; targetId: string; op: string }>,
  ): Promise<number>;
  setSessionVisibilityItem(
    identity: WriteIdentity,
    sessionId: string,
    item: { targetType: 'project' | 'source'; targetId: string; op: 'include' | 'exclude' },
  ): Promise<void>;
  clearSessionVisibility(
    identity: WriteIdentity,
    sessionId: string,
    target?: { targetType: 'project' | 'source'; targetId: string },
  ): Promise<void>;

  isSourceOwner(sourceId: string, gatewayId: string): Promise<boolean>;
  sourceVisibleToGateway(sourceId: string, gatewayId: string): Promise<boolean>;

  startIngestRuntime(): Promise<void>;
  onProgress(cb: (evt: IngestProgressEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface LocalWriteDeps {
  db: KnowledgeDatabase;
  documentConfig?: DocumentCapabilityConfig | null;
  embeddingProvider?: EmbeddingProvider | null;
  /** source.authRef 解析（SEC-3c consumer 绑定强制） */
  credentials?: import('../governance/credentials/store.js').CredentialStore | null;
  embed?: KnowledgeBootEmbed | null;
  /** Ingest 调参（knowledge.load / index.queue / index.files） */
  ingest?: KnowledgeBootIngest | null;
  /** false = 索引稳定后不自动生成 generatedDescription（knowledge.catalog.autoDescribe） */
  autoDescribe?: boolean;
}

/** 进程内唯一写者（测试 / :memory:）。 */
export class LocalKnowledgeWriteService implements KnowledgeWriteService {
  readonly sources: KnowledgeSourceStore;
  readonly index: KnowledgeIndexStore;
  readonly memberships: MembershipStore;
  readonly ingest: KnowledgeIngest;
  private readonly progressCbs = new Set<(evt: IngestProgressEvent) => void>();

  constructor(private readonly deps: LocalWriteDeps) {
    this.sources = new KnowledgeSourceStore(deps.db);
    this.index = new KnowledgeIndexStore(deps.db);
    this.memberships = new MembershipStore(deps.db);
    const embed = deps.embed ?? null;
    this.ingest = new KnowledgeIngest({
      sourceStore: this.sources,
      indexStore: this.index,
      documentConfig: deps.documentConfig ?? null,
      embeddingProvider: embed?.enabled === false ? null : (deps.embeddingProvider ?? null),
      credentials: deps.credentials ?? null,
      ...(deps.ingest ?? {}),
      ...(embed?.embedBatch != null ? { embedBatch: embed.embedBatch } : {}),
      ...(embed?.embedMinIntervalMs != null ? { embedMinIntervalMs: embed.embedMinIntervalMs } : {}),
      ...(embed?.embedConcurrency != null ? { embedConcurrency: embed.embedConcurrency } : {}),
      ...(embed?.embedSecretPolicy != null ? { embedSecretPolicy: embed.embedSecretPolicy } : {}),
    });
    this.ingest.on('knowledge.index.progress', (evt: IngestProgressEvent) => {
      for (const cb of this.progressCbs) {
        try {
          cb(evt);
        } catch {
          /* SSE 订阅方异常不得打断 ingest */
        }
      }
    });
  }

  private get db(): KnowledgeDatabase {
    return this.deps.db;
  }

  async upsertPrincipal(
    identity: WriteIdentity,
    agentId: string,
    body: { displayName?: string; status?: string },
  ): Promise<void> {
    const now = Date.now();
    this.db.raw
      .prepare(
        `INSERT INTO knowledge_principals
           (tenant_id, gateway_id, local_agent_id, display_name, status, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, gateway_id, local_agent_id) DO UPDATE SET
           display_name = COALESCE(excluded.display_name, knowledge_principals.display_name),
           status = excluded.status,
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        identity.tenantId,
        identity.gatewayId,
        agentId,
        body.displayName ?? null,
        body.status ?? 'active',
        now,
        now,
        now,
      );
  }

  async ensurePrincipal(
    identity: WriteIdentity,
    agentId: string,
    autoRegister: boolean,
  ): Promise<void> {
    const row = this.db.raw
      .prepare(
        `SELECT status FROM knowledge_principals
         WHERE tenant_id = ? AND gateway_id = ? AND local_agent_id = ?`,
      )
      .get(identity.tenantId, identity.gatewayId, agentId) as { status?: string } | undefined;
    if (row) return;
    if (autoRegister) {
      await this.upsertPrincipal(identity, agentId, {});
      return;
    }
    throw Object.assign(new Error('principal not registered'), {
      code: 'principal_not_registered',
    });
  }

  async assertOwnPrincipal(identity: WriteIdentity, agentId: string): Promise<void> {
    // 不得按 gateway 预过滤后再比较——那是永不失败的空检查。
    // 同名 principal 可挂多 gateway（复合 PK）；仅当**另一 gateway 已登记**时拒绝。
    const rows = this.db.raw
      .prepare(
        `SELECT gateway_id FROM knowledge_principals
         WHERE tenant_id = ? AND local_agent_id = ?`,
      )
      .all(identity.tenantId, agentId) as Array<{ gateway_id: string }>;
    const foreign = rows.find((r) => r.gateway_id !== identity.gatewayId);
    if (foreign) {
      throw Object.assign(new Error('not principal owner'), { code: 'not_principal_owner' });
    }
  }

  async createProject(
    identity: WriteIdentity,
    input: { projectKey: string; displayName?: string; visibility?: string },
  ): Promise<{
    projectKey: string;
    displayName: string | null;
    registeredBy: string;
    visibility: 'public' | 'private';
  }> {
    const existing = this.db.raw
      .prepare(
        `SELECT registered_by FROM knowledge_projects
         WHERE tenant_id = ? AND project_key = ?`,
      )
      .get(identity.tenantId, input.projectKey) as { registered_by?: string } | undefined;
    if (existing?.registered_by && existing.registered_by !== identity.gatewayId) {
      throw Object.assign(new Error('project owned by another gateway'), {
        code: 'not_resource_owner',
      });
    }
    this.sources.createProject(input.projectKey, input.displayName, {
      tenantId: identity.tenantId,
      registeredBy: identity.gatewayId,
    });
    const visibility = input.visibility === 'public' ? 'public' : 'private';
    this.db.raw
      .prepare(
        `UPDATE knowledge_projects SET registered_by = ?, visibility = ?
         WHERE tenant_id = ? AND project_key = ?`,
      )
      .run(identity.gatewayId, visibility, identity.tenantId, input.projectKey);
    return {
      projectKey: input.projectKey,
      displayName: input.displayName ?? null,
      registeredBy: identity.gatewayId,
      visibility,
    };
  }

  async removeProject(
    identity: WriteIdentity,
    projectKey: string,
  ): Promise<{ projectKey: string; removed: boolean }> {
    const row = this.db.raw
      .prepare(
        `SELECT registered_by FROM knowledge_projects
         WHERE tenant_id = ? AND project_key = ?`,
      )
      .get(identity.tenantId, projectKey) as { registered_by?: string } | undefined;
    if (row?.registered_by && row.registered_by !== identity.gatewayId) {
      throw Object.assign(new Error('not project owner'), { code: 'not_resource_owner' });
    }
    try {
      const removed = this.sources.removeProject(projectKey, { tenantId: identity.tenantId });
      return { projectKey, removed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not empty|non-empty|仍有/i.test(msg)) {
        throw Object.assign(new Error(msg), { code: 'project_not_empty' });
      }
      throw e;
    }
  }

  async registerSource(
    identity: WriteIdentity,
    rawInput: Record<string, unknown>,
  ): Promise<WriteRegisterResult> {
    const input = { ...rawInput };
    delete input.id;
    delete input.registeredBy;
    delete input.registered_by;
    delete input.tenantId;
    delete input.tenant_id;
    const src = this.sources.register(input as unknown as KnowledgeSourceInput);
    this.db.raw
      .prepare(
        `UPDATE knowledge_sources SET registered_by = ?, visibility = ?, tenant_id = ?
         WHERE id = ?`,
      )
      .run(
        identity.gatewayId,
        typeof input.visibility === 'string' ? input.visibility : 'private',
        identity.tenantId,
        src.id,
      );
    void this.ingest.ingestSource(src.id, { full: true }).catch((e) => {
      console.warn(
        `[Knowledge] auto-ingest after register failed (${src.id}): ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    return { ...src, registeredBy: identity.gatewayId };
  }

  async updateSource(
    identity: WriteIdentity,
    sourceId: string,
    patch: Record<string, unknown>,
  ): Promise<KnowledgeSource | null> {
    const row = this.db.raw
      .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string } | undefined;
    if (row?.registered_by && row.registered_by !== identity.gatewayId) {
      throw Object.assign(new Error('not source owner'), { code: 'not_resource_owner' });
    }
    const updated = this.sources.update(sourceId, patch as never);
    if (!updated) return null;
    if (typeof patch.visibility === 'string') {
      this.db.raw
        .prepare('UPDATE knowledge_sources SET visibility = ? WHERE id = ?')
        .run(patch.visibility, sourceId);
    }
    return updated;
  }

  async removeSource(
    identity: WriteIdentity,
    sourceId: string,
  ): Promise<{ id: string; purgedFiles: number }> {
    const src = this.sources.get(sourceId);
    if (!src) {
      throw Object.assign(new Error('source not found'), { code: 'source_not_found' });
    }
    const row = this.db.raw
      .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string } | undefined;
    if (row?.registered_by && row.registered_by !== identity.gatewayId) {
      throw Object.assign(new Error('not source owner'), { code: 'not_resource_owner' });
    }
    // 先停在途 parse/embed：否则 purge 让出窗口内 upsert 会把 File/Chunk 再写回来
    this.ingest.abortJobs({ sourceId });
    const purged = await this.memberships.unclaimAllForSourceAsync(sourceId, (fileId) =>
      this.index.purgeFileAsync(fileId),
    );
    this.sources.remove(sourceId);
    return { id: sourceId, purgedFiles: purged.length };
  }

  async describeSource(
    identity: WriteIdentity,
    sourceId: string,
    input?: WriteDescribeInput,
  ): Promise<WriteDescribeResult | null> {
    await this.assertSourceOwner(identity, sourceId);
    const src = this.sources.get(sourceId);
    if (!src) return null;
    if (input?.description != null) {
      // 写入口（B 方案回写）：调用方是 gateway 的 LLM describe 流程；内容在出 Service 前过密钥扫描，
      // 但描述会进系统提示 catalog 行——写入侧强制单行归一（防多行注入伪造 catalog 行）
      const text = normalizeGeneratedDescription(input.description);
      if (!text) {
        throw Object.assign(new Error('description empty'), { code: 'bad_request' });
      }
      const source = input.source === 'heuristic' ? 'heuristic' : 'llm';
      this.sources.update(sourceId, {
        generatedDescription: text,
        generatedDescriptionSource: source,
      });
      return { generatedDescription: text, source };
    }
    const r = await this.describeWithSample(src);
    this.sources.update(sourceId, {
      generatedDescription: r.description,
      generatedDescriptionSource: r.source === 'disabled' ? 'heuristic' : r.source,
    });
    return { generatedDescription: r.description, source: r.source };
  }

  async describeSample(
    identity: WriteIdentity,
    sourceId: string,
  ): Promise<WriteDescribeSampleResult | null> {
    await this.assertSourceOwner(identity, sourceId);
    const src = this.sources.get(sourceId);
    if (!src) return null;
    const sample = assembleDescribeSample(this.db, sourceId);
    // 密钥形态封锁：命中即不外发样本（fail-safe，同 generateKnowledgeDescription 口径）
    const secretHits = scanSecretShapes(sample);
    if (secretHits.length > 0) return { blocked: true, secretHits };
    return {
      blocked: false,
      meta: { displayName: src.displayName, kind: src.kind, location: src.location },
      sample,
    };
  }

  async listDescribePending(identity: WriteIdentity): Promise<string[]> {
    // 待升级 = 有启发式/legacy 自动描述、无人工描述、归因非 llm（legacy NULL 视为 heuristic）
    const rows = this.db.raw
      .prepare(
        `SELECT id FROM knowledge_sources
          WHERE generated_description IS NOT NULL
            AND description IS NULL
            AND (generated_description_source IS NULL OR generated_description_source = 'heuristic')
            AND status NOT IN ('removed', 'disabled')
            AND (registered_by IS NULL OR registered_by = '' OR registered_by = ?)`,
      )
      .all(identity.gatewayId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** 启发式/封锁描述生成（无 describePort：Service 侧永不含 LLM 出网，B 方案拍板） */
  private describeWithSample(src: KnowledgeSource): Promise<KnowledgeDescribeResult> {
    const sample = assembleDescribeSample(this.db, src.id);
    return generateKnowledgeDescription(src, sample, {
      enabled: true,
      sampleChars: DESCRIBE_SAMPLE_MAX_CHARS,
    });
  }

  private async assertSourceOwner(identity: WriteIdentity, sourceId: string): Promise<void> {
    const row = this.db.raw
      .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string } | undefined;
    if (!row) {
      throw Object.assign(new Error('source not found'), { code: 'source_not_found' });
    }
    if (row.registered_by && row.registered_by !== identity.gatewayId) {
      throw Object.assign(new Error('not source owner'), { code: 'not_resource_owner' });
    }
  }

  async reindexSource(sourceId: string): Promise<void> {
    void this.ingest.ingestSource(sourceId, { full: true }).catch((e) => {
      console.warn(
        `[Knowledge] reindex kick failed (${sourceId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  async reprocessFiles(sourceId: string, paths: string[]): Promise<WriteReprocessResult> {
    return this.ingest.reprocessFiles(sourceId, paths);
  }

  async reprocessByFilter(
    sourceId: string,
    filter?: { status?: string; ext?: string; q?: string },
  ): Promise<WriteReprocessResult> {
    return this.ingest.reprocessByFilter(sourceId, filter as never);
  }

  async abortSource(sourceId: string): Promise<WriteAbortStats & KnowledgeJobControlState> {
    const stats = this.ingest.abortJobs({ sourceId });
    return { ...stats, ...this.ingest.jobControlState(sourceId) };
  }

  async resumeSource(sourceId: string): Promise<KnowledgeJobControlState> {
    this.ingest.resumeJobs({ sourceId });
    return this.ingest.jobControlState(sourceId);
  }

  async abortAllOwned(identity: WriteIdentity): Promise<WriteAbortStats> {
    const owned = this.sources.list().filter((s) => this.isOwnerRow(s.id, identity.gatewayId));
    let cancelledQueued = 0;
    let abortedRunning = 0;
    let runningJobs = 0;
    for (const s of owned) {
      const st = this.ingest.abortJobs({ sourceId: s.id });
      cancelledQueued += st.cancelledQueued;
      abortedRunning += st.abortedRunning;
      runningJobs += st.runningJobs;
    }
    return { cancelledQueued, abortedRunning, runningJobs };
  }

  async resumeAllOwned(identity: WriteIdentity): Promise<WriteResumeStats> {
    const owned = this.sources.list().filter((s) => this.isOwnerRow(s.id, identity.gatewayId));
    let restoredCancelled = 0;
    let embedQueued = 0;
    for (const s of owned) {
      const st = this.ingest.resumeJobs({ sourceId: s.id });
      restoredCancelled += st.restoredCancelled;
      embedQueued += st.embedQueued;
    }
    return { restoredCancelled, embedQueued };
  }

  private isOwnerRow(sourceId: string, gatewayId: string): boolean {
    const row = this.db.raw
      .prepare('SELECT registered_by FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string } | undefined;
    if (!row) return false;
    if (row.registered_by && row.registered_by !== gatewayId) return false;
    return true;
  }

  async assignProject(
    identity: WriteIdentity,
    agentId: string,
    projectKey: string,
  ): Promise<void> {
    this.sources.assignProject(projectKey, agentId, identity);
  }

  async unassignProject(
    identity: WriteIdentity,
    agentId: string,
    projectKey: string,
  ): Promise<void> {
    this.sources.unassignProject(projectKey, agentId, identity);
  }

  async hideSource(identity: WriteIdentity, agentId: string, sourceId: string): Promise<void> {
    this.sources.hideSource(agentId, sourceId, identity);
  }

  async unhideSource(identity: WriteIdentity, agentId: string, sourceId: string): Promise<void> {
    this.sources.unhideSource(agentId, sourceId, identity);
  }

  async replaceSessionVisibility(
    identity: WriteIdentity,
    _agentId: string,
    sessionId: string,
    items: Array<{ targetType: string; targetId: string; op: string }>,
  ): Promise<number> {
    const typed = items.map((raw) => {
      const targetType = raw.targetType as 'project' | 'source' | undefined;
      const targetId = typeof raw.targetId === 'string' ? raw.targetId : '';
      const op = raw.op as 'include' | 'exclude' | undefined;
      if (
        !targetId ||
        (targetType !== 'project' && targetType !== 'source') ||
        (op !== 'include' && op !== 'exclude')
      ) {
        throw Object.assign(new Error('items[] invalid'), { code: 'bad_request' });
      }
      return { targetType, targetId, op };
    });
    this.sources.replaceSessionVisibility(sessionId, typed, identity);
    return typed.length;
  }

  async setSessionVisibilityItem(
    identity: WriteIdentity,
    sessionId: string,
    item: { targetType: 'project' | 'source'; targetId: string; op: 'include' | 'exclude' },
  ): Promise<void> {
    this.sources.setSessionVisibility(sessionId, item, identity);
  }

  async clearSessionVisibility(
    identity: WriteIdentity,
    sessionId: string,
    target?: { targetType: 'project' | 'source'; targetId: string },
  ): Promise<void> {
    this.sources.clearSessionVisibility(sessionId, target, identity);
  }

  async isSourceOwner(sourceId: string, gatewayId: string): Promise<boolean> {
    return this.isOwnerRow(sourceId, gatewayId);
  }

  async sourceVisibleToGateway(sourceId: string, gatewayId: string): Promise<boolean> {
    const row = this.db.raw
      .prepare('SELECT registered_by, visibility FROM knowledge_sources WHERE id = ?')
      .get(sourceId) as { registered_by?: string; visibility?: string } | undefined;
    if (!row) return true;
    if (row.registered_by === gatewayId) return true;
    return row.visibility === 'public';
  }

  async startIngestRuntime(): Promise<void> {
    const { sources, ingest } = this;
    ingest.onSourceSettled = (sourceId) => {
      // catalog.autoDescribe=false：索引稳定后不自动生成 generatedDescription（v0.51.5 语义）
      if (this.deps.autoDescribe === false) return;
      void (async () => {
        try {
          const src = sources.get(sourceId);
          if (!src || src.description?.trim()) return;
          // llm 归因是更高信任档：settle 不降级、不重发（B 方案 2026-11-02）
          if (src.generatedDescriptionSource === 'llm') return;
          const r = await this.describeWithSample(src);
          const source = r.source === 'disabled' ? 'heuristic' : r.source;
          // startReconciler 每 15s 对稳态源反复触发本钩子（ingest.ts）：文本无变化则
          // 不写不发，掐断「每 tick 重发 describe-pending → gateway 每 tick LLM 升级」成本环
          if (src.generatedDescription === r.description) return;
          sources.update(sourceId, {
            generatedDescription: r.description,
            generatedDescriptionSource: source,
          });
          // B 方案（2026-11-02 拍板）：LLM 描述由 gateway 代生成。
          // 启发式落库即发升级信号；blocked_secret（抽样含密钥形态）不发——素材不得外发。
          if (source === 'heuristic') {
            this.emitProgress({
              type: 'source',
              sourceId,
              status: 'describe-pending',
              detail: 'llm upgrade eligible',
            });
          }
        } catch {
          /* describe 失败不影响索引 */
        }
      })();
    };
    for (const s of sources.list()) {
      if (s.status === 'removed' || s.status === 'disabled') continue;
      if (s.sync.enabled !== false && s.sync.strategy === 'watch') {
        ingest.startWatch(s.id);
      }
      if (s.status === 'pending') {
        void ingest.ingestSource(s.id, { full: true }).catch((e) => {
          console.warn(
            `[Knowledge] recover pending failed (${s.id}): ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }
    }
    ingest.startReconciler();
    ingest.startPolling();
  }

  onProgress(cb: (evt: IngestProgressEvent) => void): () => void {
    this.progressCbs.add(cb);
    return () => {
      this.progressCbs.delete(cb);
    };
  }

  /** Writer 自产事件（describe-pending 等）；归属补齐口径与 IngestProgressEvent 一致 */
  private emitProgress(evt: IngestProgressEvent): void {
    let out = evt;
    if (evt.sourceId && evt.registeredBy === undefined) {
      try {
        const row = this.db.raw
          .prepare('SELECT tenant_id, registered_by, visibility FROM knowledge_sources WHERE id = ?')
          .get(evt.sourceId) as
          | { tenant_id?: string; registered_by?: string; visibility?: string }
          | undefined;
        if (row) {
          out = {
            ...evt,
            tenantId: row.tenant_id,
            registeredBy: row.registered_by,
            visibility: row.visibility,
          };
        }
      } catch {
        /* 源已删时保持原事件；SSE 侧按无归属放行到 fallback */
      }
    }
    for (const cb of this.progressCbs) {
      try {
        cb(out);
      } catch {
        /* SSE 订阅方异常不得打断 describe */
      }
    }
  }

  async dispose(): Promise<void> {
    this.progressCbs.clear();
    this.ingest.dispose();
  }
}
