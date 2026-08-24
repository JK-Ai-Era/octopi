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
  ChannelAdapter,
  ChannelMessage,
  ChannelReply,
  GatewayConfig,
  RegisteredTool,
  SessionMeta,
  HookContext,
} from '../../core/types.js';
import type { AgentEvent } from '../../core/event-bus.js';
import type { ModelProvider } from '../../core/interfaces/model-provider.js';
import type { Observer } from '../../core/interfaces/observer.js';
import type { SessionStore, SessionData } from '../../core/interfaces/session-store.js';
import type { StreamingChannelAdapter } from '../protocols/http.js';
import { CircuitBreaker } from '../../core/circuit-breaker.js';
import { wrapProviderWithCircuitBreaker } from '../../core/provider-wrapper.js';
import { PluginManager } from '../../harness/plugins/manager.js';

import { DefaultEventBus } from '../../core/event-bus.js';
import { DefaultSecurityGuard } from '../../core/security-guard.js';
import { IterationBudget } from '../../core/budget.js';
import { DefaultContextEngine } from '../../harness/context/default-context-engine.js';
import { SessionAwareRunner, type RunConfig } from '../../harness/runner.js';

// ================================================================
// 内存 Session 存储
// ================================================================

class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();

  async load(sessionId: string): Promise<SessionData | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async save(sessionId: string, data: SessionData): Promise<void> {
    this.sessions.set(sessionId, data);
  }

  async list(_agentId: string): Promise<any[]> {
    return Array.from(this.sessions.values());
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }
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
  private store: SessionStore;
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
  private agentCache = new Map<string, { agent: import('../../core/loop/agent.js').Agent; runner: SessionAwareRunner }>();
  /** 流式 adapter 引用（用于广播事件） */
  private streamingAdapters: StreamingChannelAdapter[] = [];
  /** 每个 provider 的熔断器 */
  private circuitBreakers = new Map<string, CircuitBreaker>();
  /** 每个 session 的中止控制器 */
  private abortControllers = new Map<string, AbortController>();

  constructor(config: GatewayConfig) {
    this.config = config;
    this.dmScope = config.session?.dmScope ?? 'main';
    this.pluginManager = new PluginManager();
    this.store = new InMemorySessionStore();

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
    const runConfig: RunConfig = {
      agentId: agent.id,
      sessionId: sessionKey,
      model: agent.model.model,
      contextWindow: agent.model.contextWindow,
      systemPrompt: typeof agent.persona === 'object' ? agent.persona?.systemPrompt ?? '' : '',
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
    agent: import('../../core/loop/agent.js').Agent;
    runner: SessionAwareRunner;
  }> {
    // 获取 provider
    const modelProvider = this.providers.get(agent.model.provider);
    if (!modelProvider) {
      throw new Error(`LLM provider "${agent.model.provider}" not found.`);
    }

    // 获取熔断器
    const cb = this.getCircuitBreaker(agent.model.provider);
    const wrappedProvider = wrapProviderWithCircuitBreaker(modelProvider, cb);

    // 使用 AgentBuilder 构建
    const builder = new (await import('../../harness/builder.js')).AgentBuilder()
      .model(wrappedProvider)
      .store(this.store);

    // 注册工具
    for (const tool of this.tools) {
      builder.tool(tool);
    }

    // 设置 systemPrompt
    const systemPrompt = typeof agent.persona === 'object' ? agent.persona?.systemPrompt ?? '' : '';
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
    return this.agents.values().next().value;
  }

  private buildSessionKey(agent: AgentDefinition, msg: ChannelMessage): string {
    // 使用消息中的原始 agentId（而非 Gateway 解析后的 agent.id）
    // 这样 sessionKey 和 WS session 的 agentId 一致，broadcastEvent 能正确匹配
    const agentId = (msg.metadata?.agentId as string) ?? agent.id;
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
