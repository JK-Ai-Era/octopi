/**
 * Octopi Web Protocol SDK
 *
 * 第一版协议层，面向浏览器前端。
 * 只负责连接、请求、事件分发，不承载 UI 观点。
 *
 * 设计目标：
 * - REST 走 /api/v1
 * - WS 走 /ws
 * - 连接状态机独立于 UI
 * - 事件映射交给上层 Runtime Store
 */

// ──────────────────────────────────────
// Types
// ──────────────────────────────────────

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export interface OctopiClientOptions {
  baseUrl: string;
  apiKey?: string;
  wsPath?: string;
  restPath?: string;
  autoReconnect?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  now?: () => number;
}

export interface AgentSummary {
  id: string;
  model: {
    provider: string;
    model: string;
    contextWindow?: number;
  };
}

export interface ModelCatalogItem {
  id: string;
  provider: string;
  model: string;
  /** 未配置时为 null */
  contextWindow: number | null;
  maxOutputTokens?: number;
  known: boolean;
  source: string;
}

export interface AgentModelSummary {
  agentId: string;
  defaultModelId: string;
}

export interface ModelCatalog {
  models: ModelCatalogItem[];
  agents: AgentModelSummary[];
  levels?: Record<string, { primary: string; fallback?: string[] }>;
}

export interface SessionModelView {
  sessionId: string;
  agentId: string;
  modelId: string | null;
  defaultModelId: string;
  /** 当前生效模型能力快照（引擎同源） */
  resolved?: ModelCatalogItem;
}

export interface ProviderSummary {
  name: string;
  circuitBreaker: {
    state: string;
    failureCount: number;
  };
}

export interface SessionSummary {
  id: string;
  agentId: string;
  channelId: string;
  peerId: string;
  status: string;
  createdAt: number;
  sessionStartedAt: number;
  lastInteractionAt: number;
  updatedAt: number;
}

export interface SessionView {
  meta: SessionSummary;
  messageCount: number;
  turnCount: number;
  taskCount?: number;
}

/** 会话任务（UI 只读） */
export interface SessionTaskView {
  id: string;
  parentId?: string;
  description: string;
  status: 'open' | 'paused' | 'done' | 'dropped';
  progressNote?: string;
  order?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  role: string;
  content: unknown;
  timestamp: number;
  source?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface MessagePage {
  messages: MessageRecord[];
  nextCursor?: string;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  riskDescription: string;
  actionDescription: string;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  agentId: string;
  request: ApprovalRequest;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  updatedAt?: number;
  decidedAt?: number;
  decisionReason?: string;
}

export interface MemoryStats {
  configured: boolean;
  totalEntries?: number;
  byType?: Record<string, number>;
  avgConfidence?: number;
  avgImportance?: number;
}

/** 七层装配 UI 快照（与 harness/context/layer-snapshot 对齐） */
export interface LayerRuntimeViewDto {
  id: 'wisdom' | 'persona' | 'skill' | 'knowledge' | 'cognition' | 'memory' | 'runtime';
  status: 'idle' | 'included' | 'empty' | 'dropped' | 'error' | 'unregistered';
  included: boolean;
  tokens: number;
  budgetTokens: number;
  priority: number;
  order: number;
  droppable: boolean;
  reason?: string;
  dropped?: string;
  sources?: string[];
  preview?: string;
  /** 层正文全文（includeLayerContent 时） */
  content?: string;
}

export interface ContextLayersSnapshotDto {
  sessionId: string;
  assembledAt?: number;
  systemBudget: number;
  structureReserve?: number;
  usedTokens: number;
  shares: Partial<Record<LayerRuntimeViewDto['id'], number>>;
  query?: string;
  layers: LayerRuntimeViewDto[];
  enabledLayerIds: LayerRuntimeViewDto['id'][];
  fallback?: boolean;
  fallbackError?: string;
}

export interface ContextLayerHealthDto {
  agentId: string;
  configured: boolean;
  layers: Array<{
    id: LayerRuntimeViewDto['id'];
    registered: boolean;
    entries?: number;
    extra?: Record<string, number>;
  }>;
  summary: {
    skills?: number;
    memory?: number;
    knowledge?: number;
    wisdom?: number;
    cognitionNodes?: number;
    cognitionEdges?: number;
    personaLoaded?: boolean;
  };
}

/** 近 N 轮装配摘要（timeline 用） */
export interface ContextLayerTurnSummaryDto {
  assembledAt?: number;
  usedTokens: number;
  systemBudget: number;
  included: LayerRuntimeViewDto['id'][];
  dropped: LayerRuntimeViewDto['id'][];
}

export interface MemoryQueryResult {
  configured: boolean;
  entries?: Array<{
    id: string;
    type: string;
    content: string;
    source: string;
    confidence: number;
    importance: number;
    tags: string[];
  }>;
}

export interface AgentEventEnvelope {
  type: string;
  timestamp?: number;
  agentId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export interface WsEnvelope {
  type: string;
  sessionId?: string;
  messageId?: string;
  message?: string;
  agents?: AgentSummary[];
  event?: AgentEventEnvelope;
  state?: string;
}

export interface OctopiClientEvents {
  onConnectionState?: (state: ConnectionState) => void;
  onWelcome?: (agents: AgentSummary[]) => void;
  onAccepted?: (sessionId: string | undefined, messageId: string | undefined) => void;
  onEvent?: (sessionId: string | undefined, event: AgentEventEnvelope) => void;
  onState?: (sessionId: string | undefined, state: string) => void;
  onError?: (error: Error) => void;
}

// ──────────────────────────────────────
// Helpers
// ──────────────────────────────────────

function defaultNow(): number {
  return Date.now();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function parseJsonResponse<T = unknown>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// ──────────────────────────────────────
// Client
// ──────────────────────────────────────

export class OctopiClient {
  private options: Required<Pick<OctopiClientOptions, 'wsPath' | 'restPath' | 'autoReconnect' | 'reconnectBaseDelayMs' | 'reconnectMaxDelayMs' | 'now'>> & OctopiClientOptions;
  private baseUrl: string;
  private restBase: string;

  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private lastWelcomeAgents: AgentSummary[] = [];

  private readonly listeners: OctopiClientEvents = {};

  constructor(options: OctopiClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.restBase = `${this.baseUrl}${options.restPath ?? '/api/v1'}`;

    this.options = {
      ...options,
      baseUrl: this.baseUrl,
      wsPath: options.wsPath ?? '/ws',
      restPath: options.restPath ?? '/api/v1',
      autoReconnect: options.autoReconnect ?? true,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs ?? 500,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 10_000,
      now: options.now ?? defaultNow,
    };
  }

  // ──────────────────────────────────
  // Public API: REST
  // ──────────────────────────────────

  async health(): Promise<{ status: string; agents: AgentSummary[] }> {
    const data = await this.getJson('/health');
    return {
      status: String(data?.data?.status ?? data?.status ?? 'unknown'),
      agents: (data?.data?.agents as AgentSummary[]) ?? [],
    };
  }

  async getAgents(): Promise<AgentSummary[]> {
    const data = await this.getJson('/agents');
    return (data?.data as AgentSummary[]) ?? [];
  }

  /**
   * 模型目录（provider 全量模型 + agent 默认 + levels）
   */
  async getModels(): Promise<ModelCatalog> {
    const data = await this.getJson('/models');
    return (data?.data as ModelCatalog) ?? { models: [], agents: [] };
  }

  /**
   * 查询 session 当前模型
   */
  async getSessionModel(sessionId: string, agentId?: string): Promise<SessionModelView | null> {
    const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    const data = await this.getJson(`/sessions/${encodeURIComponent(sessionId)}/model${qs}`);
    return (data?.data as SessionModelView | null | undefined) ?? null;
  }

  /**
   * 设置 session 模型（null = 恢复 agent 默认）
   */
  async setSessionModel(
    sessionId: string,
    model: string | null,
    agentId?: string,
  ): Promise<SessionModelView> {
    const data = await this.postJson(`/sessions/${encodeURIComponent(sessionId)}/model`, {
      model,
      ...(agentId ? { agentId } : {}),
    });
    return data?.data as SessionModelView;
  }

  /**
   * 手动结构压缩（不依赖 contextWindow）
   */
  async compactSession(sessionId: string, agentId?: string): Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    tokensBefore: number;
    tokensAfter?: number;
    summary?: string;
  }> {
    const data = await this.postJson(`/sessions/${encodeURIComponent(sessionId)}/compact`, {
      ...(agentId ? { agentId } : {}),
    });
    return data?.data;
  }

  async getProviders(): Promise<ProviderSummary[]> {
    const data = await this.getJson('/providers');
    return (data?.data as ProviderSummary[]) ?? [];
  }

  async listSessions(agentId?: string): Promise<SessionSummary[]> {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    const data = await this.getJson(`/sessions${query}`);
    const sessions = (data?.data as SessionSummary[]) ?? [];
    // 兜底：确保 lastInteractionAt 始终为有效时间戳
    return sessions.map((s) => ({
      ...s,
      lastInteractionAt: s.lastInteractionAt ?? s.updatedAt ?? s.createdAt ?? Date.now(),
    }));
  }

  async createSession(options: {
    agentId: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    /** 会话级模型（`provider/model` 或裸名）；写入 session.metadata.model */
    model?: string;
  }): Promise<SessionSummary> {
    const data = await this.postJson('/sessions', options);
    return data?.data as SessionSummary;
  }

  async getSession(sessionId: string): Promise<SessionView> {
    const data = await this.getJson(`/sessions/${encodeURIComponent(sessionId)}`);
    return data?.data as SessionView;
  }

  async getSessionMessages(sessionId: string, options?: { limit?: number; cursor?: string }): Promise<MessagePage> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.cursor) params.set('cursor', options.cursor);
    const qs = params.toString();
    const data = await this.getJson(`/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`);
    return (data?.data as MessagePage) ?? { messages: [] };
  }

  /**
   * 会话任务列表（只读）
   */
  async getSessionTasks(sessionId: string, options?: { agentId?: string }): Promise<SessionTaskView[]> {
    const params = new URLSearchParams();
    if (options?.agentId) params.set('agentId', options.agentId);
    const qs = params.toString();
    const data = await this.getJson(
      `/sessions/${encodeURIComponent(sessionId)}/tasks${qs ? `?${qs}` : ''}`,
    );
    return (data?.data as SessionTaskView[]) ?? [];
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.postJson(`/sessions/${encodeURIComponent(sessionId)}/abort`, {});
  }

  /**
   * 会话最近一次七层装配快照
   *
   * @param sessionId - 会话 id
   * @returns 快照；无装配记录时为 null
   */
  async getSessionContextLayers(sessionId: string): Promise<ContextLayersSnapshotDto | null> {
    const data = await this.getJson(`/sessions/${encodeURIComponent(sessionId)}/context/layers`);
    return (data?.data as ContextLayersSnapshotDto | null | undefined) ?? null;
  }

  /**
   * Agent 七层数据面健康
   *
   * @param agentId - Agent id
   * @returns 健康快照
   */
  async getAgentContextHealth(agentId: string): Promise<ContextLayerHealthDto | null> {
    const data = await this.getJson(`/agents/${encodeURIComponent(agentId)}/context/health`);
    return (data?.data as ContextLayerHealthDto | null | undefined) ?? null;
  }

  async listApprovals(): Promise<PendingApproval[]> {
    const data = await this.getJson('/approvals');
    return (data?.data as PendingApproval[]) ?? [];
  }

  async resolveApproval(approvalId: string, input: { action: 'approve' | 'reject'; reason?: string }): Promise<PendingApproval> {
    const data = await this.postJson(`/approvals/${encodeURIComponent(approvalId)}`, input);
    return data?.data as PendingApproval;
  }

  async getMemoryStats(): Promise<MemoryStats> {
    const data = await this.getJson('/memory/stats');
    const payload = data?.data as MemoryStats | undefined;
    return payload ?? { configured: false };
  }

  async queryMemory(q: string, limit = 10): Promise<MemoryQueryResult> {
    const data = await this.getJson(`/memory/query?q=${encodeURIComponent(q)}&limit=${limit}`);
    const payload = data?.data as MemoryQueryResult | undefined;
    return payload ?? { configured: false };
  }

  // ──────────────────────────────────
  // Public API: WS
  // ──────────────────────────────────

  on(events: OctopiClientEvents): void {
    Object.assign(this.listeners, events);
    this.emitConnectionState();
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  connect(): void {
    if (this.ws) {
      return;
    }

    this.intentionalClose = false;
    this.setConnectionState('connecting');
    this.openSocket();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnect();
    this.closeSocket();
    this.setConnectionState('disconnected');
  }

  /** Update connection options without recreating the client */
  updateOptions(partial: { baseUrl?: string; apiKey?: string }): void {
    if (partial.baseUrl) {
      this.baseUrl = normalizeBaseUrl(partial.baseUrl);
      this.options.baseUrl = this.baseUrl;
      this.restBase = `${this.baseUrl}${this.options.restPath}`;
    }
    if (partial.apiKey !== undefined) {
      this.options.apiKey = partial.apiKey || undefined;
    }
  }

  sendChat(
    sessionId: string,
    agentId: string,
    content: string,
    options?: { model?: string },
  ): void {
    this.send({
      type: 'chat',
      sessionId,
      agentId,
      content,
      senderId: 'web-ui',
      ...(options?.model ? { metadata: { model: options.model } } : {}),
    });
  }

  sendAbort(sessionId: string): void {
    this.send({
      type: 'abort',
      sessionId,
    });
  }

  sendSubscribe(sessionId: string, agentId?: string): void {
    this.send({
      type: 'subscribe',
      sessionId,
      agentId,
    });
  }

  sendUnsubscribe(sessionId: string): void {
    this.send({
      type: 'unsubscribe',
      sessionId,
    });
  }

  // ──────────────────────────────────
  // Internals
  // ──────────────────────────────────

  private emitConnectionState(): void {
    this.listeners.onConnectionState?.(this.connectionState);
  }

  private setConnectionState(next: ConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    this.emitConnectionState();
  }

  private openSocket(): void {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + this.options.wsPath;
    const socket = new WebSocket(wsUrl);
    this.ws = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      // Send auth via message instead of URL query parameter to avoid leaking credentials
      if (this.options.apiKey) {
        this.send({ type: 'auth', token: this.options.apiKey });
      }
      this.setConnectionState('connected');
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as WsEnvelope;
        this.handleEnvelope(payload);
      } catch (error) {
        this.listeners.onError?.(new Error('Failed to parse WS message'));
      }
    });

    socket.addEventListener('close', () => {
      this.ws = null;
      if (this.intentionalClose) {
        this.setConnectionState('disconnected');
        return;
      }

      if (!this.options.autoReconnect) {
        this.setConnectionState('disconnected');
        return;
      }

      this.setConnectionState('reconnecting');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      this.listeners.onError?.(new Error('WebSocket transport error'));
    });
  }


  private scheduleReconnect(): void {
    this.clearReconnect();
    const attempt = this.reconnectAttempt++;
    const delay = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectBaseDelayMs * Math.max(1, 2 ** attempt),
    );
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  private handleEnvelope(envelope: WsEnvelope): void {
    if (envelope.type === 'event' && envelope.event) {
      console.debug('[WS Client] event:', envelope.event.type, 'sessionId=', envelope.sessionId, 'data=', envelope.event.data);
    }
    switch (envelope.type) {
      case 'connected':
        this.lastWelcomeAgents = envelope.agents ?? [];
        this.listeners.onWelcome?.(this.lastWelcomeAgents);
        break;
      case 'accepted':
        this.listeners.onAccepted?.(envelope.sessionId, envelope.messageId);
        break;
      case 'event':
        this.listeners.onEvent?.(envelope.sessionId, envelope.event ?? { type: 'unknown' });
        break;
      case 'state':
        this.listeners.onState?.(envelope.sessionId, envelope.state ?? 'unknown');
        break;
      case 'error':
        this.listeners.onError?.(new Error(envelope.message ?? 'Gateway WS error'));
        break;
      default:
        break;
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    this.ws.send(JSON.stringify(payload));
  }

  private async getJson<T = any>(path: string): Promise<T> {
    const response = await fetch(`${this.restBase}${path}`, {
      headers: this.buildHeaders(),
    });
    return parseJsonResponse(response);
  }

  private async postJson<T = any>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.restBase}${path}`, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });
    return parseJsonResponse(response);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.options.apiKey) {
      headers.Authorization = `Bearer ${this.options.apiKey}`;
    }
    return headers;
  }
}
