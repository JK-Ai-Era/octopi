/**
 * Memory Extraction — MemoryExtractorBridge
 *
 * 负责把“素材采集”与“子系统触发”串起来：
 * - attach EventBus 后，自动采集 SessionExtractCollector
 * - 在 session 生命周期更新时，满足条件（recent + pending）触发 memory extractor 子系统
 * - 触发时通过 runtime.trigger() 调用，并在输入 payload 中注入 sessionExtractBundle
 *
 * 设计要点：
 * - 本模块是 harness 层胶水，不改变子系统内核
 * - memory extractor 子系统仍由 SubsystemRuntime 管理（生命周期、审计、信号）
 *
 * @module harness/memory/extraction/memory-extractor-bridge
 */

import type { EventBus, Disposable, AgentEvent } from '../../../core/primitives/event-bus.js';
import type { SubsystemRuntime } from '../../autonomous-subsystem/runtime.js';
import { SessionExtractCollector } from './session-extract-collector.js';
import type { ExtractorStore } from './extractor-store.js';
import type { SessionExtractBundle } from './session-extractor.js';

export interface MemoryExtractorBridgeOptions {
  /** 是否自动 attach EventBus（默认 true） */
  autoAttach?: boolean;
  /** 目标子系统 ID（默认 memory.extractor） */
  subsystemId?: string;
  /** 可选：素材持久化 store（JSONL/内存） */
  store?: ExtractorStore;
}

export class MemoryExtractorBridge {
  private events: EventBus;
  private runtime: SubsystemRuntime;
  private collector: SessionExtractCollector;
  private disposables: Disposable[] = [];
  private subsystemId: string;
  private options?: MemoryExtractorBridgeOptions;

  private emit(type: string, data: Record<string, unknown>): void {
    this.events.emit({ type, timestamp: Date.now(), data });
  }

  constructor(events: EventBus, runtime: SubsystemRuntime, options?: MemoryExtractorBridgeOptions) {
    this.events = events;
    this.runtime = runtime;
    this.options = options;
    this.collector = new SessionExtractCollector({ store: options?.store });
    this.subsystemId = options?.subsystemId ?? 'memory.extractor';

    if (options?.autoAttach ?? true) {
      this.attach();
    }
  }

  /** 开始监听并采集（幂等） */
  attach(): void {
    this.collector.attach(this.events);

    this.disposables.push(
      this.events.on('session.lifecycle.updated', (e) => this.onLifecycleUpdated(e)),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.collector.dispose();
  }

  private async loadBundleFromStore(agentId: string, sessionId: string): Promise<SessionExtractBundle | null> {
    if (!this.options?.store) return null;
    try {
      return await this.options.store.loadBundle(agentId, sessionId);
    } catch {
      return null;
    }
  }

  private onLifecycleUpdated(event: AgentEvent): void {
    const sessionId = event.sessionId as string | undefined;
    if (!sessionId) return;

    const data = (event.data ?? {}) as Record<string, unknown>;
    const lifecycle = data.lifecycle as string | undefined;
    const extractionStatus = data.extractionStatus as string | undefined;

    // 触发条件：session 进入 recent 且抽取状态 pending
    if (lifecycle !== 'recent' || extractionStatus !== 'pending') {
      return;
    }

    this.emit('memory.bridge.lifecycle.matched', { sessionId, agentId: event.agentId });
    let bundle = this.collector.buildBundle(sessionId);

    // 从持久化 store 加载（兜底：重启恢复）
    if (!bundle) {
      this.emit('memory.bridge.bundle.miss', { sessionId, agentId: event.agentId });
      this.loadBundleFromStore(event.agentId ?? 'unknown', sessionId).then((loaded) => {
        if (!loaded) return;
        this.emit('memory.bridge.bundle.loaded', { sessionId, agentId: loaded.agentId, eventCount: loaded.events.length });
        this.emitBundleAndTrigger(loaded);
      }).catch(() => {});
      return;
    }

    this.emit('memory.bridge.bundle.hit', { sessionId, agentId: bundle.agentId, eventCount: bundle.events.length });
    this.emitBundleAndTrigger(bundle);
  }

  private emitBundleAndTrigger(bundle: SessionExtractBundle): void {
    const sessionId = bundle.sessionId;

    this.emit('memory.bridge.trigger.start', { sessionId, agentId: bundle.agentId });
    // 将 bundle 注入 runtime 的主上下文，供 input-builder 透传到 SubsystemInput.payload.sessionLifecycle 等字段
    this.runtime.setMainAgentContext({
      messages: [],
      runConfig: { agentId: bundle.agentId, sessionId },
      events: this.events,
    });

    // 为保证子系统能读到 bundle，我们通过 EventBus 发送一个 payload-ready 事件，
    // 由子系统 handler 在 SenseContext.eventData 中读取。
    this.events.emit({
      type: 'memory.extractor.bundle.ready',
      timestamp: Date.now(),
      agentId: bundle.agentId,
      sessionId,
      data: {
        bundle,
      },
    });

    // 触发子系统执行
    this.runtime.trigger(this.subsystemId).then(() => {
      this.emit('memory.bridge.trigger.complete', { sessionId, agentId: bundle.agentId });
    }).catch(() => {
      this.emit('memory.bridge.trigger.error', { sessionId, agentId: bundle.agentId });
    });
  }
}
