import type {
  AgentDefinition,
  ChannelAdapter,
  ChannelMessage,
  GatewayConfig,
  Gateway as IGateway,
  LLMProvider,
  Plugin,
  RegisteredTool,
  SessionMeta,
  QueueMode,
} from '../core/types.js';
import { AgentLoop } from '../agent/agent-loop.js';

/**
 * Gateway — 核心守护进程
 *
 * OpenClaw 的关键洞察：Agent 需要的不是 "一个 API"，而是 "一个操作系统"。
 * Gateway 拥有所有通信面、管理所有 Agent、维护 session 状态、执行 command queue。
 *
 * 职责：
 * - Channel 路由：消息到达 → 找到正确的 Agent + Session
 * - Session 管理：创建/复用/隔离 session
 * - Agent Loop 编排：调用 agent loop 处理消息
 * - Plugin 注册：统一管理 hooks
 */
export class Gateway implements IGateway {
  private agents = new Map<string, AgentDefinition>();
  private channels = new Map<string, ChannelAdapter>();
  private agentLoop = new AgentLoop();
  private config: GatewayConfig;
  private queueModes = new Map<string, QueueMode>();
  private dmScope: string;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.dmScope = config.session?.dmScope ?? 'main';

    // 注册配置中定义的 agents
    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
    }
  }

  // ---- 生命周期 ----

  async start(): Promise<void> {
    console.log('[Gateway] Starting...');

    // 启动所有 channel adapters
    for (const [name, adapter] of this.channels) {
      console.log(`[Gateway] Starting channel: ${name}`);
      await adapter.start(async (msg) => {
        await this.handleInboundMessage(msg);
      });
    }

    console.log(`[Gateway] Ready. ${this.agents.size} agents, ${this.channels.size} channels`);
  }

  async stop(): Promise<void> {
    console.log('[Gateway] Stopping...');
    for (const [name, adapter] of this.channels) {
      await adapter.stop();
    }
    await this.agentLoop.close();
    console.log('[Gateway] Stopped.');
  }

  // ---- 注册 ----

  registerAgent(agent: AgentDefinition): void {
    this.agents.set(agent.id, agent);
  }

  registerChannel(adapter: ChannelAdapter): void {
    this.channels.set(adapter.name, adapter);
  }

  registerPlugin(plugin: Plugin): void {
    this.agentLoop.registerPlugin(plugin);
  }

  registerTool(tool: RegisteredTool, agentId?: string): void {
    this.agentLoop.registerTool(tool, agentId);
  }

  registerProvider(provider: LLMProvider): void {
    this.agentLoop.registerProvider(provider);
  }

  // ---- 核心消息处理 ----

  async send(message: ChannelMessage): Promise<void> {
    await this.handleInboundMessage(message);
  }

  getSession(sessionId: string): SessionMeta | undefined {
    return (this.agentLoop as any).sessions?.get(sessionId);
  }

  /**
   * 设置 session 的 queue mode
   */
  setQueueMode(sessionKey: string, mode: QueueMode): void {
    this.queueModes.set(sessionKey, mode);
  }

  /**
   * 事件监听转发
   */
  on(listener: (event: any) => void): void {
    this.agentLoop.on(listener);
  }

  // ---- 内部 ----

  /**
   * 入站消息处理（OpenClaw 的路由逻辑）
   *
   * 1. 消息到达 channel adapter
   * 2. 找到绑定的 agent（基于 channel + sender）
   * 3. 获取或创建 session
   * 4. 执行 agent loop
   * 5. 发送回复
   */
  private async handleInboundMessage(msg: ChannelMessage): Promise<void> {
    // 1. 找到 agent（简单路由：第一个 agent，或按 channel 绑定）
    const agent = this.resolveAgent(msg);
    if (!agent) {
      console.warn(`[Gateway] No agent resolved for message from ${msg.channel}:${msg.senderId}`);
      return;
    }

    // 2. 获取或创建 session
    const session = this.agentLoop.resolveSession(agent, msg, this.dmScope);

    // 3. 更新交互时间
    session.lastInteractionAt = Date.now();
    session.status = 'processing';

    // 4. 执行 agent loop
    try {
      const reply = await this.agentLoop.processMessage(agent, session, msg);

      // 5. 发送回复到 channel
      const adapter = this.channels.get(msg.channel);
      if (adapter && reply.content) {
        await adapter.send({
          channel: msg.channel,
          conversationId: msg.conversationId,
          content: reply.content,
          replyToId: msg.id,
        });
      }
    } catch (error) {
      console.error(`[Gateway] Error processing message:`, error);
      session.status = 'error';

      // 尝试发送错误消息
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
   * 简化版：默认路由到第一个 agent
   * 可通过 channel binding 配置扩展
   */
  private resolveAgent(msg: ChannelMessage): AgentDefinition | undefined {
    // 简单路由：返回第一个 agent
    // 生产环境应支持 binding 配置：
    // { "feishu:user1": "agent-a", "telegram:group1": "agent-b" }
    return this.agents.values().next().value;
  }
}
