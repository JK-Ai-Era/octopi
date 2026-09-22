/**
 * Gateway — 核心守护进程
 *
 * 三层架构 Integration 层组件。
 * 职责：组装 Agent + 挂载协议适配器 + 管理生命周期。
 *
 * 架构：
 *   外部消息 → Channel Adapter → Gateway → SessionAwareRunner → Agent → LLM
 *
 * 使用方式：
 * ```ts
 * const gateway = new Gateway({ agents: [myAgent] });
 * gateway.registerProvider(openaiProvider);
 * gateway.registerChannel(httpAdapter);
 * gateway.registerTool(myTool);
 * await gateway.start();
 * ```
 */

import type { RegisteredTool, SessionMeta } from '../../core/types.js';
import type { AgentDefinition, ModelConfig } from '../../harness/types/agent-definition.js';
import type { ChannelAdapter, ChannelMessage, ChannelReply } from '../types/channels.js';
import type { GatewayConfig } from '../types/gateway-config.js';

import type { HookContext } from '../../harness/types/hook-context.js';
import type { AgentEvent } from '../../core/primitives/event-bus.js';
import {
  buildContextLayersSnapshot,
  type ContextLayersSnapshot,
} from '../../harness/context/layer-snapshot.js';
import type {
  AssembleManifest,
  ContextLayerId,
} from '../../harness/context/layer-types.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { Observer } from '../../core/interfaces/observer.js';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../../harness/session-types.js';
import type { StreamingChannelAdapter } from '../protocols/http.js';
import type { Message } from '../../core/types.js';
import { randomUUID } from 'node:crypto';
import { CircuitBreaker } from '../../harness/reliability/circuit-breaker.js';
import { wrapProviderWithCircuitBreaker } from '../../harness/reliability/provider-wrapper.js';
import { resolveModel, resolveModelRef, resolveCatalogEntry, parseModelRef } from '../../harness/model/index.js';
import { PluginManager } from '../../harness/plugin-ecosystem/plugins/manager.js';

import { DefaultEventBus } from '../../core/primitives/event-bus.js';
import { DefaultSecurityGuard } from '../../harness/security/default-security-guard.js';
import { SessionAwareRunner } from '../../harness/runner.js';
import { AgentRuntime, SessionRunnerDispatcher, ExplicitRouter } from '../../harness/agent-runtime/index.js';
import { dispatchChannelMessage } from '../agent-runtime/channel-message-source.js';
import { SessionAclService } from '../../harness/session-acl/service.js';
import { InProcessSessionLock } from '../../harness/concurrency/session-lease.js';
import { ObserverHub } from '../../harness/observer/hub.js';
import type {
  RunMessagesSnapshot,
  RunObservatorySnapshot,
} from '../../harness/observer/types.js';

// Web REST 骨架所需的 Gateway 扩展类型
// ================================================================

/** Pending approval 请求载荷 */
export interface PendingApprovalRequest {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  riskDescription: string;
  actionDescription: string;
}

/** Pending approval 视图 */
export interface PendingApprovalView {
  id: string;
  sessionId: string;
  agentId: string;
  request: PendingApprovalRequest;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  updatedAt?: number;
  decidedAt?: number;
  decisionReason?: string;
}

/** WebUI 模型目录条目（与 harness/model ModelCatalogEntry 对齐） */
export interface ModelCatalogItem {
  id: string;
  provider: string;
  model: string;
  /** 未配置时为 null（未知，不猜测） */
  contextWindow: number | null;
  maxOutputTokens?: number;
  known: boolean;
  source: string;
}

/** Agent 默认模型摘要 */
export interface AgentModelSummary {
  agentId: string;
  /** agent 配置的默认模型 id（`provider/model`） */
  defaultModelId: string;
}

/** WebUI 模型目录 */
export interface ModelCatalog {
  models: ModelCatalogItem[];
  agents: AgentModelSummary[];
  /** models.level 分级名（mini/standard/pro 等） */
  levels?: Record<string, { primary: string; fallback?: string[] }>;
}

/** session 模型选择结果 */
export interface SessionModelView {
  sessionId: string;
  agentId: string;
  /** 当前生效模型 id；null 表示沿用 agent 默认 */
  modelId: string | null;
  defaultModelId: string;
  /** 当前生效模型的能力快照（UI 只读，禁止再猜窗口） */
  resolved?: ModelCatalogItem;
}

// ================================================================
// 默认 Session Store（OCTOPI_HOME/sessions）
// ================================================================

/**
 * 无显式 store 时，在 OCTOPI_HOME/sessions 创建持久化 JSONL store。
 */
async function createDefaultStore(_agents: AgentDefinition[]): Promise<SessionStore<SessionData>> {
  const { getOctopiHome } = await import('../../init.js');
  const { join } = await import('node:path');
  const { JsonlSessionStore } = await import('../storage/jsonl.js');
  return new JsonlSessionStore({
    sessionsDir: join(getOctopiHome(), 'sessions'),
  });
}

export class Gateway {
  /** 已注册的 Agent */
  private agents = new Map<string, AgentDefinition>();
  /** 已注册的 Channel Adapter */
  private channels = new Map<string, ChannelAdapter>();
  /** Plugin Manager */
  private pluginManager: PluginManager;
  /** Session Store */
  private store!: SessionStore<SessionData>;
  /** Gateway 配置 */
  private config: GatewayConfig;
  /** DM 作用域 */
  private dmScope: string;
  /** 是否已启动 */
  private started = false;
  /** 事件监听器 */
  private listeners: Array<(event: AgentEvent) => void> = [];
  /** Provider */
  private providers = new Map<string, ModelProvider>();
  /** 工具 */
  private tools: RegisteredTool[] = [];
  /** Agent 缓存（避免每条消息重建） */
  private agentCache = new Map<string, {
    agent: import('../../harness/agent/index.js').Agent;
    runner: SessionAwareRunner;
    contextEngine?: import('../../harness/context/types.js').ContextEngine;
    contextHealth?: (agentId?: string) => Promise<import('../../harness/context/layer-health.js').ContextLayerHealth>;
  }>();
  /** 流式 adapter 引用（用于广播事件） */
  private streamingAdapters: StreamingChannelAdapter[] = [];
  /** 每个 provider 的熔断器 */
  private circuitBreakers = new Map<string, CircuitBreaker>();
  /** 默认 store 的异步初始化 Promise（未传入 store 时） */
  private _defaultStorePromise?: Promise<SessionStore<SessionData>>;
  /** Web Runtime pending approvals */
  private pendingApprovals = new Map<string, PendingApprovalView>();
  /** 会话最近一次七层装配快照（含 content，仅 REST）；FIFO 防泄漏 */
  private lastContextLayers = new Map<string, ContextLayersSnapshot>();
  private static readonly MAX_CONTEXT_LAYERS_SESSIONS = 256;
  /** 产品 Observer 通道（Run 现场） */
  private observerHub: ObserverHub;
  /** models.level — 供 WebUI 模型目录展示分级名 */
  private modelLevels?: Record<string, { primary: string; fallback?: string[] }>;
  /** 激活宿主（arch/agent-runtime.md）；消息路径经 dispatch */
  private runtime: AgentRuntime;
  private gatewayBus: DefaultEventBus;
  /** Session ACL（E6）；缺省内置五角色 */
  private sessionAcl: SessionAclService;
  /** 进程内共享 Session Lease（E1/E2）：所有 Runner 注入同一实例 */
  private sessionLease: import('../../harness/concurrency/session-lease.js').InProcessSessionLock;

  constructor(config: GatewayConfig, store?: SessionStore<SessionData>) {
    this.config = config;
    this.dmScope = config.session?.dmScope ?? 'main';
    this.pluginManager = new PluginManager();
    this.sessionAcl = new SessionAclService(config.sessionAcl);
    this.sessionLease = new InProcessSessionLock();
    // Gateway EventBus：RuntimeEvents 进可观测总线，并转发到 Gateway listeners（不变量 #6）
    this.gatewayBus = new DefaultEventBus();
    this.observerHub = new ObserverHub(config.observer);
    this.runtime = new AgentRuntime({
      router: new ExplicitRouter(),
      events: this.gatewayBus,
      defaultCoalesceMs: config.agentRuntime?.coalesceWindowMs,
      coalesceBufferLimit: config.agentRuntime?.coalesceBufferLimit,
      admission: {
        expectedMaxConcurrentRuns: config.agentRuntime?.expectedMaxConcurrentRuns,
      },
    });
    this.gatewayBus.onAll((event) => {
      this.emitEvent(event);
      if (event.type === 'context.layers.assembled' && event.sessionId) {
        this.rememberContextLayers(event.sessionId, event);
      }
      // Observer 通道：Runner 在 emit 时直采 Hub（避免与 bus 双计 timeline/lifecycle）
      // Gateway 只保留产品 Context Map；不再二次 ingestEvent
      // 终态事件（turn.end / engine.*）改由 processMessage.onEvent 用 sessionKey 广播，
      // 这里跳过，避免双投；其余非流式事件仍走 bus。
      if (
        event.sessionId &&
        event.type !== 'llm_stream_delta' &&
        !Gateway.isTerminalWsEvent(event.type)
      ) {
        // WS 不广播层正文全文（content）；点选层时 UI 经 REST 拉取
        const out =
          event.type === 'context.layers.assembled'
            ? stripLayerContentFromEvent(event)
            : event;
        for (const adapter of this.streamingAdapters) {
          adapter.broadcastEvent(event.sessionId, out as never);
        }
      }
    });
    if (store) {
      this.store = store;
    } else {
      // 延迟初始化：启动时解析默认持久化 store
      this._defaultStorePromise = createDefaultStore(config.agents);
    }

    // 注册配置中定义的 agents
    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
    }

    this.modelLevels = config.levels;
  }

  /** 设置 models.level 映射（daemon 启动时注入） */
  setModelLevels(levels: Record<string, { primary: string; fallback?: string[] }> | undefined): void {
    this.modelLevels = levels;
  }

  /** 激活宿主（Schedule/Escalate 等 Source 挂载用） */
  getAgentRuntime(): AgentRuntime {
    return this.runtime;
  }

  /**
   * 按配置挂载 Runtime Sources（Schedule / Escalate）。
   * 应在 start() 之前调用；与 gatewayBus 同源。
   */
  async configureAgentRuntime(cfg: {
    schedule?: Array<{
      agentId: string;
      sessionId?: string;
      intervalMs?: number;
      cron?: string;
      content: string;
      coalesceKey?: string;
      runOnStart?: boolean;
    }>;
    escalate?: { defaultAgentId?: string; eventType?: string | string[] };
    /** 挂载 AgentSignalSource（多 Agent 通知） */
    agentSignal?: boolean;
  }): Promise<void> {
    if (cfg.schedule && cfg.schedule.length > 0) {
      const { ScheduleSource } = await import('../../harness/agent-runtime/sources/schedule.js');
      this.runtime.addSource(
        new ScheduleSource({
          jobs: cfg.schedule.map((job) => ({
            agentId: job.agentId,
            sessionId: job.sessionId,
            intervalMs: job.intervalMs,
            cron: job.cron,
            coalesceKey: job.coalesceKey,
            runOnStart: job.runOnStart,
            payload: { kind: 'system_note', content: job.content },
            metadata: { source: 'config.schedule' },
          })),
        }),
      );
      console.log(`[Gateway] AgentRuntime ScheduleSource: ${cfg.schedule.length} job(s)`);
    }
    if (cfg.escalate) {
      const { EscalateBridge } = await import(
        '../../harness/agent-runtime/sources/escalate-bridge.js'
      );
      this.runtime.addSource(
        new EscalateBridge({
          events: this.gatewayBus,
          defaultAgentId: cfg.escalate.defaultAgentId,
          eventType: cfg.escalate.eventType,
        }),
      );
      console.log(
        `[Gateway] AgentRuntime EscalateBridge (defaultAgentId=${cfg.escalate.defaultAgentId ?? 'n/a'})`,
      );
    }
    if (cfg.agentSignal) {
      const { AgentSignalSource } = await import(
        '../../harness/agent-runtime/sources/agent-signal.js'
      );
      this.runtime.addSource(new AgentSignalSource({ events: this.gatewayBus }));
      console.log('[Gateway] AgentRuntime AgentSignalSource');
    }
  }

  // ================================================================
  // 生命周期
  // ================================================================


  /**
   * 确保 store 已就绪（解析默认 store 的异步初始化）
   */
  private async ensureStore(): Promise<void> {
    if (this._defaultStorePromise) {
      this.store = await this._defaultStorePromise;
      this._defaultStorePromise = undefined;
    }
  }

  async start(): Promise<void> {
    await this.ensureStore();

    if (this.started) {
      console.warn('[Gateway] Already started');
      return;
    }

    console.log('[Gateway] Starting...');
    console.log(`[Gateway] Agents: ${Array.from(this.agents.keys()).join(', ') || '(none)'}`);
    console.log(`[Gateway] Channels: ${Array.from(this.channels.keys()).join(', ') || '(none)'}`);

    for (const [name, adapter] of this.channels) {
      console.log(`[Gateway] Starting channel: ${name}`);
      await adapter.start(async (msg) => {
        await this.handleInboundMessage(msg);
      });
    }

    await this.runtime.start();
    this.started = true;
    console.log(`[Gateway] Ready. ${this.agents.size} agent(s), ${this.channels.size} channel(s)`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    console.log('[Gateway] Stopping...');
    for (const [name, adapter] of this.channels) {
      console.log(`[Gateway] Stopping channel: ${name}`);
      await adapter.stop();
    }

    await this.runtime.stop();
    await this.pluginManager.onGatewayStop();
    this.started = false;
    console.log('[Gateway] Stopped.');
  }

  // ================================================================
  // 注册接口
  // ================================================================

  registerAgent(agent: AgentDefinition): void {
    this.agents.set(agent.id, agent);
    console.log(`[Gateway] Registered agent: ${agent.id}`);
  }

  registerChannel(adapter: ChannelAdapter): void {
    this.channels.set(adapter.name, adapter);
    // 检测是否支持流式广播
    if ('broadcastEvent' in adapter && typeof adapter.broadcastEvent === 'function') {
      this.streamingAdapters.push(adapter as StreamingChannelAdapter);
    }
    // 注册中止回调
    if ('onAbort' in adapter) {
      (adapter as any).onAbort = (sessionId: string) => this.abortSession(sessionId);
    }
    // 注册欢迎消息扩展（提供 Gateway agent 信息）
    if ('onWelcome' in adapter) {
      (adapter as any).onWelcome = () => {
        const agents = Array.from(this.agents.entries()).map(([id, agent]) => ({
          id,
          model: agent.model,
        }));
        return { agents };
      };
    }
    console.log(`[Gateway] Registered channel: ${adapter.name}`);
  }

  registerTool(tool: RegisteredTool, agentId?: string): void {
    this.tools.push(tool);
  }

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
    console.log(`[Gateway] Registered provider: ${provider.name}`);
  }

  on(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  getPluginManager(): PluginManager {
    return this.pluginManager;
  }

  /**
   * 中止指定 session 的正在运行的 agent
   * 归属：Runtime 持有 AbortController；Gateway 转调（arch/agent-runtime.md §8.1）
   */
  abortSession(sessionId: string): void {
    for (const agentId of this.agents.keys()) {
      this.runtime.abort(agentId, sessionId);
    }
  }

  // ================================================================
  // Web Runtime: read/write surface for REST skeleton
  // ================================================================

  getRegisteredAgents(): Array<{ id: string; model: ModelConfig }> {
    return Array.from(this.agents.entries()).map(([id, agent]) => ({ id, model: agent.model }));
  }

  /**
   * WebUI 模型目录
   *
   * @returns 已注册 provider 的全部模型 + agent 默认模型 + level 映射
   */
  getModelCatalog(): ModelCatalog {
    const seen = new Map<string, ModelCatalogItem>();
    const models: ModelCatalogItem[] = [];

    const push = (entry: ModelCatalogItem, opts?: { preferAgentExplicit?: boolean }) => {
      const prev = seen.get(entry.id);
      if (prev) {
        // agent 默认模型的配置窗口优先（与 session model 视图一致）
        if (opts?.preferAgentExplicit && entry.known && entry.contextWindow != null) {
          seen.set(entry.id, entry);
          const idx = models.findIndex(m => m.id === entry.id);
          if (idx >= 0) models[idx] = entry;
        }
        return;
      }
      seen.set(entry.id, entry);
      models.push(entry);
    };

    const catalogOf = (
      providerName: string,
      modelName: string,
      explicit?: { contextWindow?: number; maxOutputTokens?: number },
    ): ModelCatalogItem => {
      const e = resolveCatalogEntry({
        providerName,
        modelName,
        providers: this.providers,
        explicit,
      });
      return {
        id: e.id,
        provider: e.provider,
        model: e.model,
        contextWindow: e.contextWindow,
        maxOutputTokens: e.maxOutputTokens,
        known: e.known,
        source: e.source,
      };
    };

    for (const [providerName, provider] of this.providers) {
      // provider.models 含纯字符串模型（无能力字段）；必须入 catalog，窗口可为 null
      const declaredNames = provider.models ?? [];
      const names = new Set<string>([
        ...declaredNames,
        ...(provider.defaultModel ? [provider.defaultModel] : []),
      ]);
      for (const name of names) {
        push(catalogOf(providerName, name));
      }
      for (const info of provider.getModelInfos()) {
        push(catalogOf(providerName, info.name, {
          contextWindow: info.contextWindow,
          maxOutputTokens: info.maxOutputTokens,
        }));
      }
    }

    const agents: AgentModelSummary[] = [];
    for (const [id, agent] of this.agents) {
      const defaultModelId = `${agent.model.provider}/${agent.model.model}`;
      // agent 配置的 explicit 窗口优先于 provider 无能力条目
      push(catalogOf(agent.model.provider, agent.model.model, {
        contextWindow: agent.model.contextWindow,
        maxOutputTokens: agent.model.maxTokens,
      }), { preferAgentExplicit: true });
      agents.push({ agentId: id, defaultModelId });
    }

    models.sort((a, b) => a.id.localeCompare(b.id));
    return {
      models,
      agents,
      ...(this.modelLevels ? { levels: this.modelLevels } : {}),
    };
  }

  /**
   * 查询 session 当前模型选择
   *
   * @param sessionId - 会话 id
   * @param agentId - 可选 agent 过滤
   * @returns 模型视图；session 不存在时返回 null
   */
  async getSessionModel(sessionId: string, _agentId?: string): Promise<SessionModelView | null> {
    const session = await this.store.load(sessionId);
    if (!session) return null;
    return this.buildSessionModelView(session);
  }

  private buildSessionModelView(session: SessionData): SessionModelView {
    const agent = this.agents.get(session.agentId);
    const defaultModelId = agent
      ? `${agent.model.provider}/${agent.model.model}`
      : '';
    const modelId = this.readSessionModelId(session.metadata);
    const effectiveId = modelId ?? defaultModelId;
    const resolved = effectiveId
      ? this.catalogItemForRef(effectiveId, agent)
      : undefined;
    return {
      sessionId: session.id,
      agentId: session.agentId,
      modelId,
      defaultModelId,
      resolved,
    };
  }

  private catalogItemForRef(
    modelRef: string,
    agent: AgentDefinition | undefined,
  ): ModelCatalogItem | undefined {
    const parsed = parseModelRef(modelRef, agent?.model.provider);
    const providerName = parsed.provider ?? agent?.model.provider;
    if (!providerName) return undefined;
    const isDefault = agent
      ? modelRef === `${agent.model.provider}/${agent.model.model}`
      || parsed.model === agent.model.model
      : false;
    const e = resolveCatalogEntry({
      providerName,
      modelName: parsed.model,
      providers: this.providers,
      explicit: isDefault
        ? {
            contextWindow: agent?.model.contextWindow,
            maxOutputTokens: agent?.model.maxTokens,
          }
        : undefined,
    });
    return {
      id: e.id,
      provider: e.provider,
      model: e.model,
      contextWindow: e.contextWindow,
      maxOutputTokens: e.maxOutputTokens,
      known: e.known,
      source: e.source,
    };
  }

  /**
   * 设置 session 级模型选择
   *
   * @param sessionId - 会话 id
   * @param modelRef - `provider/model`、裸模型名或 null（恢复 agent 默认）
   * @param agentId - 可选 agent
   * @returns 更新后的模型视图
   */
  async setSessionModel(
    sessionId: string,
    modelRef: string | null,
    _agentId?: string,
  ): Promise<SessionModelView> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const agent = this.agents.get(session.agentId);
    const defaultProvider = agent?.model.provider;
    const defaultModelId = agent
      ? `${agent.model.provider}/${agent.model.model}`
      : '';

    if (modelRef === null || modelRef === '') {
      delete session.metadata.model;
    } else {
      const parsed = parseModelRef(modelRef, defaultProvider);
      const providerName = parsed.provider ?? defaultProvider;
      if (!providerName) {
        throw new Error(`Cannot resolve provider for model "${modelRef}"`);
      }
      const provider = this.providers.get(providerName);
      if (!provider) {
        throw new Error(`LLM provider "${providerName}" not found`);
      }
      // 规范化存储为 provider/model
      session.metadata.model = {
        provider: providerName,
        model: parsed.model,
      };
    }

    session.meta.updatedAt = Date.now();
    await this.store.save(session.id, session);

    return this.buildSessionModelView(session);
  }

  private readSessionModelId(metadata: Record<string, unknown> | undefined): string | null {
    const raw = metadata?.model;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (raw && typeof raw === 'object') {
      const obj = raw as { provider?: unknown; model?: unknown };
      if (typeof obj.model === 'string' && obj.model) {
        return typeof obj.provider === 'string' && obj.provider
          ? `${obj.provider}/${obj.model}`
          : obj.model;
      }
    }
    return null;
  }

  /**
   * 手动结构压缩（不依赖 contextWindow）
   *
   * 与 SessionAwareRunner.handle **共用 session 锁**（E1/E4）。
   * 权威互斥是锁，不是 status==='processing'；同 sessionId 的 run/compact 排队。
   * Compact 键 = (sessionId, agentId)；全量 messages 仍保留在 session store。
   *
   * @param sessionId - 会话 id
   * @param agentId - 可选 agent（避免全 agent 扫描；缺省用 session.agentId）
   * @returns 压缩结果
   */
  async compactSession(
    sessionId: string,
    agentId?: string,
  ): Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    tokensBefore: number;
    tokensAfter?: number;
    summary?: string;
  }> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    // E4：compact 键使用调用方 agentId（缺省 primary）；不静默改键
    const effectiveAgentId = agentId ?? session.primaryAgentId ?? session.agentId;
    let cached = this.agentCache.get(effectiveAgentId);
    if (!cached) {
      const def = this.agents.get(effectiveAgentId);
      if (!def) {
        throw new Error(`Agent "${effectiveAgentId}" not found`);
      }
      cached = await this.buildAgent(def);
      this.agentCache.set(effectiveAgentId, cached);
    }

    const engine = cached.contextEngine;
    type StructuralEngine = {
      compactStructural?: (input: {
        sessionId: string;
        agentId?: string;
        messages: import('../../core/types.js').Message[];
        summarize?: (messages: import('../../core/interfaces/model-provider.js').LLMMessage[], opts?: { maxTokens?: number }) => Promise<string>;
        compactTargetTokens?: number;
      }) => Promise<{
        ok: boolean;
        compacted: boolean;
        reason?: string;
        tokensBefore: number;
        tokensAfter?: number;
        summary?: string;
      }>;
    };
    const structural = engine as StructuralEngine | undefined;

    if (!structural?.compactStructural) {
      return {
        ok: false,
        compacted: false,
        reason: 'context engine does not support structural compact',
        tokensBefore: 0,
      };
    }

    const agentDef = this.agents.get(effectiveAgentId);
    const modelRef = this.readSessionModelId(session.metadata);
    const { createProviderSummarize } = await import('../../harness/context/summarize.js');
    const { resolveModelRef } = await import('../../harness/model/index.js');
    type SummarizeFn = (messages: import('../../core/interfaces/model-provider.js').LLMMessage[], opts?: { maxTokens?: number }) => Promise<string>;

    let summarize: SummarizeFn | undefined;
    const bound = modelRef
      ? resolveModelRef(modelRef, {
          providers: this.providers,
          defaultProvider: agentDef?.model.provider,
          isOverride: true,
        })
      : agentDef
        ? resolveModelRef(`${agentDef.model.provider}/${agentDef.model.model}`, {
            providers: this.providers,
            isOverride: false,
          })
        : null;
    if (bound) {
      summarize = createProviderSummarize(bound.provider);
    }

    const compactTargetTokens =
      this.config.context?.contextAssembler?.compactTargetTokens;

    // D1：与 handle 共用 Runner session 锁；持久化走 Runner（E4 键）
    return cached.runner.compactSession(sessionId, effectiveAgentId, {
      compactStructural: (input) =>
        structural.compactStructural!({
          sessionId: input.sessionId,
          agentId: input.agentId,
          messages: input.messages,
          summarize: input.summarize,
          compactTargetTokens: input.compactTargetTokens,
        }),
      summarize,
      compactTargetTokens,
    });
  }

  getProviderSummaries(): Array<{ name: string; circuitBreaker: { state: string; failureCount: number } }> {
    const result: Array<{ name: string; circuitBreaker: { state: string; failureCount: number } }> = [];
    for (const [name] of this.providers) {
      const cb = this.circuitBreakers.get(name);
      result.push({ name, circuitBreaker: cb ? cb.snapshot() : { state: 'closed', failureCount: 0 } });
    }
    return result;
  }

  async listSessions(agentId?: string): Promise<SessionMeta[]> {
    return this.store.list(agentId ? { agentId } : undefined);
  }

  async createSession(options: { agentId: string; sessionId?: string; metadata?: Record<string, unknown> }): Promise<SessionMeta> {
    const agent = this.agents.get(options.agentId);
    if (!agent) {
      throw new Error(`Agent "${options.agentId}" not found`);
    }

    // 文件系统安全：避免 `:` 等字符（Windows 文件名非法）
    const sessionId = options.sessionId ?? `${options.agentId}-web-${Date.now()}`;
    const session: SessionData = {
      id: sessionId,
      agentId: options.agentId,
      primaryAgentId: options.agentId,
      meta: {
        id: sessionId,
        agentId: options.agentId,
        channelId: 'web',
        peerId: 'web-ui',
        status: 'idle',
        createdAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        updatedAt: Date.now(),
      },
      messages: [],
      turns: [],
      metadata: options.metadata ?? {},
      tasks: [],
    };

    await this.store.save(sessionId, session);
    return session.meta;
  }


  /**
   * 查找 session（sessionId 一等；无需遍历 agent）
   */
  private async findSession(sessionId: string): Promise<SessionData | null> {
    return this.store.load(sessionId);
  }

  async getSessionView(sessionId: string, _agentId?: string): Promise<{ meta: SessionMeta; messageCount: number; turnCount: number; taskCount?: number } | null> {
    const session = await this.store.load(sessionId);
    if (!session) return null;
    return {
      meta: session.meta,
      messageCount: session.messages.length,
      turnCount: session.turns.length,
      taskCount: session.tasks?.length ?? 0,
    };
  }

  /**
   * 会话任务列表（只读，供 UI）
   */
  async getSessionTasks(sessionId: string, _agentId?: string): Promise<SessionData['tasks']> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    return (session.tasks ?? []).map((t) => ({ ...t }));
  }

  async getSessionMessages(sessionId: string, options: { limit: number; cursor?: string; agentId?: string }): Promise<{ messages: Message[]; nextCursor?: string }> {
    const session = await this.store.load(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    const offset = options.cursor ? Number(Buffer.from(options.cursor, 'base64').toString('utf-8')) : 0;
    const slice = session.messages.slice(offset, offset + options.limit);
    const nextOffset = offset + slice.length;
    const nextCursor = nextOffset < session.messages.length ? Buffer.from(String(nextOffset)).toString('base64') : undefined;

    return { messages: slice, nextCursor };
  }

  async getMemoryStats(): Promise<Record<string, unknown> | null> {
    // 预留：当前 Gateway 未持有 MemoryStore，返回 null 表示未配置。
    return null;
  }

  /**
   * 读取会话最近一次七层装配快照（产品 Context 面板）
   *
   * 所有权：Gateway Map = 产品路径（与 observer.level 无关，始终写入）；
   * ObserverHub 在 observer 开启时另行快照（Run 观测）。
   *
   * @param sessionId - 会话 id
   * @returns 快照；尚未装配过则为 null
   */
  getSessionContextLayers(sessionId: string): ContextLayersSnapshot | null {
    return this.lastContextLayers.get(sessionId) ?? null;
  }

  /**
   * 产品 Observer Hub（Run 观测）
   */
  getObserverHub(): ObserverHub {
    return this.observerHub;
  }

  /**
   * 会话最近一次 Run 观测投影
   *
   * @param sessionId - 会话 id
   * @returns RunObservatorySnapshot；无记录或面板关闭时 null
   */
  getSessionRunObservatory(sessionId: string): RunObservatorySnapshot | null {
    return this.observerHub.getRunObservatory(sessionId);
  }

  /**
   * Run messages 快照（摘要 + 配置允许时的全文）
   *
   * @param sessionId - 会话 id
   * @param options - phase / runId
   * @returns 快照或 null
   */
  getSessionRunMessages(
    sessionId: string,
    options?: { phase?: 'entry' | 'final' | 'llm'; runId?: string; view?: 'workspace' | 'llm' },
  ): RunMessagesSnapshot | null {
    return this.observerHub.getRunMessages(sessionId, options);
  }

  /**
   * 读取 Agent 七层数据面健康（store 计数）
   *
   * 优先：已 build 的 contextHealth probe
   * 回退：按 agent.home 直接扫 skills / agent.db（不依赖懒构建）
   *
   * @param agentId - Agent id
   * @returns 健康快照
   */
  async getAgentContextHealth(agentId: string): Promise<import('../../harness/context/layer-health.js').ContextLayerHealth> {
    const cached = this.agentCache.get(agentId);
    if (cached?.contextHealth) {
      return cached.contextHealth(agentId);
    }
    const def = this.agents.get(agentId);
    if (def?.home) {
      const { probeAgentHomeHealth } = await import('../../harness/context/layer-health.js');
      return probeAgentHomeHealth(agentId, def.home);
    }
    const { probeContextLayerHealth } = await import('../../harness/context/layer-health.js');
    return probeContextLayerHealth({ agentId, personaLoaded: false });
  }

  /**
   * 产品 Context 面板路径：始终写入 Map（与 observer.level 无关）。
   *
   * Observer Hub 采样归 **Runner.emitObserved**（以及 Builder ContextEngine emit 回调）；
   * Gateway **不要**再 `hub.ingestEvent`，否则 timeline/lifecycle 会双计。
   */
  private rememberContextLayers(sessionId: string, event: AgentEvent): void {
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
    if (
      !this.lastContextLayers.has(sessionId) &&
      this.lastContextLayers.size >= Gateway.MAX_CONTEXT_LAYERS_SESSIONS
    ) {
      const oldest = this.lastContextLayers.keys().next().value;
      if (oldest !== undefined) this.lastContextLayers.delete(oldest);
    }
    this.lastContextLayers.set(
      sessionId,
      buildContextLayersSnapshot({
        manifest: data.manifest,
        enabledLayerIds: data.enabledLayerIds,
        query: data.query,
        assembledAt: data.assembledAt ?? event.timestamp,
        fallback: data.fallback,
        fallbackError: data.fallbackError,
      }),
    );
  }

  async queryMemory(_options: { q: string; limit: number }): Promise<Record<string, unknown> | null> {
    return null;
  }

  listPendingApprovals(): PendingApprovalView[] {
    return Array.from(this.pendingApprovals.values());
  }

  createPendingApproval(input: { sessionId: string; agentId: string; request: PendingApprovalRequest }): PendingApprovalView {
    const view: PendingApprovalView = {
      id: randomUUID().slice(0, 8),
      sessionId: input.sessionId,
      agentId: input.agentId,
      request: input.request,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.pendingApprovals.set(view.id, view);
    return view;
  }

  resolvePendingApproval(approvalId: string, input: { action: 'approve' | 'reject'; reason?: string }): PendingApprovalView | null {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) return null;

    const now = Date.now();
    approval.status = input.action === 'approve' ? 'approved' : 'rejected';
    approval.decisionReason = input.reason;
    approval.decidedAt = now;
    approval.updatedAt = now;

    return approval;
  }

  // ================================================================
  // 核心消息处理
  // ================================================================

  async send(message: ChannelMessage): Promise<void> {
    await this.handleInboundMessage(message);
  }

  getSession(sessionId: string): SessionMeta | undefined {
    // 简化的 session 查询（通过 store）
    return undefined;
  }

  // ================================================================
  // 内部
  // ================================================================

  private async handleInboundMessage(msg: ChannelMessage): Promise<void> {
    console.log(`[Gateway] Inbound message from ${msg.channel}:${msg.senderId} — "${msg.content.substring(0, 50)}..."`);

    // 1. 找到 agent
    const agent = this.resolveAgent(msg);
    if (!agent) {
      console.warn(`[Gateway] No agent resolved for message from ${msg.channel}:${msg.senderId}`);
      return;
    }

    // 2. Plugin: message_received
    const sessionKey = this.buildSessionKey(agent, msg);
    await this.pluginManager.runAllHooks(
      'message_received',
      { sessionId: sessionKey, agentId: agent.id, message: msg },
    );

    // 3. 获取或构建 Agent + SessionAwareRunner，并注册进 Runtime
    let cached = this.agentCache.get(agent.id);
    if (!cached) {
      cached = await this.buildAgent(agent);
      this.agentCache.set(agent.id, cached);
    }
    const { runner } = cached;

    // 确保 Runtime 已注册该 agent 的 dispatcher
    if (!this.runtime.listAgents().some((a) => a.agentId === agent.id)) {
      await this.registerRuntimeAgent(agent, runner);
    }

    // 4–5. 经激活宿主执行（模型 A）；onEvent 做流式广播（不变量 #6）
    let finalContent = '';
    const dispatchResult = await dispatchChannelMessage({
      runtime: this.runtime,
      msg,
      resolveAgentId: () => agent.id,
      resolveSessionId: () => sessionKey,
      onEvent: (event) => {
        // Runner：llm_stream_delta 只 yield（不进 bus）；其余事件还会 emit 到 gatewayBus。
        // 流式 delta + 终态必须用闭包 sessionKey 广播：
        // - delta 不在 bus 上
        // - 终态若只靠 bus 的 event.sessionId，匹配失败时 UI 会永远停在 streaming
        if (event.type === 'llm_stream_delta') {
          this.emitEvent(event as unknown as AgentEvent);
          for (const adapter of this.streamingAdapters) {
            adapter.broadcastEvent(sessionKey, event as unknown as AgentEvent);
          }
        } else if (Gateway.isTerminalWsEvent(event.type)) {
          for (const adapter of this.streamingAdapters) {
            adapter.broadcastEvent(sessionKey, event as unknown as AgentEvent);
          }
        }
        if (event.type === 'turn.end' && event.data?.content) {
          finalContent = event.data.content as string;
        }
      },
    });

    if (dispatchResult.status === 'failed') {
      const err =
        'error' in dispatchResult
          ? dispatchResult.error
          : dispatchResult.results
              .map((r) => `${r.agentId}:${r.result.status}`)
              .join(',');
      console.error(`[Gateway] Error processing message:`, err);
      finalContent = `[Gateway Error] ${err}`;
    } else if (dispatchResult.status === 'skipped') {
      console.warn(`[Gateway] Dispatch skipped: ${dispatchResult.reason}`);
    }

    // 6. Plugin: message_sending
    const hookCtx: HookContext = { sessionId: sessionKey, agentId: agent.id };
    const channelReply: ChannelReply = {
      channel: msg.channel,
      conversationId: msg.conversationId,
      content: finalContent,
      replyToId: msg.id,
    };

    const sendBlock = await this.pluginManager.runHook<{ cancel?: boolean } | null>(
      'message_sending',
      { ...hookCtx, reply: channelReply },
      null,
    );

    if (sendBlock?.cancel) {
      console.log(`[Gateway] Reply cancelled by plugin`);
      return;
    }

    // 7. 发送回复
    const adapter = this.channels.get(msg.channel);
    if (adapter && channelReply.content) {
      await adapter.send(channelReply);
      await this.pluginManager.runAllHooks('message_sent', { ...hookCtx, reply: channelReply });
    }
  }

  private async registerRuntimeAgent(
    agent: AgentDefinition,
    runner: SessionAwareRunner,
  ): Promise<void> {
    // 仅内联 persona 写入 defaults；文件式 persona 由 runner 的 resolver 每轮解析
    const runSystemPrompt =
      typeof agent.persona === 'object' ? agent.persona?.systemPrompt ?? '' : '';
    let contextWindow = agent.model.contextWindow;
    if (!contextWindow) {
      const provider = this.providers.get(agent.model.provider);
      contextWindow = provider?.getModelInfo(agent.model.model)?.contextWindow;
    }

    this.runtime.registerAgent({
      agentId: agent.id,
      dispatcher: new SessionRunnerDispatcher({
        runner,
        // 不要把 agent 默认 model 写入 defaults：
        // RunConfig.model 只表示**消息级**覆盖；会话覆盖在 session.metadata.model
        runConfigDefaults: {
          agentId: agent.id,
          contextWindow,
          systemPrompt: runSystemPrompt,
        },
      }),
      resolveSession: (trigger) => trigger.sessionId ?? `${agent.id}:main`,
    });
  }

  /**
   * 为 Agent 构建 Agent + SessionAwareRunner（新架构）
   */
  private async buildAgent(agent: AgentDefinition): Promise<{
    agent: import('../../harness/agent/index.js').Agent;
    runner: SessionAwareRunner;
    contextEngine?: import('../../harness/context/types.js').ContextEngine;
    contextHealth?: (agentId?: string) => Promise<import('../../harness/context/layer-health.js').ContextLayerHealth>;
  }> {
    // 获取主 provider，并解析 agent 默认模型快照（含熔断包装）
    const rawProvider = this.providers.get(agent.model.provider);
    if (!rawProvider) {
      throw new Error(`LLM provider "${agent.model.provider}" not found.`);
    }
    const defaultSnapshot = resolveModel({
      providerName: agent.model.provider,
      modelName: agent.model.model,
      providers: this.providers,
      explicit: {
        contextWindow: agent.model.contextWindow,
        maxOutputTokens: agent.model.maxTokens,
      },
      isOverride: false,
      wrapProvider: (p, name) => wrapProviderWithCircuitBreaker(p, this.getCircuitBreaker(name)),
    });
    if (!defaultSnapshot) {
      throw new Error(`LLM provider "${agent.model.provider}" not found.`);
    }
    const wrappedProvider: ModelProvider = defaultSnapshot.provider;

    // 如果配置了 fallbackModels，构建 FallbackProvider（回退 provider 也包装 circuit breaker）
    let finalProvider: import('../../core/interfaces/model-provider.js').ModelProvider = wrappedProvider;
    if (agent.model.fallbackModels && agent.model.fallbackModels.length > 0) {
      const { FallbackProvider } = await import('../../harness/reliability/fallback-provider.js');
      const wrappedProviders = new Map<string, import('../../core/interfaces/model-provider.js').ModelProvider>();
      for (const [name, p] of this.providers) {
        wrappedProviders.set(name, wrapProviderWithCircuitBreaker(p, this.getCircuitBreaker(name)));
      }
      finalProvider = new FallbackProvider(
        wrappedProvider,
        agent.model.model,
        agent.model.fallbackModels,
        wrappedProviders,
      );
      console.log(`[Gateway] Agent "${agent.id}" fallback chain: ${[agent.model.model, ...agent.model.fallbackModels.map(f => f.model)].join(' → ')}`);
    }

    // 使用 AgentBuilder 构建；与 Runtime 同源 EventBus，Escalate/子系统事件才可达
    const builder = new (await import('../../harness/agent-building/builder.js')).AgentBuilder()
      .model(finalProvider)
      .store(this.store)
      .workspace(agent.workspace ?? '')
      .events(this.gatewayBus);

    if (this.config.toolIsolation) {
      builder.toolIsolation(this.config.toolIsolation);
    }
    // E1/E2：同一进程内所有 Runner 共享一把 session lease；E6：注入 ACL + agent 天花板
    builder.runnerConfig({
      sessionLease: this.sessionLease,
      sessionAcl: this.sessionAcl,
      agentMaxSessionRights: agent.maxSessionRights,
      observerHub: this.observerHub.isEnabled() ? this.observerHub : undefined,
    });

    // ── 七层数据源：skills / memory / wisdom / cognition / knowledge / assembler ──
    // 与 config-bridge 同构，保证 serve 路径 Web「上下文」能看到真实层数据
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const skillDir =
      agent.skillDirectory ?? (agent.home ? join(agent.home, 'skills') : undefined);
    if (skillDir && existsSync(skillDir)) {
      try {
        const { DefaultSkillManager } = await import('../../harness/plugin-ecosystem/skills/manager.js');
        const skillManager = new DefaultSkillManager();
        await skillManager.discover(skillDir);
        builder.skills(skillManager);
      } catch (err) {
        console.warn(`[Gateway] skill discover failed for agent "${agent.id}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (agent.home) {
      builder.agentHome(agent.home);
      builder.agentId(agent.id);
      try {
        const { AgentDatabase } = await import('../../harness/memory/sqlite/agent-db.js');
        const { SqliteMemoryStore } = await import('../../harness/memory/sqlite/memory-store.js');
        const { SqliteWisdomStore } = await import('../../harness/memory/sqlite/wisdom-store.js');
        const { SqliteConceptGraph } = await import('../../harness/memory/sqlite/cognition-store.js');
        const { MemoryKnowledgeStore } = await import('../../harness/context/knowledge/memory-store.js');
        const { resolveEmbeddingRuntime } = await import('../../harness/memory/sqlite/embedding-from-models.js');

        const embRuntime = resolveEmbeddingRuntime({
          providers: this.config.modelProviders ?? {},
          embedding: this.config.embedding,
        });
        const useVec = embRuntime && embRuntime.vectorEngine !== 'js';
        const db = await AgentDatabase.create({
          dbPath: join(agent.home, 'agent.db'),
          sqliteVec: useVec
            ? { extensionPath: embRuntime?.sqliteVecExtensionPath }
            : false,
          vectorDimensions: useVec ? embRuntime?.dimensions : undefined,
        });
        builder.memoryStore(
          new SqliteMemoryStore(db, {
            embeddingProvider: embRuntime?.provider ?? null,
            vectorEngine: embRuntime?.vectorEngine ?? 'auto',
          }),
        );
        builder.wisdomStore(new SqliteWisdomStore(db));
        builder.cognitionStore(new SqliteConceptGraph(db, {
          embeddingProvider: embRuntime?.provider ?? null,
        }));
        builder.knowledgeStore(new MemoryKnowledgeStore());
        if (embRuntime?.provider) {
          console.log(
            `[Gateway] memory embedding enabled: model=${embRuntime.model} vectorEngine=${embRuntime.vectorEngine}`,
          );
        } else {
          console.log('[Gateway] memory embedding not configured — keyword retrieval');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Gateway] context stores unavailable for agent "${agent.id}": ${msg}`);
        if (/node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE|ERR_DLOPEN|NODE_MODULE_VERSION/i.test(msg)) {
          console.warn(
            `[Gateway] hint: SQLite backend requires Node.js >= 24 with built-in node:sqlite (process.version=${process.version}). Memory tools will be skipped until the runtime is upgraded.`,
          );
        }
      }
    }
    if (this.config.context?.contextAssembler ?? this.config.contextAssembler) {
      builder.contextAssembler(this.config.context?.contextAssembler ?? this.config.contextAssembler!);
    }
    if (this.config.context?.constitution ?? this.config.constitution) {
      builder.constitution(this.config.context?.constitution ?? this.config.constitution ?? null);
    }

    // 注册工具（跳过 memory_*：由 AgentBuilder 按该 agent 的 memoryStore 创建，保证与 MemoryLayer 同实例）
    console.log(`[Gateway] Building agent "${agent.id}" with ${this.tools.length} global tools: ${this.tools.map(t => t.definition.name).join(', ')}`);
    for (const tool of this.tools) {
      const name = tool.definition.name;
      if (name === 'memory_store' || name === 'memory_search') continue;
      builder.tool(tool);
    }

    // 设置 systemPrompt：内联 persona 固定烤入；文件式 persona 走 builder.persona（run 时热更新）
    if (typeof agent.persona === 'object' && agent.persona?.systemPrompt) {
      builder.systemPrompt(agent.persona.systemPrompt);
    } else if (agent.home) {
      builder.persona(agent.home);
    }

    // 错误策略
    builder.errorStrategy({
      onModelError: (error, attempt) => {
        const retryable = ['rate_limit', 'timeout', 'network', 'server'];
        if (retryable.includes(error.reason) && attempt < 3) {
          const delayMs = (attempt + 1) * (error.reason === 'rate_limit' ? 1000 : 2000);
          return { action: 'retry', delayMs };
        }
        return { action: 'abort', reason: error.message };
      },
      onToolError: () => ({ action: 'skip', reason: 'Tool failed' }),
      onContextOverflow: () => ({ action: 'compact' }),
      onSecurityViolation: (v) => ({ action: 'block', reason: v.description }),
    });

    // 构建（builder.observerHub 已注入；setObserverHub 兼容仅 runnerConfig 传入的路径）
    builder.observerHub(this.observerHub.isEnabled() ? this.observerHub : undefined);
    const built = await builder.build();
    built.runner.setObserverHub(this.observerHub.isEnabled() ? this.observerHub : undefined);
    const agentToolNames = built.agent.context.tools
      ?.map((t: any) => t?.definition?.name ?? t?.name)
      .filter(Boolean) ?? [];
    const hasMemoryTools = agentToolNames.includes('memory_store') && agentToolNames.includes('memory_search');
    console.log(
      `[Gateway] Agent "${agent.id}" tools: ${agentToolNames.join(', ') || '(none)'}` +
        (hasMemoryTools ? ' [memory_store/search OK]' : ' [memory_store/search MISSING]'),
    );

    // ── Run 级模型快照解析（方案 B 唯一入口）──
    // 每 run 调一次；provider 缺失返回 null，Runner 回退 Agent 实例默认
    const wrap = (p: ModelProvider, providerName: string) =>
      wrapProviderWithCircuitBreaker(p, this.getCircuitBreaker(providerName));

    built.runner.setModelResolver(({ modelRef, defaultProvider }) => {
      const agentDef = this.agents.get(agent.id) ?? agent;
      if (!modelRef) {
        return resolveModel({
          providerName: agentDef.model.provider,
          modelName: agentDef.model.model,
          providers: this.providers,
          explicit: {
            contextWindow: agentDef.model.contextWindow,
            maxOutputTokens: agentDef.model.maxTokens,
          },
          isOverride: false,
          wrapProvider: wrap,
        });
      }
      return resolveModelRef(modelRef, {
        providers: this.providers,
        defaultProvider: defaultProvider ?? agentDef.model.provider,
        isOverride: true,
        wrapProvider: wrap,
      });
    });

    // 会话任务事件 → WebSocket（UI 只读实时面板）
    const forwardTaskEvent = (event: { sessionId?: string; type: string; data?: unknown }) => {
      if (!event.sessionId) return;
      for (const adapter of this.streamingAdapters) {
        adapter.broadcastEvent(event.sessionId, event as any);
      }
    };
    for (const type of ['session.task.created', 'session.task.updated', 'session.task.snapshot']) {
      built.events.on(type, forwardTaskEvent);
    }

    return { agent: built.agent, runner: built.runner, contextEngine: built.contextEngine, contextHealth: built.contextHealth };
  }

  private resolveAgent(msg: ChannelMessage): AgentDefinition | undefined {
    for (const agent of this.agents.values()) {
      if (agent.channelBindings) {
        const binding = agent.channelBindings[msg.channel];
        if (binding) {
          if (binding === '*' || binding === `user:${msg.senderId}`) {
            return agent;
          }
        }
      }
    }
    // Fallback: use first registered agent
    const fallback = this.agents.values().next().value;
    if (fallback) console.warn(`[Gateway] No channel binding match for ${msg.channel}:${msg.senderId}, falling back to agent "${fallback.id}"`);
    return fallback;
  }

  private buildSessionKey(agent: AgentDefinition, msg: ChannelMessage): string {
    // 使用消息中的原始 agentId（而非 Gateway 解析后的 agent.id）
    // 这样 sessionKey 和 WS session 的 agentId 一致，broadcastEvent 能正确匹配
    const agentId = (msg.metadata?.agentId as string) ?? agent.id;

    // 优先使用客户端传来的 sessionId（WebUI 通过 REST API 创建的 session）
    const clientSessionId = msg.metadata?.sessionId as string | undefined;
    if (clientSessionId) {
      return clientSessionId;
    }

    switch (this.dmScope) {
      case 'per-peer':
        return `${agentId}:${msg.senderId}`;
      case 'per-channel-peer':
        return `${agentId}:${msg.channel}:${msg.senderId}`;
      default:
        return `${agentId}:main`;
    }
  }

  private static isTerminalWsEvent(type: string): boolean {
    return (
      type === 'turn.end' ||
      type === 'engine.end' ||
      type === 'engine.error' ||
      type === 'aborted' ||
      type === 'interrupted'
    );
  }

  private emitEvent(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener 错误不应中断流程
      }
    }
  }

  /**
   * 获取或创建 provider 熔断器
   */
  private getCircuitBreaker(providerName: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(providerName);
    if (!cb) {
      cb = new CircuitBreaker({
        failureThreshold: 5,
        recoveryTimeoutMs: 30_000,
        name: providerName,
      });
      this.circuitBreakers.set(providerName, cb);
    }
    return cb;
  }

  /**
   * 获取所有熔断器状态
   */
  getCircuitBreakerStatus(): Record<string, { state: string; failureCount: number }> {
    const result: Record<string, { state: string; failureCount: number }> = {};
    for (const [name, cb] of this.circuitBreakers) {
      result[name] = cb.snapshot();
    }
    return result;
  }

  /**
   * 解析 trace 日志级别字符串为数字
   */
  private parseTraceLevel(level: string): number {
    const levels: Record<string, number> = {
      'ERROR': 1, 'WARN': 2, 'INFO': 3, 'DEBUG': 4, 'TRACE': 5,
    };
    return levels[level.toUpperCase()] ?? 3;
  }
}

/**
 * WS 广播前剥离 context.layers.assembled 里的层正文 content
 *
 * Gateway 缓存/REST 仍保留全文；UI 点选层时经 REST 拉取。
 * preview 保留在 WS，便于未点选时浏览摘要。
 */
function stripLayerContentFromEvent(event: AgentEvent): AgentEvent {
  const data = event.data as
    | { manifest?: AssembleManifest; [k: string]: unknown }
    | undefined;
  if (!data?.manifest?.layers) return event;
  return {
    ...event,
    data: {
      ...data,
      manifest: {
        ...data.manifest,
        layers: data.manifest.layers.map(({ content: _content, ...rest }) => rest),
      },
    },
  } as AgentEvent;
}
