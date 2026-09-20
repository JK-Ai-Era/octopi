/**
 * ObserverHub — 产品 Observer 通道（Run 现场打包与缓存）
 *
 * EventBus 仍是协调总线；本 Hub 消费事件 + Runner 快照，
 * 为 Web/测试提供「当前/最近 Run」可检视现场。
 * 观测失败 fail-open，不打断业务路径。
 */

import type { Message } from '../../core/types.js';
import type { AgentEvent } from '../../core/primitives/event-bus.js';
import {
  resolveObserverConfig,
  buildRunMessagesDiff,
  summarizeLlmMessages,
  type ObserverConfig,
  type ResolvedObserverConfig,
  type RunGuardMetricsView,
  type RunLifecycleView,
  type RunMemoryActivityView,
  type RunMessagesDiff,
  type RunMessagesSnapshot,
  type RunMessagesSummary,
  type RunObservatorySnapshot,
  type RunScopeView,
  type RunSecurityEventView,
  type RunTimelineEventView,
  type RunToolEffectView,
} from './types.js';
import { buildRunMessagesSnapshot, buildRunScopeView } from './run-snapshot.js';
import type { RunScope } from '../run-scope.js';
import type { ContextLayersSnapshot } from '../context/layer-snapshot.js';
import { buildContextLayersSnapshot } from '../context/layer-snapshot.js';
import type { AssembleManifest, ContextLayerId } from '../context/layer-types.js';

const SECURITY_EVENT_TYPES = new Set([
  'injection.detected',
  'sensitive_data.detected',
  'policy.violated',
  'security.blocked',
  'security.behavior_blocked',
]);
const MEMORY_TOOLS = new Set(['memory_store', 'memory_search']);
const MAX_SECURITY_EVENTS = 50;
const MAX_MEMORY_ENTRIES = 40;

function emptyMemoryActivity(): RunMemoryActivityView {
  return {
    stores: 0,
    searches: 0,
    storedOk: 0,
    rejected: 0,
    superseded: 0,
    searchHits: 0,
    entries: [],
  };
}

function parseToolJson(content: unknown): Record<string, unknown> | null {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

interface RunRecord {
  runId: string;
  sessionId: string;
  agentId?: string;
  scope: RunScopeView;
  messages?: {
    entry?: RunMessagesSnapshot;
    final?: RunMessagesSnapshot;
    llm?: RunMessagesSnapshot;
  };
  messageClones?: {
    entry?: Message[];
    final?: Message[];
    llm?: Array<{ role: string; content: unknown; [k: string]: unknown }>;
  };
  llmEstimatedTokens?: number;
  guardMetrics?: RunGuardMetricsView;
  messagesDiff?: RunMessagesDiff;
  lifecycle: RunLifecycleView;
  timeline: RunTimelineEventView[];
  securityEvents: RunSecurityEventView[];
  memoryActivity: RunMemoryActivityView;
  toolEffect: RunToolEffectView;
  updatedAt: number;
}

const TIMELINE_TYPES = new Set([
  'engine.start',
  'engine.end',
  'engine.error',
  'iteration.start',
  'turn.end',
  'tool.exec.start',
  'tool.exec.end',
  'budget.exceeded',
  'run_guard.stopped',
  'run_guard.recovered',
  'context.compact.start',
  'context.compact.end',
  'context.compact.error',
  'context.layers.assembled',
  'persona.resolve.failed',
  'injection.detected',
  'policy.violated',
  'sensitive_data.detected',
  'security.blocked',
  'security.behavior_blocked',
]);

let runSeq = 0;

/** Hub 兜底：scope 未带 runId 时使用（生产路径应由 Runner/createRunId 提供） */
function nextRunId(): string {
  runSeq += 1;
  return `run_${Date.now().toString(36)}_${runSeq}`;
}

/**
 * 产品 Observer Hub
 */
export class ObserverHub {
  private readonly config: ResolvedObserverConfig;
  private readonly runsBySession = new Map<string, RunRecord[]>();
  private readonly runById = new Map<string, RunRecord>();
  private readonly activeRunBySession = new Map<string, string>();
  private readonly contextLayersBySession = new Map<string, ContextLayersSnapshot>();
  /** session → 最近一次 LLM 视图（run 记录缺失时的兜底） */
  private readonly lastLlmBySession = new Map<string, RunMessagesSnapshot>();
  private static readonly MAX_CONTEXT_LAYERS_SESSIONS = 256;
  /** session 键 FIFO 上限（runs / active / llm 共用） */
  private static readonly MAX_OBSERVER_SESSIONS = 256;

  constructor(config?: ObserverConfig) {
    this.config = resolveObserverConfig(config);
  }

  getConfig(): ResolvedObserverConfig {
    return this.config;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Runner 在组装 RunScope 后调用：登记 run + entry messages
   */
  recordRunStart(input: {
    scope: RunScope;
    /** 可选：Runner 显式传入；缺省用 scope.runId */
    runId?: string;
    resolvedModel?: { modelName?: string; providerId?: string; contextWindow?: number };
    messages?: Message[];
  }): string {
    if (!this.isEnabled() || !this.config.channels['run.scope']) return '';
    try {
      // runId 与 RunScope/Runner 对齐；Hub 不另造权威身份
      const runId = input.scope.runId || input.runId || nextRunId();
      const capturedAt = Date.now();
      const scopeView = buildRunScopeView({
        scope: input.scope,
        runId,
        resolvedModel: input.resolvedModel,
        capturedAt,
        includeSystemPromptPreview:
          this.config.payload.layerPreview || this.config.payload.layerContent,
        includeSystemPromptFull:
          this.config.level === 'full' || this.config.payload.layerContent === true,
      });
      const record: RunRecord = {
        runId,
        sessionId: input.scope.sessionId,
        agentId: input.scope.agentId,
        scope: scopeView,
        lifecycle: { startedAt: capturedAt },
        timeline: [],
        securityEvents: [],
        memoryActivity: emptyMemoryActivity(),
        toolEffect: {
          sessionId: input.scope.sessionId,
          agentId: input.scope.agentId,
          runId,
          cwd: scopeView.toolRuntime?.cwd,
          isolation: scopeView.toolRuntime?.isolation,
          tools: [],
        },
        updatedAt: capturedAt,
      };
      if (input.messages && this.config.channels['run.messages']) {
        const built = buildRunMessagesSnapshot(
          {
            sessionId: input.scope.sessionId,
            agentId: input.scope.agentId,
            runId,
            messages: input.messages,
            phase: 'entry',
            runCapturedAt: capturedAt,
          },
          this.config,
        );
        record.messages = { entry: built.snapshot };
        if (built.cloned) record.messageClones = { entry: built.cloned };
        record.scope = {
          ...scopeView,
          toolRuntime: scopeView.toolRuntime
            ? { ...scopeView.toolRuntime, messagesCount: input.messages.length }
            : scopeView.toolRuntime,
        };
      }
      this.appendRun(record);
      this.activeRunBySession.set(record.sessionId, runId);
      return runId;
    } catch (err) {
      this.warn('recordRunStart', err);
      return '';
    }
  }

  /**
   * Runner 在 run 结束时调用：final messages + entry/final diff
   */
  recordRunEnd(input: {
    runId: string;
    sessionId: string;
    messages?: Message[];
    endReason?: string;
    error?: string;
  }): void {
    if (!this.isEnabled() || !input.runId) return;
    try {
      const record = this.runById.get(input.runId);
      if (!record) return;
      const endedAt = Date.now();
      const g = record.guardMetrics;
      record.lifecycle = {
        ...record.lifecycle,
        endedAt,
        endReason: input.endReason,
        error: input.error,
        durationMs:
          record.lifecycle.startedAt != null
            ? endedAt - record.lifecycle.startedAt
            : undefined,
        // timeline 事件缺失时从 Guard / messages 摘要回填，避免面板全空
        turns: record.lifecycle.turns ?? g?.iteration,
        toolCalls: record.lifecycle.toolCalls ?? g?.totalToolCalls,
      };
      if (input.messages && this.config.channels['run.messages']) {
        const built = buildRunMessagesSnapshot(
          {
            sessionId: input.sessionId,
            agentId: record.agentId,
            runId: input.runId,
            messages: input.messages,
            phase: 'final',
            runCapturedAt: endedAt,
          },
          this.config,
        );
        record.messages = { ...record.messages, final: built.snapshot };
        if (built.cloned) {
          record.messageClones = { ...record.messageClones, final: built.cloned };
        }
        if (record.lifecycle.turns == null && record.guardMetrics?.iteration != null) {
          record.lifecycle.turns = record.guardMetrics.iteration;
        }
        if (record.lifecycle.toolCalls == null && record.guardMetrics?.totalToolCalls != null) {
          record.lifecycle.toolCalls = record.guardMetrics.totalToolCalls;
        }
        record.scope = {
          ...record.scope,
          toolRuntime: record.scope.toolRuntime
            ? {
                ...record.scope.toolRuntime,
                messagesCount: input.messages.length,
              }
            : record.scope.toolRuntime,
        };

        // entry → final diff
        const entryClone = record.messageClones?.entry;
        const finalClone = record.messageClones?.final;
        const entrySummary = record.messages?.entry?.summary;
        const finalSummary = built.snapshot.summary;
        if (entryClone && finalClone) {
          record.messagesDiff = buildRunMessagesDiff(entryClone, finalClone);
        } else if (entrySummary && finalSummary) {
          record.messagesDiff = {
            entryCount: entrySummary.count,
            finalCount: finalSummary.count,
            added: [],
            removedCount: Math.max(0, entrySummary.count - finalSummary.count),
            notes:
              finalSummary.count > entrySummary.count
                ? `final 比 entry 多 ${finalSummary.count - entrySummary.count} 条（summary 模式无逐条列表）`
                : finalSummary.count === entrySummary.count
                  ? 'entry 与 final 条数相同'
                  : `final 比 entry 少 ${entrySummary.count - finalSummary.count} 条`,
          };
        }
      }
      record.updatedAt = endedAt;
      if (this.activeRunBySession.get(input.sessionId) === input.runId) {
        this.activeRunBySession.delete(input.sessionId);
      }
    } catch (err) {
      this.warn('recordRunEnd', err);
    }
  }

  /**
   * ContextEngine assemble 出口：LLM 实际输入
   */
  recordLlmMessages(input: {
    sessionId: string;
    agentId?: string;
    runId?: string;
    messages: Array<{ role: string; content?: unknown }>;
    estimatedTokens?: number;
  }): void {
    if (!this.isEnabled() || !this.config.channels['context.llm']) return;
    try {
      const runId =
        input.runId ??
        this.activeRunBySession.get(input.sessionId) ??
        this.latestRun(input.sessionId)?.runId;

      const summary: RunMessagesSummary = summarizeLlmMessages(input.messages);
      const wantFull = this.shouldCaptureFullLlm();
      const snapshot: RunMessagesSnapshot = {
        sessionId: input.sessionId,
        agentId: input.agentId,
        runId,
        runCapturedAt: Date.now(),
        view: 'llm',
        phase: 'final',
        summary,
        messages: wantFull
          ? input.messages.map((m, index) => {
              const text = typeof m.content === 'string' ? m.content : extractPreview(m.content);
              return {
                index,
                role: (m.role || 'unknown') as 'user' | 'assistant' | 'system' | 'tool',
                content: text,
                contentChars: text.length,
                contentPreview: text.slice(0, 200),
              };
            })
          : undefined,
        notes: wantFull
          ? 'LLM 实际输入（ContextEngine assemble 出口；可能已 compact）'
          : 'LLM 视图仅摘要；observer.level=full 可看全文',
      };
      // session 级兜底，避免 run 生命周期边界丢数据
      this.lastLlmBySession.set(input.sessionId, snapshot);

      const record = runId ? this.runById.get(runId) : undefined;
      if (record) {
        record.messages = { ...record.messages, llm: snapshot };
        if (wantFull) {
          record.messageClones = {
            ...record.messageClones,
            llm: input.messages.map((m) => ({ role: m.role, content: m.content })),
          };
        }
        record.llmEstimatedTokens = input.estimatedTokens;
        record.updatedAt = Date.now();
      }
    } catch (err) {
      this.warn('recordLlmMessages', err);
    }
  }

  private shouldCaptureFullLlm(): boolean {
    return (
      this.config.payload.messageFullText === true &&
      this.config.retention.messagesPerRun === 'full'
    );
  }

  /**
   * 七层装配快照（自 Gateway 迁入 Hub）
   */
  rememberContextLayers(
    sessionId: string,
    event: AgentEvent,
  ): void {
    if (!this.isEnabled() || !this.config.channels['context.layers']) return;
    const data = event.data as
      | {
          manifest?: AssembleManifest;
          enabledLayerIds?: ContextLayerId[];
          query?: string;
          assembledAt?: number;
          fallback?: boolean;
          fallbackError?: string;
        }
      | undefined;
    if (!data?.manifest) return;
    try {
      if (
        !this.contextLayersBySession.has(sessionId) &&
        this.contextLayersBySession.size >= ObserverHub.MAX_CONTEXT_LAYERS_SESSIONS
      ) {
        const oldest = this.contextLayersBySession.keys().next().value;
        if (oldest !== undefined) this.contextLayersBySession.delete(oldest);
      }
      this.contextLayersBySession.set(
        sessionId,
        stripLayerPayload(
          buildContextLayersSnapshot({
            manifest: data.manifest,
            enabledLayerIds: data.enabledLayerIds,
            query: data.query,
            assembledAt: data.assembledAt ?? event.timestamp,
            fallback: data.fallback,
            fallbackError: data.fallbackError,
          }),
          this.config.payload,
        ),
      );
    } catch (err) {
      this.warn('rememberContextLayers', err);
    }
  }

  /**
   * 读取会话七层快照（REST 真源之一）
   */
  getContextLayers(sessionId: string): ContextLayersSnapshot | null {
    return this.contextLayersBySession.get(sessionId) ?? null;
  }

  /**
   * Gateway EventBus 适配：timeline / lifecycle / guard / llm 摘要
   */
  ingestEvent(event: AgentEvent): void {
    if (!this.isEnabled()) return;

    if (event.type === 'context.layers.assembled' && event.sessionId) {
      this.rememberContextLayers(event.sessionId, event);
    }

    if (
      !this.config.channels['run.timeline'] &&
      !this.config.channels.security &&
      !this.config.channels.memory &&
      !this.config.channels['tool.effect'] &&
      event.type !== 'run.guard.metrics' &&
      event.type !== 'run.scope.llm'
    ) {
      return;
    }
    if (!event.sessionId) return;

    try {
      const runId = this.activeRunBySession.get(event.sessionId);
      const record = runId ? this.runById.get(runId) : this.latestRun(event.sessionId);
      if (!record) return;

      if (event.type === 'run.guard.metrics' && this.config.channels['run.guard']) {
        const d = event.data as unknown as RunGuardMetricsView;
        record.guardMetrics = {
          ...record.guardMetrics,
          ...d,
        };
        record.updatedAt = Date.now();
        return;
      }

      // security 通道：结构化事件（不依赖 TIMELINE）
      if (this.config.channels.security && SECURITY_EVENT_TYPES.has(event.type)) {
        this.appendSecurityEvent(record, event);
        record.updatedAt = Date.now();
        // 继续落入 timeline（若启用）
      }

      // memory / tool.effect：从 tool.exec.end 投影
      if (
        event.type === 'tool.exec.end' &&
        (this.config.channels.memory || this.config.channels['tool.effect'])
      ) {
        const d = (event.data ?? {}) as {
          toolName?: string;
          hasError?: boolean;
          durationMs?: number;
          args?: Record<string, unknown>;
          result?: unknown;
        };
        const toolName = d.toolName ?? '';
        if (this.config.channels['tool.effect'] && toolName) {
          this.applyToolEffect(record, toolName, d.hasError === true, d.durationMs);
        }
        if (this.config.channels.memory && MEMORY_TOOLS.has(toolName)) {
          this.applyMemoryActivity(record, toolName, d);
        }
      }

      if (event.type === 'run.scope.llm') {
        const d = event.data as {
          runId?: string;
          summary?: RunMessagesSummary;
          estimatedTokens?: number;
        };
        const target =
          (d.runId ? this.runById.get(d.runId) : undefined) ??
          record;
        if (target) {
          if (d.estimatedTokens != null) {
            target.llmEstimatedTokens = d.estimatedTokens;
          }
          // 真源 = recordLlmMessages；事件仅在尚无 llm 快照时补摘要，避免冲掉全文
          const existing = target.messages?.llm;
          if (!existing?.messages?.length && d.summary) {
            target.messages = {
              ...target.messages,
              llm: {
                sessionId: target.sessionId,
                agentId: target.agentId,
                runId: target.runId,
                view: 'llm',
                phase: 'final',
                summary: d.summary,
                notes: 'LLM 实际输入摘要',
              },
            };
          }
          const llmSnap = target.messages?.llm;
          if (llmSnap) {
            this.lastLlmBySession.set(target.sessionId, llmSnap);
          }
        }
        record.updatedAt = Date.now();
        return;
      }

      if (!this.config.channels['run.timeline'] || !TIMELINE_TYPES.has(event.type)) {
        // guard/budget 补充字段仍写入
        this.mergeGuardFlags(record, event);
        return;
      }

      const node = toTimelineNode(event);
      if (node) {
        record.timeline.push(node);
        const max = this.config.retention.timelineEvents;
        if (record.timeline.length > max) {
          record.timeline.splice(0, record.timeline.length - max);
        }
      }

      const life = record.lifecycle;
      if (event.type === 'turn.end') {
        life.turns = (life.turns ?? 0) + 1;
      } else if (event.type === 'tool.exec.end') {
        life.toolCalls = (life.toolCalls ?? 0) + 1;
      } else if (event.type === 'engine.end') {
        const reason = (event.data as { reason?: string } | undefined)?.reason;
        if (!life.endedAt) {
          life.endedAt = event.timestamp;
          life.endReason = reason;
          if (life.startedAt != null) life.durationMs = event.timestamp - life.startedAt;
        }
      } else if (event.type === 'engine.error') {
        life.error = (event.data as { error?: string } | undefined)?.error;
        life.endReason = life.endReason ?? 'error';
        if (!life.endedAt) {
          life.endedAt = event.timestamp;
          if (life.startedAt != null) life.durationMs = event.timestamp - life.startedAt;
        }
      }
      this.mergeGuardFlags(record, event);
      record.updatedAt = Date.now();
    } catch (err) {
      this.warn('ingestEvent', err);
    }
  }

  private appendSecurityEvent(record: RunRecord, event: AgentEvent): void {
    const d = (event.data ?? {}) as Record<string, unknown>;
    const violations = Array.isArray(d.violations)
      ? (d.violations as Array<{ type?: string; severity?: string; description?: string }>)
      : undefined;
    const view: RunSecurityEventView = {
      type: event.type,
      timestamp: event.timestamp,
      severity:
        (d.severity as string | undefined) ??
        violations?.[0]?.severity,
      description:
        (d.description as string | undefined) ??
        (d.reason as string | undefined) ??
        violations?.[0]?.description,
      source: d.source as string | undefined,
      toolName: (d.toolName as string | undefined) ?? (d.tool as string | undefined),
      action: d.action as string | undefined,
      violationTypes: violations?.map((v) => v.type).filter(Boolean) as string[] | undefined,
      count: typeof d.count === 'number' ? d.count : undefined,
    };
    record.securityEvents.push(view);
    if (record.securityEvents.length > MAX_SECURITY_EVENTS) {
      record.securityEvents.splice(0, record.securityEvents.length - MAX_SECURITY_EVENTS);
    }
  }

  private applyToolEffect(
    record: RunRecord,
    toolName: string,
    hasError: boolean,
    durationMs?: number,
  ): void {
    const effect = record.toolEffect;
    effect.cwd = effect.cwd ?? record.scope.toolRuntime?.cwd;
    effect.isolation = effect.isolation ?? record.scope.toolRuntime?.isolation;
    let row = effect.tools.find((t) => t.name === toolName);
    if (!row) {
      row = { name: toolName, calls: 0, errors: 0 };
      effect.tools.push(row);
    }
    row.calls += 1;
    if (hasError) row.errors += 1;
    if (typeof durationMs === 'number') row.lastDurationMs = durationMs;
  }

  private applyMemoryActivity(
    record: RunRecord,
    toolName: string,
    d: {
      hasError?: boolean;
      args?: Record<string, unknown>;
      result?: unknown;
    },
  ): void {
    const act = record.memoryActivity;
    const payload = parseToolJson(d.result);
    const args = d.args ?? {};
    const isError = d.hasError === true;

    if (toolName === 'memory_store') {
      act.stores += 1;
      const stored = payload?.stored === true;
      const rejected = payload?.rejected === true || (!stored && !isError && payload != null);
      const ok = stored && !isError;
      if (ok) act.storedOk += 1;
      if (rejected || (isError && !stored)) act.rejected += 1;
      const supersededId =
        (payload?.supersededId as string | null | undefined) ??
        (args.supersedes_id as string | undefined) ??
        null;
      if (ok && supersededId) act.superseded += 1;
      const proposition =
        typeof payload?.content === 'string'
          ? payload.content
          : typeof args.proposition === 'string'
            ? args.proposition
            : undefined;
      act.entries.push({
        kind: 'store',
        timestamp: Date.now(),
        toolName,
        success: ok,
        memoryId: payload?.id as string | undefined,
        memoryType: (payload?.type as string | undefined) ?? (args.type as string | undefined),
        status: payload?.status as string | undefined,
        propositionPreview: proposition?.slice(0, 160),
        supersededId,
        rejectReason: payload?.reason as string | undefined,
      });
    } else if (toolName === 'memory_search') {
      act.searches += 1;
      const total =
        typeof payload?.total === 'number'
          ? payload.total
          : Array.isArray(payload?.results)
            ? payload.results.length
            : 0;
      act.searchHits += total;
      act.entries.push({
        kind: 'search',
        timestamp: Date.now(),
        toolName,
        success: !isError,
        query: typeof args.query === 'string' ? args.query.slice(0, 120) : undefined,
        resultCount: total,
      });
    }

    if (act.entries.length > MAX_MEMORY_ENTRIES) {
      act.entries.splice(0, act.entries.length - MAX_MEMORY_ENTRIES);
    }
  }

  private mergeGuardFlags(record: RunRecord, event: AgentEvent): void {
    if (!this.config.channels['run.guard']) return;
    if (event.type === 'budget.exceeded') {
      const reason = (event.data as { reason?: string } | undefined)?.reason;
      record.guardMetrics = {
        iteration: 0,
        totalToolCalls: record.lifecycle.toolCalls ?? 0,
        totalTokens: 0,
        elapsedMs: record.lifecycle.durationMs ?? 0,
        consecutiveErrors: record.guardMetrics?.consecutiveErrors ?? 0,
        consecutiveSameTool: record.guardMetrics?.consecutiveSameTool ?? 0,
        noopStreak: record.guardMetrics?.noopStreak ?? 0,
        hasProgress: record.guardMetrics?.hasProgress ?? true,
        uniqueTools: record.guardMetrics?.uniqueTools ?? [],
        recentTools: record.guardMetrics?.recentTools ?? [],
        recoveryCount: record.guardMetrics?.recoveryCount ?? 0,
        ...record.guardMetrics,
        budgetExceededReason: reason,
      };
    } else if (event.type === 'run_guard.stopped') {
      const reason = (event.data as { reason?: string } | undefined)?.reason;
      record.guardMetrics = {
        iteration: record.guardMetrics?.iteration ?? 0,
        totalToolCalls: record.guardMetrics?.totalToolCalls ?? 0,
        totalTokens: record.guardMetrics?.totalTokens ?? 0,
        elapsedMs: record.guardMetrics?.elapsedMs ?? 0,
        consecutiveErrors: record.guardMetrics?.consecutiveErrors ?? 0,
        consecutiveSameTool: record.guardMetrics?.consecutiveSameTool ?? 0,
        noopStreak: record.guardMetrics?.noopStreak ?? 0,
        hasProgress: record.guardMetrics?.hasProgress ?? false,
        uniqueTools: record.guardMetrics?.uniqueTools ?? [],
        recentTools: record.guardMetrics?.recentTools ?? [],
        recoveryCount: record.guardMetrics?.recoveryCount ?? 0,
        ...record.guardMetrics,
        guardStoppedReason: reason,
      };
    } else if (event.type === 'run_guard.recovered') {
      const d = event.data as { reason?: string; actions?: string[] };
      record.guardMetrics = {
        iteration: record.guardMetrics?.iteration ?? 0,
        totalToolCalls: record.guardMetrics?.totalToolCalls ?? 0,
        totalTokens: record.guardMetrics?.totalTokens ?? 0,
        elapsedMs: record.guardMetrics?.elapsedMs ?? 0,
        consecutiveErrors: record.guardMetrics?.consecutiveErrors ?? 0,
        consecutiveSameTool: record.guardMetrics?.consecutiveSameTool ?? 0,
        noopStreak: record.guardMetrics?.noopStreak ?? 0,
        hasProgress: record.guardMetrics?.hasProgress ?? true,
        uniqueTools: record.guardMetrics?.uniqueTools ?? [],
        recentTools: record.guardMetrics?.recentTools ?? [],
        recoveryCount: record.guardMetrics?.recoveryCount ?? 0,
        ...record.guardMetrics,
        guardRecovered: { reason: d.reason ?? '', actions: d.actions ?? [] },
      };
    }
  }

  getRunObservatory(sessionId: string): RunObservatorySnapshot | null {
    if (!this.config.webPanel) return null;
    const record = this.latestRun(sessionId);
    if (!record) return null;
    return this.toProjection(record);
  }

  /**
   * 读取 Run 投影（Runner/事件路径；不检查 webPanel）
   */
  getRunById(runId: string): RunObservatorySnapshot | null {
    const record = this.runById.get(runId);
    return record ? this.toProjection(record) : null;
  }

  getRunMessages(
    sessionId: string,
    options?: { phase?: 'entry' | 'final' | 'llm'; runId?: string; view?: 'workspace' | 'llm' },
  ): RunMessagesSnapshot | null {
    if (!this.config.webPanel) return null;
    const record = options?.runId
      ? this.runById.get(options.runId)
      : this.latestRun(sessionId);
    if (!record) return null;

    const view = options?.view ?? (options?.phase === 'llm' ? 'llm' : 'workspace');
    if (view === 'llm') {
      const recordLlm = record.messages?.llm;
      const fallback = this.lastLlmBySession.get(sessionId);
      const llmSnap = recordLlm ?? fallback;
      if (!llmSnap) return null;
      const clones = record.messageClones?.llm;
      if (clones && llmSnap.messages) {
        return {
          ...llmSnap,
          messages: llmSnap.messages.map((v, i) => {
            const m = clones[i];
            if (!m) return v;
            const content =
              typeof m.content === 'string'
                ? m.content
                : extractPreview(m.content);
            return { ...v, content };
          }),
        };
      }
      // 投影里只有 llmSummary 时，合成可展示快照
      if (!llmSnap.messages && llmSnap.summary) {
        return llmSnap;
      }
      return llmSnap;
    }

    const phase = options?.phase === 'entry' ? 'entry' : 'final';
    const snap =
      (phase === 'entry' ? record.messages?.entry : record.messages?.final) ??
      record.messages?.final ??
      record.messages?.entry;
    if (!snap) return null;

    const clones =
      phase === 'entry' ? record.messageClones?.entry : record.messageClones?.final;
    if (clones && snap.messages) {
      return {
        ...snap,
        messages: snap.messages.map((v) => {
          const m = clones[v.index];
          return m ? { ...v, content: m.content } : v;
        }),
      };
    }
    return snap;
  }

  getStatus(): {
    enabled: boolean;
    level: string;
    webPanel: boolean;
    channels: Record<string, boolean>;
  } {
    return {
      enabled: this.config.enabled,
      level: this.config.level,
      webPanel: this.config.webPanel,
      channels: { ...this.config.channels },
    };
  }

  private latestRun(sessionId: string): RunRecord | undefined {
    const list = this.runsBySession.get(sessionId);
    return list?.[list.length - 1];
  }

  private toProjection(record: RunRecord): RunObservatorySnapshot {
    const g = record.guardMetrics;
    const lifecycle: RunLifecycleView = {
      ...record.lifecycle,
      turns: record.lifecycle.turns ?? g?.iteration,
      toolCalls: record.lifecycle.toolCalls ?? g?.totalToolCalls,
      durationMs: record.lifecycle.durationMs ?? g?.elapsedMs,
    };
    return {
      sessionId: record.sessionId,
      agentId: record.agentId,
      runId: record.runId,
      scope: record.scope,
      messagesSummary:
        record.messages?.final?.summary ?? record.messages?.entry?.summary,
      llmSummary:
        record.messages?.llm?.summary ??
        this.lastLlmBySession.get(record.sessionId)?.summary,
      llmEstimatedTokens:
        record.llmEstimatedTokens ??
        undefined,
      guardMetrics: record.guardMetrics,
      messagesDiff: record.messagesDiff,
      lifecycle,
      timeline: record.timeline.slice(),
      securityEvents: this.config.channels.security
        ? record.securityEvents.slice()
        : undefined,
      memoryActivity: this.config.channels.memory
        ? {
            ...record.memoryActivity,
            entries: record.memoryActivity.entries.slice(),
          }
        : undefined,
      toolEffect: this.config.channels['tool.effect']
        ? {
            ...record.toolEffect,
            tools: record.toolEffect.tools.map((t) => ({ ...t })),
            notes: record.toolEffect.notes ? [...record.toolEffect.notes] : undefined,
          }
        : undefined,
      observer: {
        enabled: this.config.enabled,
        level: this.config.level,
        webPanel: this.config.webPanel,
      },
    };
  }

  private appendRun(record: RunRecord): void {
    this.evictObserverSessionsIfFull(record.sessionId);
    this.runById.set(record.runId, record);
    let list = this.runsBySession.get(record.sessionId);
    if (!list) {
      list = [];
      this.runsBySession.set(record.sessionId, list);
    }
    list.push(record);
    const max = Math.max(1, this.config.retention.runsPerSession);
    while (list.length > max) {
      const dropped = list.shift();
      if (dropped) {
        this.runById.delete(dropped.runId);
        // 同步清 LLM 兜底，避免 run 淘汰后 full 正文仍挂在 session 上
        const llm = this.lastLlmBySession.get(record.sessionId);
        if (llm?.runId === dropped.runId) {
          const stillHasLlm = list.some((r) => r.messages?.llm);
          if (!stillHasLlm) {
            this.lastLlmBySession.delete(record.sessionId);
          }
        }
      }
    }
  }

  /** session 键超限时 FIFO 淘汰最旧（不含 keepSessionId） */
  private evictObserverSessionsIfFull(keepSessionId: string): void {
    const max = ObserverHub.MAX_OBSERVER_SESSIONS;
    while (this.runsBySession.size >= max && !this.runsBySession.has(keepSessionId)) {
      const oldest = this.runsBySession.keys().next().value;
      if (oldest === undefined) break;
      this.dropSessionObserverState(oldest);
    }
    while (this.lastLlmBySession.size >= max && !this.lastLlmBySession.has(keepSessionId)) {
      const oldest = this.lastLlmBySession.keys().next().value;
      if (oldest === undefined || oldest === keepSessionId) break;
      this.lastLlmBySession.delete(oldest);
      if (!this.runsBySession.has(oldest)) {
        this.activeRunBySession.delete(oldest);
      }
    }
  }

  private dropSessionObserverState(sessionId: string): void {
    const list = this.runsBySession.get(sessionId);
    if (list) {
      for (const r of list) this.runById.delete(r.runId);
    }
    this.runsBySession.delete(sessionId);
    this.lastLlmBySession.delete(sessionId);
    this.activeRunBySession.delete(sessionId);
  }

  private warn(where: string, err: unknown): void {
    if (!this.config.failOpen) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[octopi:observer] ${where} failed: ${msg}`);
  }
}

function extractPreview(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string })?.type === 'text')
      .map((b) => String((b as { text?: string }).text ?? ''))
      .join('');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** 按 payload 剥离层正文/预览（summary 缺省不进 Hub） */
function stripLayerPayload(
  snapshot: ContextLayersSnapshot,
  payload: ResolvedObserverConfig['payload'],
): ContextLayersSnapshot {
  if (payload.layerContent && payload.layerPreview) return snapshot;
  return {
    ...snapshot,
    layers: snapshot.layers.map((layer) => {
      const next = { ...layer };
      if (!payload.layerContent) delete next.content;
      if (!payload.layerPreview) delete next.preview;
      return next;
    }),
  };
}

function toTimelineNode(event: AgentEvent): RunTimelineEventView | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  return {
    type: event.type,
    timestamp: event.timestamp,
    agentId: event.agentId,
    toolCallId: data.toolCallId as string | undefined,
    toolName: data.toolName as string | undefined,
    hasError: Boolean(data.hasError) || event.type === 'engine.error' || data.error === true,
    durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
    reason: (data.reason ?? data.fallbackError) as string | undefined,
    usage: data.usage as RunTimelineEventView['usage'],
  };
}
