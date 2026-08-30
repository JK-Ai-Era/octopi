/**
 * ConversationAdapter
 *
 * 负责将两种数据源映射成 ConversationItem[]：
 *   1. Runtime events   (AgentEventEnvelope 流) → 实时 item 更新
 *   2. Session messages  (MessageRecord[])     → 历史 item 列表
 *
 * 适配器自身保持精简状态（当前 streaming assistant id、tool 索引等），
 * 每次调用返回不可变的 items 快照，由上层 ViewStore 持久化。
 */

import type {
  AgentEventEnvelope,
  MessageRecord,
} from '../sdk/client.js';

import type {
  ConversationItem,
  AssistantConversationItem,
  ToolConversationItem,
  SystemConversationItem,
  UserConversationItem,
  StreamingState,
} from './types.js';

// ──────────────────────────────────────
// Helpers
// ──────────────────────────────────────

let _idCounter = 0;

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++_idCounter}`;
}

/** 从 MessageRecord.content 中提取纯文本 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => String(b.text ?? ''))
      .join('');
  }
  if (content != null) return JSON.stringify(content);
  return '';
}

// ──────────────────────────────────────
// ConversationAdapter
// ──────────────────────────────────────

export class ConversationAdapter {
  // ──── 内部追踪状态 ────
  private currentAssistantId: string | undefined;
  private toolIndex: Record<string, string> = {}; // toolCallId → conversationItemId
  private streamingContent = '';

  // ──────────────────────────────────
  // Runtime events → item mutations
  // ──────────────────────────────────

  /**
   * 处理一个 runtime 事件，返回可能被修改的 items 数组以及当前 streaming 状态。
   *
   * 调用方负责传入当前 items 引用；本方法会直接修改它以减少拷贝开销。
   * 返回值中的 `changed` 标志用于调用方决定是否需要触发 UI 更新。
   */
  applyEvent(
    event: AgentEventEnvelope,
    sessionId: string,
    items: ConversationItem[],
  ): { items: ConversationItem[]; changed: boolean; streaming: StreamingState; toolIndex: Record<string, string> } {
    let changed = false;

    switch (event.type) {
      // ── LLM stream delta ──
      case 'llm_stream_delta': {
        const delta = String(event.data?.delta ?? '');
        if (!delta) break;

        this.streamingContent += delta;

        if (!this.currentAssistantId) {
          // 创建一条新的 streaming assistant item
          const item: AssistantConversationItem = {
            id: makeId('ast'),
            role: 'assistant',
            createdAt: Date.now(),
            sessionId,
            source: 'runtime',
            status: 'streaming',
            content: this.streamingContent,
            toolCalls: [],
          };
          this.currentAssistantId = item.id;
          items = [...items, item];
        } else {
          // 追加到已有 streaming item
          items = items.map((it) =>
            it.id === this.currentAssistantId && it.role === 'assistant'
              ? { ...it, content: this.streamingContent }
              : it,
          );
        }
        changed = true;
        break;
      }

      // ── Tool exec start ──
      case 'tool.exec.start': {
        const toolCallId = String(event.data?.toolCallId ?? `tc_${Date.now()}`);
        const toolItem: ToolConversationItem = {
          id: makeId('tool'),
          role: 'tool',
          createdAt: Date.now(),
          sessionId,
          source: 'runtime',
          toolName: String(event.data?.toolName ?? 'unknown'),
          toolCallId,
          status: 'running',
          args: event.data?.args,
          expandable: true,
        };
        this.toolIndex[toolCallId] = toolItem.id;

        // 关联到当前 assistant
        if (this.currentAssistantId) {
          items = items.map((it) =>
            it.id === this.currentAssistantId && it.role === 'assistant'
              ? { ...it, toolCalls: [...((it as AssistantConversationItem).toolCalls ?? []), toolCallId] }
              : it,
          );
        }

        items = [...items, toolItem];
        changed = true;
        break;
      }

      // ── Tool exec end ──
      case 'tool.exec.end': {
        const toolCallId = String(event.data?.toolCallId ?? '');
        const isError = Boolean(event.data?.isError ?? event.data?.hasError);
        const itemId = this.toolIndex[toolCallId];
        if (itemId) {
          items = items.map((it) =>
            it.id === itemId && it.role === 'tool'
              ? {
                  ...it,
                  status: isError ? 'error' : 'success',
                  result: event.data?.result,
                  error: isError ? String(event.data?.result ?? 'Tool failed') : undefined,
                }
              : it,
          );
        }
        changed = true;
        break;
      }

      // ── Turn end ──
      case 'turn.end': {
        const content = String(event.data?.content ?? this.streamingContent ?? '');
        if (this.currentAssistantId) {
          items = items.map((it) =>
            it.id === this.currentAssistantId && it.role === 'assistant'
              ? { ...it, status: 'completed' as const, content: content || (it as AssistantConversationItem).content }
              : it,
          );
        } else if (content) {
          // 没有 streaming item 但有 content（例如非流式场景）
          const item: AssistantConversationItem = {
            id: makeId('ast'),
            role: 'assistant',
            createdAt: Date.now(),
            sessionId,
            source: 'runtime',
            status: 'completed',
            content,
          };
          items = [...items, item];
        }
        this.currentAssistantId = undefined;
        this.streamingContent = '';
        changed = true;
        break;
      }

      // ── Engine end / interrupted / aborted ──
      case 'engine.end':
      case 'interrupted':
      case 'aborted': {
        // 如果有未完成的 streaming assistant，标记为 completed
        if (this.currentAssistantId) {
          items = items.map((it) =>
            it.id === this.currentAssistantId && it.role === 'assistant'
              ? { ...it, status: 'completed' as const }
              : it,
          );
          this.currentAssistantId = undefined;
        }

        if (event.type === 'aborted') {
          const notice: SystemConversationItem = {
            id: makeId('sys'),
            role: 'system',
            createdAt: Date.now(),
            sessionId,
            source: 'runtime',
            kind: 'aborted',
            message: 'Run aborted',
          };
          items = [...items, notice];
        }

        this.streamingContent = '';
        changed = true;
        break;
      }

      // ── Error events ──
      case 'model.call.error':
      case 'engine.error': {
        const error = String(event.data?.error ?? 'Unknown error');
        if (this.currentAssistantId) {
          items = items.map((it) =>
            it.id === this.currentAssistantId && it.role === 'assistant'
              ? { ...it, status: 'error' as const, error }
              : it,
          );
        }
        const notice: SystemConversationItem = {
          id: makeId('sys'),
          role: 'system',
          createdAt: Date.now(),
          sessionId,
          source: 'runtime',
          kind: 'error',
          message: error,
        };
        items = [...items, notice];
        this.currentAssistantId = undefined;
        this.streamingContent = '';
        changed = true;
        break;
      }

      // ── Security blocked ──
      case 'security.blocked':
      case 'security.behavior_blocked': {
        const reason = String(event.data?.reason ?? 'blocked');
        const notice: SystemConversationItem = {
          id: makeId('sys'),
          role: 'system',
          createdAt: Date.now(),
          sessionId,
          source: 'runtime',
          kind: 'blocked',
          message: reason,
        };
        items = [...items, notice];
        changed = true;
        break;
      }

      // ── Context truncated ──
      case 'context.truncated': {
        const from = Number(event.data?.from ?? 0);
        const to = Number(event.data?.to ?? 0);
        const notice: SystemConversationItem = {
          id: makeId('sys'),
          role: 'system',
          createdAt: Date.now(),
          sessionId,
          source: 'runtime',
          kind: 'truncated',
          message: `Context truncated (${from} → ${to})`,
        };
        items = [...items, notice];
        changed = true;
        break;
      }

      // ── Retry ──
      case 'empty_response_retry':
      case 'planning_only_retry': {
        const label = event.type === 'empty_response_retry' ? 'Empty response, retrying' : 'Planning-only response, retrying';
        const notice: SystemConversationItem = {
          id: makeId('sys'),
          role: 'system',
          createdAt: Date.now(),
          sessionId,
          source: 'runtime',
          kind: 'retry',
          message: label,
        };
        items = [...items, notice];
        changed = true;
        break;
      }

      // ── Loop detected ──
      case 'loop_detected': {
        const msg = String(event.data?.message ?? 'Loop detected');
        const notice: SystemConversationItem = {
          id: makeId('sys'),
          role: 'system',
          createdAt: Date.now(),
          sessionId,
          source: 'runtime',
          kind: 'warning',
          message: msg,
        };
        items = [...items, notice];
        changed = true;
        break;
      }

      // ── Budget exceeded ──
      case 'budget.exceeded': {
        const status = String(event.data?.status ?? 'exceeded');
        const notice: SystemConversationItem = {
          id: makeId('sys'),
          role: 'system',
          createdAt: Date.now(),
          sessionId,
          source: 'runtime',
          kind: 'warning',
          message: `Budget ${status}`,
        };
        items = [...items, notice];
        changed = true;
        break;
      }

      default:
        break;
    }

    return {
      items,
      changed,
      streaming: {
        active: !!this.currentAssistantId,
        content: this.streamingContent,
        assistantItemId: this.currentAssistantId,
      },
      toolIndex: { ...this.toolIndex },
    };
  }

  // ──────────────────────────────────
  // User message injection
  // ──────────────────────────────────

  /**
   * 当用户发送消息时，注入一条 UserConversationItem。
   */
  injectUserMessage(
    content: string,
    sessionId: string,
    items: ConversationItem[],
  ): ConversationItem[] {
    const item: UserConversationItem = {
      id: makeId('usr'),
      role: 'user',
      createdAt: Date.now(),
      sessionId,
      source: 'runtime',
      content,
    };
    return [...items, item];
  }

  // ──────────────────────────────────
  // History messages → items
  // ──────────────────────────────────

  /**
   * 将 Session Messages API 返回的 MessageRecord[] 转换为 ConversationItem[]。
   *
   * 这是 `openSession()` 之后构建历史视图的入口。
   * 返回的 items source 统一为 'history'。
   */
  static buildHistoryItems(
    messages: MessageRecord[],
    sessionId: string,
  ): ConversationItem[] {
    const items: ConversationItem[] = [];

    for (const msg of messages) {
      const ts = msg.timestamp ?? Date.now();

      switch (msg.role) {
        case 'user': {
          const item: UserConversationItem = {
            id: makeId('usr'),
            role: 'user',
            createdAt: ts,
            sessionId,
            source: 'history',
            content: extractText(msg.content),
          };
          items.push(item);
          break;
        }
        case 'assistant': {
          const item: AssistantConversationItem = {
            id: makeId('ast'),
            role: 'assistant',
            createdAt: ts,
            sessionId,
            source: 'history',
            status: 'completed',
            content: extractText(msg.content),
            // 如果 MessageRecord 携带 toolCalls 元数据，提取 id 列表
            toolCalls: extractToolCallIds(msg),
          };
          items.push(item);
          break;
        }
        case 'tool': {
          // Gateway 存储的 tool 消息包含 toolResults 数组
          const toolResults = extractToolResults(msg);
          if (toolResults.length > 0) {
            for (const tr of toolResults) {
              items.push({
                id: makeId('tool'),
                role: 'tool',
                createdAt: ts,
                sessionId,
                source: 'history',
                toolName: tr.name ?? 'unknown',
                toolCallId: tr.toolCallId ?? `tc_${ts}`,
                status: tr.isError ? 'error' : 'success',
                result: tr.result,
                error: tr.isError ? String(tr.result ?? tr.error ?? 'Tool failed') : undefined,
                expandable: true,
              });
            }
          } else {
            // fallback: 从 metadata/source 提取
            items.push({
              id: makeId('tool'),
              role: 'tool',
              createdAt: ts,
              sessionId,
              source: 'history',
              toolName: extractToolName(msg),
              toolCallId: extractToolCallId(msg),
              status: extractIsError(msg) ? 'error' : 'success',
              result: msg.content,
              expandable: true,
            });
          }
          break;
        }
        case 'system': {
          const item: SystemConversationItem = {
            id: makeId('sys'),
            role: 'system',
            createdAt: ts,
            sessionId,
            source: 'history',
            kind: 'info',
            message: extractText(msg.content),
          };
          items.push(item);
          break;
        }
        default: {
          // 未知 role → 降级为 system info
          const item: SystemConversationItem = {
            id: makeId('sys'),
            role: 'system',
            createdAt: ts,
            sessionId,
            source: 'history',
            kind: 'info',
            message: `[${msg.role}] ${extractText(msg.content)}`,
          };
          items.push(item);
          break;
        }
      }
    }

    return items;
  }

  // ──────────────────────────────────
  // Reset
  // ──────────────────────────────────

  /**
   * 当切换 session 时重置内部状态。
   */
  reset(): void {
    this.currentAssistantId = undefined;
    this.toolIndex = {};
    this.streamingContent = '';
  }
}

// ──────────────────────────────────────
// MessageRecord metadata extractors
// ──────────────────────────────────────

function extractToolCallIds(msg: MessageRecord): string[] | undefined {
  // 优先从 Message.toolCalls 直接读取（Gateway 存储格式）
  const directCalls = (msg as any).toolCalls as Array<{ id?: string }> | undefined;
  if (Array.isArray(directCalls) && directCalls.length > 0) {
    return directCalls.map((c) => String(c.id ?? '')).filter(Boolean);
  }
  // fallback: 从 metadata/source 读取
  const meta = msg.metadata as Record<string, unknown> | undefined;
  const source = msg.source as Record<string, unknown> | undefined;
  const calls = (meta?.toolCalls ?? source?.toolCalls) as Array<{ id?: string }> | undefined;
  if (!Array.isArray(calls) || calls.length === 0) return undefined;
  return calls.map((c) => String(c.id ?? '')).filter(Boolean);
}

function extractToolResults(msg: MessageRecord): Array<{ toolCallId: string; name: string; result: unknown; error?: string; isError: boolean }> {
  // Gateway 存储的 tool 消息直接包含 toolResults 数组
  const results = (msg as any).toolResults as Array<{ toolCallId?: string; name?: string; result?: unknown; error?: string; isError?: boolean }> | undefined;
  if (Array.isArray(results) && results.length > 0) {
    return results.map(r => ({
      toolCallId: String(r.toolCallId ?? ''),
      name: String(r.name ?? 'unknown'),
      result: r.result,
      error: r.error,
      isError: Boolean(r.isError),
    }));
  }
  return [];
}

function extractToolName(msg: MessageRecord): string {
  const meta = msg.metadata as Record<string, unknown> | undefined;
  const source = msg.source as Record<string, unknown> | undefined;
  return String(meta?.toolName ?? source?.toolName ?? 'unknown');
}

function extractToolCallId(msg: MessageRecord): string {
  const meta = msg.metadata as Record<string, unknown> | undefined;
  const source = msg.source as Record<string, unknown> | undefined;
  return String(meta?.toolCallId ?? source?.toolCallId ?? `tc_${msg.timestamp}`);
}

function extractIsError(msg: MessageRecord): boolean {
  const meta = msg.metadata as Record<string, unknown> | undefined;
  const source = msg.source as Record<string, unknown> | undefined;
  return Boolean(meta?.isError ?? source?.isError);
}
