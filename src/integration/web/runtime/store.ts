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
 */

import type {
  AgentEventEnvelope,
  AgentSummary,
  ConnectionState,
  MessageRecord,
  OctopiClient,
  PendingApproval,
  SessionSummary,
  SessionView,
} from '../../web/sdk/client.js';

import { ConversationAdapter } from '../conversation/adapter.js';
import type { ConversationItem, ToolConversationItem, UserConversationItem, AssistantConversationItem, ViewMode } from '../conversation/types.js';

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
  'error': RuntimeErrorEvent;
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
export class ChatEvent extends RuntimeEvent<{ messages: MessageRecord[] }> {}
export class ConversationEvent extends RuntimeEvent<{ items: ConversationItem[] }> {}
export class ViewModeEvent extends RuntimeEvent<{ mode: ViewMode }> {}
export class StreamEvent extends RuntimeEvent<{ streaming: boolean; content: string }> {}
export class ToolEvent extends RuntimeEvent<{ tools: ToolRun[] }> {}
export class ApprovalEvent extends RuntimeEvent<{ approvals: PendingApproval[] }> {}
export class InspectorEvent extends RuntimeEvent<{ inspector: InspectorState }> {}
export class RuntimeErrorEvent extends RuntimeEvent<{ error: string }> {}

// ──────────────────────────────────────
// State types
// ──────────────────────────────────────

export type RunStatus = 'idle' | 'sending' | 'waiting' | 'streaming' | 'aborted' | 'error';

export interface ToolRun {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  endedAt?: number;
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
  lastLoopMessage?: string;
}

export interface ChatState {
  sessionId?: string;
  agentId?: string;
  /** Phase 2: 当前视图模式 */
  viewMode: ViewMode;
  /** @legacy 向后兼容，后续由 conversation 替代 */
  messages: MessageRecord[];
  /** Phase 1 新增：统一的会话视图模型 */
  conversation: ConversationItem[];
  streamingContent: string;
  runStatus: RunStatus;
  tools: ToolRun[];
  approvals: PendingApproval[];
  inspector: InspectorState;
}

// ──────────────────────────────────────
// Store
// ──────────────────────────────────────

export class OctopiRuntimeStore extends EventTarget {
  private readonly client: OctopiClient;
  private readonly conversationAdapter = new ConversationAdapter();
  private static readonly MAX_CACHE_SIZE = 20;
  /** 本地缓存：切走 session 时保存 conversation items + legacy messages，切回时恢复 */
  private readonly conversationCache = new Map<string, { items: ConversationItem[]; messages: MessageRecord[]; viewMode: ViewMode }>();

  private connectionState: ConnectionState = 'idle';
  private agents: AgentSummary[] = [];
  private sessions: SessionSummary[] = [];
  private currentSession: SessionView | null = null;
  private chat: ChatState = this.createEmptyChat();

  constructor(client: OctopiClient) {
    super();
    this.client = client;
    this.client.on({
      onConnectionState: (state: ConnectionState) => this.applyConnectionState(state),
      onWelcome: (agents: AgentSummary[]) => this.applyWelcome(agents),
      onAccepted: (_sessionId: string | undefined, _messageId: string | undefined) => this.applyAccepted(),
      onEvent: (_sessionId: string | undefined, event: AgentEventEnvelope) => this.applyEvent(event),
      onState: (_sessionId: string | undefined, state: string) => this.applyExternalState(state),
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

  // ──────────────────────────────────
  // Actions
  // ──────────────────────────────────

  connect(): void {
    this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  /** Reconnect with new options without destroying store state */
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

  async openSession(sessionId: string): Promise<SessionView> {
    // Phase 4: 切走前缓存当前 session 的 conversation items + messages
    if (this.chat.sessionId && this.chat.conversation.length > 0) {
      // LRU eviction: remove oldest entry when cache is full
      if (this.conversationCache.size >= OctopiRuntimeStore.MAX_CACHE_SIZE) {
        const oldest = this.conversationCache.keys().next().value;
        if (oldest) this.conversationCache.delete(oldest);
      }
      this.conversationCache.set(this.chat.sessionId, {
        items: this.chat.conversation,
        messages: this.chat.messages,
        viewMode: this.chat.viewMode,
      });
    }

    const view = await this.client.getSession(sessionId);

    this.conversationAdapter.reset();
    this.currentSession = view;

    // Phase 4: 优先使用本地缓存，避免切回时丢失运行时 items
    const cached = this.conversationCache.get(sessionId);
    let conversationItems: ConversationItem[];
    let messages: MessageRecord[];
    let viewMode: ViewMode;

    if (cached) {
      conversationItems = cached.items;
      messages = cached.messages;
      viewMode = cached.viewMode;
    } else {
      const page = await this.client.getSessionMessages(sessionId, { limit: 50 });
      messages = page.messages;
      conversationItems = ConversationAdapter.buildHistoryItems(messages, sessionId);
      viewMode = 'history';
    }

    this.chat = {
      sessionId,
      agentId: view.meta.agentId,
      viewMode,
      messages,
      conversation: conversationItems,
      streamingContent: '',
      runStatus: 'idle',
      tools: [],
      approvals: await this.client.listApprovals(),
      inspector: {},
    };

    this.client.sendSubscribe(sessionId, view.meta.agentId);

    this.dispatch('session', new SessionEvent('session', { session: this.currentSession }));
    this.dispatch('chat', new ChatEvent('chat', { messages: this.chat.messages }));
    this.dispatch('conversation', new ConversationEvent('conversation', { items: this.chat.conversation }));
    this.dispatch('viewMode', new ViewModeEvent('viewMode', { mode: this.chat.viewMode }));
    this.dispatch('tool', new ToolEvent('tool', { tools: this.chat.tools }));
    this.dispatch('approval', new ApprovalEvent('approval', { approvals: this.chat.approvals }));
    this.dispatch('inspector', new InspectorEvent('inspector', { inspector: this.chat.inspector }));

    return view;
  }

  async createSession(agentId: string, options?: { sessionId?: string; metadata?: Record<string, unknown> }): Promise<SessionSummary> {
    const session = await this.client.createSession({ agentId, ...options });

    // 创建后直接初始化聊天视图，避免立刻调用 getSession/getSessionMessages 导致新 session 查询失败。
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
      messages: [],
      conversation: [],
      streamingContent: '',
      runStatus: 'idle',
      tools: [],
      approvals: await this.client.listApprovals(),
      inspector: {},
    };

    this.client.sendSubscribe(session.id, session.agentId);
    await this.refreshSessions();

    this.dispatch('session', new SessionEvent('session', { session: this.currentSession }));
    this.dispatch('chat', new ChatEvent('chat', { messages: this.chat.messages }));
    this.dispatch('conversation', new ConversationEvent('conversation', { items: this.chat.conversation }));
    this.dispatch('viewMode', new ViewModeEvent('viewMode', { mode: this.chat.viewMode }));
    this.dispatch('tool', new ToolEvent('tool', { tools: this.chat.tools }));
    this.dispatch('approval', new ApprovalEvent('approval', { approvals: this.chat.approvals }));
    this.dispatch('inspector', new InspectorEvent('inspector', { inspector: this.chat.inspector }));

    return session;
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.chat.sessionId || !this.chat.agentId) {
      throw new Error('No active session');
    }

    // Derive legacy messages from conversation items
    this.chat.conversation = this.conversationAdapter.injectUserMessage(content, this.chat.sessionId, this.chat.conversation);
    this.chat.messages = this.deriveMessages(this.chat.conversation);

    // Phase 4: 用户发送消息时，根据当前 viewMode 决定目标模式
    // history → hybrid（历史会话叠加新交互）
    // runtime / hybrid → runtime（保持或回到 runtime）
    this.setViewMode(this.chat.viewMode === 'history' ? 'hybrid' : 'runtime');

    this.chat.runStatus = 'sending';
    this.chat.streamingContent = '';

    this.dispatch('chat', new ChatEvent('chat', { messages: this.chat.messages }));
    this.dispatch('conversation', new ConversationEvent('conversation', { items: this.chat.conversation }));
    this.dispatch('stream', new StreamEvent('stream', { streaming: false, content: '' }));

    this.client.sendChat(this.chat.sessionId, this.chat.agentId, content);
    this.chat.runStatus = 'waiting';
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

  private applyAccepted(): void {
    this.chat.runStatus = 'waiting';
  }

  private applyExternalState(state: string): void {
    if (!this.chat) return;
    switch (state) {
      case 'running':
        this.chat.runStatus = 'streaming';
        break;
      case 'idle':
        if (this.chat.runStatus !== 'error') this.chat.runStatus = 'idle';
        break;
      case 'aborted':
        this.chat.runStatus = 'aborted';
        break;
      case 'error':
        this.chat.runStatus = 'error';
        break;
      default:
        break;
    }
  }

  private applyEvent(event: AgentEventEnvelope): void {
    const sessionId = this.chat.sessionId ?? '';

    // ── Phase 4: 收到 runtime 事件时，若仍在 history 模式则切到 hybrid ──
    if (this.chat.viewMode === 'history' && this.chat.sessionId) {
      this.setViewMode('hybrid');
    }

    // ── Phase 1: route through ConversationAdapter ──
    const convResult = this.conversationAdapter.applyEvent(event, sessionId, this.chat.conversation);
    // ── Derive all state from adapter result (single source of truth) ──
    if (convResult.changed) {
      this.chat.conversation = convResult.items;
      this.chat.streamingContent = convResult.streaming.content;
      this.chat.tools = this.deriveTools(convResult.items);
      this.chat.messages = this.deriveMessages(convResult.items);

      // Derive runStatus from streaming and tool state
      if (convResult.streaming.active) {
        this.chat.runStatus = 'streaming';
      } else if (event.type === 'aborted') {
        this.chat.runStatus = 'aborted';
      } else if (event.type === 'model.call.error' || event.type === 'engine.error') {
        this.chat.runStatus = 'error';
      } else if (event.type === 'turn.end' || event.type === 'engine.end' || event.type === 'interrupted') {
        this.chat.runStatus = 'idle';
      }

      // Dispatch derived events
      this.dispatch('conversation', new ConversationEvent('conversation', { items: this.chat.conversation }));
      this.dispatch('stream', new StreamEvent('stream', { streaming: convResult.streaming.active, content: convResult.streaming.content }));
      this.dispatch('tool', new ToolEvent('tool', { tools: this.chat.tools }));
      this.dispatch('chat', new ChatEvent('chat', { messages: this.chat.messages }));
    }

    // ── Inspector metadata (not derivable from conversation items) ──
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
      case 'empty_response_retry':
      case 'planning_only_retry': {
        this.chat.inspector = { ...this.chat.inspector, lastRetryLabel: event.type === 'empty_response_retry' ? 'Empty response' : 'Planning-only' };
        inspectorChanged = true;
        break;
      }
      case 'loop_detected': {
        this.chat.inspector = { ...this.chat.inspector, lastLoopMessage: String(event.data?.message ?? 'loop detected') };
        inspectorChanged = true;
        break;
      }
      default: break;
    }
    if (inspectorChanged) {
      this.dispatch('inspector', new InspectorEvent('inspector', { inspector: this.chat.inspector }));
    }
  }

  private emitRuntimeError(message: string): void {
    this.dispatch('error', new RuntimeErrorEvent('error', { error: message }));
  }

  private dispatch(_type: string, event: Event): void {
    this.dispatchEvent(event);
  }

  /**
   * Phase 2: 切换 viewMode 并广播事件。
   */
  private setViewMode(mode: ViewMode): void {
    if (this.chat.viewMode === mode) return;
    this.chat.viewMode = mode;
    this.dispatch('viewMode', new ViewModeEvent('viewMode', { mode }));
  }

  private createEmptyChat(): ChatState {
    return {
      viewMode: 'history',
      messages: [],
      conversation: [],
      streamingContent: '',
      runStatus: 'idle',
      tools: [],
      approvals: [],
      inspector: {},
    };
  }

  /** Derive ToolRun[] from conversation items (single source of truth) */
  private deriveTools(items: ConversationItem[]): ToolRun[] {
    return items
      .filter((i): i is ToolConversationItem => i.role === 'tool')
      .map((t) => ({ toolCallId: t.toolCallId, toolName: t.toolName, args: t.args, status: t.status, startedAt: t.createdAt, endedAt: t.status !== 'running' ? t.createdAt : undefined, error: t.error }));
  }

  /** Derive legacy MessageRecord[] from conversation items */
  private deriveMessages(items: ConversationItem[]): MessageRecord[] {
    return items
      .filter((i): i is UserConversationItem | AssistantConversationItem => i.role === 'user' || i.role === 'assistant')
      .map((i) => ({ role: i.role, content: i.content, timestamp: i.createdAt }));
  }
}
