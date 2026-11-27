/**
 * KnowledgeClient — Gateway 侧 RPC（不打开 knowledge.db）
 */

import type { KnowledgeSourceKind } from './types.js';
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';
import { getRunScope } from '../run/run-scope.js';

/**
 * run 归属租户断言提供者（T3b）：run 内 = run 租户（DEFAULT 兜底，fail-closed）；
 * run 外 = 不断言（宿主面，broker 全量语义）。实例级挂载，防逐方法漏传断言。
 */
export function runTenantClaimProvider(): () => string | undefined {
  return () => {
    const scope = getRunScope();
    if (!scope) return undefined;
    return scope.principal?.tenantId ?? DEFAULT_TENANT_ID;
  };
}

export interface KnowledgeClientOptions {
  baseUrl: string;
  token: string;
  /**
   * HTTP 超时。默认 30s：索引期 FTS/写库会让 Service 短暂繁忙，
   * 5s 会把正常的「忙」误报成 timeout/503。仍应通过分批让出保证 /health 可达。
   */
  timeoutMs?: number;
  /**
   * 只读 API 超时（search/list/stats）。默认 12s：
   * 查询走 Query Worker，应快速失败并由 UI 重试，而不是拖到 30s。
   */
  readTimeoutMs?: number;
}

export class KnowledgeClient {
  /** 实例级租户断言提供者（T3b）：逐方法 opts 缺省时取用——防新增方法漏传断言的结构性漂移 */
  private tenantProvider?: () => string | undefined;

  constructor(private readonly opts: KnowledgeClientOptions) {}

  /**
   * 设置实例级租户断言提供者（调用时刻求值；逐方法 opts.tenantId 优先）。
   *
   * @param provider - 返回断言租户；undefined = 不断言（宿主面）
   */
  setTenantProvider(provider: () => string | undefined): void {
    this.tenantProvider = provider;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  get token(): string {
    return this.opts.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    opts?: { read?: boolean },
  ): Promise<T> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`;
    // 显式 timeoutMs 约束所有请求；readTimeoutMs 仅在未设 timeoutMs 时给只读更短缺省
    const timeoutMs = opts?.read
      ? (this.opts.readTimeoutMs ?? this.opts.timeoutMs ?? 12_000)
      : (this.opts.timeoutMs ?? 30_000);
    const ac = new AbortController();
    const timeoutErr = new Error(
      `knowledge_http_timeout ${method} ${path} after ${timeoutMs}ms (service busy or blocked)`,
    );
    const t = setTimeout(() => ac.abort(timeoutErr), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          ...(body != null ? { 'content-type': 'application/json' } : {}),
          // 租户断言单点收口（T3b）：实例级 provider 兜底，逐方法显式断言优先——
          // 新增方法不传 opts 也自动带 run 归属，防漏传漂移
          ...(this.tenantHeaders(undefined) ?? {}),
          ...headers,
        },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      const json = (await res.json()) as { ok?: boolean; data?: T; error?: { code: string; message: string } };
      if (!res.ok || json.error) {
        throw new Error(json.error?.message ?? `knowledge_http_${res.status}`);
      }
      return (json.data ?? json) as T;
    } catch (err) {
      if (ac.signal.aborted) throw timeoutErr;
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  health(): Promise<{ ok: boolean; service: string; version: string }> {
    return this.request('GET', '/health', undefined, undefined, { read: true });
  }

  ready(): Promise<{ ready: boolean; sqliteVec: boolean }> {
    return this.request('GET', '/v1/ready', undefined, undefined, { read: true });
  }

  ensurePrincipal(localAgentId: string, displayName?: string): Promise<unknown> {
    return this.request('PUT', `/v1/principals/${encodeURIComponent(localAgentId)}`, {
      displayName,
      status: 'active',
    });
  }

  listSources(opts?: {
    scopeLevel?: 'global' | 'project' | 'session';
    projectKey?: string;
    sessionId?: string;
    tenantId?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const qs = new URLSearchParams();
    if (opts?.scopeLevel) qs.set('scopeLevel', opts.scopeLevel);
    if (opts?.projectKey) qs.set('projectKey', opts.projectKey);
    if (opts?.sessionId) qs.set('sessionId', opts.sessionId);
    const q = qs.toString();
    return this.request(
      'GET',
      `/v1/sources${q ? `?${q}` : ''}`,
      undefined,
      this.tenantHeaders(opts?.tenantId),
      {
        read: true,
      },
    );
  }

  createSource(
    input: Record<string, unknown>,
    opts?: { tenantId?: string; fenceExemptGranted?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      '/v1/sources',
      input,
      this.tenantHeaders(opts?.tenantId, opts?.fenceExemptGranted),
    );
  }

  /**
   * 单项目登记行（含归属域/可见性；管理面域继承用）。未登记/不可见 → null。
   * opts.tenantId = 读身份收口（评审 R1/R2）：按该域视角解析（本域优先），他域私有行不可见。
   */
  async getProject(projectKey: string, opts?: { tenantId?: string }): Promise<Record<string, unknown> | null> {
    try {
      return await this.request(
        'GET',
        `/v1/projects/${encodeURIComponent(projectKey)}`,
        undefined,
        this.tenantHeaders(opts?.tenantId),
        { read: true },
      );
    } catch {
      return null;
    }
  }

  patchSource(
    sourceId: string,
    patch: Record<string, unknown>,
    opts?: { tenantId?: string; fenceExemptGranted?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.request(
      'PATCH',
      `/v1/sources/${encodeURIComponent(sourceId)}`,
      patch,
      this.tenantHeaders(opts?.tenantId, opts?.fenceExemptGranted),
    );
  }

  deleteSource(sourceId: string, opts?: { tenantId?: string }): Promise<unknown> {
    return this.request(
      'DELETE',
      `/v1/sources/${encodeURIComponent(sourceId)}`,
      undefined,
      this.tenantHeaders(opts?.tenantId),
    );
  }

  reindex(sourceId: string): Promise<unknown> {
    return this.request('POST', `/v1/sources/${encodeURIComponent(sourceId)}/reindex`);
  }

  /** 按路径 / 筛选强制重解析（中止态自动 resume） */
  reprocess(
    sourceId: string,
    opts: {
      paths?: string[];
      filter?: { status?: string; ext?: string; q?: string };
    },
  ): Promise<{
    queued: number;
    alreadyActive: number;
    cleanedNonFiles: number;
    resumed: boolean;
    rejected: number;
  }> {
    return this.request(
      'POST',
      `/v1/sources/${encodeURIComponent(sourceId)}/reprocess`,
      opts,
    );
  }

  search(
    agentId: string,
    q: string,
    opts?: { sessionId?: string; limit?: number; tenantId?: string },
  ): Promise<{ hits: unknown[]; keywordHits: number; vectorHits: number }> {
    const qs = new URLSearchParams({ q });
    if (opts?.sessionId) qs.set('sessionId', opts.sessionId);
    if (opts?.limit != null) qs.set('limit', String(opts.limit));
    return this.request(
      'GET',
      `/v1/principals/${encodeURIComponent(agentId)}/search?${qs}`,
      undefined,
      this.tenantHeaders(opts?.tenantId),
      { read: true },
    );
  }

  /** turn 级自动召回分档（与 Search Worker `autoGround` 同源） */
  autoGround(
    agentId: string,
    q: string,
    opts?: {
      sessionId?: string;
      limit?: number;
      tenantId?: string;
      recall?: 'off' | 'hint' | 'hybrid' | 'inject';
    },
  ): Promise<{
    mode: 'inject' | 'hint' | 'none';
    hits: unknown[];
    hint?: string;
    reason: string;
    coverage: number;
    scoreFloor: number;
  }> {
    const qs = new URLSearchParams({ q });
    if (opts?.sessionId) qs.set('sessionId', opts.sessionId);
    if (opts?.limit != null) qs.set('limit', String(opts.limit));
    if (opts?.recall) qs.set('recall', opts.recall);
    return this.request(
      'GET',
      `/v1/principals/${encodeURIComponent(agentId)}/ground?${qs}`,
      undefined,
      this.tenantHeaders(opts?.tenantId),
      { read: true },
    );
  }

  stats(agentId: string): Promise<Record<string, number>> {
    return this.request(
      'GET',
      `/v1/principals/${encodeURIComponent(agentId)}/stats`,
      undefined,
      undefined,
      { read: true },
    );
  }

  /**
   * 管理面可见性操作（项目挂载/源屏蔽）。
   *
   * @param agentId - 目标 agent
   * @param op - 可见性操作
   * @param body - projectKey（挂载）或 sourceId（屏蔽）
   * @param opts - 租户断言：token=platform 时上行归属域。**缺省 ≠ DEFAULT**，而是实例
   *   provider（run 内=run 归属、run 外=无断言 → 写域降级 DEFAULT）——管理面调用必须
   *   显式断言目标 agent 归属域，否则行落错域（agent 看不见 = 假成功）
   */
  visibility(
    agentId: string,
    op: 'assignProject' | 'unassignProject' | 'hide' | 'unhide',
    body: { projectKey?: string; sourceId?: string },
    opts?: { tenantId?: string },
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/v1/principals/${encodeURIComponent(agentId)}/visibility`,
      { op, ...body },
      this.tenantHeaders(opts?.tenantId),
    );
  }

  listProjects(opts?: { tenantId?: string }): Promise<Array<Record<string, unknown>>> {
    return this.request('GET', '/v1/projects', undefined, this.tenantHeaders(opts?.tenantId), {
      read: true,
    });
  }

  createProject(
    input: {
      projectKey: string;
      displayName?: string;
      visibility?: string;
    },
    tenantId?: string,
  ): Promise<Record<string, unknown>> {
    // 显式 tenantId = 租户断言（如公共项目断言 'platform' 落共享面）；缺省走实例 provider
    return this.request('POST', '/v1/projects', input, this.tenantHeaders(tenantId));
  }

  deleteProject(projectKey: string, opts?: { tenantId?: string }): Promise<unknown> {
    return this.request(
      'DELETE',
      `/v1/projects/${encodeURIComponent(projectKey)}`,
      undefined,
      this.tenantHeaders(opts?.tenantId),
    );
  }

  getSource(sourceId: string): Promise<Record<string, unknown>> {
    return this.request(
      'GET',
      `/v1/sources/${encodeURIComponent(sourceId)}`,
      undefined,
      undefined,
      { read: true },
    );
  }

  /** 中止源任务；省略 sourceId = 中止本 Gateway 全部源 */
  abort(sourceId?: string): Promise<unknown> {
    return sourceId
      ? this.request('POST', `/v1/sources/${encodeURIComponent(sourceId)}/abort`)
      : this.request('POST', '/v1/jobs/abort');
  }

  /** 继续源任务；省略 sourceId = 继续本 Gateway 全部源 */
  resume(sourceId?: string): Promise<unknown> {
    return sourceId
      ? this.request('POST', `/v1/sources/${encodeURIComponent(sourceId)}/resume`)
      : this.request('POST', '/v1/jobs/resume');
  }

  listFiles(sourceId: string): Promise<Array<Record<string, unknown>>> {
    return this.request(
      'GET',
      `/v1/sources/${encodeURIComponent(sourceId)}/files`,
      undefined,
      undefined,
      { read: true },
    );
  }

  listFilesPaged(
    sourceId: string,
    opts?: {
      status?: 'indexed' | 'skipped' | 'error' | 'all';
      ext?: string;
      q?: string;
      page?: number;
      pageSize?: number;
    },
  ): Promise<{
    items: Array<Record<string, unknown>>;
    total: number;
    page: number;
    pageSize: number;
    statusCounts: { indexed: number; skipped: number; error: number };
    extCounts: Array<{ ext: string; n: number }>;
  }> {
    const qs = new URLSearchParams();
    if (opts?.status) qs.set('status', opts.status);
    if (opts?.ext) qs.set('ext', opts.ext);
    if (opts?.q) qs.set('q', opts.q);
    if (opts?.page != null) qs.set('page', String(opts.page));
    if (opts?.pageSize != null) qs.set('pageSize', String(opts.pageSize));
    const s = qs.toString();
    return this.request(
      'GET',
      `/v1/sources/${encodeURIComponent(sourceId)}/files${s ? `?${s}` : ''}`,
      undefined,
      undefined,
      { read: true },
    );
  }

  catalog(agentId: string, opts?: { tenantId?: string }): Promise<unknown[]> {
    return this.request(
      'GET',
      `/v1/principals/${encodeURIComponent(agentId)}/catalog`,
      undefined,
      this.tenantHeaders(opts?.tenantId),
      { read: true },
    );
  }

  promotionCandidates(opts?: { minSessions?: number; minHits?: number }): Promise<unknown[]> {
    const qs = new URLSearchParams();
    if (opts?.minSessions != null) qs.set('minSessions', String(opts.minSessions));
    if (opts?.minHits != null) qs.set('minHits', String(opts.minHits));
    const search = qs.toString();
    return this.request(
      'GET',
      `/v1/promotion-candidates${search ? `?${search}` : ''}`,
      undefined,
      undefined,
      { read: true },
    );
  }

  describeSource(
    sourceId: string,
    input?: { description: string; source?: 'llm' | 'heuristic' },
  ): Promise<{ generatedDescription: string; source: string }> {
    return this.request(
      'POST',
      `/v1/sources/${encodeURIComponent(sourceId)}/describe`,
      input as unknown,
    );
  }

  /** B 方案取素材（Service 侧密钥扫描把关；blocked=true 时无 sample） */
  getDescribeSample(sourceId: string): Promise<
    | {
        blocked: false;
        meta: { displayName: string; kind: KnowledgeSourceKind; location: string };
        sample: string;
      }
    | { blocked: true; secretHits: string[] }
  > {
    return this.request(
      'GET',
      `/v1/sources/${encodeURIComponent(sourceId)}/describe-sample`,
      undefined,
      undefined,
      { read: true },
    );
  }

  /** 待 LLM 升级的源 id（boot sweep 用） */
  listDescribePending(): Promise<string[]> {
    return this.request('GET', '/v1/describe-pending', undefined, undefined, { read: true });
  }

  listChunks(
    agentId: string,
    sourceId: string,
    path: string,
    opts?: { tenantId?: string },
  ): Promise<
    Array<{ id: string; text: string; startLine: number; endLine: number; ordinal: number; path: string }>
  > {
    const qs = new URLSearchParams({ sourceId, path });
    return this.request(
      'GET',
      `/v1/principals/${encodeURIComponent(agentId)}/chunks?${qs}`,
      undefined,
      this.tenantHeaders(opts?.tenantId),
      { read: true },
    );
  }

  read(
    agentId: string,
    body: { chunkId?: string; sourceId?: string; path?: string },
    opts?: { tenantId?: string },
  ): Promise<{
    found: boolean;
    path?: string;
    startLine?: number;
    endLine?: number;
    text?: string;
    chunkCount?: number;
  }> {
    return this.request(
      'POST',
      `/v1/principals/${encodeURIComponent(agentId)}/read`,
      body,
      this.tenantHeaders(opts?.tenantId),
    );
  }

  /** 租户断言头（T3，arch/multi-tenancy.md §6）：token=platform 时上行 run 归属域 */
  private tenantHeaders(
    tenantId?: string,
    fenceExemptGranted?: boolean,
  ): Record<string, string> | undefined {
    const t = tenantId ?? this.tenantProvider?.();
    const headers: Record<string, string> = {};
    if (t) headers['x-octopi-tenant'] = t;
    // R5/MAJOR-3a 豁免资格（受信链内声明）：写服务据此推导行级 fenceExempt 标记
    if (fenceExemptGranted) headers['x-octopi-fence-exempt'] = '1';
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  getVisibility(agentId: string): Promise<{
    assignedProjects: string[];
    hiddenSourceIds: string[];
  }> {
    return this.request(
      'GET',
      `/v1/principals/${encodeURIComponent(agentId)}/visibility`,
      undefined,
      undefined,
      { read: true },
    );
  }

  sessionVisibility(
    agentId: string,
    sessionId: string,
    opts?: { tenantId?: string },
  ): Promise<Array<Record<string, unknown>>> {
    return this.request(
      'GET',
      `/v1/principals/${encodeURIComponent(agentId)}/session-visibility?sessionId=${encodeURIComponent(sessionId)}`,
      undefined,
      this.tenantHeaders(opts?.tenantId),
      { read: true },
    );
  }

  /**
   * agent 级可见性 override（T3b 挂载物化）：op=mount|unmount|hide|unhide。
   *
   * @param agentId - 消费 agent
   * @param op - override 操作
   * @param sourceId - 目标知识源
   * @param opts - 租户断言（token=platform 时上行归属域）
   */
  setAgentVisibility(
    agentId: string,
    op: 'mount' | 'unmount' | 'hide' | 'unhide',
    sourceId: string,
    opts?: { tenantId?: string },
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/v1/principals/${encodeURIComponent(agentId)}/visibility`,
      { op, sourceId },
      this.tenantHeaders(opts?.tenantId),
    );
  }

  setSessionVisibility(
    agentId: string,
    item: {
      sessionId: string;
      targetType: 'project' | 'source';
      targetId: string;
      op: 'include' | 'exclude';
    },
    opts?: { tenantId?: string },
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/v1/principals/${encodeURIComponent(agentId)}/session-visibility`,
      item,
      this.tenantHeaders(opts?.tenantId),
    );
  }

  replaceSessionVisibility(
    agentId: string,
    sessionId: string,
    items: Array<{ targetType: 'project' | 'source'; targetId: string; op: 'include' | 'exclude' }>,
    opts?: { tenantId?: string },
  ): Promise<unknown> {
    return this.request(
      'PUT',
      `/v1/principals/${encodeURIComponent(agentId)}/session-visibility`,
      { sessionId, items },
      this.tenantHeaders(opts?.tenantId),
    );
  }

  clearSessionVisibility(
    agentId: string,
    sessionId: string,
    target?: { targetType: 'project' | 'source'; targetId: string },
    opts?: { tenantId?: string },
    op?: 'include' | 'exclude',
  ): Promise<unknown> {
    const qs = new URLSearchParams({ sessionId });
    if (target?.targetType && target?.targetId) {
      qs.set('targetType', target.targetType);
      qs.set('targetId', target.targetId);
    }
    if (op) qs.set('op', op);
    return this.request(
      'DELETE',
      `/v1/principals/${encodeURIComponent(agentId)}/session-visibility?${qs}`,
      undefined,
      this.tenantHeaders(opts?.tenantId),
    );
  }

  jobControl(sourceId: string): Promise<{
    aborted: boolean;
    jobsQueued: number;
    jobsRunning: number;
    jobsCancelled: number;
    embedMissing: boolean;
    canAbort: boolean;
    canResume: boolean;
  }> {
    return this.request(
      'GET',
      `/v1/jobs/control?sourceId=${encodeURIComponent(sourceId)}`,
      undefined,
      undefined,
      { read: true },
    );
  }

  jobs(query?: { sourceId?: string; status?: string }): Promise<Array<Record<string, unknown>>> {
    const qs = new URLSearchParams();
    if (query?.sourceId) qs.set('sourceId', query.sourceId);
    if (query?.status) qs.set('status', query.status);
    const s = qs.toString();
    return this.request('GET', `/v1/jobs${s ? `?${s}` : ''}`, undefined, undefined, {
      read: true,
    });
  }
}

/**
 * AutoGroundPort 适配器 — Gateway 侧 turn 级 grounding 走 Knowledge Service。
 * 不打开 knowledge.db；分档逻辑在 Search Worker 的 KnowledgeRetriever.autoGround。
 */
export class ClientKnowledgeGrounding {
  constructor(
    private readonly client: KnowledgeClient,
    /** 缺省 recall（agents[].knowledge.recall / 全局）；请求可覆盖 */
    private readonly defaultRecall?: 'off' | 'hint' | 'hybrid' | 'inject',
  ) {}

  async autoGround(
    query: string,
    opts: {
      agentId: string;
      sessionId?: string;
      limit?: number;
      tenantId?: string;
      gatewayId?: string;
      recall?: 'off' | 'hint' | 'hybrid' | 'inject';
    },
  ): Promise<import('./retriever.js').AutoGroundDecision> {
    await this.client.ensurePrincipal(opts.agentId).catch(() => undefined);
    const recall = opts.recall ?? this.defaultRecall;
    return (await this.client.autoGround(opts.agentId, query, {
      ...(opts.sessionId != null ? { sessionId: opts.sessionId } : {}),
      ...(opts.limit != null ? { limit: opts.limit } : {}),
      // 租户断言（T3）：run 归属域上行，服务端按 token 域包含校验
      ...(opts.tenantId != null ? { tenantId: opts.tenantId } : {}),
      ...(recall ? { recall } : {}),
    })) as import('./retriever.js').AutoGroundDecision;
  }
}
