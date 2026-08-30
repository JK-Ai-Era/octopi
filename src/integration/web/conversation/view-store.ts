/**
 * ConversationViewStore
 *
 * 面向 UI 的会话视图存储。
 * 职责：
 *   - 维护当前 session 的 ConversationItem[]
 *   - 管理 view mode (runtime / history / hybrid)
 *   - 管理 streaming overlay 状态
 *   - 提供 toolCallId → itemId 索引
 *
 * 不直接依赖 OctopiRuntimeStore，而是由上层编排代码
 * 调用 applyEvent / loadHistory / injectUserMessage 来驱动更新。
 *
 * 通过 EventTarget 暴露变更事件，UI 层可按需监听。
 */

import type {
  ConversationItem,
  ConversationSource,
  SessionViewState,
  StreamingState,
  ViewMode,
} from './types.js';

import { ConversationAdapter } from './adapter.js';
import type {
  AgentEventEnvelope,
  MessageRecord,
} from '../sdk/client.js';

// ──────────────────────────────────────
// Events
// ──────────────────────────────────────

export interface ConversationEventMap {
  'items': ConversationItemsEvent;
  'streaming': ConversationStreamingEvent;
  'mode': ConversationModeEvent;
  'reset': ConversationResetEvent;
}

export class ConversationEvent<T = unknown> extends Event {
  readonly detail: T;
  constructor(type: string, detail: T) {
    super(type);
    this.detail = detail;
  }
}

export class ConversationItemsEvent extends ConversationEvent<{ items: ConversationItem[] }> {}
export class ConversationStreamingEvent extends ConversationEvent<StreamingState> {}
export class ConversationModeEvent extends ConversationEvent<{ mode: ViewMode }> {}
export class ConversationResetEvent extends ConversationEvent<{}> {}

// ──────────────────────────────────────
// Store
// ──────────────────────────────────────

export class ConversationViewStore extends EventTarget {
  private sessionId = '';
  private agentId = '';
  private mode: ViewMode = 'history';
  private items: ConversationItem[] = [];
  private streaming: StreamingState = { active: false, content: '' };
  private toolIndex: Record<string, string> = {};
  private adapter = new ConversationAdapter();

  // ──────────────────────────────────
  // State accessors
  // ──────────────────────────────────

  getState(): SessionViewState {
    return {
      sessionId: this.sessionId,
      agentId: this.agentId,
      mode: this.mode,
      items: this.items,
      streaming: { ...this.streaming },
      toolIndex: { ...this.toolIndex },
    };
  }

  getItems(): ReadonlyArray<ConversationItem> {
    return this.items;
  }

  getStreaming(): StreamingState {
    return { ...this.streaming };
  }

  getMode(): ViewMode {
    return this.mode;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  // ──────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────

  /**
   * 切换到新 session。重置 adapter 和本地状态。
   */
  openSession(sessionId: string, agentId: string): void {
    this.adapter.reset();
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.items = [];
    this.streaming = { active: false, content: '' };
    this.toolIndex = {};
    this.mode = 'history'; // 先以 history 模式加载
    this.emit('reset', new ConversationResetEvent('reset', {}));
  }

  /**
   * 加载 session 历史消息，构建 history view。
   * 适用于 openSession() 后首次加载和切回历史 session。
   */
  loadHistory(messages: MessageRecord[], sessionId?: string): void {
    const sid = sessionId ?? this.sessionId;
    this.items = ConversationAdapter.buildHistoryItems(messages, sid);
    this.mode = 'history';
    this.emit('items', new ConversationItemsEvent('items', { items: this.items }));
    this.emit('mode', new ConversationModeEvent('mode', { mode: this.mode }));
  }

  /**
   * 加载历史后，如果当前 session 是活跃的，切换到 hybrid 模式。
   * 后续 runtime 事件会以 overlay 方式叠加。
   */
  activateHybrid(): void {
    this.mode = 'hybrid';
    this.emit('mode', new ConversationModeEvent('mode', { mode: this.mode }));
  }

  /**
   * 标记为纯 runtime 模式（当前 session、当前 run）。
   */
  activateRuntime(): void {
    this.mode = 'runtime';
    this.emit('mode', new ConversationModeEvent('mode', { mode: this.mode }));
  }

  // ──────────────────────────────────
  // Runtime event processing
  // ──────────────────────────────────

  /**
   * 处理一个 runtime 事件。
   * 返回 true 表示 items 有变化。
   */
  applyEvent(event: AgentEventEnvelope): boolean {
    const result = this.adapter.applyEvent(event, this.sessionId, this.items);
    if (result.changed) {
      this.items = result.items;
      this.streaming = result.streaming;
      this.toolIndex = { ...result.toolIndex };
      this.emit('items', new ConversationItemsEvent('items', { items: this.items }));
      this.emit('streaming', new ConversationStreamingEvent('streaming', this.streaming));
    }
    return result.changed;
  }

  /**
   * 用户发送消息时注入 user item。
   */
  injectUserMessage(content: string): void {
    this.items = this.adapter.injectUserMessage(content, this.sessionId, this.items);
    // 发送消息后自动切到 runtime 模式
    if (this.mode !== 'hybrid') {
      this.mode = 'runtime';
      this.emit('mode', new ConversationModeEvent('mode', { mode: this.mode }));
    }
    this.emit('items', new ConversationItemsEvent('items', { items: this.items }));
  }

  // ──────────────────────────────────
  // EventTarget plumbing
  // ──────────────────────────────────

  private emit(type: string, event: Event): void {
    this.dispatchEvent(event);
  }
}
