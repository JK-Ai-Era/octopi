/**
 * Memory Extraction — SessionExtractCollector
 *
 * 负责将 EventBus 事件聚合为可回放的结构化素材包（SessionExtractBundle）。
 * 不做入库，不做 LLM；仅负责“采集 + 结构化”。
 *
 * 用法：
 * 1) attach(events) 开始监听
 * 2) 系统运行过程中自动采集
 * 3) 在 session 生命周期结束时调用 buildBundle(sessionId) 生成 bundle
 *
 * @module harness/memory/extraction/session-extract-collector
 */

import type { EventBus, Disposable, AgentEvent } from '../../../core/primitives/event-bus.js';
import type {
  SessionExtractBundle,
  SessionExtractEvent,
  SessionExtractEventType,
  RunSummary,
} from './session-extractor.js';
import { detectSemanticSignals } from './semantic-signals.js';
import type { ExtractorStore } from './extractor-store.js';

interface CollectedSessionState {
  sessionId: string;
  agentId?: string;
  startAt: number;
  endAt?: number;
  events: SessionExtractEvent[];
  toolCalls: number;
  toolFailures: number;
  errors: number;
  majorErrors: Set<string>;
  resolvedErrors: Set<string>;
  lastAssistantTextByTurn?: string;
}

export interface SessionExtractCollectorOptions {
  store?: ExtractorStore;
}

export class SessionExtractCollector {
  private disposables: Disposable[] = [];
  private sessions = new Map<string, CollectedSessionState>();
  private attached = false;
  private store?: ExtractorStore;

  constructor(options?: SessionExtractCollectorOptions) {
    this.store = options?.store;
  }

  /** 是否已 attach */
  get isAttached(): boolean {
    return this.attached;
  }

  /** 开始监听通用事件（幂等） */
  attach(events: EventBus): void {
    if (this.attached) return;
    this.attached = true;

    this.disposables.push(
      events.on('session.lifecycle.updated', (e) => this.onLifecycleUpdated(e)),
    );
    this.disposables.push(
      events.on('turn.end', (e) => this.onTurnEnd(e)),
    );
    this.disposables.push(
      events.on('tool.exec.start', (e) => this.onToolStart(e)),
    );
    this.disposables.push(
      events.on('tool.exec.end', (e) => this.onToolEnd(e)),
    );
    this.disposables.push(
      events.on('engine.end', (e) => this.onEngineEnd(e)),
    );
  }

  /** 停止监听并清空状态 */
  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.sessions.clear();
    this.attached = false;
  }

  /** 主动重置某 session 采集状态（可选） */
  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** 生成 SessionExtractBundle（可重复调用） */
  buildBundle(sessionId: string): SessionExtractBundle | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;

    const runSummary: RunSummary = {
      totalTurns: s.events.filter((e) => e.type === 'assistant_summary').length,
      totalToolCalls: s.toolCalls,
      failureRate: s.toolCalls > 0 ? s.toolFailures / s.toolCalls : 0,
      majorErrors: [...s.majorErrors],
      resolvedErrors: [...s.resolvedErrors],
    };

    const bundle: SessionExtractBundle = {
      sessionId: s.sessionId,
      agentId: s.agentId ?? 'unknown',
      startAt: s.startAt,
      endAt: s.endAt,
      events: s.events,
      condensedTurns: [],
      runSummary,
      humanCheckpoints: s.events
        .filter((e) => e.type === 'constraint_set' || e.type === 'user_confirm' || e.type === 'user_reject' || e.type === 'goal_change')
        .map((e) => ({
          ts: e.ts,
          kind: mapHumanCheckpointKind(e.type),
          sourceEventIds: e.sourceMessageIds,
        })),
    };

    // 快照落盘（忽略失败）
    if (this.store) {
      this.store.saveBundle(s.agentId ?? 'unknown', s.sessionId, bundle, {
        sessionId: s.sessionId,
        agentId: s.agentId,
        lifecycle: 'recent',
        extractionStatus: 'pending',
      }).catch(() => {});
    }

    return bundle;
  }

  private ensureSession(sessionId: string, agentId?: string): CollectedSessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        agentId,
        startAt: Date.now(),
        events: [],
        toolCalls: 0,
        toolFailures: 0,
        errors: 0,
        majorErrors: new Set(),
        resolvedErrors: new Set(),
      };
      this.sessions.set(sessionId, s);
    }
    if (agentId && !s.agentId) s.agentId = agentId;
    return s;
  }

  private onLifecycleUpdated(event: AgentEvent): void {
    const sessionId = event.sessionId as string | undefined;
    if (!sessionId) return;

    const s = this.ensureSession(sessionId, event.agentId);
    const data = (event.data ?? {}) as Record<string, unknown>;
    const lifecycle = data.lifecycle as string | undefined;
    const extractionStatus = data.extractionStatus as string | undefined;

    if (lifecycle === 'active' && !s.startAt) {
      s.startAt = (data.lastInteractionAt as number) ?? Date.now();
    }

    if (lifecycle === 'recent') {
      s.endAt = Date.now();
      this.pushEvent(s, 'goal_set', { lifecycle, extractionStatus });
    }
  }

  private onTurnEnd(event: AgentEvent): void {
    const sessionId = event.sessionId as string | undefined;
    if (!sessionId) return;
    const s = this.ensureSession(sessionId, event.agentId);

    const data = (event.data ?? {}) as Record<string, unknown>;
    const content = (data.content as string) ?? '';
    const userText = (data.userText as string) ?? '';
    const assistantText = content;

    s.lastAssistantTextByTurn = content;

    // 简单结构化信号：助手总结（长度阈值 + 包含总结关键词）
    if (isSummaryLikeText(assistantText)) {
      this.pushEvent(s, 'assistant_summary', { length: assistantText.length });
    }

    // 优先从用户文本做极性检测（降低误判）
    const sem = detectSemanticSignals({ text: userText || assistantText, lastAssistantText: assistantText });
    if (sem.confirmLikely) {
      this.pushEvent(s, 'user_confirm', { confidence: sem.confidence });
    } else if (sem.rejectLikely) {
      this.pushEvent(s, 'user_reject', { confidence: sem.confidence });
    }
  }

  private onToolStart(event: AgentEvent): void {
    const sessionId = event.sessionId as string | undefined;
    if (!sessionId) return;
    const s = this.ensureSession(sessionId, event.agentId);
    s.toolCalls += 1;
    const data = (event.data ?? {}) as Record<string, unknown>;
    this.pushEvent(s, 'tool_call', { toolName: data.toolName, toolCallId: data.toolCallId });
  }

  private onToolEnd(event: AgentEvent): void {
    const sessionId = event.sessionId as string | undefined;
    if (!sessionId) return;
    const s = this.ensureSession(sessionId, event.agentId);
    const data = (event.data ?? {}) as Record<string, unknown>;
    const hasError = !!data.hasError;

    if (hasError) {
      s.toolFailures += 1;
      this.pushEvent(s, 'tool_failure', { toolName: data.toolName, result: summarizeResult(data.result) });
    } else {
      this.pushEvent(s, 'tool_success', { toolName: data.toolName });
      // 如果之前有失败并随后成功，则记为 fix_applied（简化启发）
      if (s.toolFailures > 0) {
        this.pushEvent(s, 'fix_applied', { toolName: data.toolName });
        s.resolvedErrors.add(String(data.toolName ?? 'unknown'));
      }
    }
  }

  private onEngineEnd(event: AgentEvent): void {
    const sessionId = event.sessionId as string | undefined;
    if (!sessionId) return;
    const s = this.ensureSession(sessionId, event.agentId);
    const data = (event.data ?? {}) as Record<string, unknown>;
    s.endAt = Date.now();

    if (data.reason === 'error') {
      s.errors += 1;
      s.majorErrors.add(String(data.error ?? 'engine_error'));
      this.pushEvent(s, 'error', { reason: data.reason, error: data.error });
    }
  }

  private pushEvent(s: CollectedSessionState, type: SessionExtractEventType, payload?: Record<string, unknown>): void {
    const evt: SessionExtractEvent = {
      ts: Date.now(),
      type,
      sessionId: s.sessionId,
      agentId: s.agentId,
      payload,
    };
    s.events.push(evt);

    // 异步持久化（忽略失败，不影响主流程）
    if (this.store) {
      this.store.appendEvents(s.agentId ?? 'unknown', s.sessionId, [evt]).catch(() => {});
    }
  }
}

function isSummaryLikeText(text: string): boolean {
  if (text.length < 80) return false;
  const markers = ['总结', '小结', '结论', '总结如下', 'Summary', 'Conclusion', 'Takeaway'];
  return markers.some((m) => text.includes(m));
}

function summarizeResult(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, 200);
  try {
    return JSON.stringify(result).slice(0, 200);
  } catch {
    return 'unknown';
  }
}


function mapHumanCheckpointKind(type: string): 'confirm' | 'reject' | 'goal_change' | 'constraint_set' {
  switch (type) {
    case 'user_confirm': return 'confirm';
    case 'user_reject': return 'reject';
    case 'goal_change': return 'goal_change';
    case 'constraint_set': return 'constraint_set';
    default: return 'constraint_set';
  }
}
