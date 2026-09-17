/**
 * Octopi Web Runtime Store
 *
 * 第一版 Chat Runtime Store。
 * 把 Gateway REST/WS 协议翻译成前端可消费的状态模型。
 *
 * 设计原则：
 * - 不依赖具体 UI 框架
 * - 通过 EventTarget 暴露状态变化
 * - 只做状态建模，不做渲染
 *
 * 说明：
 * - 本版本移除遗留的 `messages` 双写状态，统一以 `conversation` 为唯一 source of truth。
 * - `MessageRecord` 仅保留用于历史数据导入（`ConversationAdapter.buildHistoryItems`）。
 */

import type {
  AgentEventEnvelope,
  AgentSummary,
  ConnectionState,
  MessageRecord,
  OctopiClient,
  PendingApproval,
  SessionSummary,
  SessionTaskView,
  SessionView,
} from '../../web/sdk/client.js';

import { ConversationAdapter } from '../conversation/adapter.js';
import type { AdapterSnapshot } from '../conversation/adapter.js';
import type { ConversationItem, ToolConversationItem, ViewMode } from '../conversation/types.js';

// ──────────────────────────────────────
// Events
// ──────────────────────────────────────

export interface RuntimeEventMap {
  'connection': ConnectionEvent;
  'sessions': SessionsEvent;
  'session': SessionEvent;
  'chat': ChatEvent;
  'conversation': ConversationEvent;
  'viewMode': ViewModeEvent;
  'stream': StreamEvent;
  'tool': ToolEvent;
  'approval': ApprovalEvent;
  'inspector': InspectorEvent;
  'tasks': TasksEvent;
  'error': RuntimeErrorEvent;
  'runStatus': RunStatusEvent;
}

export class RuntimeEvent<T = unknown> extends Event {
  readonly detail: T;
  constructor(type: string, detail: T) {
    super(type);
    this.detail = detail;
  }
}

export class ConnectionEvent extends RuntimeEvent<{ state: ConnectionState; agents: AgentSummary[] }> {}
export class SessionsEvent extends RuntimeEvent<{ sessions: SessionSummary[] }> {}
export class SessionEvent extends RuntimeEvent<{ session: SessionView | null }> {}
export class ChatEvent extends RuntimeEvent<{ conversation: ConversationItem[] }> {}
export class ConversationEvent extends RuntimeEvent<{ items: ConversationItem[] }> {}
export class ViewModeEvent extends RuntimeEvent<{ mode: ViewMode }> {}
export class StreamEvent extends RuntimeEvent<{ streaming: boolean; content: string }> {}
export class ToolEvent extends RuntimeEvent<{ tools: ToolRun[] }> {}
export class ApprovalEvent extends RuntimeEvent<{ approvals: PendingApproval[] }> {}
export class InspectorEvent extends RuntimeEvent<{ inspector: InspectorState }> {}
export class TasksEvent extends RuntimeEvent<{ tasks: SessionTaskView[] }> {}
export class RuntimeErrorEvent extends RuntimeEvent<{ error: string }> {}
export class RunStatusEvent extends RuntimeEvent<{ status: RunStatus }> {}

// ──────────────────────────────────────
// State types
// ──────────────────────────────────────

export type RunStatus = 'idle' | 'sending' | 'waiting' | 'streaming' | 'tools' | 'aborted' | 'error';

export interface ToolRun {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface CompactStatus {
  active: boolean;
  reason?: 'proactive' | 'overflow';
  cached?: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  threshold?: number;
  durationMs?: number;
  error?: string;
}

export interface InspectorState {
  contextTokens?: number;
  contextWindow?: number;
  truncatedFrom?: number;
  truncatedTo?: number;
  lastError?: string;
  lastToolError?: string;
  lastToolName?: string;
  lastBlockedReason?: string;
  lastBudgetStatus?: string;
  lastRetryLabel?: string;
  /** 上下文压缩状态（context.compact.*） */
  compact?: CompactStatus;
}

export interface ChatState {
  sessionId?: string;
  agentId?: string;
  viewMode: ViewMode;
  conversation: ConversationItem[];
  streamingContent: string;
  runStatus: RunStatus;
  tools: ToolRun[];
  approvals: PendingApproval[];
  inspector: InspectorState;
  /** 会话任务（goal/step），UI 只读 */
  tasks: SessionTaskView[];
}

// ──────────────────────────────────────
// Store
// ──────────────────────────────────────

interface SessionCacheEntry {
  items: ConversationItem[];
  viewMode: ViewMode;
  adapterState: AdapterSnapshot;
  inspector: InspectorState;
  /** 后台会话的 runStatus；切回时恢复，避免只从 items 推导丢掉 waiting */
  runStatus: RunStatus;
}

export class OctopiRuntimeStore extends EventTarget {
  private readonly client: OctopiClient;
  private readonly conversationAdapter = new ConversationAdapter();
  private static readonly MAX_CACHE_SIZE = 20;
  private readonly conversationCache = new Map<string, SessionCacheEntry>();

  private connectionState: ConnectionState = 'idle';
  private agents: AgentSummary[] = [];
  private sessions: SessionSummary[] = [];
  private currentSession: SessionView | null = null;
  private chat: ChatState = this.createEmptyChat();
  /** 本轮 run 是否仍活跃；用于忽略终态之后迟到的 state=running */
  private engineActive = false;

  constructor(client: OctopiClient) {
    super();
    this.client = client;
    this.client.on({
      onConnectionState: (state: ConnectionState) => this.applyConnectionState(state),
      onWelcome: (agents: AgentSummary[]) => this.applyWelcome(agents),
      onAccepted: (sessionId: string | undefined, _messageId: string | undefined) => this.applyAccepted(sessionId),
      onEvent: (sessionId: string | undefined, event: AgentEventEnvelope) => this.applyEvent(sessionId, event),
      onState: (sessionId: string | undefined, state: string) => this.applyExternalState(sessionId, state),
      onError: (error: Error) => this.emitRuntimeError(error.message),
    });
  }

  // ──────────────────────────────────
  // Public state
  // ──────────────────────────────────

  getState(): {
    connection: ConnectionState;
    agents: AgentSummary[];
    sessions: SessionSummary[];
    currentSession: SessionView | null;
    chat: ChatState;
  } {
    return {
      connection: this.connectionState,
      agents: this.agents,
      sessions: this.sessions,
      currentSession: this.currentSession,
      chat: this.chat,
    };
  }

  /** 当前会话任务列表 */
  getTasks(): SessionTaskView[] {
    return this.chat.tasks;
  }

  // ──────────────────────────────────
  // Actions
  // ──────────────────────────────────

  connect(): void {
    this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  reconnect(baseUrl?: string, apiKey?: string): void {
    this.client.updateOptions({ baseUrl, apiKey });
    this.client.disconnect();
    this.client.connect();
  }

  async refreshAgents(): Promise<AgentSummary[]> {
    this.agents = await this.client.getAgents();
    this.dispatch('connection', new ConnectionEvent('connection', { state: this.connectionState, agents: this.agents }));
    return this.agents;
  }

  async refreshSessions(agentId?: string): Promise<SessionSummary[]> {
    this.sessions = await this.client.listSessions(agentId);
    this.dispatch('sessions', new SessionsEvent('sessions', { sessions: this.sessions }));
    return this.sessions;
  }

  /** 将当前会话的运行时状态写入缓存（切走时调用） */
  private cacheCurrentSession(): void {
    const sid = this.chat.sessionId;
    if (!sid) return;
    // 仅在 key 不存在且容量已满时淘汰，避免更新已有条目时误删其他会话
    if (!this.conversationCache.has(sid) && this.conversationCache.size >= OctopiRuntimeStore.MAX_CACHE_SIZE) {
      const oldest = this.conversationCache.keys().next().value;
      if (oldest) this.conversationCache.delete(oldest);
    }
    this.conversationCache.set(sid, {
      items: this.chat.conversation,
      viewMode: this.chat.viewMode,
      adapterState: this.conversationAdapter.getState(),
      inspector: { ...this.chat.inspector },
      runStatus: this.chat.runStatus,
    });
  }

  async openSession(sessionId: string): Promise<SessionView> {
    const isSameSession = this.chat.sessionId === sessionId;

    if (!isSameSession) {
      // 切走：缓存当前会话
      this.cacheCurrentSession();
      // 为目标会话预建空缓存条目，使 await 窗口内的事件能写入而非丢弃
      if (!this.conversationCache.has(sessionId)) {
        this.conversationCache.set(sessionId, {
          items: [],
          viewMode: 'history',
          adapterState: { toolIndex: {}, streamingContent: '' },
          inspector: {},
          runStatus: 'idle',
        });
      }
    }
    // 同会话重开：live 状态永远不比 cache 旧，不缓存也不 restore/reset

    const view = await this.client.getSession(sessionId);
    this.currentSession = view;

    let tasks: SessionTaskView[] = [];
    try {
      tasks = await this.client.getSessionTasks(sessionId);
    } catch {
      try {
        tasks = await this.client.getSessionTasks(sessionId, { agentId: view.meta.agentId });
      } catch {
        tasks = [];
      }
    }

    const approvals = await this.client.listApprovals();

    // ── 同会话重开：live 为权威，只刷新 tasks/approvals，不动 conversation/adapter ──
    if (isSameSession) {
      this.chat = { ...this.chat, tasks, approvals };
      this.dispatch('session', new SessionEvent('session', { session: this.currentSession }));
      this.dispatch('tasks', new TasksEvent('tasks', { tasks }));
      this.dispatch('approval', new ApprovalEvent('approval', { approvals }));
      return view;
    }

    // ── 切换到其他会话：以服务端历史为权威，缓存补全未落盘运行时条目 ──

    // await 窗口内源会话事件仍走 live 路径（chat.sessionId 未变），
    // 替换 chat 前重新缓存，确保这些更新不被丢弃
    this.cacheCurrentSession();

    let conversationItems: ConversationItem[] = [];
    let viewMode: ViewMode = 'history';
    try {
      const page = await this.client.getSessionMessages(sessionId, { limit: 100 });
      conversationItems = ConversationAdapter.buildHistoryItems(page.messages, sessionId);
    } catch {
      conversationItems = [];
    }

    // await 期间缓存可能已被后台事件更新，重新读取
    const cached = this.conversationCache.get(sessionId);
    let usedCacheItems = false;
    if (cached && cached.items.length > 0) {
      // 运行时活性（running 工具 / 流式）比「条目数」更能代表真相：
      // 历史可能更长（含旧轮次已落盘消息），但缓存里的 running 工具尚未写入 store。
      // 若只比长度，会丢掉 running 状态，切回时被推导成 idle。
      const cacheHasRuntimeActivity =
        cached.items.some(
          (it) => it.role === 'tool' && (it as ToolConversationItem).status === 'running',
        ) || Boolean(cached.adapterState.streamingContent) || Boolean(cached.adapterState.currentAssistantId);

      if (cacheHasRuntimeActivity || cached.items.length > conversationItems.length) {
        conversationItems = cached.items;
        viewMode = cached.viewMode === 'history' ? 'hybrid' : cached.viewMode;
        usedCacheItems = true;
      } else if (cached.viewMode !== 'history') {
        viewMode = cached.viewMode;
      }
    }

    if (usedCacheItems && cached) {
      this.conversationAdapter.restoreState(cached.adapterState);
    } else {
      this.conversationAdapter.reset();
      // 预建的空缓存条目（窗口内无事件写入）用完即删，避免占 LRU 槽位
      if (cached && cached.items.length === 0) {
        this.conversationCache.delete(sessionId);
      }
    }

    // 兜底去重：同 toolCallId 只保留最后一条（历史与缓存可能各有一条）
    const seenToolIds = new Set<string>();
    conversationItems = conversationItems.filter((it) => {
      if (it.role !== 'tool') return true;
      const tcId = (it as ToolConversationItem).toolCallId;
      if (seenToolIds.has(tcId)) return false;
      seenToolIds.add(tcId);
      return true;
    });

    const tools = this.deriveTools(conversationItems);
    const hasRunningTool = tools.some(t => t.status === 'running');
    const streamingContent = usedCacheItems ? (cached?.adapterState.streamingContent ?? '') : '';
    // 优先用缓存里的 runStatus（含 waiting：工具结束后下一轮 LLM 尚未吐 token）。
    // 仅从 items 推导会把 waiting 丢成 idle。
    const cachedStatus = usedCacheItems ? cached?.runStatus : undefined;
    const isActiveStatus =
      cachedStatus === 'tools' || cachedStatus === 'streaming' || cachedStatus === 'waiting' || cachedStatus === 'sending';
    const derivedRunStatus: RunStatus = hasRunningTool
      ? 'tools'
      : streamingContent
        ? 'streaming'
        : isActiveStatus
          ? cachedStatus!
          : 'idle';
    // 切回后必须恢复 engineActive，否则迟到的 running/tools 状态会被忽略
    this.engineActive =
      derivedRunStatus === 'tools' || derivedRunStatus === 'streaming' || derivedRunStatus === 'waiting' || derivedRunStatus === 'sending';

    this.chat = {
      sessionId,
      agentId: view.meta.agentId,
      viewMode,
      conversation: conversationItems,
      streamingContent,
      runStatus: derivedRunStatus,
      tools,
      approvals,
      inspector: cached?.inspector ? { ...cached.inspector } : {},
      tasks,
    };

    this.client.sendSubscribe(sessionId, view.meta.agentId);

    this.dispatch('session', new SessionEvent('session', { session: this.currentSession }));
    this.dispatch('chat', new ChatEvent('chat', { conversation: this.chat.conversation }));
    this.dispatch('conversation', new ConversationEvent('conversation', { items: this.chat.conversation }));
    this.dispatch('viewMode', new ViewModeEvent('viewMode', { mode: this.chat.viewMode }));
    this.dispatch('tool', new ToolEvent('tool', { tools: this.chat.tools }));
    this.dispatch('stream', new StreamEvent('stream', { streaming: derivedRunStatus === 'streaming', content: streamingContent }));
    this.dispatch('runStatus', new RunStatusEvent('runStatus', { status: derivedRunStatus }));
    this.dispatch('approval', new ApprovalEvent('approval', { approvals: this.chat.approvals }));
    this.dispatch('inspector', new InspectorEvent('inspector', { inspector: this.chat.inspector }));
    this.dispatch('tasks', new TasksEvent('tasks', { tasks: this.chat.tasks }));

    return view;
  }

  async createSession(agentId: string, options?: { sessionId?: string; metadata?: Record<string, unknown> }): Promise<SessionSummary> {
    // 离开当前会话前先缓存，避免丢掉进行中的工具/流式状态
    this.cacheCurrentSession();

    // 若调用方指定了 sessionId，预建空缓存条目使 await 窗口内事件可写入
    const knownId = options?.sessionId;
    if (knownId && !this.conversationCache.has(knownId)) {
      this.conversationCache.set(knownId, {
        items: [],
        viewMode: 'history',
        adapterState: { toolIndex: {}, streamingContent: '' },
        inspector: {},
        runStatus: 'idle',
      });
    }

    const session = await this.client.createSession({ agentId, ...options });

    this.conversationAdapter.reset();
    this.currentSession = {
      meta: session,
      messageCount: 0,
      turnCount: 0,
    };
    this.chat = {
      sessionId: session.id,
      agentId: session.agentId,
      viewMode: 'runtime',
      conversation: [],
      streamingContent: '',
      runStatus: 'idle',
      tools: [],
      approvals: await this.client.listApprovals(),
      inspector: {},
      tasks: [],
    };

    this.client.sendSubscribe(session.id, session.agentId);
    await this.refreshSessions();

    this.dispatch('session', new SessionEvent('session', { session: this.currentSession }));
    this.dispatch('chat', new ChatEvent('chat', { conversation: this.chat.conversation }));
    this.dispatch('conversation', new ConversationEvent('conversation', { items: this.chat.conversation }));
    this.dispatch('viewMode', new ViewModeEvent('viewMode', { mode: this.chat.viewMode }));
    this.dispatch('tool', new ToolEvent('tool', { tools: this.chat.tools }));
    this.dispatch('stream', new StreamEvent('stream', { streaming: false, content: '' }));
    this.dispatch('runStatus', new RunStatusEvent('runStatus', { status: 'idle' }));
    this.dispatch('approval', new ApprovalEvent('approval', { approvals: this.chat.approvals }));
    this.dispatch('inspector', new InspectorEvent('inspector', { inspector: this.chat.inspector }));
    this.dispatch('tasks', new TasksEvent('tasks', { tasks: this.chat.tasks }));

    return session;
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.chat.sessionId || !this.chat.agentId) {
      throw new Error('No active session');
    }

    this.chat.conversation = this.conversationAdapter.injectUserMessage(content, this.chat.sessionId, this.chat.conversation);

    this.setViewMode(this.chat.viewMode === 'history' ? 'hybrid' : 'runtime');

    this.engineActive = true;
    this.setRunStatus('sending');
    this.chat.streamingContent = '';

    this.dispatch('chat', new ChatEvent('chat', { conversation: this.chat.conversation }));
    this.dispatch('conversation', new ConversationEvent('conversation', { items: this.chat.conversation }));
    this.dispatch('stream', new StreamEvent('stream', { streaming: false, content: '' }));

    this.client.sendChat(this.chat.sessionId, this.chat.agentId, content);
    this.setRunStatus('waiting');
  }

  abort(): void {
    if (!this.chat.sessionId) return;
    this.client.sendAbort(this.chat.sessionId);
  }

  // ──────────────────────────────────
  // Event mapping
  // ──────────────────────────────────

  private applyConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.dispatch('connection', new ConnectionEvent('connection', { state, agents: this.agents }));
  }

  private applyWelcome(agents: AgentSummary[]): void {
    this.agents = agents;
    this.dispatch('connection', new ConnectionEvent('connection', { state: this.connectionState, agents: this.agents }));
  }

  private applyAccepted(sessionId?: string): void {
    // 仅当前会话的 accepted 才更新 UI 状态
    if (sessionId && this.chat.sessionId && sessionId !== this.chat.sessionId) return;
    this.engineActive = true;
    this.setRunStatus('waiting');
  }

  private applyExternalState(sessionId: string | undefined, state: string): void {
    if (!this.chat) return;
    // 状态事件仅作用于当前会话；其他会话的状态不影响 UI
    if (sessionId && this.chat.sessionId && sessionId !== this.chat.sessionId) return;
    switch (state) {
      case 'running':
        // 终态后迟到的 running 不得把 idle 打回 streaming
        if (this.engineActive) this.setRunStatus('streaming');
        break;
      case 'tools':
        if (this.engineActive) this.setRunStatus('tools');
        break;
      case 'idle':
        // 当前会话仍有 running 工具时，忽略 idle（防协议/时序噪声覆盖）
        if (this.chat.tools.some((t) => t.status === 'running')) break;
        if (this.chat.runStatus !== 'error') {
          this.engineActive = false;
          this.setRunStatus('idle');
        }
        break;
      case 'aborted':
        this.engineActive = false;
        this.setRunStatus('aborted');
        break;
      case 'error':
        this.engineActive = false;
        this.setRunStatus('error');
        break;
      default:
        break;
    }
  }

  private applyEvent(eventSessionId: string | undefined, event: AgentEventEnvelope): void {
    const currentSessionId = this.chat.sessionId ?? '';

    // 事件明确属于另一个已打开过的会话：更新其缓存，不影响当前 UI
    if (currentSessionId && eventSessionId && eventSessionId !== currentSessionId) {
      this.applyEventToCachedSession(eventSessionId, event);
      return;
    }

    const sessionId = currentSessionId;

    if (this.chat.viewMode === 'history' && this.chat.sessionId) {
      this.setViewMode('hybrid');
    }

    // 会话任务事件（只读面板）
    if (event.type === 'session.task.created' || event.type === 'session.task.updated' || event.type === 'session.task.snapshot') {
      this.applyTaskEvent(event);
    }

    const convResult = this.conversationAdapter.applyEvent(event, sessionId, this.chat.conversation);
    if (convResult.changed) {
      this.chat.conversation = convResult.items;
      this.chat.streamingContent = convResult.streaming.content;
      this.chat.tools = this.deriveTools(convResult.items);
    }

    // ── runStatus 状态机（与后台缓存共用 nextRunStatus） ──
    const prevStatus = this.chat.runStatus;
    const nextStatus = OctopiRuntimeStore.nextRunStatus(event, prevStatus);
    if (nextStatus !== prevStatus) {
      this.setRunStatus(nextStatus);
    }
    // engineActive：激活/终态与 nextRunStatus 对齐
    if (
      event.type === 'engine.start' ||
      event.type === 'iteration.start' ||
      event.type === 'llm_stream_delta'
    ) {
      this.engineActive = true;
    } else if (
      event.type === 'aborted' ||
      event.type === 'model.call.error' ||
      event.type === 'engine.error' ||
      event.type === 'engine.end' ||
      event.type === 'interrupted' ||
      (event.type === 'turn.end' &&
        (event.data as { phase?: string; error?: boolean } | undefined)?.phase !== 'pre_tools' &&
        !(event.data as { error?: boolean } | undefined)?.error)
    ) {
      this.engineActive = false;
    }
    // 终态清流式
    if (
      event.type === 'engine.end' ||
      event.type === 'interrupted' ||
      (event.type === 'turn.end' &&
        (event.data as { phase?: string; error?: boolean } | undefined)?.phase !== 'pre_tools' &&
        !(event.data as { error?: boolean } | undefined)?.error)
    ) {
      this.chat.streamingContent = '';
      this.dispatch('stream', new StreamEvent('stream', { streaming: false, content: '' }));
    }

    if (convResult.changed) {
      this.dispatch('conversation', new ConversationEvent('conversation', { items: this.chat.conversation }));
      this.dispatch('stream', new StreamEvent('stream', { streaming: convResult.streaming.active, content: convResult.streaming.content }));
      this.dispatch('tool', new ToolEvent('tool', { tools: this.chat.tools }));
      this.dispatch('chat', new ChatEvent('chat', { conversation: this.chat.conversation }));
    }

    let inspectorChanged = false;
    switch (event.type) {
      case 'tool.exec.end': {
        const isError = Boolean(event.data?.isError ?? event.data?.hasError);
        if (isError) {
          const toolCallId = String(event.data?.toolCallId ?? '');
          const failedTool = this.chat.tools.find((r) => r.toolCallId === toolCallId);
          this.chat.inspector = { ...this.chat.inspector, lastToolError: String(event.data?.result ?? 'Tool failed'), lastToolName: failedTool?.toolName ?? 'unknown' };
          inspectorChanged = true;
        }
        break;
      }
      case 'model.call.error':
      case 'engine.error': {
        this.chat.inspector = { ...this.chat.inspector, lastError: String(event.data?.error ?? 'Unknown error') };
        inspectorChanged = true;
        this.emitRuntimeError(String(event.data?.error ?? 'Unknown error'));
        break;
      }
      case 'budget.exceeded': {
        this.chat.inspector = { ...this.chat.inspector, lastBudgetStatus: String(event.data?.status ?? 'exceeded') };
        inspectorChanged = true;
        break;
      }
      case 'security.blocked':
      case 'security.behavior_blocked': {
        this.chat.inspector = { ...this.chat.inspector, lastBlockedReason: String(event.data?.reason ?? 'blocked') };
        inspectorChanged = true;
        break;
      }
      case 'context.truncated': {
        this.chat.inspector = { ...this.chat.inspector, truncatedFrom: Number(event.data?.from ?? undefined), truncatedTo: Number(event.data?.to ?? undefined) };
        inspectorChanged = true;
        break;
      }
      case 'context.compact.start': {
        const d = event.data as {
          reason?: 'proactive' | 'overflow';
          tokensBefore?: number;
          threshold?: number;
        } | undefined;
        this.chat.inspector = {
          ...this.chat.inspector,
          compact: {
            active: true,
            reason: d?.reason,
            tokensBefore: typeof d?.tokensBefore === 'number' ? d.tokensBefore : undefined,
            threshold: typeof d?.threshold === 'number' ? d.threshold : undefined,
          },
        };
        inspectorChanged = true;
        break;
      }
      case 'context.compact.end': {
        const d = event.data as {
          reason?: 'proactive' | 'overflow';
          tokensBefore?: number;
          tokensAfter?: number;
          durationMs?: number;
          cached?: boolean;
        } | undefined;
        const tokensAfter = typeof d?.tokensAfter === 'number' ? d.tokensAfter : undefined;
        this.chat.inspector = {
          ...this.chat.inspector,
          ...(tokensAfter !== undefined ? { contextTokens: tokensAfter } : {}),
          compact: {
            active: false,
            reason: d?.reason,
            cached: Boolean(d?.cached),
            tokensBefore: typeof d?.tokensBefore === 'number' ? d.tokensBefore : undefined,
            tokensAfter,
            durationMs: typeof d?.durationMs === 'number' ? d.durationMs : undefined,
          },
        };
        inspectorChanged = true;
        break;
      }
      case 'context.compact.error': {
        const d = event.data as { error?: string; durationMs?: number } | undefined;
        this.chat.inspector = {
          ...this.chat.inspector,
          compact: {
            active: false,
            error: String(d?.error ?? 'compact failed'),
            durationMs: typeof d?.durationMs === 'number' ? d.durationMs : undefined,
          },
        };
        inspectorChanged = true;
        break;
      }
      case 'empty_response_retry':
      case 'planning_only_retry': {
        this.chat.inspector = { ...this.chat.inspector, lastRetryLabel: event.type === 'empty_response_retry' ? 'Empty response' : 'Planning-only' };
        inspectorChanged = true;
        break;
      }
      case 'turn.end': {
        const contextTokens = typeof event.data?.contextTokens === 'number' ? event.data.contextTokens : undefined;
        const contextWindow = typeof event.data?.contextWindow === 'number' ? event.data.contextWindow : undefined;
        if (contextTokens !== undefined || contextWindow !== undefined) {
          this.chat.inspector = {
            ...this.chat.inspector,
            ...(contextTokens !== undefined ? { contextTokens } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {}),
          };
          inspectorChanged = true;
        }
        break;
      }
      default: break;
    }
    if (inspectorChanged) {
      this.dispatch('inspector', new InspectorEvent('inspector', { inspector: this.chat.inspector }));
    }
  }

  /**
   * 将事件应用到后台会话的缓存条目。
   * 切走后工具完成、流式继续等场景，切回时才能看到正确终态。
   */
  private applyEventToCachedSession(sessionId: string, event: AgentEventEnvelope): void {
    const cached = this.conversationCache.get(sessionId);
    if (!cached) return;

    // 用临时 adapter 复原该会话的追踪状态后应用事件
    const adapter = new ConversationAdapter();
    adapter.restoreState(cached.adapterState);
    const result = adapter.applyEvent(event, sessionId, cached.items);

    // 后台也要跑同一套 runStatus 状态机，否则切回时 waiting 会丢成 idle
    const nextStatus = OctopiRuntimeStore.nextRunStatus(event, cached.runStatus);

    if (!result.changed && nextStatus === cached.runStatus) return;

    this.conversationCache.set(sessionId, {
      items: result.changed ? result.items : cached.items,
      viewMode: cached.viewMode === 'history' ? 'hybrid' : cached.viewMode,
      adapterState: result.changed ? adapter.getState() : cached.adapterState,
      inspector: cached.inspector,
      runStatus: nextStatus,
    });
  }

  /**
   * runStatus 状态机（与 Loop 事件契约对齐）——供 live 与后台缓存共用。
   *
   * waiting:   已发出、等待模型（iteration.start / stream fallback）
   * streaming: 正在收 token
   * tools:     工具执行中
   * idle:      本轮 run 真正结束
   */
  private static nextRunStatus(event: AgentEventEnvelope, current: RunStatus): RunStatus {
    if (event.type === 'engine.start' || event.type === 'iteration.start') {
      return 'waiting';
    }
    if (event.type === 'llm_stream_delta') {
      return 'streaming';
    }
    if (event.type === 'stream.fallback_to_sync' || event.type === 'stream.fallback_failed') {
      return 'waiting';
    }
    if (event.type === 'aborted') {
      return 'aborted';
    }
    if (event.type === 'model.call.error' || event.type === 'engine.error') {
      return 'error';
    }
    if (event.type === 'turn.end') {
      const data = event.data as { phase?: string; error?: boolean } | undefined;
      if (data?.phase === 'pre_tools') return 'tools';
      if (data?.error) return 'waiting';
      return 'idle';
    }
    if (event.type === 'engine.end' || event.type === 'interrupted') {
      return 'idle';
    }
    if (event.type === 'tool.exec.start') {
      return 'tools';
    }
    return current;
  }

  private emitRuntimeError(message: string): void {
    this.dispatch('error', new RuntimeErrorEvent('error', { error: message }));
  }

  private applyTaskEvent(event: AgentEventEnvelope): void {
    if (event.type === 'session.task.snapshot') {
      const raw = event.data?.tasks;
      if (Array.isArray(raw)) {
        this.chat.tasks = raw as SessionTaskView[];
        this.dispatch('tasks', new TasksEvent('tasks', { tasks: this.chat.tasks }));
      }
      return;
    }

    const rawTask = event.data?.task as SessionTaskView | undefined;
    if (!rawTask?.id) return;

    const idx = this.chat.tasks.findIndex((t) => t.id === rawTask.id);
    const next = [...this.chat.tasks];
    if (idx >= 0) {
      next[idx] = rawTask;
    } else {
      next.push(rawTask);
    }
    this.chat.tasks = next;
    this.dispatch('tasks', new TasksEvent('tasks', { tasks: this.chat.tasks }));
  }

  private dispatch(_type: string, event: Event): void {
    this.dispatchEvent(event);
  }

  private setViewMode(mode: ViewMode): void {
    if (this.chat.viewMode === mode) return;
    this.chat.viewMode = mode;
    this.dispatch('viewMode', new ViewModeEvent('viewMode', { mode }));
  }

  private setRunStatus(status: RunStatus): void {
    if (this.chat.runStatus === status) return;
    this.chat.runStatus = status;
    this.dispatch('runStatus', new RunStatusEvent('runStatus', { status }));
  }

  private createEmptyChat(): ChatState {
    return {
      viewMode: 'history',
      conversation: [],
      streamingContent: '',
      runStatus: 'idle',
      tools: [],
      approvals: [],
      inspector: {},
      tasks: [],
    };
  }

  private deriveTools(items: ConversationItem[]): ToolRun[] {
    return items
      .filter((i): i is ToolConversationItem => i.role === 'tool')
      .map((t) => ({
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        args: t.args,
        status: t.status,
        startedAt: t.createdAt,
        endedAt: t.endedAt ?? (t.status !== 'running' ? t.createdAt : undefined),
        error: t.error,
      }));
  }
}
