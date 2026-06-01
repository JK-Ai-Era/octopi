/**
 * Gateway — 核心守护进程
 *
 * OpenClaw 的关键洞察：Agent 需要的不是 "一个 API"，而是 "一个操作系统"。
 * Gateway 拥有所有通信面、管理所有 Agent、维护 session 状态、执行 command queue。
 *
 * 架构：
 *
 *   外部消息 → Channel Adapter → Gateway → Agent Loop → LLM
 *                                        ↓
 *                                  Session Manager
 *                                        ↓
 *                                  Channel Adapter → 外部回复
 *
 * 职责：
 * - Channel 路由：消息到达 → 找到正确的 Agent + Session
 * - Session 管理：创建/复用/隔离 session
 * - Agent Loop 编排：调用 agent loop 处理消息
 * - Plugin 注册：统一管理 hooks
 * - 健康检查：提供 /health 端点
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
  LLMProvider,
  Plugin,
  PluginHooks,
  RegisteredTool,
  SessionMeta,
  QueueMode,
  AgentEvent,
  HookContext,
} from '../core/types.js';
import { AgentLoop } from '../agent/agent-loop.js';

/**
 * Gateway 实现
 *
 * 生命周期：
 * 1. new Gateway(config) — 创建实例，注册配置中的 agents
 * 2. register*() — 注册 provider、channel、tool、plugin
 * 3. start() — 启动所有 channel adapter，开始监听消息
 * 4. send() / handleInboundMessage() — 处理消息
 * 5. stop() — 优雅关闭
 */
export class Gateway {
  /** 已注册的 Agent（id → AgentDefinition） */
  private agents = new Map<string, AgentDefinition>();
  /** 已注册的 Channel Adapter（name → adapter） */
  private channels = new Map<string, ChannelAdapter>();
  /** Agent Loop 实例 */
  private agentLoop: AgentLoop;
  /** Gateway 配置 */
  private config: GatewayConfig;
  /** DM 作用域 */
  private dmScope: string;
  /** 是否已启动 */
  private started = false;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.dmScope = config.session?.dmScope ?? 'main';
    this.agentLoop = new AgentLoop();

    // 注册配置中定义的 agents
    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
    }

    // 注册事件监听（日志）
    this.agentLoop.on(async (event) => {
      this.handleEvent(event);
    });
  }

  // ================================================================
  // 生命周期
  // ================================================================

  /**
   * 启动 Gateway
   *
   * 启动所有已注册的 channel adapter，开始监听外部消息。
   */
  async start(): Promise<void> {
    if (this.started) {
      console.warn('[Gateway] Already started');
      return;
    }

    console.log('[Gateway] Starting...');
    console.log(`[Gateway] Agents: ${Array.from(this.agents.keys()).join(', ') || '(none)'}`);
    console.log(`[Gateway] Channels: ${Array.from(this.channels.keys()).join(', ') || '(none)'}`);

    // 启动所有 channel adapters
    for (const [name, adapter] of this.channels) {
      console.log(`[Gateway] Starting channel: ${name}`);
      await adapter.start(async (msg) => {
        await this.handleInboundMessage(msg);
      });
    }

    this.started = true;
    console.log(`[Gateway] Ready. ${this.agents.size} agent(s), ${this.channels.size} channel(s)`);
  }

  /**
   * 停止 Gateway
   *
   * 优雅关闭所有 channel adapter 和 agent loop。
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    console.log('[Gateway] Stopping...');

    for (const [name, adapter] of this.channels) {
      console.log(`[Gateway] Stopping channel: ${name}`);
      await adapter.stop();
    }

    await this.agentLoop.close();
    this.started = false;
    console.log('[Gateway] Stopped.');
  }

  // ================================================================
  // 注册接口
  // ================================================================

  /**
   * 注册 Agent
   */
  registerAgent(agent: AgentDefinition): void {
    this.agents.set(agent.id, agent);
    console.log(`[Gateway] Registered agent: ${agent.id}`);
  }

  /**
   * 注册 Channel Adapter
   *
   * 必须在 start() 之前调用。
   */
  registerChannel(adapter: ChannelAdapter): void {
    this.channels.set(adapter.name, adapter);
    console.log(`[Gateway] Registered channel: ${adapter.name}`);
  }

  /**
   * 注册 Plugin
   */
  registerPlugin(plugin: Plugin): void {
    this.agentLoop.registerPlugin(plugin);
  }

  /**
   * 注册工具（全局或 Agent 级）
   */
  registerTool(tool: RegisteredTool, agentId?: string): void {
    this.agentLoop.registerTool(tool, agentId);
  }

  /**
   * 注册 LLM Provider
   */
  registerProvider(provider: LLMProvider): void {
    this.agentLoop.registerProvider(provider);
  }

  /**
   * 注册事件监听器
   */
  on(listener: (event: AgentEvent) => void): void {
    this.agentLoop.on(listener);
  }

  // ================================================================
  // 核心消息处理
  // ================================================================

  /**
   * 手动发送消息（用于测试或外部集成）
   */
  async send(message: ChannelMessage): Promise<void> {
    await this.handleInboundMessage(message);
  }

  /**
   * 获取 session 信息
   */
  getSession(sessionId: string): SessionMeta | undefined {
    return this.agentLoop.getSessionManager().get(sessionId);
  }

  /**
   * 获取 Agent Loop 实例（高级用法）
   */
  getAgentLoop(): AgentLoop {
    return this.agentLoop;
  }

  // ================================================================
  // 内部
  // ================================================================

  /**
   * 入站消息处理（OpenClaw 的路由逻辑）
   *
   * 完整流程：
   * 1. Plugin: message_received（通知所有 plugin 有新消息）
   * 2. 找到绑定的 agent（基于 channel + sender）
   * 3. 获取或创建 session
   * 4. 执行 agent loop
   * 5. Plugin: message_sending（可拦截回复）
   * 6. 发送回复到 channel
   * 7. Plugin: message_sent（通知所有 plugin 回复已发送）
   */
  private async handleInboundMessage(msg: ChannelMessage): Promise<void> {
    console.log(`[Gateway] Inbound message from ${msg.channel}:${msg.senderId} — "${msg.content.substring(0, 50)}..."`);

    // 1. Plugin: message_received
    const agent = this.resolveAgent(msg);
    if (agent) {
      const session = this.agentLoop.resolveSession(agent, msg, this.dmScope);
      await this.agentLoop['pluginManager'].runAllHooks(
        'message_received',
        { sessionId: session.id, agentId: agent.id, message: msg },
      );
    }

    // 2. 找到 agent
    if (!agent) {
      console.warn(`[Gateway] No agent resolved for message from ${msg.channel}:${msg.senderId}`);
      return;
    }

    // 3. 获取或创建 session
    const session = this.agentLoop.resolveSession(agent, msg, this.dmScope);

    // 4. 更新交互时间
    session.lastInteractionAt = Date.now();
    session.status = 'processing';

    // 5. 执行 agent loop
    try {
      const reply = await this.agentLoop.processMessage(agent, session, msg);

      // 6. Plugin: message_sending（可拦截回复）
      const hookCtx: HookContext = {
        sessionId: session.id,
        agentId: agent.id,
      };
      const channelReply: ChannelReply = {
        channel: msg.channel,
        conversationId: msg.conversationId,
        content: reply.content,
        replyToId: msg.id,
      };

      const sendBlock = await this.agentLoop['pluginManager'].runHook<{ cancel?: boolean } | null>(
        'message_sending',
        { ...hookCtx, reply: channelReply },
        null,
      );

      if (sendBlock?.cancel) {
        console.log(`[Gateway] Reply cancelled by plugin`);
        return;
      }

      // 7. 发送回复到 channel
      const adapter = this.channels.get(msg.channel);
      if (adapter && channelReply.content) {
        await adapter.send(channelReply);

        // 8. Plugin: message_sent
        await this.agentLoop['pluginManager'].runAllHooks(
          'message_sent',
          { ...hookCtx, reply: channelReply },
        );
      }
    } catch (error) {
      console.error(`[Gateway] Error processing message:`, error);
      session.status = 'error';

      // 尝试发送错误消息到 channel
      const adapter = this.channels.get(msg.channel);
      if (adapter) {
        try {
          await adapter.send({
            channel: msg.channel,
            conversationId: msg.conversationId,
            content: `[Gateway Error] ${error instanceof Error ? error.message : String(error)}`,
            replyToId: msg.id,
          });
        } catch {
          // 发送错误消息也失败了，只能记日志
        }
      }
    }
  }

  /**
   * Agent 路由（OpenClaw 的 binding 逻辑）
   *
   * 路由策略：
   * 1. 如果 agent 有 channelBindings，按 binding 匹配
   * 2. 否则返回第一个 agent（单 agent 模式）
   *
   * TODO: 支持更复杂的路由规则（如按 senderId 路由到不同 agent）
   */
  private resolveAgent(msg: ChannelMessage): AgentDefinition | undefined {
    // 按 channel binding 匹配
    for (const agent of this.agents.values()) {
      if (agent.channelBindings) {
        const binding = agent.channelBindings[msg.channel];
        if (binding) {
          // binding 格式："user:open_id_xxx" 或 "group:chat_id_xxx"
          if (binding === '*' || binding === `user:${msg.senderId}`) {
            return agent;
          }
        }
      }
    }

    // 默认：返回第一个 agent
    return this.agents.values().next().value;
  }

  /**
   * 事件处理（日志）
   */
  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        console.log(`[Gateway] Turn ${event.turnId} started for session ${event.sessionId}`);
        break;
      case 'llm_request':
        console.log(`[Gateway] LLM request: model=${event.request.model}, messages=${event.request.messages.length}`);
        break;
      case 'llm_response':
        console.log(`[Gateway] LLM response: model=${event.response.model}, finishReason=${event.response.finishReason}`);
        break;
      case 'tool_call':
        console.log(`[Gateway] Tool call: ${event.call.name}(${JSON.stringify(event.call.arguments).substring(0, 100)})`);
        break;
      case 'tool_result':
        console.log(`[Gateway] Tool result: ${event.result.name} (${event.result.durationMs}ms) ${event.result.error ? 'ERROR: ' + event.result.error : 'OK'}`);
        break;
      case 'turn_end':
        console.log(`[Gateway] Turn ${event.turn.id} ended (${event.turn.durationMs}ms)`);
        break;
      case 'error':
        console.error(`[Gateway] Error:`, event.error.message);
        break;
    }
  }
}
