/**
 * Autonomous Subsystem — SessionLifecycleBridge
 *
 * 将主会话生命周期状态转化为子系统可感知的事件与指标：
 * - session lifecycle 变更（active/recent/extracted/archived）
 * - 空闲时间（idleMs）
 * - 抽取/处理状态（extractionStatus）
 *
 * 设计为通用桥接层，不做 memory 业务语义；memory-extractor 通过 SenseContext 消费这些状态。
 *
 * @module autonomous-subsystem/sense/session-lifecycle-bridge
 */

import type { EventBus, Disposable, AgentEvent } from '../../../core/primitives/event-bus.js';
import type { MetricsStore } from './metrics.js';
import type {
  SessionLifecycleStatus,
  ProcessExtractionStatus,
  SenseContext,
} from '../types.js';

// ── Options ──

export interface SessionLifecycleBridgeOptions {
  /** 是否开启 idle 指标更新（默认 true） */
  enableIdle?: boolean;
  /** idle 更新间隔（毫秒，默认 15_000） */
  idleTickMs?: number;
}

// ── Session State ──

interface SessionLifecycleState {
  sessionId: string;
  agentId?: string;
  lifecycle?: SessionLifecycleStatus;
  extractionStatus?: ProcessExtractionStatus;
  lastInteractionAt?: number;
}

/**
 * SessionLifecycleBridge
 */
export class SessionLifecycleBridge {
  private events: EventBus;
  private metrics: MetricsStore;
  private disposables: Disposable[] = [];
  private state = new Map<string, SessionLifecycleState>();
  private tick?: ReturnType<typeof setInterval>;
  private enableIdle: boolean;
  private idleTickMs: number;

  constructor(events: EventBus, metrics: MetricsStore, options?: SessionLifecycleBridgeOptions) {
    this.events = events;
    this.metrics = metrics;
    this.enableIdle = options?.enableIdle ?? true;
    this.idleTickMs = options?.idleTickMs ?? 15_000;

    // 订阅通用 session 生命周期事件（由 runner / plugin-manager 等发出）
    this.disposables.push(
      this.events.on('session.lifecycle.updated', (e) => this.onLifecycleUpdated(e)),
    );

    // 订阅 engine.end 以标记 session 最近结束
    this.disposables.push(
      this.events.on('engine.end', (e) => this.onEngineEnd(e)),
    );

    // 可选：轮询计算 idle 指标（不触发子系统，仅更新指标快照）
    if (this.enableIdle) {
      this.tick = setInterval(() => this.refreshIdleMetrics(), this.idleTickMs);
    }
  }

  /** 更新主会话状态（外部调用：Runner / SessionManager / PluginManager） */
  updateState(input: {
    sessionId: string;
    agentId?: string;
    lifecycle?: SessionLifecycleStatus;
    extractionStatus?: ProcessExtractionStatus;
    lastInteractionAt?: number;
  }): void {
    const prev = this.state.get(input.sessionId) ?? { sessionId: input.sessionId };
    const next: SessionLifecycleState = {
      ...prev,
      ...input,
    };
    this.state.set(input.sessionId, next);

    // 更新指标
    this.metrics.update(`session.lifecycle.${next.lifecycle ?? 'unknown'}`, 1);
    if (next.extractionStatus) {
      this.metrics.update(`session.extraction.${next.extractionStatus}`, 1);
    }
  }

  /** 获取某 session 的 SenseContext 片段（供 SenseEngine condition 使用） */
  getSessionSenseContext(sessionId: string): Pick<
    SenseContext,
    'sessionLifecycle' | 'lastInteractionAt' | 'idleMs' | 'extractionStatus'
  > {
    const s = this.state.get(sessionId);
    if (!s) return {};
    return {
      sessionLifecycle: s.lifecycle,
      lastInteractionAt: s.lastInteractionAt,
      idleMs: s.lastInteractionAt ? Date.now() - s.lastInteractionAt : undefined,
      extractionStatus: s.extractionStatus,
    };
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = undefined;
    }
    this.state.clear();
  }

  private onLifecycleUpdated(event: AgentEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const sessionId = (event.sessionId ?? data.sessionId) as string | undefined;
    if (!sessionId) return;

    this.updateState({
      sessionId,
      agentId: (event.agentId ?? data.agentId) as string | undefined,
      lifecycle: data.lifecycle as SessionLifecycleStatus | undefined,
      extractionStatus: data.extractionStatus as ProcessExtractionStatus | undefined,
      lastInteractionAt: data.lastInteractionAt as number | undefined,
    });
  }

  private onEngineEnd(event: AgentEvent): void {
    const sessionId = event.sessionId;
    if (!sessionId) return;

    this.updateState({
      sessionId,
      agentId: event.agentId,
      lastInteractionAt: Date.now(),
    });
  }

  private refreshIdleMetrics(): void {
    // 仅做指标刷新，不做触发；触发由 SenseEngine 条件驱动
    const now = Date.now();
    for (const [, s] of this.state) {
      if (s.lastInteractionAt) {
        const idleMs = now - s.lastInteractionAt;
        this.metrics.update('session.idle.ms', idleMs);
      }
    }
  }
}
