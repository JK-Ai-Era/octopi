/**
 * KnowledgeClient — Gateway 侧 RPC（不打开 knowledge.db）
 */

export interface KnowledgeClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class KnowledgeClient {
  constructor(private readonly opts: KnowledgeClientOptions) {}

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
  ): Promise<T> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 5000);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          ...(body != null ? { 'content-type': 'application/json' } : {}),
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
    } finally {
      clearTimeout(t);
    }
  }

  health(): Promise<{ ok: boolean; service: string; version: string }> {
    return this.request('GET', '/health');
  }

  ready(): Promise<{ ready: boolean; sqliteVec: boolean }> {
    return this.request('GET', '/v1/ready');
  }

  ensurePrincipal(localAgentId: string, displayName?: string): Promise<unknown> {
    return this.request('PUT', `/v1/principals/${encodeURIComponent(localAgentId)}`, {
      displayName,
      status: 'active',
    });
  }

  listSources(): Promise<Array<Record<string, unknown>>> {
    return this.request('GET', '/v1/sources');
  }

  createSource(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/v1/sources', input);
  }

  patchSource(
    sourceId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/v1/sources/${encodeURIComponent(sourceId)}`, patch);
  }

  deleteSource(sourceId: string): Promise<unknown> {
    return this.request('DELETE', `/v1/sources/${encodeURIComponent(sourceId)}`);
  }

  reindex(sourceId: string): Promise<unknown> {
    return this.request('POST', `/v1/sources/${encodeURIComponent(sourceId)}/reindex`);
  }

  search(
    agentId: string,
    q: string,
    opts?: { sessionId?: string; limit?: number },
  ): Promise<{ hits: unknown[]; keywordHits: number; vectorHits: number }> {
    const qs = new URLSearchParams({ q });
    if (opts?.sessionId) qs.set('sessionId', opts.sessionId);
    if (opts?.limit != null) qs.set('limit', String(opts.limit));
    return this.request('GET', `/v1/principals/${encodeURIComponent(agentId)}/search?${qs}`);
  }

  stats(agentId: string): Promise<Record<string, number>> {
    return this.request('GET', `/v1/principals/${encodeURIComponent(agentId)}/stats`);
  }

  visibility(
    agentId: string,
    op: 'assignProject' | 'unassignProject' | 'hide' | 'unhide',
    body: { projectKey?: string; sourceId?: string },
  ): Promise<unknown> {
    return this.request('POST', `/v1/principals/${encodeURIComponent(agentId)}/visibility`, {
      op,
      ...body,
    });
  }

  listProjects(): Promise<Array<Record<string, unknown>>> {
    return this.request('GET', '/v1/projects');
  }

  createProject(input: {
    projectKey: string;
    displayName?: string;
    visibility?: string;
  }): Promise<Record<string, unknown>> {
    return this.request('POST', '/v1/projects', input);
  }

  deleteProject(projectKey: string): Promise<unknown> {
    return this.request('DELETE', `/v1/projects/${encodeURIComponent(projectKey)}`);
  }

  getSource(sourceId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/sources/${encodeURIComponent(sourceId)}`);
  }

  abort(sourceId: string): Promise<unknown> {
    return this.request('POST', `/v1/sources/${encodeURIComponent(sourceId)}/abort`);
  }

  resume(sourceId: string): Promise<unknown> {
    return this.request('POST', `/v1/sources/${encodeURIComponent(sourceId)}/resume`);
  }

  listFiles(sourceId: string): Promise<Array<Record<string, unknown>>> {
    return this.request('GET', `/v1/sources/${encodeURIComponent(sourceId)}/files`);
  }

  catalog(agentId: string): Promise<unknown[]> {
    return this.request('GET', `/v1/principals/${encodeURIComponent(agentId)}/catalog`);
  }

  listChunks(
    agentId: string,
    sourceId: string,
    path: string,
  ): Promise<
    Array<{ id: string; text: string; startLine: number; endLine: number; ordinal: number; path: string }>
  > {
    const qs = new URLSearchParams({ sourceId, path });
    return this.request(
      'GET',
      `/v1/principals/${encodeURIComponent(agentId)}/chunks?${qs}`,
    );
  }

  read(
    agentId: string,
    body: { chunkId?: string; sourceId?: string; path?: string },
  ): Promise<{
    found: boolean;
    path?: string;
    startLine?: number;
    endLine?: number;
    text?: string;
    chunkCount?: number;
  }> {
    return this.request('POST', `/v1/principals/${encodeURIComponent(agentId)}/read`, body);
  }

  getVisibility(agentId: string): Promise<{
    assignedProjects: string[];
    hiddenSourceIds: string[];
  }> {
    return this.request('GET', `/v1/principals/${encodeURIComponent(agentId)}/visibility`);
  }

  sessionVisibility(
    agentId: string,
    sessionId: string,
  ): Promise<Array<Record<string, unknown>>> {
    return this.request(
      'GET',
      `/v1/principals/${encodeURIComponent(agentId)}/session-visibility?sessionId=${encodeURIComponent(sessionId)}`,
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
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/v1/principals/${encodeURIComponent(agentId)}/session-visibility`,
      item,
    );
  }

  clearSessionVisibility(
    agentId: string,
    sessionId: string,
    target?: { targetType: 'project' | 'source'; targetId: string },
  ): Promise<unknown> {
    const qs = new URLSearchParams({ sessionId });
    if (target?.targetType && target?.targetId) {
      qs.set('targetType', target.targetType);
      qs.set('targetId', target.targetId);
    }
    return this.request(
      'DELETE',
      `/v1/principals/${encodeURIComponent(agentId)}/session-visibility?${qs}`,
    );
  }

  jobs(query?: { sourceId?: string; status?: string }): Promise<Array<Record<string, unknown>>> {
    const qs = new URLSearchParams();
    if (query?.sourceId) qs.set('sourceId', query.sourceId);
    if (query?.status) qs.set('status', query.status);
    const s = qs.toString();
    return this.request('GET', `/v1/jobs${s ? `?${s}` : ''}`);
  }
}
