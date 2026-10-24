/**
 * Octopi Web Protocol SDK
 *
 * 第一版协议层，面向浏览器前端。
 * 只负责连接、请求、事件分发，不承担 UI 观点。
 *
 * 设计目标：
 * - REST `/api/v1`
 * - WS `/ws`
 * - 连接状态机独立于 UI
 * - 事件映射交给上层 Runtime Store
 */

// ──────────────────────────────────────
// Types
// ──────────────────────────────────────

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

/**
 * 对话斜杠命令目录项（与 `CommandCatalogItem` 的传输投影对齐）。
 * 权威类型：`harness/extension/plugin-ecosystem/commands/types.ts`。
 */
export interface CommandCatalogItemDto {
  name: string;
  display: string;
  description: string;
  usage?: string;
  kind: string;
  source: string;
}

/**
 * Git 状态快照 DTO（WebUI Git 页签）。
 * 权威实现：engine `harness/extension/plugin-ecosystem/tools/git-status-snapshot.ts`
 * （Gateway.getSessionGitStatus 组装 path + snapshot）。
 */
export interface GitStatusEntryView {
  kind: 'changed' | 'renamed' | 'copied' | 'untracked' | 'conflicted';
  group: 'conflicted' | 'staged' | 'unstaged' | 'untracked';
  /** 索引侧状态字符（'.' = 未暂存变化） */
  x: string;
  /** 工作树侧状态字符（'.' = 无未暂存变化） */
  y: string;
  path: string;
  /** rename/copy 的源路径 */
  origPath?: string;
}

export interface GitStatusBranchView {
  /** HEAD oid；首个提交之前为 null（(initial)） */
  oid: string | null;
  /** 分支名；detached 时为 null */
  head: string | null;
  detached: boolean;
  initial: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface GitStatusView {
  path: string;
  /** false = 目录不在任何 git 工作树内（是状态不是错误） */
  isRepo: boolean;
  repoRoot: string | null;
  branch: GitStatusBranchView | null;
  /** 全量计数（不受 entries 截断影响） */
  counts: { conflicted: number; staged: number; unstaged: number; untracked: number };
  entries: GitStatusEntryView[];
  truncated: boolean;
  /** 已知类型但解析失败的记录数（格式漂移信号，>0 时计数可能不完整） */
  skippedRecords: number;
  generatedAt: string;
}

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
  /** Effective effectPolicy.mode (workspace|project|host|untrusted) */
  effectMode?: string;
  /** agent | global | default */
  effectModeSource?: 'agent' | 'global' | 'default';
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
  /** 展示标题（snippet / auto / user）；缺省回退短 id */
  title?: string;
  titleSource?: 'snippet' | 'auto' | 'user';
  titleUpdatedAt?: number;
  /** 置顶时间戳（epoch ms）；存在即置顶排序 */
  pinnedAt?: number;
  /** 实时运行态投影（服务端按活跃 Run 标注；不落盘） */
  running?: boolean;
}

export interface SessionView {
  meta: SessionSummary;
  messageCount: number;
  turnCount: number;
  taskCount?: number;
  /** 被中止的轮（编辑重发入口）；userMessageIndex 为 session.messages 下标 */
  abortedTurn?: { userMessageIndex: number; at?: number };
  /** 最近一次 LLM 调用的上下文用量（runner 持久化；重开会话恢复显示，不再用末页消息估算） */
  contextTokens?: number;
  contextWindow?: number;
}

/** 会话任务（UI 只读）*/
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

/** 会话日程（UI 投影） */
export interface SessionScheduleView {
  id: string;
  sessionId: string;
  kind: 'once' | 'interval' | 'cron';
  status: 'active' | 'paused' | 'completed' | 'cancelled' | 'failed';
  nextFireAt: number;
  fireAt?: number;
  intervalMs?: number;
  cron?: string;
  runCount: number;
  maxRuns?: number;
  title?: string;
  prompt: string;
  delivery: 'wakeup' | 'notify';
  catchUp: 'skip' | 'fire_once';
  coalesceKey?: string;
  createdAt: number;
  createdByRunId?: string;
  lastFireAt?: number;
  lastError?: string;
}

/** Knowledge 源传输投影（管理面） */
export interface KnowledgeSourceDto {
  id: string;
  kind: string;
  location: string;
  scopeRef: { level: 'global' | 'project' | 'session'; key: string };
  sync: { strategy: string; debounceMs?: number; intervalMs?: number; enabled: boolean };
  status: string;
  coverage?: number;
  errors?: Array<{ path?: string; message: string; at: number }>;
  displayName: string;
  description?: string;
  generatedDescription?: string;
  catalogPriority?: number;
  hiddenFromCatalog?: boolean;
  authRef?: string;
  lastPolledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeJobControlDto {
  aborted: boolean;
  jobsQueued: number;
  jobsRunning: number;
  jobsCancelled: number;
  embedMissing: boolean;
  canAbort: boolean;
  canResume: boolean;
}

export interface KnowledgeSourceDetailDto extends KnowledgeSourceDto {
  fileCount: number;
  chunkCount: number;
  embeddingCount: number;
  errorFileCount: number;
  skippedFileCount: number;
  assignedAgentIds: string[];
  hiddenForAgentIds: string[];
  /** 中止/继续 互斥按钮读数 */
  jobControl?: KnowledgeJobControlDto;
}

export interface KnowledgeSessionVisibilityItemDto {
  sessionId: string;
  targetType: 'project' | 'source';
  targetId: string;
  op: 'include' | 'exclude';
  createdAt: number;
}

export interface MessageRecord {
  role: string;
  content: unknown;
  timestamp: number;
  /** 在 session.messages 中的绝对下标（分叉定位用） */
  index?: number;
  source?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface MessagePage {
  messages: MessageRecord[];
  nextCursor?: string;
  /** session.messages 总数 */
  total?: number;
  /** backward 模式下是否还有更早消息 */
  hasMore?: boolean;
  /** 在途 Run 现场快照（盲窗 overlay）：未定形流式正文 / running 工具；Run 不活跃缺省 */
  live?: import('../../protocols/live-run-tracker.js').LiveRunOverlay;
}

/** 会话附件（OP-15） */
export interface SessionAttachmentDto {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  contentHash: string;
  path: string;
  extractPath?: string;
  status: 'ready' | 'parsing' | 'parsed' | 'parse_failed' | 'promoted';
  kind: 'document' | 'image' | 'text' | 'code' | 'other';
  createdAt: number;
  parse?: { ok: boolean; chars?: number; error?: string };
  searchableSourceId?: string;
  promoted?: { projectKey: string; targetSourceId?: string; at: number };
}

export interface ApprovalRequest {
  id: string;
  kind: 'high_risk' | 'effect';
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  riskDescription: string;
  actionDescription: string;
}

export type ApprovalScope = 'once' | 'session' | 'always';

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
  decisionScope?: ApprovalScope;
}

/** ask_user 待答问题 */
export interface PendingQuestion {
  id: string;
  sessionId: string;
  agentId: string;
  question: string;
  options?: string[];
  status: 'pending' | 'answered' | 'cancelled';
  createdAt: number;
  updatedAt?: number;
  decidedAt?: number;
  answer?: string;
}

/** Client Tool 描述符（客户端上报） */
export interface ClientToolDescriptorDto {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  interaction?: 'silent' | 'ui' | 'device';
  device?: {
    class?: 'sensor' | 'actuator' | 'media_io';
    sensitivity?: 'public' | 'personal' | 'sensitive';
    consent?: 'none' | 'prompt' | 'strict';
  };
  resultKinds?: Array<'value' | 'asset'>;
  processing?: 'server' | 'local';
  /** Host 流通道域工具（§15.1）；LLM 结果仍为 value 句柄 */
  stream?: {
    direction: 'source' | 'sink' | 'stop';
    handleKey?: string;
  };
  version?: string;
}

export type ClientToolCallOutcomeDto =
  | {
      status: 'ok';
      result:
        | { kind: 'value'; data: unknown }
        | {
            kind: 'asset';
            assetId: string;
            mime: string;
            sizeBytes: number;
            name?: string;
            preview?: string;
          };
    }
  | {
      status: 'error';
      reason:
        | 'invalid_arguments'
        | 'client_unavailable'
        | 'consent_denied'
        | 'permission_denied'
        | 'expired'
        | 'cancelled'
        | 'unsupported'
        | 'internal';
      hint?: string;
    };

export interface ClientToolCallDto {
  id: string;
  name: string;
  sessionId: string;
  agentId: string;
  args: Record<string, unknown>;
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  targetClientInstanceId?: string;
  outcome?: ClientToolCallOutcomeDto;
  completedByPrincipalId?: string;
  /** html_ui 正文 attachment 引用 */
  assetId?: string;
  /** send_file 已 release 文件引用；正文 GET /sessions/:id/files/:fileId */
  fileRef?: {
    fileId: string;
    name: string;
    mime: string;
    sizeBytes: number;
  };
  createdAt: number;
  ttlAt: number;
}

export interface MemoryStats {
  configured: boolean;
  totalEntries?: number;
  byType?: Record<string, number>;
  avgConfidence?: number;
  avgImportance?: number;
}

/** System 装配 UI 快照（产品八层之 1）；与 harness/context/layer-snapshot 对齐。*/
export interface LayerRuntimeViewDto {
  id: 'wisdom' | 'persona' | 'skill' | 'knowledge' | 'cognition' | 'memory' | 'runtime';
  /** E8 装配位置；同 id 双实例时主行=system、附加行=snapshot（如 runtime 双份） */
  placement?: 'system' | 'snapshot';
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
  /** 易变快照组实际使用 token（E8 分账；无 snapshot 层时缺省） */
  usedSnapshotTokens?: number;
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

/** 前 N 轮装配摘要（timeline 用） */
export interface ContextLayerTurnSummaryDto {
  assembledAt?: number;
  /** system 组用量 */
  usedTokens: number;
  /** 易变快照组用量（E8 分账；无 snapshot 层时缺省） */
  usedSnapshotTokens?: number;
  systemBudget: number;
  /** system 组纳入（去重；双 runtime 时为主行） */
  included: LayerRuntimeViewDto['id'][];
  dropped: LayerRuntimeViewDto['id'][];
  /** snapshot 组纳入/丢弃（与 included/dropped 可能同 id，如 runtime 双份） */
  snapshotIncluded?: LayerRuntimeViewDto['id'][];
  snapshotDropped?: LayerRuntimeViewDto['id'][];
}

export interface RunScopeViewDto {
  sessionId: string;
  agentId: string;
  runId?: string;
  agentRevision?: string;
  systemPromptChars?: number;
  systemPromptPreview?: string;
  systemPromptFull?: string;
  toolRuntime?: {
    sessionId: string;
    agentId: string;
    messagesCount: number;
    cwd?: string;
    isolation?: string;
  };
  resolvedModel?: {
    modelName?: string;
    providerId?: string;
    contextWindow?: number;
  };
  capturedAt: number;
}

export interface RunMessagesSummaryDto {
  count: number;
  byRole: Record<string, number>;
  /** 按归因 kind 计数（机器插槽与用户发言分开；WS 增量合并时可能缺省） */
  byKind?: Record<string, number>;
  systemPromptCount: number;
  contextSummaryCount: number;
  hiddenFromChatCount: number;
  chars: number;
  agentIds: string[];
}

export interface RunTimelineEventDto {
  type: string;
  timestamp: number;
  agentId?: string;
  toolCallId?: string;
  toolName?: string;
  hasError?: boolean;
  durationMs?: number;
  reason?: string;
  usage?: import('@octopi-agent/core/types/turn.js').TokenUsage;
  /** F3 计时段（turn.end 的 LLM 计时 / run.timing 的 wait/build/run_end 分段） */
  timing?: {
    stage?: string;
    waitMs?: number;
    buildMs?: number;
    durMs?: number;
    /** LLM 调用总耗时（turn.end.llmTiming） */
    durationMs?: number;
    /** LLM 调用标识（可关联 model.call.end 行） */
    callId?: string;
    ttftMs?: number;
    reqChars?: number;
    toolChars?: number;
    outChars?: number;
    finishReason?: string;
    /** run.timing=run_end 附带 */
    loopEnd?: string;
    stopReason?: string;
    /** run.timing=context_ready 附带（sysChars 为稳定前缀规模，E8 后不含易变快照） */
    msgs?: number;
    sysChars?: number;
    groundingTokens?: number;
  };
}

export interface RunObservatorySnapshotDto {
  sessionId: string;
  agentId?: string;
  runId: string;
  scope: RunScopeViewDto;
  messagesSummary?: RunMessagesSummaryDto;
  llmSummary?: RunMessagesSummaryDto;
  llmEstimatedTokens?: number;
  /**
   * Guard / RunMetrics 投影）。
   * 权威类型：Observer `RunGuardMetricsView`（含 wrap-up / usageLedger）；
   * 传输上WS 增量合并可能只有子集，故用 Partial 防漂移。
   */
  guardMetrics?: Partial<import('@octopi-agent/engine/harness/observability/observer/types.js').RunGuardMetricsView>;
  messagesDiff?: {
    entryCount: number;
    finalCount: number;
    added: Array<{
      index: number;
      role: string;
      contentChars?: number;
      hiddenFromChat?: boolean;
      source?: string;
    }>;
    removedCount: number;
    notes: string;
  };
  lifecycle?: {
    startedAt?: number;
    endedAt?: number;
    endReason?: string;
    durationMs?: number;
    turns?: number;
    toolCalls?: number;
    error?: string;
  };
  timeline?: RunTimelineEventDto[];
  securityEvents?: Array<{
    type: string;
    timestamp: number;
    severity?: string;
    description?: string;
    source?: string;
    toolName?: string;
    action?: string;
    violationTypes?: string[];
    count?: number;
  }>;
  memoryActivity?: {
    stores: number;
    searches: number;
    storedOk: number;
    rejected: number;
    superseded: number;
    searchHits: number;
    entries: Array<{
      kind: 'store' | 'search';
      timestamp: number;
      toolName: string;
      success: boolean;
      memoryId?: string;
      memoryType?: string;
      status?: string;
      propositionPreview?: string;
      supersededId?: string | null;
      rejectReason?: string;
      query?: string;
      resultCount?: number;
    }>;
  };
  toolEffect?: {
    sessionId: string;
    agentId: string;
    runId?: string;
    cwd?: string;
    isolation?: string;
    tools: Array<{ name: string; calls: number; errors: number; lastDurationMs?: number }>;
    undo?: {
      entries: number;
      truncated?: boolean;
      notReversedReason?: string;
      notReversedPaths?: number;
    };
    notes?: string[];
  };
  observer: { enabled: boolean; level: string; webPanel: boolean };
}

export interface RunMessageViewDto {
  index: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  agentId?: string;
  timestamp?: number;
  content?: unknown;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  metadata?: Record<string, unknown>;
  hiddenFromChat?: boolean;
  /** 归因（机器插槽 vs 用户发言；权威类型 Observer `RunMessageAttribution`，UI 只渲染） */
  attribution?: import('@octopi-agent/engine/harness/observability/observer/types.js').RunMessageAttribution;
  contentChars?: number;
  contentPreview?: string;
}

export interface RunMessagesSnapshotDto {
  sessionId: string;
  agentId?: string;
  runId?: string;
  runCapturedAt?: number;
  view: 'workspace' | 'llm';
  phase: 'entry' | 'final';
  summary: RunMessagesSummaryDto;
  messages?: RunMessageViewDto[];
  notes?: string;
}

export interface ObserverStatusDto {
  enabled: boolean;
  level: string;
  webPanel: boolean;
  channels: Record<string, boolean>;
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

export interface ClientStreamChannelDto {
  streamId: string;
  direction: 'source' | 'sink';
  sampleHint?: string;
  owner: {
    sessionId: string;
    clientInstanceId: string;
    toolCallId?: string;
    toolName?: string;
  };
  status: 'open' | 'closed';
  openedAt: number;
  closedAt?: number;
  maxDurationMs?: number;
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
    // 服务端错误契约是 {ok:false,error}：优先透出 error 文案，避免调用方裸吐 JSON
    let message = text || response.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // 非 JSON 错误体（代理页/网关截断）：保持原文
    }
    throw new Error(`HTTP ${response.status}: ${message}`);
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

  /** 对话斜杠命令目录 */
  async getCommands(): Promise<CommandCatalogItemDto[]> {
    const data = await this.getJson('/commands');
    return (data?.data as CommandCatalogItemDto[] | undefined) ?? [];
  }

  /** 系统问题）*/
  async listIssues(status?: 'open' | 'resolved' | 'dismissed'): Promise<Array<{
    id: string;
    domain: string;
    code: string;
    severity: string;
    title: string;
    detail: string;
    status: string;
  }>> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const data = await this.getJson(`/issues${qs}`);
    return (data?.data as Array<{
      id: string;
      domain: string;
      code: string;
      severity: string;
      title: string;
      detail: string;
      status: string;
    }>) ?? [];
  }

  async dismissIssue(id: string): Promise<void> {
    await this.postJson(`/issues/${encodeURIComponent(id)}/dismiss`, {});
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

  /**
   * 从历史切前缀新建分支会话。
   * `beforeIndex` 为 session.messages 绝对下标；新会话含 `[0, beforeIndex)`，不含该条。
   */
  async branchSession(
    sessionId: string,
    options: { beforeIndex: number; agentId?: string },
  ): Promise<SessionSummary> {
    const data = await this.postJson(
      `/sessions/${encodeURIComponent(sessionId)}/branch`,
      options,
    );
    return data?.data as SessionSummary;
  }

  /**
   * 从 fromIndex 起截断（含），用于「编辑重发」：丢掉被中止轮的用户输入与残片。
   */
  async truncateMessagesFrom(
    sessionId: string,
    fromIndex: number,
  ): Promise<{
    messageCount: number;
    fileEffects?: {
      discarded: Array<{ path: string; action: 'deleted' | 'restored' }>;
      keptUserEdits: Array<{ path: string; reason: string }>;
      notReversed?: {
        reason: string;
        created?: string[];
        modified?: string[];
        deleted?: string[];
      };
      truncated?: boolean;
      entries: number;
    };
  }> {
    const data = await this.postJson(
      `/sessions/${encodeURIComponent(sessionId)}/messages/truncate`,
      { fromIndex },
    );
    return data?.data as {
      messageCount: number;
      fileEffects?: {
        discarded: Array<{ path: string; action: 'deleted' | 'restored' }>;
        keptUserEdits: Array<{ path: string; reason: string }>;
        notReversed?: {
          reason: string;
          created?: string[];
          modified?: string[];
          deleted?: string[];
        };
        truncated?: boolean;
        entries: number;
      };
    };
  }

  async getSession(sessionId: string): Promise<SessionView> {
    const data = await this.getJson(`/sessions/${encodeURIComponent(sessionId)}`);
    return data?.data as SessionView;
  }

  /** 手动重命名会话标题（titleSource=user，不被自动摘要覆盖） */
  async renameSession(sessionId: string, title: string): Promise<SessionSummary> {
    const data = await this.patchJson(`/sessions/${encodeURIComponent(sessionId)}`, { title });
    return data?.data as SessionSummary;
  }

  /** 置顶 / 取消置顶会话（写 SessionMeta.pinnedAt） */
  async setSessionPinned(sessionId: string, pinned: boolean): Promise<SessionSummary> {
    const data = await this.patchJson(`/sessions/${encodeURIComponent(sessionId)}`, { pinned });
    return data?.data as SessionSummary;
  }

  /** 删除会话（Run 在途时服务端返回 409） */
  async deleteSession(sessionId: string): Promise<void> {
    await this.deleteJson(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  /** Session temporary effect roots (append-only, session lifetime) */
  async getSessionEffectRoots(sessionId: string): Promise<{
    sessionId: string;
    temporaryRoots: string[];
    configuredRoots: string[];
    mode?: string;
  }> {
    const data = await this.getJson(
      `/sessions/${encodeURIComponent(sessionId)}/effect-roots`,
    );
    return data?.data as {
      sessionId: string;
      temporaryRoots: string[];
      configuredRoots: string[];
      mode?: string;
    };
  }

  /** Append a session-temporary transaction root (absolute path) */
  async addSessionEffectRoot(
    sessionId: string,
    path: string,
  ): Promise<{ temporaryRoots: string[] }> {
    const data = await this.postJson(
      `/sessions/${encodeURIComponent(sessionId)}/effect-roots`,
      { path },
    );
    return data?.data as { temporaryRoots: string[] };
  }

  /** 结构化 git 状态（WebUI Git 页签轮询；只读，path 必须在会话 roots 内） */
  async getSessionGitStatus(
    sessionId: string,
    path: string,
    maxEntries?: number,
  ): Promise<GitStatusView> {
    const params = new URLSearchParams({ path });
    if (maxEntries !== undefined) params.set('maxEntries', String(maxEntries));
    const data = await this.getJson(
      `/sessions/${encodeURIComponent(sessionId)}/git-status?${params.toString()}`,
    );
    return data?.data as GitStatusView;
  }

  /** Remove one session-temporary transaction root */
  async removeSessionEffectRoot(
    sessionId: string,
    path: string,
  ): Promise<{ temporaryRoots: string[] }> {
    const qs = `?path=${encodeURIComponent(path)}`;
    const data = await this.deleteJson(
      `/sessions/${encodeURIComponent(sessionId)}/effect-roots${qs}`,
    );
    return data?.data as { temporaryRoots: string[] };
  }

  /** 会话附件列表 */
  async listSessionAttachments(sessionId: string): Promise<SessionAttachmentDto[]> {
    const data = await this.getJson(`/sessions/${encodeURIComponent(sessionId)}/attachments`);
    return (data?.data as SessionAttachmentDto[]) ?? [];
  }

  /** 上传会话附件（base64 或 utf8 text） */
  async uploadSessionAttachments(
    sessionId: string,
    files: Array<{ name: string; mime?: string; dataBase64?: string; text?: string }>,
  ): Promise<SessionAttachmentDto[]> {
    const data = await this.postJson(`/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      files,
    });
    return (data?.data as SessionAttachmentDto[]) ?? [];
  }

  /** 删除会话附件 */
  async deleteSessionAttachment(sessionId: string, attachmentId: string): Promise<void> {
    await this.deleteJson(
      `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  }

  /** 归入项目 */
  async promoteSessionAttachment(
    sessionId: string,
    attachmentId: string,
    body: { projectKey: string; targetSourceId?: string },
  ): Promise<{ attachment: SessionAttachmentDto; targetPath: string }> {
    const data = await this.postJson(
      `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/promote`,
      body,
    );
    return data?.data as { attachment: SessionAttachmentDto; targetPath: string };
  }

  /** 升为可检索（注册 session Knowledge source + ingest） */
  async makeAttachmentSearchable(
    sessionId: string,
    attachmentId: string,
  ): Promise<{ attachment: SessionAttachmentDto; sourceId: string; status: string }> {
    const data = await this.postJson(
      `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}/make-searchable`,
      {},
    );
    return data?.data as { attachment: SessionAttachmentDto; sourceId: string; status: string };
  }

  async getSessionMessages(
    sessionId: string,
    options?: {
      limit?: number;
      cursor?: string;
      direction?: 'forward' | 'backward';
    },
  ): Promise<MessagePage> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.cursor) params.set('cursor', options.cursor);
    if (options?.direction) params.set('direction', options.direction);
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

  /**
   * 会话日程列表（UI 投影）
   */
  async getSessionSchedules(sessionId: string): Promise<SessionScheduleView[]> {
    const data = await this.getJson(
      `/sessions/${encodeURIComponent(sessionId)}/schedules`,
    );
    return (data?.data as SessionScheduleView[]) ?? [];
  }

  /**
   * 日程控制：cancel / pause / resume
   */
  async controlSchedule(
    sessionId: string,
    scheduleId: string,
    action: 'cancel' | 'pause' | 'resume',
    reason?: string,
  ): Promise<{ id: string; status: string; nextFireAt: number; runCount: number }> {
    const data = await this.postJson(
      `/sessions/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(scheduleId)}/${action}`,
      reason ? { reason } : {},
    );
    return data?.data as {
      id: string;
      status: string;
      nextFireAt: number;
      runCount: number;
    };
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.postJson(`/sessions/${encodeURIComponent(sessionId)}/abort`, {});
  }

  /**
   * 会话最近一次 System 装配快照（产物 L1–L7）
   *
   * @param sessionId - 会话 id
   * @returns 快照；无装配记录时为 null
   */
  async getSessionContextLayers(sessionId: string): Promise<ContextLayersSnapshotDto | null> {
    const data = await this.getJson(`/sessions/${encodeURIComponent(sessionId)}/context/layers`);
    return (data?.data as ContextLayersSnapshotDto | null | undefined) ?? null;
  }

  /**
   * 会话最近一次 Run 观测投影（Observer 调试）/debug/run）。
   */
  async getSessionRunObservatory(
    sessionId: string,
  ): Promise<{ snapshot: RunObservatorySnapshotDto | null; observer?: ObserverStatusDto }> {
    const data = await this.getDebugJson(
      `/debug/run/${encodeURIComponent(sessionId)}/scope`,
    );
    return {
      snapshot: (data?.data as RunObservatorySnapshotDto | null | undefined) ?? null,
      observer: data?.observer as ObserverStatusDto | undefined,
    };
  }

  /**
   * Run messages 快照（摘要 + 配置允许时全文；调试）/debug/run）。
   */
  async getSessionRunMessages(
    sessionId: string,
    options?: { phase?: 'entry' | 'final' | 'llm'; runId?: string; view?: 'workspace' | 'llm' },
  ): Promise<RunMessagesSnapshotDto | null> {
    const params = new URLSearchParams();
    if (options?.phase) params.set('phase', options.phase);
    if (options?.runId) params.set('runId', options.runId);
    if (options?.view) params.set('view', options.view);
    const qs = params.toString();
    const data = await this.getDebugJson(
      `/debug/run/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`,
    );
    return (data?.data as RunMessagesSnapshotDto | null | undefined) ?? null;
  }

  /**
   * Agent 数据面健康（产品 L1–L7 store 计数）
   *
   * @param agentId - Agent id
   * @returns 健康快照
   */
  async getAgentContextHealth(agentId: string): Promise<ContextLayerHealthDto | null> {
    const data = await this.getJson(`/agents/${encodeURIComponent(agentId)}/context/health`);
    return (data?.data as ContextLayerHealthDto | null | undefined) ?? null;
  }

  async listApprovals(sessionId?: string): Promise<PendingApproval[]> {
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const data = await this.getJson(`/approvals${q}`);
    return (data?.data as PendingApproval[]) ?? [];
  }

  async resolveApproval(
    approvalId: string,
    input: { action: 'approve' | 'reject'; scope?: ApprovalScope; reason?: string },
  ): Promise<PendingApproval> {
    const data = await this.postJson(`/approvals/${encodeURIComponent(approvalId)}`, input);
    return data?.data as PendingApproval;
  }

  async listQuestions(sessionId?: string): Promise<PendingQuestion[]> {
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const data = await this.getJson(`/questions${q}`);
    return (data?.data as PendingQuestion[]) ?? [];
  }

  async answerQuestion(questionId: string, answer: string): Promise<PendingQuestion> {
    const data = await this.postJson(`/questions/${encodeURIComponent(questionId)}`, { answer });
    return data?.data as PendingQuestion;
  }

  // ── Client Tools（arch/client-tools.md）──

  /** 客户端上报能力（UI/设备 tool） */
  async registerClientTools(input: {
    sessionId: string;
    clientInstanceId: string;
    platform?: string;
    principalId?: string;
    descriptors: ClientToolDescriptorDto[];
  }): Promise<{ toolNames: string[] }> {
    const data = await this.postJson('/client-tools', input);
    return data?.data as { toolNames: string[] };
  }

  async unregisterClientTools(sessionId: string, clientInstanceId: string): Promise<{ removedNames: string[] }> {
    const data = await this.deleteJson(
      `/client-tools/${encodeURIComponent(clientInstanceId)}?sessionId=${encodeURIComponent(sessionId)}`,
    );
    return data?.data as { removedNames: string[] };
  }

  /** 心跳续期（在线性） */
  async heartbeatClientTools(sessionId: string, clientInstanceId: string): Promise<{ alive: boolean }> {
    const data = await this.postJson('/client-tools/heartbeat', { sessionId, clientInstanceId });
    return data?.data as { alive: boolean };
  }

  async listSessionClientTools(sessionId: string): Promise<Array<{ name: string; description: string; interaction?: string }>> {
    const data = await this.getJson(`/client-tools?sessionId=${encodeURIComponent(sessionId)}`);
    return (data?.data as Array<{ name: string; description: string; interaction?: string }>) ?? [];
  }

  async listClientToolCalls(sessionId: string): Promise<ClientToolCallDto[]> {
    const data = await this.getJson(`/client-tool-calls?sessionId=${encodeURIComponent(sessionId)}`);
    return (data?.data as ClientToolCallDto[]) ?? [];
  }

  /** 已 release 文件列表（元数据） */
  async listSessionFiles(sessionId: string): Promise<
    Array<{
      fileId: string;
      name: string;
      mime: string;
      sizeBytes: number;
      sourcePathDisplay: string;
      sourceKind: string;
      toolName: string;
      createdAt: number;
    }>
  > {
    const data = await this.getJson(`/sessions/${encodeURIComponent(sessionId)}/files`);
    return (data?.data as never) ?? [];
  }

  /** 拉取已 release 文件字节 */
  async fetchSessionFile(sessionId: string, fileId: string): Promise<Response> {
    const url = `${this.restBase}/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`;
    const headers: Record<string, string> = {};
    if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
    return fetch(url, { headers });
  }

  // ── Client Streams（§15.1 Host 通道）──

  async openClientStream(input: {
    sessionId: string;
    clientInstanceId: string;
    direction: 'source' | 'sink';
    toolName?: string;
    sampleHint?: string;
    maxDurationMs?: number;
  }): Promise<ClientStreamChannelDto> {
    const data = await this.postJson('/client-streams', input);
    return data?.data as ClientStreamChannelDto;
  }

  async writeClientStreamSamples(
    streamId: string,
    samples: unknown[],
  ): Promise<{ accepted: number }> {
    const data = await this.postJson(
      `/client-streams/${encodeURIComponent(streamId)}/samples`,
      { samples },
    );
    return data?.data as { accepted: number };
  }

  async closeClientStream(
    streamId: string,
    reason?: string,
  ): Promise<ClientStreamChannelDto> {
    const data = await this.postJson(
      `/client-streams/${encodeURIComponent(streamId)}/close`,
      { reason },
    );
    return data?.data as ClientStreamChannelDto;
  }

  async listClientStreams(sessionId: string): Promise<ClientStreamChannelDto[]> {
    const data = await this.getJson(`/client-streams?sessionId=${encodeURIComponent(sessionId)}`);
    return (data?.data as ClientStreamChannelDto[]) ?? [];
  }

  /** UI/设备提交结果 */
  async resolveClientToolCall(
    callId: string,
    outcome: ClientToolCallOutcomeDto,
    completedByPrincipalId?: string,
  ): Promise<ClientToolCallDto> {
    const data = await this.postJson(`/client-tool-calls/${encodeURIComponent(callId)}/resolve`, {
      outcome,
      completedByPrincipalId,
    });
    return data?.data as ClientToolCallDto;
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

  // ── Knowledge 管理面（arch/knowledge-admin-ui.md）──

  async listKnowledgeProjects(agentId = 'default'): Promise<
    Array<{
      projectKey: string;
      displayName?: string;
      sourceCount: number;
      assignedAgentIds: string[];
    }>
  > {
    const data = await this.getJson(`/agents/${agentId}/knowledge/projects`);
    return (data?.data as Array<{
      projectKey: string;
      displayName?: string;
      sourceCount: number;
      assignedAgentIds: string[];
    }>) ?? [];
  }

  async createKnowledgeProject(
    agentId: string,
    projectKey: string,
    displayName?: string,
  ): Promise<void> {
    await this.postJson(`/agents/${agentId}/knowledge/projects`, { projectKey, displayName });
  }

  async removeKnowledgeProject(agentId: string, projectKey: string): Promise<void> {
    await this.deleteJson(
      `/agents/${agentId}/knowledge/projects/${encodeURIComponent(projectKey)}`,
    );
  }

  async listKnowledgeSources(
    agentId: string,
    opts?: { sessionId?: string; scopeLevel?: 'global' | 'project' | 'session'; projectKey?: string },
  ): Promise<KnowledgeSourceDto[]> {
    const params = new URLSearchParams();
    if (opts?.sessionId) params.set('sessionId', opts.sessionId);
    if (opts?.scopeLevel) params.set('scopeLevel', opts.scopeLevel);
    if (opts?.projectKey) params.set('projectKey', opts.projectKey);
    const qs = params.toString();
    const data = await this.getJson(
      `/agents/${agentId}/knowledge/sources${qs ? `?${qs}` : ''}`,
    );
    return (data?.data as KnowledgeSourceDto[]) ?? [];
  }

  async getKnowledgeSourceDetail(agentId: string, sourceId: string): Promise<KnowledgeSourceDetailDto | null> {
    const data = await this.getJson(`/agents/${agentId}/knowledge/sources/${encodeURIComponent(sourceId)}`);
    return (data?.data as KnowledgeSourceDetailDto | null) ?? null;
  }

  async createKnowledgeSource(
    agentId: string,
    input: {
      kind: string;
      location: string;
      scopeRef: { level: 'global' | 'project' | 'session'; key: string };
      displayName?: string;
      description?: string;
    },
  ): Promise<KnowledgeSourceDto> {
    const data = await this.postJson(`/agents/${agentId}/knowledge/sources`, input);
    return data?.data as KnowledgeSourceDto;
  }

  async updateKnowledgeSource(
    agentId: string,
    sourceId: string,
    patch: Record<string, unknown>,
  ): Promise<KnowledgeSourceDto | null> {
    const data = await this.patchJson(
      `/agents/${agentId}/knowledge/sources/${encodeURIComponent(sourceId)}`,
      patch,
    );
    return (data?.data as KnowledgeSourceDto | null) ?? null;
  }

  async deleteKnowledgeSource(agentId: string, sourceId: string): Promise<void> {
    await this.deleteJson(`/agents/${agentId}/knowledge/sources/${encodeURIComponent(sourceId)}`);
  }

  async reindexKnowledgeSource(
    agentId: string,
    sourceId: string,
    opts?: { full?: boolean; watch?: boolean },
  ): Promise<{ ok: true; sourceId: string; status: string }> {
    const data = await this.postJson(
      `/agents/${agentId}/knowledge/sources/${encodeURIComponent(sourceId)}/reindex`,
      opts ?? {},
    );
    return data?.data as { ok: true; sourceId: string; status: string };
  }

  /** 中止某源索引任务 */
  async abortKnowledgeSourceJobs(
    agentId: string,
    sourceId: string,
  ): Promise<{
    ok: true;
    cancelledQueued: number;
    abortedRunning: number;
    runningJobs?: number;
  }> {
    const data = await this.postJson(
      `/agents/${agentId}/knowledge/sources/${encodeURIComponent(sourceId)}/abort`,
      {},
    );
    return data?.data as {
      ok: true;
      cancelledQueued: number;
      abortedRunning: number;
      runningJobs?: number;
    };
  }

  /** 中止全部知识索引任务 */
  async abortAllKnowledgeJobs(
    agentId: string,
  ): Promise<{
    ok: true;
    cancelledQueued: number;
    abortedRunning: number;
    runningJobs?: number;
  }> {
    const data = await this.postJson(`/agents/${agentId}/knowledge/abort`, {});
    return data?.data as {
      ok: true;
      cancelledQueued: number;
      abortedRunning: number;
      runningJobs?: number;
    };
  }

  /** 恢复/继续某源索引（中止后） */
  async resumeKnowledgeSourceJobs(
    agentId: string,
    sourceId: string,
  ): Promise<{ ok: true; restoredCancelled: number; embedQueued: number }> {
    const data = await this.postJson(
      `/agents/${agentId}/knowledge/sources/${encodeURIComponent(sourceId)}/resume`,
      {},
    );
    return data?.data as {
      ok: true;
      restoredCancelled: number;
      embedQueued: number;
    };
  }

  /** 恢复/继续全部知识索引（中止后） */
  async resumeAllKnowledgeJobs(
    agentId: string,
  ): Promise<{ ok: true; restoredCancelled: number; embedQueued: number }> {
    const data = await this.postJson(`/agents/${agentId}/knowledge/resume`, {});
    return data?.data as {
      ok: true;
      restoredCancelled: number;
      embedQueued: number;
    };
  }

  /** 源文件全量列表（兼容旧用法） */
  async listKnowledgeSourceFiles(
    agentId: string,
    sourceId: string,
  ): Promise<Array<{ path: string; status: string; chunkCount: number; error?: string }>> {
    const data = await this.getJson(
      `/agents/${agentId}/knowledge/sources/${encodeURIComponent(sourceId)}/files`,
    );
    return (data?.data as Array<{ path: string; status: string; chunkCount: number; error?: string }>) ?? [];
  }

  /** 重做文件：强制重新解析/分块/向量（单文件或按筛选批量；中止态会自动继续） */
  async reprocessKnowledgeFiles(
    agentId: string,
    sourceId: string,
    opts: {
      paths?: string[];
      filter?: {
        status?: 'indexed' | 'skipped' | 'error' | 'all';
        ext?: string;
        q?: string;
      };
    },
  ): Promise<{
    ok: true;
    queued: number;
    alreadyActive?: number;
    cleanedNonFiles?: number;
    resumed?: boolean;
  }> {
    const data = await this.postJson(
      `/agents/${agentId}/knowledge/sources/${encodeURIComponent(sourceId)}/reprocess`,
      opts,
    );
    return (
      (data?.data as {
        ok: true;
        queued: number;
        alreadyActive?: number;
        cleanedNonFiles?: number;
        resumed?: boolean;
      }) ?? { ok: true, queued: 0 }
    );
  }

  /** 路径任务/文件状态（跟踪重做是否完成） */
  async getKnowledgePathJobStates(
    agentId: string,
    sourceId: string,
    paths: string[],
  ): Promise<
    Array<{
      path: string;
      jobsActive: number;
      fileStatus: string | null;
      chunkCount: number;
      error: string | null;
      exists: boolean;
    }>
  > {
    const data = await this.postJson(
      `/agents/${agentId}/knowledge/sources/${encodeURIComponent(sourceId)}/path-jobs`,
      { paths },
    );
    return (
      (data?.data as Array<{
        path: string;
        jobsActive: number;
        fileStatus: string | null;
        chunkCount: number;
        error: string | null;
        exists: boolean;
      }>) ?? []
    );
  }

  /** 源文件分页 + 筛选（状态 / 扩展名 / 路径关键词） */
  async listKnowledgeSourceFilesPaged(
    agentId: string,
    sourceId: string,
    opts?: {
      status?: 'indexed' | 'skipped' | 'error' | 'all';
      ext?: string;
      q?: string;
      page?: number;
      pageSize?: number;
    },
  ): Promise<{
    items: Array<{
      path: string;
      status: string;
      chunkCount: number;
      error?: string;
      size: number;
      ext: string;
    }>;
    total: number;
    page: number;
    pageSize: number;
    statusCounts: { indexed: number; skipped: number; error: number };
    extCounts: Array<{ ext: string; n: number }>;
  }> {
    const params = new URLSearchParams();
    if (opts?.status && opts.status !== 'all') params.set('status', opts.status);
    if (opts?.ext && opts.ext !== 'all') params.set('ext', opts.ext);
    if (opts?.q) params.set('q', opts.q);
    params.set('page', String(opts?.page ?? 1));
    params.set('pageSize', String(opts?.pageSize ?? 50));
    const data = await this.getJson(
      `/agents/${agentId}/knowledge/sources/${encodeURIComponent(sourceId)}/files?${params.toString()}`,
    );
    return (
      (data?.data as {
        items: Array<{
          path: string;
          status: string;
          chunkCount: number;
          error?: string;
          size: number;
          ext: string;
        }>;
        total: number;
        page: number;
        pageSize: number;
        statusCounts: { indexed: number; skipped: number; error: number };
        extCounts: Array<{ ext: string; n: number }>;
      }) ?? {
        items: [],
        total: 0,
        page: 1,
        pageSize: opts?.pageSize ?? 50,
        statusCounts: { indexed: 0, skipped: 0, error: 0 },
        extCounts: [],
      }
    );
  }

  async listKnowledgeChunks(
    agentId: string,
    sourceId: string,
    path: string,
  ): Promise<Array<{ id: string; path: string; text: string; startLine: number; endLine: number }>> {
    const params = new URLSearchParams({ sourceId, path });
    const data = await this.getJson(`/agents/${agentId}/knowledge/chunks?${params.toString()}`);
    return (
      (data?.data as Array<{
        id: string;
        path: string;
        text: string;
        startLine: number;
        endLine: number;
      }>) ?? []
    );
  }

  async getKnowledgeStats(agentId: string): Promise<Record<string, number>> {
    const data = await this.getJson(`/agents/${agentId}/knowledge/stats`);
    return (data?.data as Record<string, number>) ?? {};
  }

  async setKnowledgeVisibility(
    agentId: string,
    body: {
      op: 'assignProject' | 'unassignProject' | 'hide' | 'unhide';
      projectKey?: string;
      sourceId?: string;
    },
  ): Promise<void> {
    await this.postJson(`/agents/${agentId}/knowledge/visibility`, body);
  }

  async getKnowledgeVisibility(agentId: string): Promise<{
    hiddenSourceIds: string[];
    globalSources: Array<KnowledgeSourceDto & { hiddenForAgent: boolean }>;
    assignedProjects: Array<{
      projectKey: string;
      displayName?: string;
      sourceCount: number;
      assignedAgentIds: string[];
      sources: KnowledgeSourceDto[];
    }>;
    unassignedProjects: Array<{
      projectKey: string;
      displayName?: string;
      sourceCount: number;
      assignedAgentIds: string[];
    }>;
  }> {
    const data = await this.getJson(`/agents/${agentId}/knowledge/visibility`);
    return (
      (data?.data as {
        hiddenSourceIds: string[];
        globalSources: Array<KnowledgeSourceDto & { hiddenForAgent: boolean }>;
        assignedProjects: Array<{
          projectKey: string;
          displayName?: string;
          sourceCount: number;
          assignedAgentIds: string[];
          sources: KnowledgeSourceDto[];
        }>;
        unassignedProjects: Array<{
          projectKey: string;
          displayName?: string;
          sourceCount: number;
          assignedAgentIds: string[];
        }>;
      }) ?? {
        hiddenSourceIds: [],
        globalSources: [],
        assignedProjects: [],
        unassignedProjects: [],
      }
    );
  }

  async getKnowledgeSessionVisibility(
    agentId: string,
    sessionId: string,
  ): Promise<KnowledgeSessionVisibilityItemDto[]> {
    const data = await this.getJson(
      `/agents/${agentId}/knowledge/session-visibility?sessionId=${encodeURIComponent(sessionId)}`,
    );
    return (data?.data as KnowledgeSessionVisibilityItemDto[]) ?? [];
  }

  async setKnowledgeSessionVisibility(
    agentId: string,
    item: {
      sessionId: string;
      targetType: 'project' | 'source';
      targetId: string;
      op: 'include' | 'exclude';
    },
  ): Promise<void> {
    await this.postJson(`/agents/${agentId}/knowledge/session-visibility`, item);
  }

  async clearKnowledgeSessionVisibility(
    agentId: string,
    sessionId: string,
    target?: { targetType: 'project' | 'source'; targetId: string },
  ): Promise<void> {
    const params = new URLSearchParams({ sessionId });
    if (target) {
      params.set('targetType', target.targetType);
      params.set('targetId', target.targetId);
    }
    await this.deleteJson(`/agents/${agentId}/knowledge/session-visibility?${params.toString()}`);
  }

  async searchKnowledge(
    agentId: string,
    q: string,
    opts?: { sessionId?: string; limit?: number },
  ): Promise<{
    usedVector: boolean;
    coverage: number;
    hits: Array<{
      sourceId: string;
      path: string;
      startLine: number;
      endLine: number;
      score: number;
      snippet: string;
    }>;
  }> {
    const params = new URLSearchParams({ q });
    if (opts?.sessionId) params.set('sessionId', opts.sessionId);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const data = await this.getJson(`/agents/${agentId}/knowledge/search?${params.toString()}`);
    return (
      (data?.data as {
        usedVector: boolean;
        coverage: number;
        hits: Array<{
          sourceId: string;
          path: string;
          startLine: number;
          endLine: number;
          score: number;
          snippet: string;
        }>;
      }) ?? { usedVector: false, coverage: 0, hits: [] }
    );
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
    options?: { model?: string; attachmentIds?: string[] },
  ): void {
    const metadata: Record<string, unknown> = {};
    if (options?.model) metadata.model = options.model;
    if (options?.attachmentIds?.length) metadata.attachmentIds = options.attachmentIds;
    this.send({
      type: 'chat',
      sessionId,
      agentId,
      content,
      senderId: 'web-ui',
      ...(Object.keys(metadata).length ? { metadata } : {}),
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

  /** Debug 面请求：挂在服务器根路径，不经过 restBase=/api/v1 */
  private async getDebugJson<T = any>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
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

  private async patchJson<T = any>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.restBase}${path}`, {
      method: 'PATCH',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });
    return parseJsonResponse(response);
  }

  private async deleteJson<T = any>(path: string): Promise<T> {
    const response = await fetch(`${this.restBase}${path}`, {
      method: 'DELETE',
      headers: this.buildHeaders(),
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
