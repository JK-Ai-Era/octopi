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

import type {
  AgentDefinition,
  RegisteredTool,
  SessionMeta,
} from '../../core/types.js';
import type { ChannelAdapter, ChannelMessage, ChannelReply } from '../types/channels.js';
import type { GatewayConfig } from '../types/gateway-config.js';

/** persona 缓存：路径 → 内容，避免每次消息都读磁盘 */
const personaCache = new Map<string, string>();

async function loadPersonaCached(personaPath: string): Promise<string> {
  const cached = personaCache.get(personaPath);
  if (cached !== undefined) return cached;
  const { loadPersona } = await import('../../harness/agent-building/persona.js');
  const content = await loadPersona(personaPath);
  personaCache.set(personaPath, content);
  return content;
}

/** 清除 persona 缓存（文件变更后调用） */
export function clearPersonaCache(): void {
  personaCache.clear();
}
import type { HookContext } from '../../harness/types/hook-context.js';
import type { AgentEvent } from '../../core/primitives/event-bus.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { Observer } from '../../core/interfaces/observer.js';
import type { SessionStore } from '../../core/interfaces/session-store.js';
import type { SessionData } from '../../harness/session-types.js';
import type { StreamingChannelAdapter } from '../protocols/http.js';
import type { Message, ModelConfig } from '../../core/types.js';
import { randomUUID } from 'node:crypto';
import { CircuitBreaker } from '../../harness/reliability/circuit-breaker.js';
import { wrapProviderWithCircuitBreaker } from '../../harness/reliability/provider-wrapper.js';
import { PluginManager } from '../../harness/plugin-ecosystem/plugins/manager.js';

import { DefaultEventBus } from '../../core/primitives/event-bus.js';
import { DefaultSecurityGuard } from '../../harness/security/default-security-guard.js';
import { IterationBudget } from '../../harness/budget/budget.js';
import { DefaultContextEngine } from '../../harness/context/default-context-engine.js';
import { SessionAwareRunner, type RunConfig } from '../../harness/runner.js';

// ================================================================
// 内存 Session 存储
// ================================================================

class InMemorySessionStore implements SessionStore<SessionData> {
    private static key(agentId: string, sessionId: string): string { return `${agentId}:${sessionId}`; }
  private sessions = new Map<string, SessionData>();

  async load(_agentId: string, sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(InMemorySessionStore.key(_agentId, sessionId)) ?? null;
  }

  async save(_agentId: string, sessionId: string, data: SessionData): Promise<void> {
    this.sessions.set(InMemorySessionStore.key(_agentId, sessionId), data);
  }

  async list(agentId: string): Promise<any[]> {
    return Array.from(this.sessions.values()).filter(s => s.agentId === agentId);
  }

  async delete(_agentId: string, sessionId: string): Promise<void> {
    this.sessions.delete(InMemorySessionStore.key(_agentId, sessionId));
  }

  async exists(_agentId: string, sessionId: string): Promise<boolean> {
    return this.sessions.has(InMemorySessionStore.key(_agentId, sessionId));
  }
}

// ================================================================
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

// ================================================================
// Gateway
// ================================================================

/**
 * Gateway 实现
 *
 * 使用 Agent + SessionAwareRunner 架构。
 */
export class Gateway {
  /** 已注册的 Agent */
  private agents = new Map<string, AgentDefinition>();
  /** 已注册的 Channel Adapter */
  private channels = new Map<string, ChannelAdapter>();
  /** Plugin Manager */
  private pluginManager: PluginManager;
  /** Session Store */
  private store: SessionStore<SessionData>;
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
  private agentCache = new Map<string, { agent: import('../../loop/agent.js').Agent; runner: SessionAwareRunner }>();
  /** 流式 adapter 引用（用于广播事件） */
  private streamingAdapters: StreamingChannelAdapter[] = [];
  /** 每个 provider 的熔断器 */
  private circuitBreakers = new Map<string, CircuitBreaker>();
  /** 每个 session 的中止控制器 */
  private abortControllers = new Map<string, AbortController>();
  /** Web Runtime pending approvals */
  private pendingApprovals = new Map<string, PendingApprovalView>();

  constructor(config: GatewayConfig, store?: SessionStore<SessionData>) {
    this.config = config;
    this.dmScope = config.session?.dmScope ?? 'main';
    this.pluginManager = new PluginManager();
    this.store = store ?? new InMemorySessionStore();

    // 注册配置中定义的 agents
    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
    }
  }

  // ================================================================
  // 生命周期
  // ================================================================

  async start(): Promise<void> {
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

    await this.pluginManager.onGatewayStop();
    personaCache.clear();
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
   */
  abortSession(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
  }

  // ================================================================
  // Web Runtime: read/write surface for REST skeleton
  // ================================================================

  getRegisteredAgents(): Array<{ id: string; model: ModelConfig }> {
    return Array.from(this.agents.entries()).map(([id, agent]) => ({ id, model: agent.model }));
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
    const agentIds = agentId ? [agentId] : Array.from(this.agents.keys());
    const results = await Promise.all(agentIds.map((id) => this.store.list(id)));
    return (results as SessionMeta[][]).flat();
  }

  async createSession(options: { agentId: string; sessionId?: string; metadata?: Record<string, unknown> }): Promise<SessionMeta> {
    const agent = this.agents.get(options.agentId);
    if (!agent) {
      throw new Error(`Agent "${options.agentId}" not found`);
    }

    const sessionId = options.sessionId ?? `${options.agentId}:web:${Date.now()}`;
    const session: SessionData = {
      id: sessionId,
      agentId: options.agentId,
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
    };

    await this.store.save(options.agentId, sessionId, session);
    return session.meta;
  }


  /**
   * 查找 session（遍历所有已知 agent）
   * 用于 API 层面不知道 agentId 的场景
   */
  private async findSession(sessionId: string): Promise<SessionData | null> {
    for (const agentId of this.agents.keys()) {
      const session = await this.store.load(agentId, sessionId);
      if (session) return session;
    }
    return null;
  }

  async getSessionView(sessionId: string, agentId?: string): Promise<{ meta: SessionMeta; messageCount: number; turnCount: number } | null> {
    const session = agentId ? await this.store.load(agentId, sessionId) : await this.findSession(sessionId);
    if (!session) return null;
    return { meta: session.meta, messageCount: session.messages.length, turnCount: session.turns.length };
  }

  async getSessionMessages(sessionId: string, options: { limit: number; cursor?: string; agentId?: string }): Promise<{ messages: Message[]; nextCursor?: string }> {
    const session = options.agentId ? await this.store.load(options.agentId, sessionId) : await this.findSession(sessionId);
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

    // 3. 获取或构建 Agent + SessionAwareRunner
    let cached = this.agentCache.get(agent.id);
    if (!cached) {
      cached = await this.buildAgent(agent);
      this.agentCache.set(agent.id, cached);
    }
    const { runner } = cached;

    // 4. 构建用户消息
    const userMessage = {
      role: 'user' as const,
      content: msg.content,
      source: {
        channel: msg.channel,
        senderId: msg.senderId,
        senderName: msg.senderName,
        messageId: msg.id,
        conversationId: msg.conversationId,
      },
      timestamp: msg.timestamp,
    };

    // 5. 运行 Agent
    let runSystemPrompt = typeof agent.persona === 'object' ? agent.persona?.systemPrompt ?? '' : '';
    if (!runSystemPrompt && agent.home) {
      runSystemPrompt = await loadPersonaCached(agent.home);
    }
    // 解析 contextWindow：优先用 agent 配置，否则从 provider model info 获取
    let contextWindow = agent.model.contextWindow;
    if (!contextWindow) {
      const provider = this.providers.get(agent.model.provider);
      const modelInfo = provider?.getModelInfo(agent.model.model);
      contextWindow = modelInfo?.contextWindow;
    }

    const runConfig: RunConfig = {
      agentId: agent.id,
      sessionId: sessionKey,
      model: agent.model.model,
      contextWindow,
      systemPrompt: runSystemPrompt,
    };

    let finalContent = '';

    // 创建中止控制器
    const abortController = new AbortController();
    this.abortControllers.set(sessionKey, abortController);

    try {
      for await (const event of runner.handle(sessionKey, userMessage, runConfig, abortController.signal)) {
        // 转发事件给监听器
        this.emitEvent(event as any);

        // 广播给 WebSocket 客户端
        for (const adapter of this.streamingAdapters) {
          adapter.broadcastEvent(sessionKey, event as any);
        }

        // 捕获最终回复
        if (event.type === 'turn.end' && event.data?.content) {
          finalContent = event.data.content as string;
        }
      }
    } catch (error) {
      console.error(`[Gateway] Error processing message:`, error);
      finalContent = `[Gateway Error] ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.abortControllers.delete(sessionKey);
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

  /**
   * 为 Agent 构建 Agent + SessionAwareRunner（新架构）
   */
  private async buildAgent(agent: AgentDefinition): Promise<{
    agent: import('../../loop/agent.js').Agent;
    runner: SessionAwareRunner;
  }> {
    // 获取主 provider
    const modelProvider = this.providers.get(agent.model.provider);
    if (!modelProvider) {
      throw new Error(`LLM provider "${agent.model.provider}" not found.`);
    }

    // 获取熔断器
    const cb = this.getCircuitBreaker(agent.model.provider);
    const wrappedProvider = wrapProviderWithCircuitBreaker(modelProvider, cb);

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

    // 使用 AgentBuilder 构建
    const builder = new (await import('../../harness/agent-building/builder.js')).AgentBuilder()
      .model(finalProvider)
      .store(this.store)
      .workspace(agent.workspace ?? '');

    // 注册工具
    for (const tool of this.tools) {
      builder.tool(tool);
    }

    // 设置 systemPrompt
    let systemPrompt = typeof agent.persona === 'object' ? agent.persona?.systemPrompt ?? '' : '';
    if (!systemPrompt && agent.home) {
      // 从 home 目录加载 persona 文件
      systemPrompt = await loadPersonaCached(agent.home);
    }
    if (systemPrompt) {
      builder.systemPrompt(systemPrompt);
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

    // 构建
    const built = await builder.build();
    return { agent: built.agent, runner: built.runner };
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
